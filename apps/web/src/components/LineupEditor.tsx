"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";

/**
 * The lineup screen.
 *
 * Every slot shows what locks it and when. That is the difference between a
 * manager who knows their deadline and one who finds out afterwards — and with
 * per-player locks the deadline is different for each slot, so "lineups lock
 * Sunday at 1" is not a thing anyone can be told.
 *
 * Locked slots are shown as locked, but the server checks again on write. The
 * greying-out is a courtesy; the refusal is the rule.
 */

interface Slot {
  slotType: string;
  slotIndex: number;
  eligiblePositions: string[];
  playerId: string | null;
  locksAt: number | null;
  locked: boolean;
}

interface RosterPlayer {
  playerId: string;
  name: string;
  positions: string[];
  status: string;
  kickoffAt: number | null;
  /**
   * How settled this player's week is. `BYE` is a rest week and he cannot
   * score. `TIME_TBD` is a real fixture whose hour the NFL has not fixed — he
   * will play, and `kickoffAt` is the earliest he could, not a promise.
   * `UNSCHEDULED` is the same news with less of it: no fixture stored at all.
   */
  availability: "SCHEDULED" | "TIME_TBD" | "BYE" | "UNSCHEDULED";
  milliPoints: number;
  /** This week's projection under this league's scoring. Null if unpublished. */
  projectedMilliPoints: number | null;
  /** Season to date. Null before week 2, when there is no history yet. */
  averageMilliPoints: number | null;
}

interface LineupResponse {
  week: number;
  autofill: { enabled: boolean; mode: "WEEKLY_PROJECTION" | "SEASON_AVERAGE" };
  slots: Slot[];
  roster: RosterPlayer[];
}

/**
 * A projection well above what this player usually does.
 *
 * The floor is the part that matters. Without it, a player averaging 0.4 points
 * projected at 0.6 is "+50%" — technically true, useless to a manager, and it
 * would put a badge on half the bench. The threshold is a display choice and
 * lives here rather than in the API, which sends the two raw numbers.
 */
const BREAKOUT_RATIO = 1.25;
const BREAKOUT_FLOOR_MILLI = 6_000;

function isBreakout(player: RosterPlayer): boolean {
  const { projectedMilliPoints: projected, averageMilliPoints: average } = player;
  if (projected === null || average === null || average <= 0) return false;
  if (projected < BREAKOUT_FLOOR_MILLI) return false;
  return projected >= average * BREAKOUT_RATIO;
}

const fetcher = async (url: string): Promise<LineupResponse> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<LineupResponse>;
};

const points = (milli: number): string => (milli / 1000).toFixed(1);

