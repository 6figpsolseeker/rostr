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
  complete: boolean;
}

interface DraftResponse {
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
    { refreshInterval: 3000, revalidateOnFocus: true },
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

  const available = useMemo(() => {
    const term = search.trim().toLowerCase();
    return players
      .filter((player) => !drafted.has(player.id))
      .filter((player) => position === "ALL" || player.positions.includes(position))
      .filter((player) => term === "" || player.name.toLowerCase().includes(term))
      .slice(0, 200);
  }, [players, drafted, position, search]);

  const onTheClock = draft?.currentTeamId ?? null;
  const isMyTurn = myTeamId !== null && onTheClock === myTeamId;

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

          <PlayerList
            players={available}
            queue={queue}
            canPick={isMyTurn && draft.status === "IN_PROGRESS"}
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
  teams,
  isMyTurn,
  isCommissioner,
  busy,
  onStart,
}: {
  draft: DraftState;
  teams: Map<string, Team>;
  isMyTurn: boolean;
  isCommissioner: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  const deadline = draft.clockStartedAt
    ? new Date(draft.clockStartedAt).getTime() + draft.pickSeconds * 1000
    : null;

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
  if (players.length === 0) {
    return <p className="text-sm text-white/40">Nobody left matching that.</p>;
  }

  return (
    <ul className="divide-y divide-white/5 rounded border border-white/10">
      {players.map((player) => (
        <li key={player.id} className="flex items-center gap-3 px-4 py-2.5">
          <span className="w-10 text-xs text-white/30 tabular-nums">{player.rank}</span>
          <span className="flex-1 truncate text-sm">{player.name}</span>
          <span className="w-12 text-xs text-white/40">{player.positions.join("/")}</span>

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
