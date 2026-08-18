"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerCard } from "./PlayerCard";
import { buildBoard, focusRound, picksUntilTurn } from "@/lib/draft-board";
import type { BoardCell, BoardRow } from "@/lib/draft-board";
import {
  POSITION_ORDER,
  injuryBadge,
  injuryTone,
  points,
  positionColour,
  positionGroup,
  shortName,
} from "@/lib/player";

/**
 * The draft room.
 *
 * Polls rather than holds a socket. A 90-second pick clock does not need
 * sub-second updates, and polling survives sleep, tab-switching, and flaky
 * mobile connections without a reconnect protocol. It also means the server has
 * no per-connection state, which matters when it runs as serverless functions.
 *
 * The board is fetched once — it only changes when the stats sync runs — and
 * availability is worked out here by subtracting who has been drafted.
 *
 * **The grid is the screen's centre of gravity**, one column per seat and one
 * row per round, because that is the layout that answers "when am I up again"
 * by counting downwards. Its geometry comes from `lib/draft-board.ts`, which
 * asks the engine's own `pickPosition` — the snake is authored once, on the
 * server, and this room reads it rather than restating it.
 */

interface Player {
  id: string;
  name: string;
  positions: string[];
  rank: number;
  /** Milli-points, scored with this league's rules. Null when unprojected. */
  projectedMilliPoints: number | null;
  /** Display only — see the board route. Null on a pool synced before `0032`. */
  imageUrl: string | null;
  teamRef: string | null;
  byeWeek: number | null;
  injuryDesignation: string | null;
}

/**
 * Best projection first, then ADP.
 *
 * ADP is the fallback rather than the primary sort. It measures where a player
 * is *being taken*, which is a crowd's opinion filtered through other people's
 * league settings; a projection scored against this league's own rules is a
 * statement about what he is worth here. Unprojected players sort last but stay
 * draftable — a late flier on someone unranked is a legitimate pick.
 */
function byProjection(a: Player, b: Player): number {
  const left = a.projectedMilliPoints;
  const right = b.projectedMilliPoints;

  if (left === null && right === null) return a.rank - b.rank;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left || a.rank - b.rank;
}

interface Pick {
  pickNumber: number;
  round: number;
  teamId: string;
  playerId: string;
  source: string;
}

interface Team {
  id: string;
  name: string;
  isBot: boolean;
  draftPosition: number | null;
}

interface DraftState {
  status: "SCHEDULED" | "IN_PROGRESS" | "PAUSED" | "COMPLETE";
  rounds: number;
  pickSeconds: number;
  scheduledAt: string;
  clockStartedAt: string | null;
  draw: { slot: number; blockhash: string; seed: string; drawnAt: string } | null;
  order: string[];
  picks: Pick[];
  picksMade: number;
  totalPicks: number;
  currentPickNumber: number | null;
  currentTeamId: string | null;
  onDeckTeamId: string | null;
  complete: boolean;
}

/**
 * How often to ask for updates.
 *
 * Three seconds is invisible when you are watching someone else pick. It is not
 * invisible when the turn passes to you: a poll that lands three seconds late
 * costs three of your ninety.
 *
 * So the interval tightens while you are on the clock **or next**. Being next is
 * the important half — by the time it flips to your turn, the fast poll is
 * already running, so you learn within a second rather than finding out three
 * seconds in.
 */
function pollInterval(data: DraftResponse | undefined): number {
  const draft = data?.draft;
  const me = data?.me.teamId;
  if (!draft || !me || draft.status !== "IN_PROGRESS") return 5000;

  return draft.currentTeamId === me || draft.onDeckTeamId === me ? 1000 : 3000;
}

interface DraftResponse {
  /** The server clock when this payload was built. See `serverNow` below. */
  now?: string;
  draft: DraftState | null;
  teams: Team[];
  me: { teamId: string | null; isCommissioner: boolean; queue: string[] };
}

const fetcher = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json();
};

const FILTERS = ["ALL", ...POSITION_ORDER] as const;

type Tab = "QUEUE" | "ROSTER" | "ORDER";

