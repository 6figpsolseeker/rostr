"use client";

import { useEffect, useMemo, useState } from "react";
import { opponentLabel } from "@/lib/opponent";
import { isIrEligible as irEligible } from "@rostr/core";
import { previewHeading, whyNot } from "@/lib/autofill";
import useSWR from "swr";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerCard } from "./PlayerCard";
import { injuryBadge, injuryTone, positionColour, positionGroup } from "@/lib/player";

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
  /** Stashed on injured reserve: on the roster, out of the rotation. */
  onIr: boolean;
  /** This week's opponent, or null on a bye and on an un-ingested fixture. */
  opponentRef: string | null;
  isHome: boolean | null;
  milliPoints: number;
  /** This week's projection under this league's scoring. Null if unpublished. */
  projectedMilliPoints: number | null;
  /** Season to date. Null before week 2, when there is no history yet. */
  averageMilliPoints: number | null;
  /**
   * Display only. Null on a pool synced before migration `0032`.
   *
   * The designation in particular is **shown and never enforced**: §6 locks a
   * slot at that player's own kickoff and says nothing about whether he is fit,
   * so starting a doubtful player stays the manager's call.
   */
  imageUrl: string | null;
  teamRef: string | null;
  injuryDesignation: string | null;
}

interface LineupResponse {
  week: number;
  autofill: {
    enabled: boolean;
    mode: "WEEKLY_PROJECTION" | "SEASON_AVERAGE";
    /** Per empty slot: who it would start, and who it left on the bench. */
    preview: {
      slotType: string;
      slotIndex: number;
      playerId: string;
      runnerUpId: string | null;
      runnerUpReason: "LOWER_RANKED" | "UNAVAILABLE" | "NO_DATA" | null;
    }[];
  };
  slots: Slot[];
  roster: RosterPlayer[];
  /** From the frozen rules. Zero means the league has no injured reserve. */
  irSlots: number;
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
  /** The player whose card is open. Every face and name on this screen opens one. */
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);
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

  /*
    Counted from the slots, not from the preview's length.

    The preview only covers slots the autofill can actually fill; a slot with no
    eligible player left produces no entry. Deriving the count from it would
    quietly under-report — the manager would be told two slots are empty while
    three score nothing.
  */
  const emptySlots = data.slots.filter((slot) => slot.playerId === null).length;
  const heading = previewHeading({ enabled: data.autofill.enabled, emptySlots });

  const starterPoints = data.slots.reduce(
    (total, slot) => total + (slot.playerId ? (byId.get(slot.playerId)?.milliPoints ?? 0) : 0),
    0,
  );

  /*
    Three places a player can be, not two.

    A stashed player is neither started nor on the bench — he is out of the
    rotation, and listing him among the bench would offer him in every slot's
    dropdown, which is precisely what injured reserve exists to stop.
  */
  const stashed = data.roster.filter((player) => player.onIr);
  const bench = data.roster.filter((player) => !started.has(player.playerId) && !player.onIr);

  /**
   * Move a player on or off injured reserve.
   *
   * The server decides. This sends the intent and re-reads — every rule that
   * matters (is he injured, is there room, has his game started) lives in
   * `@rostr/core` and `@rostr/db`, and duplicating any of it here would be a
   * screen that permits what the server refuses.
   */
  async function ir(playerId: string, action: "STASH" | "ACTIVATE"): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(`/api/leagues/${leagueId}/ir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, week, action }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not change injured reserve");
      await mutate();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

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

      {/*
        What the autofill will actually do, named.

        The checkbox alone asks a manager to trust a decision taken while they
        are asleep, on a week that counts. This is the same `autolineupChoices`
        the write uses, so the names here are the names that get started.

        Rendered whether autofill is on or off, and saying different things: on,
        it is a prediction; off, an empty slot scores nothing and that is the
        more useful warning.
      */}
      {heading && (
        <div className="space-y-2 rounded border border-nocturne-neutral-900 px-4 py-3 text-sm">
          <p className={data.autofill.enabled ? "text-nocturne-neutral-400" : "text-amber-300"}>
            {heading}
          </p>

          {data.autofill.enabled && (
            <ul className="space-y-1.5">
              {data.autofill.preview.map((choice) => {
                const starter = byId.get(choice.playerId);
                const passed = choice.runnerUpId ? byId.get(choice.runnerUpId) : null;
                if (!starter) return null;

                return (
                  <li key={`${choice.slotType}#${choice.slotIndex}`} className="text-[13px]">
                    <span className="text-nocturne-neutral-600">{choice.slotType}</span>{" "}
                    <span className="text-nocturne-text">{starter.name}</span>
                    {passed && choice.runnerUpReason && (
                      // The road not taken. Without it the preview is an
                      // assertion; with it, a manager can tell whether the
                      // autofill understood something they did not.
                      <span className="text-nocturne-neutral-600">
                        {" "}
                        — over {passed.name},{" "}
                        {whyNot(choice.runnerUpReason, data.autofill.mode)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

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

              {/*
                The face, and the man's own details, outside the <select>.
                A native select cannot render an image and its option text is the
                only thing it can show — so an editor built entirely out of one
                reduces your team to a list of strings. The control stays exactly
                as it was, because it is the accessible, keyboard-navigable way
                to change a slot; what is added is everything a select cannot
                say.
              */}
              {player ? (
                <button
                  onClick={() => setOpenPlayerId(player.playerId)}
                  className="flex min-w-0 items-center gap-2.5 text-left"
                  title={`${player.name} — open card`}
                >
                  <PlayerAvatar
                    name={player.name}
                    positions={player.positions}
                    imageUrl={player.imageUrl}
                    size={40}
                  />
                  <span className="hidden min-w-0 sm:block">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{player.name}</span>
                      {injuryBadge(player.injuryDesignation) && (
                        <span
                          className={`text-[10px] font-semibold ${injuryTone(player.injuryDesignation)}`}
                        >
                          {injuryBadge(player.injuryDesignation)}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-nocturne-neutral-600">
                      <span
                        className={`rounded px-1 py-px font-medium ring-1 ${positionColour(positionGroup(player.positions))}`}
                      >
                        {positionGroup(player.positions)}
                      </span>
                      {player.teamRef ?? "FA"}
                      {/*
                        Who he plays, next to who he plays for. A manager
                        deciding a lineup is comparing matchups, and sending
                        them to another tab to find out who somebody faces is
                        the friction this removes.
                      */}
                      {(() => {
                        const opponent = opponentLabel({
                          opponentRef: player.opponentRef,
                          isHome: player.isHome,
                          availability: player.availability,
                        });
                        return opponent === null ? null : (
                          <span
                            className={
                              opponent === "BYE"
                                ? "text-nocturne-neutral-700"
                                : "text-nocturne-neutral-500"
                            }
                          >
                            {opponent}
                          </span>
                        );
                      })()}
                    </span>
                  </span>
                </button>
              ) : (
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-dashed border-nocturne-neutral-800 text-nocturne-neutral-700"
                  aria-hidden
                >
                  +
                </span>
              )}

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
            <li key={player.playerId} className="flex items-center gap-3">
              <button
                onClick={() => setOpenPlayerId(player.playerId)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <PlayerAvatar
                  name={player.name}
                  positions={player.positions}
                  imageUrl={player.imageUrl}
                  size={28}
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs">{player.name}</span>
                  <span className="block text-[10px] text-nocturne-neutral-600">
                    {positionGroup(player.positions)}
                    {player.teamRef ? ` · ${player.teamRef}` : ""}
                    {/*
                      The bench is where a substitution gets decided, so the
                      matchup matters here at least as much as it does on a
                      starter. Injured reserve deliberately does not carry it:
                      a stashed player is out of the rotation, and naming his
                      fixture would invite a comparison that cannot be acted on.
                    */}
                    {(() => {
                      const opponent = opponentLabel({
                        opponentRef: player.opponentRef,
                        isHome: player.isHome,
                        availability: player.availability,
                      });
                      return opponent === null ? null : ` · ${opponent}`;
                    })()}
                  </span>
                </span>
              </button>
              {OUT_STATUSES.has(player.status.toUpperCase()) && (
                <span className="text-amber-400/70">{player.status}</span>
              )}
              {/*
                Offered only to a player the server would actually accept. The
                rule is enforced there; this just avoids a button whose only
                outcome is a refusal.
              */}
              {data.irSlots > 0 &&
                stashed.length < data.irSlots &&
                irEligible(player.injuryDesignation) && (
                  <button
                    onClick={() => void ir(player.playerId, "STASH")}
                    disabled={saving}
                    className="text-[10px] text-nocturne-neutral-600 hover:text-nocturne-accent-300 disabled:opacity-40"
                  >
                    To IR
                  </button>
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

      {/*
        Injured reserve.

        Rendered whenever the league has slots, even when empty, because unlike
        the bell's badge this is a *rule members signed* — `roster.irSlots` is in
        the frozen document and `RulesView` shows it above the join control. A
        section that only appeared once used would leave a manager unable to find
        out the allowance existed.
      */}
      {data.irSlots > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-nocturne-neutral-400">
            Injured reserve{" "}
            <span className="text-xs font-normal text-nocturne-neutral-600">
              {stashed.length} of {data.irSlots}
            </span>
          </h3>

          {stashed.length === 0 ? (
            <p className="text-[11px] text-nocturne-neutral-600">
              Holds players carrying an official out designation. They do not count against your
              roster limit and the autofill will never start them.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {stashed.map((player) => {
                // The owner's rule made visible: a player on IR must actually be
                // injured. When he recovers nothing is dropped or moved — he
                // simply stops being exempt, so the roster is over its limit
                // until the manager acts. Saying so is the whole remedy.
                const recovered = !irEligible(player.injuryDesignation);

                return (
                  <li key={player.playerId} className="flex items-center gap-3">
                    <button
                      onClick={() => setOpenPlayerId(player.playerId)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <PlayerAvatar
                        name={player.name}
                        positions={player.positions}
                        imageUrl={player.imageUrl}
                        size={28}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-xs">{player.name}</span>
                        <span className="block text-[10px] text-nocturne-neutral-600">
                          {positionGroup(player.positions)}
                          {player.teamRef ? ` · ${player.teamRef}` : ""}
                          {player.injuryDesignation ? ` · ${player.injuryDesignation}` : ""}
                        </span>
                      </span>
                    </button>

                    {recovered && (
                      <span className="text-[10px] text-amber-300">
                        no longer out — counts against your roster
                      </span>
                    )}

                    <button
                      onClick={() => void ir(player.playerId, "ACTIVATE")}
                      disabled={saving}
                      className="text-[10px] text-nocturne-neutral-600 hover:text-nocturne-accent-300 disabled:opacity-40"
                    >
                      Activate
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <p className="text-xs text-nocturne-neutral-600">
        Each slot locks when that player&rsquo;s game kicks off, not all at once — so a Thursday
        starter locking does not stop you moving anyone else.
      </p>

      {openPlayerId && (
        <PlayerCard
          leagueId={leagueId}
          playerId={openPlayerId}
          onClose={() => setOpenPlayerId(null)}
          {...(byId.get(openPlayerId) ? { fallbackName: byId.get(openPlayerId)!.name } : {})}
          {...(byId.get(openPlayerId)
            ? { fallbackPositions: byId.get(openPlayerId)!.positions }
            : {})}
        />
      )}
    </div>
  );
}
