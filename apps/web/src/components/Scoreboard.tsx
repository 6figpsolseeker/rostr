"use client";

import { useState } from "react";
import useSWR from "swr";

/**
 * The Sunday screen: who you are playing, and where it stands.
 *
 * **Your matchup renders in full and first**, with every starter on both sides.
 * The rest of the league is a compact list underneath, because the question this
 * screen answers is "am I winning" and everything else is context.
 *
 * **"Still to play" is given as much weight as the score**, and that is the one
 * design decision here worth defending. Being up twenty with three players left
 * is a completely different position from being up twenty with none, and a
 * scoreboard that shows only totals hides the difference — which is exactly when
 * a manager makes a bad waiver decision on Sunday night.
 *
 * The polling interval drops while games are running, for the same reason the
 * draft room's does: a number that is stale for thirty seconds during a game is
 * a number nobody trusts.
 */

interface PlayerLine {
  playerId: string;
  name: string;
  position: string;
  slot: string;
  milliPoints: number;
  gameState: "BYE" | "UNSCHEDULED" | "YET_TO_PLAY" | "IN_PROGRESS" | "FINAL";
  kickoffAt: string | null;
}

interface Side {
  teamId: string;
  name: string;
  isBot: boolean;
  milliPoints: number;
  restatedMilliPoints: number | null;
  yetToPlay: number;
  inProgress: number;
  /** Starters whose fixture has no kickoff time yet. Never "all done". */
  unscheduled: number;
  starters: PlayerLine[];
  bench: PlayerLine[];
}

interface Matchup {
  week: number;
  phase: "REGULAR" | "PLAYOFF" | "CONSOLATION";
  finalized: boolean;
  home: Side;
  away: Side | null;
}

interface ScoreboardResponse {
  week: number;
  myTeamId: string | null;
  regularSeasonWeeks: number;
  matchups: Matchup[];
}

const fetcher = async (url: string): Promise<ScoreboardResponse> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<ScoreboardResponse>;
};

const points = (milli: number): string => (milli / 1000).toFixed(1);