export function DraftRoom({ leagueId, leagueName }: { leagueId: string; leagueName: string }) {
  const { data, error, mutate } = useSWR<DraftResponse>(
    `/api/leagues/${leagueId}/draft`,
    fetcher as (url: string) => Promise<DraftResponse>,
    { refreshInterval: pollInterval, revalidateOnFocus: true },
  );

  const { data: boardData } = useSWR<{ players: Player[] }>(
    `/api/leagues/${leagueId}/draft/board`,
    fetcher as (url: string) => Promise<{ players: Player[] }>,
    { revalidateOnFocus: false, revalidateIfStale: false },
  );

  const [position, setPosition] = useState<(typeof FILTERS)[number]>("ALL");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("QUEUE");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The player whose card is open, or null. Opened from anywhere on the page. */
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);

  const draft = data?.draft ?? null;
  const teams = useMemo(() => new Map((data?.teams ?? []).map((t) => [t.id, t])), [data]);
  const myTeamId = data?.me.teamId ?? null;
  const queue = useMemo(() => data?.me.queue ?? [], [data]);

  const drafted = useMemo(
    () => new Set((draft?.picks ?? []).map((pick) => pick.playerId)),
    [draft],
  );

  const players = useMemo(() => boardData?.players ?? [], [boardData]);
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  /**
   * Available players, ranked.
   *
   * One flat list rather than the old per-position sections. The sections
   * existed to stop a quarterback's 340 being compared against a kicker's 130,
   * and the filter row does that job better: it is one click, it shows how many
   * are left at each position, and it leaves the default view as the honest
   * "best available" a manager is actually choosing from.
   */
  const pool = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (
      players
        .filter((player) => !drafted.has(player.id))
        .filter((player) => term === "" || player.name.toLowerCase().includes(term))
        .filter((player) => position === "ALL" || positionGroup(player.positions) === position)
        .sort(byProjection)
        // Deep enough that nobody runs out mid-draft, short enough to render.
        .slice(0, 200)
    );
  }, [players, drafted, position, search]);

  /** How many are left at each position, for the filter row. */
  const remaining = useMemo(() => {
    const counts = new Map<string, number>();
    for (const player of players) {
      if (drafted.has(player.id)) continue;
      const group = positionGroup(player.positions);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return counts;
  }, [players, drafted]);

  const onTheClock = draft?.currentTeamId ?? null;
  const isMyTurn = myTeamId !== null && onTheClock === myTeamId;

  /**
   * The server clock, as of the last poll.
   *
   * The pick clock is the server's, so whether it has run out is the server's
   * question and must not be asked of the browser's. A machine an hour fast
   * would otherwise read every deadline as passed and disable its own Draft
   * button for the entire draft, auto-picking every round.
   *
   * Falls back to the local clock only if the field is missing, which means an
   * older server — the previous behaviour, no worse.
   */
  const serverNow = data?.now ? new Date(data.now).getTime() : Date.now();

  /**
   * When the pick on the clock expires, in milliseconds.
   *
   * Computed here rather than in the header because two things need it and they
   * must not be able to disagree: the countdown, and whether the Draft button
   * still does anything.
   */
  const deadline =
    draft?.clockStartedAt !== null && draft?.clockStartedAt !== undefined
      ? new Date(draft.clockStartedAt).getTime() + draft.pickSeconds * 1000
      : null;

  /**
   * Whether the countdown has reached zero.
   *
   * A single timer fired *at* the deadline, not a tick — the button only has to
   * change once, and re-rendering the whole board four times a second to find
   * that out would be silly.
   *
   * The server refuses a late pick outright (`CLOCK_EXPIRED`), so without this
   * the button stays live after the clock reads 0:00 and an ordinary manager
   * clicking a moment late gets a 409 instead of a disabled button. This does
   * not decide anything — the server does — it stops the room offering an action
   * it knows will be refused.
   */
  const [clockExpired, setClockExpired] = useState(false);
  useEffect(() => {
    if (deadline === null) {
      setClockExpired(false);
      return;
    }
    // Measured against the *server* clock carried in the payload, not the
    // browser's. Only the elapsed-time half of the local clock is used — for
    // the timeout below — and that stays accurate however wrong the absolute
    // time is. A skewed machine must not be locked out of its own picks.
    const untilDeadline = deadline - serverNow;
    setClockExpired(untilDeadline <= 0);
    if (untilDeadline <= 0) return;

    const timer = setTimeout(() => setClockExpired(true), untilDeadline);
    return () => clearTimeout(timer);
  }, [deadline, serverNow]);

  const post = useCallback(
    async (path: string, body?: unknown, method = "POST"): Promise<void> => {
      setBusy(true);
      setActionError(null);
      try {
        const response = await fetch(`/api/leagues/${leagueId}/draft${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "That did not work");
        await mutate();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [leagueId, mutate],
  );

  const canPick = isMyTurn && draft?.status === "IN_PROGRESS" && !clockExpired;

  const pick = useCallback(
    (playerId: string): void => {
      setOpenPlayerId(null);
      void post("/pick", { playerId });
    },
    [post],
  );

  const toggleQueue = useCallback(
    (playerId: string): void => {
      void post(
        "/queue",
        {
          playerIds: queue.includes(playerId)
            ? queue.filter((id) => id !== playerId)
            : [...queue, playerId],
        },
        "PUT",
      );
    },
    [post, queue],
  );

  const rows = useMemo(
    () =>
      buildBoard({
        order: draft?.order ?? [],
        rounds: draft?.rounds ?? 0,
        picks: draft?.picks ?? [],
        currentPickNumber: draft?.currentPickNumber ?? null,
      }),
    [draft],
  );

  if (error) {
    return <p className="text-sm text-red-400">{error.message}</p>;
  }

  if (!data) {
    return <p className="text-sm text-nocturne-neutral-600">Loading the draft…</p>;
  }

  if (!draft) {
    return (
      <section className="rounded-lg border border-nocturne-neutral-900 p-6">
        <p className="text-sm text-nocturne-neutral-400">
          No draft has been scheduled for {leagueName} yet.
        </p>
      </section>
    );
  }

  const untilMyTurn = picksUntilTurn(rows, myTeamId, draft.currentPickNumber);
  const openPlayer = openPlayerId ? byId.get(openPlayerId) : undefined;

  return (
    <div className="space-y-4">
      <ClockBar
        draft={draft}
        deadline={deadline}
        teams={teams}
        isMyTurn={isMyTurn}
        untilMyTurn={untilMyTurn}
        isCommissioner={data.me.isCommissioner}
        busy={busy}
        onStart={() => void post("/start")}
      />

      {actionError && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {actionError}
        </p>
      )}

      <PickBoard
        rows={rows}
        teams={teams}
        order={draft.order}
        myTeamId={myTeamId}
        byId={byId}
        currentPickNumber={draft.currentPickNumber}
        onOpenPlayer={setOpenPlayerId}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((slot) => (
              <button
                key={slot}
                onClick={() => setPosition(slot)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  position === slot
                    ? "bg-nocturne-accent text-nocturne-bg"
                    : "border border-nocturne-neutral-800 text-nocturne-neutral-400 hover:text-nocturne-text"
                }`}
              >
                {slot}
                {slot !== "ALL" && (
                  <span className="ml-1.5 opacity-60 tabular-nums">
                    {remaining.get(slot) ?? 0}
                  </span>
                )}
              </button>
            ))}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find player"
              className="ml-auto w-44 rounded-full border border-nocturne-neutral-800 bg-nocturne-surface/40 px-3.5 py-1.5 text-sm placeholder:text-nocturne-neutral-600"
            />
          </div>

          <PlayerTable
            players={pool}
            queue={queue}
            canPick={canPick === true}
            busy={busy}
            inLeague={myTeamId !== null}
            onPick={pick}
            onQueue={toggleQueue}
            onOpen={setOpenPlayerId}
          />

          {pool.length === 0 && (
            <p className="text-sm text-nocturne-neutral-600">Nobody left matching that.</p>
          )}
        </section>

        <aside className="min-w-0">
          <div className="flex border-b border-nocturne-neutral-900">
            {(["QUEUE", "ROSTER", "ORDER"] as const).map((name) => (
              <button
                key={name}
                onClick={() => setTab(name)}
                className={`flex-1 px-3 py-2 text-xs font-medium tracking-wide uppercase transition-colors ${
                  tab === name
                    ? "border-b-2 border-nocturne-accent text-nocturne-text"
                    : "text-nocturne-neutral-600 hover:text-nocturne-neutral-400"
                }`}
              >
                {name}
                {name === "QUEUE" && queue.length > 0 && (
                  <span className="ml-1.5 opacity-60 tabular-nums">{queue.length}</span>
                )}
              </button>
            ))}
          </div>

          <div className="pt-4">
            {tab === "QUEUE" && (
              <Queue
                queue={queue}
                byId={byId}
                drafted={drafted}
                busy={busy}
                onOpen={setOpenPlayerId}
                onChange={(ids) => void post("/queue", { playerIds: ids }, "PUT")}
              />
            )}
            {tab === "ROSTER" && (
              <MyRoster
                picks={draft.picks}
                myTeamId={myTeamId}
                byId={byId}
                onOpen={setOpenPlayerId}
              />
            )}
            {tab === "ORDER" && <OrderPanel draft={draft} teams={teams} myTeamId={myTeamId} />}
          </div>

          <RecentPicks picks={draft.picks} teams={teams} byId={byId} onOpen={setOpenPlayerId} />
        </aside>
      </div>

      {openPlayerId && (
        <PlayerCard
          leagueId={leagueId}
          playerId={openPlayerId}
          onClose={() => setOpenPlayerId(null)}
          {...(openPlayer ? { fallbackName: openPlayer.name } : {})}
          {...(openPlayer ? { fallbackPositions: openPlayer.positions } : {})}
          actions={
            <>
              <button
                onClick={() => pick(openPlayerId)}
                disabled={!canPick || busy || drafted.has(openPlayerId)}
                className="rounded bg-nocturne-accent px-4 py-1.5 text-sm font-medium text-nocturne-bg disabled:opacity-30"
              >
                {drafted.has(openPlayerId) ? "Already drafted" : "Draft"}
              </button>
              {myTeamId !== null && !drafted.has(openPlayerId) && (
                <button
                  onClick={() => toggleQueue(openPlayerId)}
                  disabled={busy}
                  className="rounded border border-nocturne-neutral-800 px-4 py-1.5 text-sm text-nocturne-neutral-300 hover:text-nocturne-text disabled:opacity-40"
                >
                  {queue.includes(openPlayerId) ? "Remove from queue" : "Add to queue"}
                </button>
              )}
            </>
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ClockBar({
  draft,
  deadline,
  teams,
  isMyTurn,
  untilMyTurn,
  isCommissioner,
  busy,
  onStart,
}: {
  draft: DraftState;
  /** Milliseconds, or `null` when no clock is running. Owned by `DraftRoom`. */
  deadline: number | null;
  teams: Map<string, Team>;
  isMyTurn: boolean;
  /** Picks until this manager is up, or null. */
  untilMyTurn: number | null;
  isCommissioner: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  // Ticks locally between polls so the countdown is smooth. The server decides
  // expiry; this is only the display.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline]);

  const remaining = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  const team = draft.currentTeamId ? teams.get(draft.currentTeamId) : null;

  if (draft.status === "SCHEDULED" || draft.status === "PAUSED") {
    return (
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-nocturne-neutral-900 bg-nocturne-surface/30 p-6">
        <div className="space-y-1">
          <p className="text-lg font-medium">
            {draft.status === "PAUSED" ? "Draft paused" : "Draft not started"}
          </p>
          <p className="text-sm text-nocturne-neutral-500">
            Scheduled for {new Date(draft.scheduledAt).toLocaleString()} ·{" "}
            {draft.pickSeconds >= 3600
              ? `${Math.round(draft.pickSeconds / 3600)}h`
              : `${draft.pickSeconds}s`}{" "}
            per pick · {draft.rounds} rounds
          </p>
          {!draft.draw && (
            <p className="text-xs text-nocturne-neutral-600">
              The order is drawn from the first Solana block at or after the scheduled time, so
              it cannot be known in advance.
            </p>
          )}
        </div>
        {isCommissioner && (
          <button
            onClick={onStart}
            disabled={busy}
            className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
          >
            {busy ? "Starting…" : draft.draw ? "Resume draft" : "Draw order and start"}
          </button>
        )}
      </section>
    );
  }

  if (draft.complete) {
    return (
      <section className="rounded-lg border border-nocturne-neutral-900 bg-nocturne-surface/30 p-6">
        <p className="text-lg font-medium">Draft complete</p>
        <p className="text-sm text-nocturne-neutral-500">
          {draft.totalPicks} picks over {draft.rounds} rounds. Set your lineup before the first
          kickoff.
        </p>
      </section>
    );
  }

  const urgent = remaining !== null && remaining <= 15;

  return (
    <section
      className={`flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-nocturne-surface/30 p-5 transition-colors ${
        isMyTurn ? "border-nocturne-accent" : "border-nocturne-neutral-900"
      }`}
    >
      <div className="flex items-center gap-4">
        {team && (
          <span
            className={`grid h-11 w-11 place-items-center rounded-full text-sm font-semibold ring-1 ${
              isMyTurn
                ? "bg-nocturne-accent/20 text-nocturne-accent-200 ring-nocturne-accent/40"
                : "bg-nocturne-neutral-900 text-nocturne-neutral-400 ring-nocturne-neutral-800"
            }`}
          >
            {team.name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <div className="space-y-0.5">
          <p className="text-xs tracking-wide text-nocturne-neutral-500 uppercase">
            Round {Math.ceil((draft.currentPickNumber ?? 1) / draft.order.length)} · Pick{" "}
            {draft.currentPickNumber} of {draft.totalPicks}
          </p>
          <p className="text-lg font-medium">
            {isMyTurn ? "You are on the clock" : `${team?.name ?? "…"} is on the clock`}
            {team?.isBot && <span className="ml-2 text-xs text-nocturne-neutral-600">bot</span>}
          </p>
          {remaining === 0 ? (
            // Says what is about to happen rather than leaving a dead button and
            // a 0:00 with no explanation. The pick is the auto-pick's from the
            // deadline onwards, and the server refuses a late manual one.
            <p className="text-xs text-nocturne-neutral-600">
              {isMyTurn ? "Your time is up — " : "Time is up — "}
              the auto-pick takes this one, stamped at the deadline it missed.
            </p>
          ) : (
            untilMyTurn !== null &&
            untilMyTurn > 0 && (
              <p className="text-xs text-nocturne-neutral-600">
                You pick in {untilMyTurn} {untilMyTurn === 1 ? "pick" : "picks"}.
              </p>
            )
          )}
        </div>
      </div>

      {remaining !== null && (
        <div
          className={`text-4xl font-semibold tabular-nums transition-colors ${
            urgent ? "text-red-400" : ""
          }`}
        >
          {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
        </div>
      )}
    </section>
  );
}

/**
 * The grid: a column per seat, a row per round.
 *
 * Scrolls in both directions with the team header pinned, because twelve teams
 * do not fit on a laptop and fifteen rounds do not fit on a screen. The row for
 * the pick on the clock is scrolled to on mount and whenever the round turns
 * over — a board sitting on round one while round nine is being drafted is the
 * commonest way this screen goes useless.
 */
function PickBoard({
  rows,
  teams,
  order,
  myTeamId,
  byId,
  currentPickNumber,
  onOpenPlayer,
}: {
  rows: readonly BoardRow[];
  teams: Map<string, Team>;
  order: readonly string[];
  myTeamId: string | null;
  byId: Map<string, Player>;
  currentPickNumber: number | null;
  onOpenPlayer: (playerId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const round = focusRound(rows, currentPickNumber);

  useEffect(() => {
    const node = scroller.current?.querySelector<HTMLElement>(`[data-round="${round}"]`);
    // `nearest` rather than `center`: the board is one panel among several, and
    // pulling the page around it every time a round turns over would yank the
    // player list out from under whoever was reading it.
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [round]);

  if (rows.length === 0) {
    return (
      <section className="rounded-lg border border-nocturne-neutral-900 p-6 text-sm text-nocturne-neutral-500">
        The board appears once the order is drawn.
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-nocturne-neutral-900">
      <div ref={scroller} className="max-h-[22rem] overflow-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 w-10 border-b border-nocturne-neutral-900 bg-nocturne-bg px-2 py-2 text-[10px] font-medium text-nocturne-neutral-600">
                RD
              </th>
              {order.map((teamId) => {
                const team = teams.get(teamId);
                const mine = teamId === myTeamId;
                return (
                  <th
                    key={teamId}
                    className={`min-w-[7.5rem] border-b border-nocturne-neutral-900 bg-nocturne-bg px-2 py-2 text-left ${
                      mine ? "text-nocturne-accent-300" : "text-nocturne-neutral-400"
                    }`}
                  >
                    <span className="block truncate text-xs font-medium">
                      {team?.name ?? "—"}
                    </span>
                    <span className="block text-[10px] font-normal text-nocturne-neutral-600">
                      {mine ? "you" : team?.isBot ? "bot" : " "}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={row.round} data-round={row.round}>
                <td className="sticky left-0 z-10 bg-nocturne-bg px-2 py-1 text-center align-middle">
                  <span className="block text-xs font-medium text-nocturne-neutral-500 tabular-nums">
                    {row.round}
                  </span>
                  {/* The reversal is the one thing people get wrong when
                      planning two picks ahead, so it is drawn rather than
                      implied by the numbers. */}
                  <span className="block text-[10px] text-nocturne-neutral-700">
                    {row.direction === "FORWARD" ? "→" : "←"}
                  </span>
                </td>

                {row.cells.map((cell) => (
                  <td key={cell.pickNumber} className="p-0.5 align-top">
                    <BoardSquare
                      cell={cell}
                      player={cell.playerId ? byId.get(cell.playerId) : undefined}
                      mine={cell.teamId === myTeamId}
                      onOpen={onOpenPlayer}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BoardSquare({
  cell,
  player,
  mine,
  onOpen,
}: {
  cell: BoardCell;
  player: Player | undefined;
  mine: boolean;
  onOpen: (playerId: string) => void;
}) {
  if (cell.state === "ON_CLOCK") {
    return (
      <div className="flex h-14 flex-col justify-center rounded bg-nocturne-accent/20 px-2 ring-1 ring-nocturne-accent">
        <span className="text-[10px] text-nocturne-accent-200 tabular-nums">{cell.label}</span>
        <span className="text-xs font-medium text-nocturne-accent-200">On the clock</span>
      </div>
    );
  }

  if (cell.playerId === null) {
    return (
      <div
        className={`flex h-14 flex-col justify-center rounded px-2 ${
          mine
            ? "bg-nocturne-neutral-900/60 ring-1 ring-nocturne-neutral-800"
            : "bg-nocturne-surface/20"
        }`}
      >
        <span className="text-[10px] text-nocturne-neutral-700 tabular-nums">{cell.label}</span>
      </div>
    );
  }

  const group = player ? positionGroup(player.positions) : "—";

  return (
    <button
      onClick={() => onOpen(cell.playerId!)}
      className={`flex h-14 w-full flex-col justify-center rounded px-2 text-left ring-1 transition-opacity hover:opacity-80 ${positionColour(group)}`}
      title={player?.name ?? cell.playerId}
    >
      <span className="flex items-baseline justify-between gap-1">
        <span className="truncate text-xs font-medium">
          {player ? shortName(player.name) : "—"}
        </span>
        <span className="shrink-0 text-[10px] opacity-70 tabular-nums">{cell.label}</span>
      </span>
      <span className="truncate text-[10px] opacity-80">
        {group}
        {player?.teamRef ? ` · ${player.teamRef}` : ""}
        {/* An auto-pick is marked, because "the bot outdrafted me while I was
            asleep" is a thing people say and the record should be plain. */}
        {cell.source && cell.source !== "MANUAL" ? " · auto" : ""}
      </span>
    </button>
  );
}

function PlayerTable({
  players,
  queue,
  canPick,
  busy,
  inLeague,
  onPick,
  onQueue,
  onOpen,
}: {
  players: Player[];
  queue: string[];
  canPick: boolean;
  busy: boolean;
  inLeague: boolean;
  onPick: (playerId: string) => void;
  onQueue: (playerId: string) => void;
  onOpen: (playerId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-nocturne-neutral-900">
      <div className="grid grid-cols-[2.5rem_1fr_3rem_3rem_4rem_auto] items-center gap-2 border-b border-nocturne-neutral-900 px-3 py-2 text-[10px] font-medium tracking-wide text-nocturne-neutral-600 uppercase">
        <span>Rk</span>
        <span>Player</span>
        <span className="text-right">Bye</span>
        <span className="text-right">ADP</span>
        <span className="text-right">Proj</span>
        <span />
      </div>

      <ul className="divide-y divide-nocturne-neutral-900">
        {players.map((player) => {
          const group = positionGroup(player.positions);
          const badge = injuryBadge(player.injuryDesignation);

          return (
            <li
              key={player.id}
              className="grid grid-cols-[2.5rem_1fr_3rem_3rem_4rem_auto] items-center gap-2 px-3 py-2 hover:bg-nocturne-surface/30"
            >
              <span className="text-xs text-nocturne-neutral-600 tabular-nums">
                {player.rank}
              </span>

              {/* The whole cell opens the card, not a separate "info" affordance
                  — a name is the thing people expect to click. */}
              <button
                onClick={() => onOpen(player.id)}
                className="flex min-w-0 items-center gap-2.5 text-left"
              >
                <PlayerAvatar
                  name={player.name}
                  positions={player.positions}
                  imageUrl={player.imageUrl}
                  size={32}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{player.name}</span>
                    {badge && (
                      <span
                        className={`text-[10px] font-semibold ${injuryTone(player.injuryDesignation)}`}
                      >
                        {badge}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-nocturne-neutral-600">
                    <span
                      className={`rounded px-1 py-px font-medium ring-1 ${positionColour(group)}`}
                    >
                      {group}
                    </span>
                    {player.teamRef ?? "FA"}
                  </span>
                </span>
              </button>

              <span className="text-right text-xs text-nocturne-neutral-600 tabular-nums">
                {player.byeWeek ?? "—"}
              </span>
              <span className="text-right text-xs text-nocturne-neutral-600 tabular-nums">
                {player.rank}
              </span>
              <span
                className="text-right text-sm font-medium tabular-nums"
                title={
                  player.projectedMilliPoints === null
                    ? "No projection published for this player"
                    : "Projected season points, scored with this league's rules"
                }
              >
                {points(player.projectedMilliPoints)}
              </span>

              <span className="flex items-center gap-1.5">
                {inLeague && (
                  <button
                    onClick={() => onQueue(player.id)}
                    disabled={busy}
                    className={`rounded border px-2 py-1 text-xs disabled:opacity-40 ${
                      queue.includes(player.id)
                        ? "border-nocturne-accent/40 text-nocturne-accent-300"
                        : "border-nocturne-neutral-800 text-nocturne-neutral-500 hover:text-nocturne-text"
                    }`}
                    title="Add to or remove from your queue"
                  >
                    {queue.includes(player.id) ? "Queued" : "Queue"}
                  </button>
                )}
                <button
                  onClick={() => onPick(player.id)}
                  disabled={!canPick || busy}
                  className="rounded bg-nocturne-accent px-3 py-1 text-xs font-medium text-nocturne-bg disabled:opacity-25"
                >
                  Draft
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Queue({
  queue,
  byId,
  drafted,
  busy,
  onChange,
  onOpen,
}: {
  queue: string[];
  byId: Map<string, Player>;
  drafted: Set<string>;
  busy: boolean;
  onChange: (ids: string[]) => void;
  onOpen: (playerId: string) => void;
}) {
  const move = (index: number, delta: number): void => {
    const next = [...queue];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  if (queue.length === 0) {
    return (
      <p className="text-xs text-nocturne-neutral-600">
        Empty. If your clock expires, the auto-pick takes the best available player who fits
        your roster instead.
      </p>
    );
  }

  return (
    <ol className="space-y-1">
      {queue.map((playerId, index) => {
        const player = byId.get(playerId);
        const gone = drafted.has(playerId);
        return (
          <li
            key={playerId}
            className={`flex items-center gap-2 rounded border border-nocturne-neutral-900 px-2 py-1.5 ${
              gone ? "opacity-40" : ""
            }`}
          >
            <span className="w-4 text-xs text-nocturne-neutral-600 tabular-nums">
              {index + 1}
            </span>
            <button
              onClick={() => onOpen(playerId)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <PlayerAvatar
                name={player?.name ?? "?"}
                positions={player?.positions ?? []}
                imageUrl={player?.imageUrl ?? null}
                size={24}
              />
              <span className="min-w-0 flex-1 truncate text-xs">
                {player?.name ?? playerId}
                {gone && <span className="ml-1 text-nocturne-neutral-600">— taken</span>}
              </span>
            </button>
            <button
              onClick={() => move(index, -1)}
              disabled={busy || index === 0}
              className="px-1 text-nocturne-neutral-600 hover:text-nocturne-text disabled:opacity-20"
              aria-label="Move up"
            >
              ↑
            </button>
            <button
              onClick={() => move(index, 1)}
              disabled={busy || index === queue.length - 1}
              className="px-1 text-nocturne-neutral-600 hover:text-nocturne-text disabled:opacity-20"
              aria-label="Move down"
            >
              ↓
            </button>
            <button
              onClick={() => onChange(queue.filter((id) => id !== playerId))}
              disabled={busy}
              className="px-1 text-nocturne-neutral-600 hover:text-nocturne-text disabled:opacity-20"
              aria-label="Remove"
            >
              ×
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function MyRoster({
  picks,
  myTeamId,
  byId,
  onOpen,
}: {
  picks: Pick[];
  myTeamId: string | null;
  byId: Map<string, Player>;
  onOpen: (playerId: string) => void;
}) {
  if (!myTeamId) {
    return <p className="text-xs text-nocturne-neutral-600">You are watching, not drafting.</p>;
  }

  const mine = picks.filter((pick) => pick.teamId === myTeamId);

  if (mine.length === 0) {
    return <p className="text-xs text-nocturne-neutral-600">Nothing yet.</p>;
  }

  return (
    <ul className="space-y-1">
      {mine.map((pick) => {
        const player = byId.get(pick.playerId);
        return (
          <li key={pick.pickNumber}>
            <button
              onClick={() => onOpen(pick.playerId)}
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-nocturne-surface/40"
            >
              <PlayerAvatar
                name={player?.name ?? "?"}
                positions={player?.positions ?? []}
                imageUrl={player?.imageUrl ?? null}
                size={28}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{player?.name ?? pick.playerId}</span>
                <span className="block text-[10px] text-nocturne-neutral-600">
                  {player ? positionGroup(player.positions) : "—"}
                  {player?.teamRef ? ` · ${player.teamRef}` : ""}
                </span>
              </span>
              <span className="text-[10px] text-nocturne-neutral-600">R{pick.round}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RecentPicks({
  picks,
  teams,
  byId,
  onOpen,
}: {
  picks: Pick[];
  teams: Map<string, Team>;
  byId: Map<string, Player>;
  onOpen: (playerId: string) => void;
}) {
  const recent = [...picks].reverse().slice(0, 8);
  if (recent.length === 0) return null;

  return (
    <section className="mt-6 space-y-2 border-t border-nocturne-neutral-900 pt-4">
      <h2 className="text-xs font-medium tracking-wide text-nocturne-neutral-500 uppercase">
        Recent picks
      </h2>
      <ul className="space-y-1 text-xs">
        {recent.map((pick) => (
          <li key={pick.pickNumber} className="flex items-center gap-2">
            <span className="w-8 text-nocturne-neutral-600 tabular-nums">
              {pick.pickNumber}
            </span>
            <button
              onClick={() => onOpen(pick.playerId)}
              className="min-w-0 flex-1 truncate text-left hover:text-nocturne-accent-300"
            >
              {byId.get(pick.playerId)?.name ?? pick.playerId}
            </button>
            <span className="max-w-[8ch] truncate text-nocturne-neutral-600">
              {teams.get(pick.teamId)?.name ?? "—"}
            </span>
            {pick.source !== "MANUAL" && (
              <span className="text-nocturne-text/25" title={`Auto-picked: ${pick.source}`}>
                auto
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OrderPanel({
  draft,
  teams,
  myTeamId,
}: {
  draft: DraftState;
  teams: Map<string, Team>;
  myTeamId: string | null;
}) {
  if (draft.order.length === 0) {
    return (
      <p className="text-xs text-nocturne-neutral-600">The order has not been drawn yet.</p>
    );
  }

  return (
    <section className="space-y-2">
      <ol className="space-y-1 text-xs">
        {draft.order.map((teamId, index) => (
          <li
            key={teamId}
            className={`flex gap-2 ${teamId === myTeamId ? "text-nocturne-accent-300" : ""}`}
          >
            <span className="w-4 text-nocturne-neutral-600 tabular-nums">{index + 1}</span>
            <span className="flex-1 truncate">{teams.get(teamId)?.name ?? teamId}</span>
            {teams.get(teamId)?.isBot && <span className="text-nocturne-text/25">bot</span>}
          </li>
        ))}
      </ol>

      {draft.draw && (
        <details className="pt-2 text-xs text-nocturne-neutral-600">
          <summary className="cursor-pointer hover:text-nocturne-neutral-400">
            How this order was decided
          </summary>
          <div className="space-y-2 pt-2">
            <p>
              Drawn from Solana slot{" "}
              <span className="font-mono text-nocturne-neutral-400">{draft.draw.slot}</span>,
              the first block produced at or after the scheduled draft time. Nobody could know
              it while teams were still joining.
            </p>
            <p className="font-mono break-all text-nocturne-neutral-500">
              {draft.draw.blockhash}
            </p>
            <p>
              Check it: look up that slot on any explorer, confirm its time is at or after the
              draft time and the block before it is earlier, then recompute
              <span className="font-mono"> sha256(rostr:draft-order:v1:…)</span>.
            </p>
            <p className="font-mono break-all text-nocturne-neutral-500">{draft.draw.seed}</p>
          </div>
        </details>
      )}
    </section>
  );
}
