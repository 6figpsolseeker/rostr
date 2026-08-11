"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";

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
 */

interface Player {
  id: string;
  name: string;
  positions: string[];
  rank: number;
  /** Milli-points, scored with this league's rules. Null when unprojected. */
  projectedMilliPoints: number | null;
}

/** Display order for the position groups. Matches the roster, top to bottom. */
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

const points = (milli: number | null): string =>
  milli === null ? "—" : (milli / 1000).toFixed(1);

/**
 * A player's group.
 *
 * Multi-position players are filed under the first position the roster cares
 * about, so a receiver who also returns kicks does not appear twice.
 */
function groupOf(player: Player): string {
  for (const position of POSITION_ORDER) {
    if (player.positions.includes(position)) return position;
  }
  return player.positions[0] ?? "—";
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

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"] as const;

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

  const [position, setPosition] = useState<(typeof POSITIONS)[number]>("ALL");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const draft = data?.draft ?? null;
  const teams = useMemo(() => new Map((data?.teams ?? []).map((t) => [t.id, t])), [data]);
  const myTeamId = data?.me.teamId ?? null;
  const queue = data?.me.queue ?? [];

  const drafted = useMemo(
    () => new Set((draft?.picks ?? []).map((pick) => pick.playerId)),
    [draft],
  );

  const players = boardData?.players ?? [];
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  /**
   * Available players, grouped by position and ranked within each group.
   *
   * Grouping is the point: comparing a quarterback's 340 projected points
   * against a kicker's 130 says nothing useful, because you need one of each.
   * What matters is who is the best one left *at a position*.
   */
  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = players
      .filter((player) => !drafted.has(player.id))
      .filter((player) => term === "" || player.name.toLowerCase().includes(term));

    const wanted = position === "ALL" ? POSITION_ORDER : [position];

    return wanted
      .map((slot) => ({
        position: slot,
        players: matching
          .filter((player) => groupOf(player) === slot)
          .sort(byProjection)
          // Deep enough that nobody runs out mid-draft, short enough to render.
          .slice(0, position === "ALL" ? 25 : 150),
      }))
      .filter((group) => group.players.length > 0);
  }, [players, drafted, position, search]);

  const onTheClock = draft?.currentTeamId ?? null;
  const isMyTurn = myTeamId !== null && onTheClock === myTeamId;

  /**
   * When the pick on the clock expires, in milliseconds.
   *
   * Computed here rather than in `ClockBar` because two things need it and they
   * must not be able to disagree: the countdown, and whether the Draft button
   * still does anything.
   */
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

  if (error) {
    return <p className="text-sm text-red-400">{error.message}</p>;
  }

  if (!data) {
    return <p className="text-sm text-white/40">Loading the draft…</p>;
  }

  if (!draft) {
    return (
      <section className="rounded border border-white/10 p-6">
        <p className="text-sm text-white/60">
          No draft has been scheduled for {leagueName} yet.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <ClockBar
        draft={draft}
        deadline={deadline}
        teams={teams}
        isMyTurn={isMyTurn}
        isCommissioner={data.me.isCommissioner}
        busy={busy}
        onStart={() => void post("/start")}
      />

      {actionError && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {actionError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {POSITIONS.map((slot) => (
              <button
                key={slot}
                onClick={() => setPosition(slot)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${
                  position === slot
                    ? "bg-[--color-turf] text-black"
                    : "border border-white/15 text-white/70 hover:text-white"
                }`}
              >
                {slot}
              </button>
            ))}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search players"
              className="ml-auto w-44 rounded border border-white/15 bg-transparent px-3 py-1 text-sm"
            />
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-white/40">Nobody left matching that.</p>
          ) : (
            groups.map((group) => (
              <section key={group.position} className="space-y-1.5">
                <h2 className="flex items-baseline gap-2 text-xs font-medium tracking-wide text-white/50 uppercase">
                  {group.position}
                  <span className="text-[10px] normal-case">
                    {group.players.length} available · projected season points
                  </span>
                </h2>
                <PlayerList
                  players={group.players}
                  queue={queue}
                  canPick={isMyTurn && draft.status === "IN_PROGRESS" && !clockExpired}
                  busy={busy}
                  onPick={(playerId) => void post("/pick", { playerId })}
                  onQueue={(playerId) =>
                    void post(
                      "/queue",
                      {
                        playerIds: queue.includes(playerId)
                          ? queue.filter((q) => q !== playerId)
                          : [...queue, playerId],
                      },
                      "PUT",
                    )
                  }
                  inLeague={myTeamId !== null}
                />
              </section>
            ))
          )}

          {position === "ALL" && (
            <p className="text-xs text-white/30">
              Showing the top 25 at each position. Pick a position above for the full list.
            </p>
          )}
        </section>

        <aside className="space-y-6">
          <Queue
            queue={queue}
            byId={byId}
            drafted={drafted}
            busy={busy}
            onChange={(ids) => void post("/queue", { playerIds: ids }, "PUT")}
          />
          <MyRoster picks={draft.picks} myTeamId={myTeamId} byId={byId} />
          <RecentPicks picks={draft.picks} teams={teams} byId={byId} />
          <OrderPanel draft={draft} teams={teams} myTeamId={myTeamId} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ClockBar({
  draft,
  deadline,
  teams,
  isMyTurn,
  isCommissioner,
  busy,
  onStart,
}: {
  draft: DraftState;
  /** Milliseconds, or `null` when no clock is running. Owned by `DraftRoom`. */
  deadline: number | null;
  teams: Map<string, Team>;
  isMyTurn: boolean;
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
      <section className="flex flex-wrap items-center justify-between gap-4 rounded border border-white/10 p-6">
        <div className="space-y-1">
          <p className="text-lg font-medium">
            {draft.status === "PAUSED" ? "Draft paused" : "Draft not started"}
          </p>
          <p className="text-sm text-white/50">
            Scheduled for {new Date(draft.scheduledAt).toLocaleString()} ·{" "}
            {draft.pickSeconds >= 3600
              ? `${Math.round(draft.pickSeconds / 3600)}h`
              : `${draft.pickSeconds}s`}{" "}
            per pick
          </p>
          {!draft.draw && (
            <p className="text-xs text-white/40">
              The order is drawn from the first Solana block at or after the scheduled time, so
              it cannot be known in advance.
            </p>
          )}
        </div>
        {isCommissioner && (
          <button
            onClick={onStart}
            disabled={busy}
            className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
          >
            {busy ? "Starting…" : draft.draw ? "Resume draft" : "Draw order and start"}
          </button>
        )}
      </section>
    );
  }

  if (draft.complete) {
    return (
      <section className="rounded border border-white/10 p-6">
        <p className="text-lg font-medium">Draft complete</p>
        <p className="text-sm text-white/50">
          {draft.totalPicks} picks over {draft.rounds} rounds.
        </p>
      </section>
    );
  }

  const urgent = remaining !== null && remaining <= 15;

  return (
    <section
      className={`flex flex-wrap items-center justify-between gap-4 rounded border p-6 ${
        isMyTurn ? "border-[--color-turf] bg-[--color-turf]/5" : "border-white/10"
      }`}
    >
      <div className="space-y-1">
        <p className="text-sm text-white/50">
          Round {Math.ceil((draft.currentPickNumber ?? 1) / draft.order.length)} · Pick{" "}
          {draft.currentPickNumber} of {draft.totalPicks}
        </p>
        <p className="text-lg font-medium">
          {isMyTurn ? "You are on the clock" : `${team?.name ?? "…"} is on the clock`}
          {team?.isBot && <span className="ml-2 text-xs text-white/40">bot</span>}
        </p>
        {remaining === 0 && (
          // Says what is about to happen rather than leaving a dead button and a
          // 0:00 with no explanation. The pick is the auto-pick's from the
          // deadline onwards, and the server refuses a late manual one.
          <p className="text-xs text-white/40">
            {isMyTurn ? "Your time is up — " : "Time is up — "}
            the auto-pick takes this one, stamped at the deadline it missed.
          </p>
        )}
      </div>

      {remaining !== null && (
        <div className={`text-3xl font-semibold tabular-nums ${urgent ? "text-red-400" : ""}`}>
          {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
        </div>
      )}
    </section>
  );
}

function PlayerList({
  players,
  queue,
  canPick,
  busy,
  onPick,
  onQueue,
  inLeague,
}: {
  players: Player[];
  queue: string[];
  canPick: boolean;
  busy: boolean;
  onPick: (playerId: string) => void;
  onQueue: (playerId: string) => void;
  inLeague: boolean;
}) {
  return (
    <ul className="divide-y divide-white/5 rounded border border-white/10">
      {players.map((player) => (
        <li key={player.id} className="flex items-center gap-3 px-4 py-2.5">
          <span
            className="w-14 text-right text-sm font-medium tabular-nums"
            title={
              player.projectedMilliPoints === null
                ? "No projection published for this player"
                : "Projected season points, scored with this league's rules"
            }
          >
            {points(player.projectedMilliPoints)}
          </span>
          <span className="flex-1 truncate text-sm">{player.name}</span>
          <span
            className="w-10 text-xs text-white/30 tabular-nums"
            title="Average draft position"
          >
            {player.rank}
          </span>

          {inLeague && (
            <button
              onClick={() => onQueue(player.id)}
              disabled={busy}
              className="rounded border border-white/15 px-2 py-1 text-xs text-white/60 hover:text-white disabled:opacity-40"
              title="Add to or remove from your queue"
            >
              {queue.includes(player.id) ? "Queued" : "Queue"}
            </button>
          )}

          <button
            onClick={() => onPick(player.id)}
            disabled={!canPick || busy}
            className="rounded bg-[--color-turf] px-3 py-1 text-xs font-medium text-black disabled:opacity-30"
          >
            Draft
          </button>
        </li>
      ))}
    </ul>
  );
}

function Queue({
  queue,
  byId,
  drafted,
  busy,
  onChange,
}: {
  queue: string[];
  byId: Map<string, Player>;
  drafted: Set<string>;
  busy: boolean;
  onChange: (ids: string[]) => void;
}) {
  const move = (index: number, delta: number): void => {
    const next = [...queue];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-white/70">
        Your queue
        <span className="ml-2 text-xs font-normal text-white/30">
          used if your clock runs out
        </span>
      </h2>

      {queue.length === 0 ? (
        <p className="text-xs text-white/40">
          Empty. If your clock expires, the auto-pick takes the best available player who fits
          your roster instead.
        </p>
      ) : (
        <ol className="space-y-1">
          {queue.map((playerId, index) => {
            const player = byId.get(playerId);
            const gone = drafted.has(playerId);
            return (
              <li
                key={playerId}
                className={`flex items-center gap-2 rounded border border-white/10 px-2 py-1.5 text-xs ${
                  gone ? "opacity-40" : ""
                }`}
              >
                <span className="w-4 text-white/30">{index + 1}</span>
                <span className="flex-1 truncate">
                  {player?.name ?? playerId}
                  {gone && <span className="ml-1 text-white/40">— taken</span>}
                </span>
                <button
                  onClick={() => move(index, -1)}
                  disabled={busy || index === 0}
                  className="px-1 text-white/40 hover:text-white disabled:opacity-20"
                >
                  ↑
                </button>
                <button
                  onClick={() => move(index, 1)}
                  disabled={busy || index === queue.length - 1}
                  className="px-1 text-white/40 hover:text-white disabled:opacity-20"
                >
                  ↓
                </button>
                <button
                  onClick={() => onChange(queue.filter((id) => id !== playerId))}
                  disabled={busy}
                  className="px-1 text-white/40 hover:text-white disabled:opacity-20"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function MyRoster({
  picks,
  myTeamId,
  byId,
}: {
  picks: Pick[];
  myTeamId: string | null;
  byId: Map<string, Player>;
}) {
  if (!myTeamId) return null;

  const mine = picks.filter((pick) => pick.teamId === myTeamId);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-white/70">
        Your roster <span className="text-xs font-normal text-white/30">{mine.length}</span>
      </h2>
      {mine.length === 0 ? (
        <p className="text-xs text-white/40">Nothing yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {mine.map((pick) => {
            const player = byId.get(pick.playerId);
            return (
              <li key={pick.pickNumber} className="flex gap-2">
                <span className="w-10 text-white/30">{player?.positions[0] ?? "—"}</span>
                <span className="flex-1 truncate">{player?.name ?? pick.playerId}</span>
                <span className="text-white/30">R{pick.round}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RecentPicks({
  picks,
  teams,
  byId,
}: {
  picks: Pick[];
  teams: Map<string, Team>;
  byId: Map<string, Player>;
}) {
  const recent = [...picks].reverse().slice(0, 10);
  if (recent.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-white/70">Recent picks</h2>
      <ul className="space-y-1 text-xs">
        {recent.map((pick) => (
          <li key={pick.pickNumber} className="flex gap-2">
            <span className="w-8 text-white/30 tabular-nums">{pick.pickNumber}</span>
            <span className="flex-1 truncate">
              {byId.get(pick.playerId)?.name ?? pick.playerId}
            </span>
            <span className="max-w-[8ch] truncate text-white/40">
              {teams.get(pick.teamId)?.name ?? "—"}
            </span>
            {pick.source !== "MANUAL" && (
              <span className="text-white/25" title={`Auto-picked: ${pick.source}`}>
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
  if (draft.order.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-white/70">Draft order</h2>
      <ol className="space-y-1 text-xs">
        {draft.order.map((teamId, index) => (
          <li
            key={teamId}
            className={`flex gap-2 ${teamId === myTeamId ? "text-[--color-turf]" : ""}`}
          >
            <span className="w-4 text-white/30">{index + 1}</span>
            <span className="flex-1 truncate">{teams.get(teamId)?.name ?? teamId}</span>
            {teams.get(teamId)?.isBot && <span className="text-white/25">bot</span>}
          </li>
        ))}
      </ol>

      {draft.draw && (
        <details className="pt-2 text-xs text-white/40">
          <summary className="cursor-pointer hover:text-white/70">
            How this order was decided
          </summary>
          <div className="space-y-2 pt-2">
            <p>
              Drawn from Solana slot{" "}
              <span className="font-mono text-white/60">{draft.draw.slot}</span>, the first
              block produced at or after the scheduled draft time. Nobody could know it while
              teams were still joining.
            </p>
            <p className="font-mono break-all text-white/50">{draft.draw.blockhash}</p>
            <p>
              Check it: look up that slot on any explorer, confirm its time is at or after the
              draft time and the block before it is earlier, then recompute
              <span className="font-mono"> sha256(rostr:draft-order:v1:…)</span>.
            </p>
            <p className="font-mono break-all text-white/50">{draft.draw.seed}</p>
          </div>
        </details>
      )}
    </section>
  );
}