function kickoffLabel(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function Scoreboard({ leagueId }: { leagueId: string }) {
  const [week, setWeek] = useState<number | null>(null);

  const { data, error } = useSWR<ScoreboardResponse>(
    `/api/leagues/${leagueId}/matchup${week === null ? "" : `?week=${week}`}`,
    fetcher,
    {
      // Faster while anything is running. A ten-minute cron writes the stored
      // result, but this screen scores live on every read, so polling is the
      // only thing between a touchdown and the number moving.
      refreshInterval: (latest) =>
        (latest?.matchups ?? []).some(
          (m) => m.home.inProgress > 0 || (m.away?.inProgress ?? 0) > 0,
        )
          ? 30_000
          : 120_000,
    },
  );

  if (error) return <p className="text-sm text-red-400">{error.message}</p>;
  if (!data) return <p className="text-sm text-nocturne-neutral-600">Loading scores…</p>;

  const mine = data.matchups.find(
    (m) => m.home.teamId === data.myTeamId || m.away?.teamId === data.myTeamId,
  );
  const others = data.matchups.filter((m) => m !== mine);

  const weeks = Array.from({ length: data.regularSeasonWeeks }, (_, i) => i + 1);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-1">
        {weeks.map((n) => (
          <button
            key={n}
            onClick={() => setWeek(n)}
            className={`rounded px-2 py-1 text-xs ${
              data.week === n
                ? "border border-nocturne-accent text-nocturne-accent-200"
                : "border border-nocturne-neutral-900 text-nocturne-neutral-500 hover:text-nocturne-text"
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      {data.matchups.length === 0 && (
        <p className="text-sm text-nocturne-neutral-600">
          No fixtures for week {data.week}. The schedule is drawn when the draft finishes.
        </p>
      )}

      {mine && <FullMatchup matchup={mine} myTeamId={data.myTeamId} />}

      {others.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-nocturne-neutral-400">
            {mine ? "Around the league" : "This week"}
          </h2>
          <ul className="space-y-2">
            {others.map((matchup) => (
              <li key={matchup.home.teamId}>
                <CompactMatchup matchup={matchup} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * How much of this side's week is still to come.
 *
 * "All done" is the claim worth being careful with: it is what tells a manager
 * the result is settled, and a starter whose fixture has no kickoff time yet has
 * not played and is not counted anywhere else on this line. Saying "all done"
 * over an undated fixture would report a loss that has not happened.
 */
function progressLabel(side: Side): string {
  const parts: string[] = [];
  if (side.yetToPlay > 0) parts.push(`${side.yetToPlay} still to play`);
  if (side.inProgress > 0) parts.push(`${side.inProgress} playing`);
  if (side.unscheduled > 0) {
    parts.push(`${side.unscheduled} not scheduled yet`);
  }
  return parts.length > 0 ? parts.join(" · ") : "all done";
}

function Header({ side, opponent }: { side: Side; opponent: Side | null }) {
  const winning = opponent !== null && side.milliPoints > opponent.milliPoints;

  return (
    <div className="space-y-0.5">
      <p className="truncate text-sm text-nocturne-neutral-400">{side.name}</p>
      <p className={`text-3xl font-semibold ${winning ? "text-nocturne-accent-300" : ""}`}>
        {points(side.milliPoints)}
      </p>
      <p className="text-xs text-nocturne-neutral-600">{progressLabel(side)}</p>
    </div>
  );
}

function FullMatchup({ matchup, myTeamId }: { matchup: Matchup; myTeamId: string | null }) {
  const [showBench, setShowBench] = useState(false);

  // Yours on the left, whichever side of the fixture you are on. The screen is
  // read from your point of view; making you hunt for your own team on the
  // right half is a small thing that is wrong every single week.
  const [left, right] =
    matchup.away && matchup.away.teamId === myTeamId
      ? [matchup.away, matchup.home]
      : [matchup.home, matchup.away];

  return (
    <section className="space-y-4 rounded border border-nocturne-neutral-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <Header side={left} opponent={right} />
        <div className="pt-6 text-xs text-nocturne-neutral-600">
          {matchup.phase !== "REGULAR" && (
            <span className="mr-2 uppercase tracking-wide">{matchup.phase.toLowerCase()}</span>
          )}
          {matchup.finalized ? "final" : "live"}
        </div>
        {right ? (
          <div className="text-right">
            <Header side={right} opponent={left} />
          </div>
        ) : (
          <p className="pt-6 text-sm text-nocturne-neutral-600">Bye</p>
        )}
      </div>

      {(left.restatedMilliPoints !== null || right?.restatedMilliPoints != null) && (
        <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/80">
          This week is final and stands as scored. A stat correction has landed since — under
          today&rsquo;s numbers it would have been{" "}
          {points(left.restatedMilliPoints ?? left.milliPoints)}
          {right && ` – ${points(right.restatedMilliPoints ?? right.milliPoints)}`} — but a
          finalised week is never rescored.
        </p>
      )}

      {right && <Rows left={left.starters} right={right.starters} />}
      {!right && <OneSided lines={left.starters} />}

      <button
        onClick={() => setShowBench((on) => !on)}
        className="text-xs text-nocturne-neutral-600 hover:text-nocturne-text"
      >
        {showBench ? "Hide bench" : "Show bench"}
      </button>

      {showBench &&
        (right ? (
          <Rows left={left.bench} right={right.bench} muted />
        ) : (
          <OneSided lines={left.bench} muted />
        ))}
    </section>
  );
}

/**
 * Starters side by side, paired by slot.
 *
 * Both lineups come from the same frozen roster rules, so slot *n* on the left
 * is slot *n* on the right and the columns line up without any matching logic.
 */
function Rows({
  left,
  right,
  muted = false,
}: {
  left: PlayerLine[];
  right: PlayerLine[];
  muted?: boolean;
}) {
  const rows = Math.max(left.length, right.length);

  return (
    <ul className={`divide-y divide-nocturne-neutral-900 ${muted ? "opacity-50" : ""}`}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-1.5">
          <Player line={left[i]} />
          <span className="w-10 text-center text-[10px] uppercase tracking-wide text-nocturne-text/25">
            {left[i]?.slot ?? right[i]?.slot ?? ""}
          </span>
          <Player line={right[i]} align="right" />
        </li>
      ))}
    </ul>
  );
}

function OneSided({ lines, muted = false }: { lines: PlayerLine[]; muted?: boolean }) {
  return (
    <ul className={`divide-y divide-nocturne-neutral-900 ${muted ? "opacity-50" : ""}`}>
      {lines.map((line) => (
        <li key={line.playerId} className="flex items-center gap-2 py-1.5">
          <span className="w-10 text-[10px] uppercase tracking-wide text-nocturne-text/25">
            {line.slot}
          </span>
          <Player line={line} />
        </li>
      ))}
    </ul>
  );
}

function Player({
  line,
  align = "left",
}: {
  line: PlayerLine | undefined;
  align?: "left" | "right";
}) {
  if (!line) return <span />;

  const right = align === "right";

  return (
    <span className={`flex items-baseline gap-2 text-sm ${right ? "justify-end" : ""}`}>
      {right && <Score line={line} />}
      <span className="min-w-0">
        <span className="truncate">{line.name || "—"}</span>{" "}
        <span className="text-xs text-nocturne-neutral-600">{line.position}</span>
      </span>
      {!right && <Score line={line} />}
    </span>
  );
}

/**
 * A player's points, and — when they are not final — why they might still move.
 *
 * A zero that is finished and a zero that has not kicked off look identical as
 * numbers and mean opposite things, so the state is always shown alongside.
 */
function Score({ line }: { line: PlayerLine }) {
  const label =
    line.gameState === "BYE"
      ? "bye"
      : // A fixture with no kickoff time yet. Distinct from a bye, because this
        // player will play and a bye player cannot — the difference decides
        // whether a manager holds the roster spot.
        line.gameState === "UNSCHEDULED"
        ? "TBD"
        : line.gameState === "YET_TO_PLAY"
          ? kickoffLabel(line.kickoffAt)
          : line.gameState === "IN_PROGRESS"
            ? "live"
            : null;

  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span
        className={`tabular-nums ${
          line.gameState === "IN_PROGRESS" ? "text-nocturne-accent-300" : ""
        }`}
      >
        {points(line.milliPoints)}
      </span>
      {label && <span className="text-[10px] text-nocturne-neutral-600">{label}</span>}
    </span>
  );
}

function CompactMatchup({ matchup }: { matchup: Matchup }) {
  const { home, away } = matchup;

  return (
    <div className="flex items-center gap-3 rounded border border-nocturne-neutral-900 px-4 py-2 text-sm">
      <span className="flex-1 truncate">{home.name}</span>
      <span
        className={`tabular-nums ${
          away && home.milliPoints > away.milliPoints ? "text-nocturne-accent-300" : ""
        }`}
      >
        {points(home.milliPoints)}
      </span>
      <span className="text-nocturne-text/20">–</span>
      {away ? (
        <>
          <span
            className={`tabular-nums ${
              home.milliPoints < away.milliPoints ? "text-nocturne-accent-300" : ""
            }`}
          >
            {points(away.milliPoints)}
          </span>
          <span className="flex-1 truncate text-right">{away.name}</span>
        </>
      ) : (
        <span className="flex-1 text-right text-nocturne-neutral-600">bye</span>
      )}
    </div>
  );
}