/** "in 2h 14m", or "locked" once it has passed. */
function untilLock(locksAt: number | null, now: number): string {
  if (locksAt === null) return "no game";
  const seconds = locksAt - now;
  if (seconds <= 0) return "locked";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

const OUT_STATUSES = new Set(["OUT", "IR", "INACTIVE", "SUSPENDED", "DOUBTFUL", "PUP", "NFI"]);

export function LineupEditor({ leagueId, week }: { leagueId: string; week: number }) {
  const { data, error, mutate } = useSWR<LineupResponse>(
    `/api/leagues/${leagueId}/lineup?week=${week}`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Ticks so the countdowns move without waiting for the next poll.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  const byId = useMemo(
    () => new Map((data?.roster ?? []).map((player) => [player.playerId, player])),
    [data],
  );

  const started = useMemo(
    () => new Set((data?.slots ?? []).map((slot) => slot.playerId).filter(Boolean)),
    [data],
  );

  if (error) return <p className="text-sm text-red-400">{error.message}</p>;
  if (!data) return <p className="text-sm text-nocturne-neutral-600">Loading your lineup…</p>;

  async function save(next: Slot[]): Promise<void> {
    setSaving(true);
    setProblems([]);
    setSaveError(null);

    try {
      const response = await fetch(`/api/leagues/${leagueId}/lineup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week,
          assignments: next.map((slot) => ({
            slotType: slot.slotType,
            slotIndex: slot.slotIndex,
            playerId: slot.playerId,
          })),
        }),
      });

      const body = (await response.json()) as {
        error?: string;
        problems?: { message: string }[];
      };
      if (!response.ok) {
        setProblems((body.problems ?? []).map((problem) => problem.message));
        throw new Error(body.error ?? "Could not save that lineup");
      }

      await mutate();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function setAutofill(enabled: boolean): Promise<void> {
    setSaving(true);
    setSaveError(null);

    try {
      const response = await fetch(`/api/leagues/${leagueId}/lineup`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autofillEnabled: enabled }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not change that setting");
      }

      await mutate();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function assign(slot: Slot, playerId: string | null): void {
    const next = data!.slots.map((entry) =>
      entry.slotType === slot.slotType && entry.slotIndex === slot.slotIndex
        ? { ...entry, playerId }
        : // Moving a player into a slot takes him out of wherever he was.
          entry.playerId === playerId && playerId !== null
          ? { ...entry, playerId: null }
          : entry,
    );

    void save(next);
  }

  const starterPoints = data.slots.reduce(
    (total, slot) => total + (slot.playerId ? (byId.get(slot.playerId)?.milliPoints ?? 0) : 0),
    0,
  );

  const bench = data.roster.filter((player) => !started.has(player.playerId));

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Week {data.week}</h2>
        <span className="text-2xl font-semibold tabular-nums">{points(starterPoints)}</span>
      </header>

      <label className="flex items-start gap-3 rounded border border-nocturne-neutral-900 px-4 py-3 text-sm">
        <input
          type="checkbox"
          checked={data.autofill.enabled}
          disabled={saving}
          onChange={(e) => void setAutofill(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block">Fill my empty slots at kickoff</span>
          <span className="block text-xs text-nocturne-neutral-600">
            {data.autofill.mode === "WEEKLY_PROJECTION"
              ? "Uses this week's projections. "
              : "Uses each player's season average. "}
            {data.autofill.enabled
              ? "You can still change anything yourself — this only touches slots you leave empty."
              : "Off: an empty slot stays empty and scores nothing."}
          </span>
        </span>
      </label>

      {(saveError || problems.length > 0) && (
        <div className="space-y-1 rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {saveError && <p>{saveError}</p>}
          {problems.map((problem) => (
            <p key={problem} className="text-xs">
              {problem}
            </p>
          ))}
        </div>
      )}

      <ul className="divide-y divide-nocturne-neutral-900 rounded border border-nocturne-neutral-900">
        {data.slots.map((slot) => {
          const player = slot.playerId ? byId.get(slot.playerId) : null;
          const options = bench.filter((candidate) =>
            candidate.positions.some((position) => slot.eligiblePositions.includes(position)),
          );

          return (
            <li
              key={`${slot.slotType}#${slot.slotIndex}`}
              className="flex items-center gap-3 px-4 py-3"
            >
              <span className="w-12 text-xs font-medium text-nocturne-neutral-500">
                {slot.slotType}
              </span>

              <div className="min-w-0 flex-1">
                <select
                  value={slot.playerId ?? ""}
                  disabled={slot.locked || saving}
                  onChange={(e) => assign(slot, e.target.value || null)}
                  className="w-full rounded border border-nocturne-neutral-800 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50"
                >
                  <option value="">— empty —</option>
                  {player && (
                    <option value={player.playerId}>
                      {player.name} ({player.positions.join("/")})
                    </option>
                  )}
                  {options.map((candidate) => {
                    // His game has started, so he cannot be moved into a slot —
                    // the server rejects it, and rightly: starting a player
                    // after seeing him score is the whole reason the lock
                    // exists. Disabling here means the manager never reaches
                    // that rejection rather than meeting it with a raw id in
                    // the message. The server still decides; this only stops
                    // the screen offering something it knows will fail.
                    const played = candidate.kickoffAt !== null && now >= candidate.kickoffAt;

                    return (
                      <option
                        key={candidate.playerId}
                        value={candidate.playerId}
                        disabled={played}
                      >
                        {candidate.name} ({candidate.positions.join("/")})
                        {played ? " — played" : ""}
                        {candidate.availability === "BYE" ? " — bye" : ""}
                        {/* Not folded into the bye label: a bye scores nothing
                            and this player will score, once the fixture has a
                            date. Choosing between them is the point of this
                            list. */}
                        {candidate.availability === "UNSCHEDULED" ||
                        candidate.availability === "TIME_TBD"
                          ? " — TBD"
                          : ""}
                        {OUT_STATUSES.has(candidate.status.toUpperCase())
                          ? ` — ${candidate.status}`
                          : ""}
                      </option>
                    );
                  })}
                </select>
              </div>

              <span
                className={`w-24 text-right text-xs ${slot.locked ? "text-nocturne-neutral-600" : "text-nocturne-neutral-500"}`}
                title={
                  slot.locksAt
                    ? `Locks at ${new Date(slot.locksAt * 1000).toLocaleString()}`
                    : player?.availability === "UNSCHEDULED"
                      ? "No fixture stored for his team this week, and it is not their bye, so the slot cannot lock."
                      : "This player has no game this week"
                }
              >
                {untilLock(slot.locksAt, now)}
              </span>

              <span
                className="w-12 text-right text-sm tabular-nums text-nocturne-neutral-500"
                title="Projected this week"
              >
                {player?.projectedMilliPoints != null
                  ? points(player.projectedMilliPoints)
                  : "—"}
              </span>

              <span className="w-12 text-right text-sm tabular-nums" title="Scored so far">
                {player ? points(player.milliPoints) : "—"}
              </span>
            </li>
          );
        })}
      </ul>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-nocturne-neutral-400">
          Bench{" "}
          <span className="text-xs font-normal text-nocturne-neutral-600">{bench.length}</span>
        </h3>
        <ul className="space-y-1 text-xs">
          {bench.map((player) => (
            <li key={player.playerId} className="flex gap-3">
              <span className="w-10 text-nocturne-neutral-600">
                {player.positions.join("/")}
              </span>
              <span className="flex-1 truncate">{player.name}</span>
              {OUT_STATUSES.has(player.status.toUpperCase()) && (
                <span className="text-amber-400/70">{player.status}</span>
              )}
              {player.availability === "BYE" && (
                <span className="text-nocturne-neutral-600">bye</span>
              )}
              {(player.availability === "UNSCHEDULED" ||
                player.availability === "TIME_TBD") && (
                <span
                  className="text-nocturne-neutral-600"
                  title={
                    player.availability === "TIME_TBD"
                      ? "He plays this week. The NFL has not fixed the kickoff time, so this slot locks at the earliest hour the game could start."
                      : "No fixture stored for his team this week, and it is not their bye. Check back once the schedule syncs."
                  }
                >
                  TBD
                </span>
              )}
              {isBreakout(player) && (
                <span
                  className="rounded border border-nocturne-accent/20 px-1 text-nocturne-accent-300"
                  title={`Projected ${points(player.projectedMilliPoints ?? 0)} against a season average of ${points(player.averageMilliPoints ?? 0)}`}
                >
                  ▲ projected up
                </span>
              )}
              <span
                className="w-10 text-right tabular-nums text-nocturne-neutral-500"
                title="Projected this week"
              >
                {player.projectedMilliPoints != null
                  ? points(player.projectedMilliPoints)
                  : "—"}
              </span>
              <span className="w-10 text-right tabular-nums" title="Scored so far">
                {points(player.milliPoints)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-nocturne-neutral-600">
        Each slot locks when that player&rsquo;s game kicks off, not all at once — so a Thursday
        starter locking does not stop you moving anyone else.
      </p>
    </div>
  );
}
