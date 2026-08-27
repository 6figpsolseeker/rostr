/**
 * The autolineup.
 *
 * Fills a team's starting slots without a human. It runs for bots every week and
 * for any manager who has not turned it off — which is most of them, because it
 * defaults to on and the point is that forgetting costs you nothing.
 *
 * It has to be **deterministic**. A filled team's results decide other people's
 * playoff seeds, and in a league with a pot those seeds decide who gets paid. So
 * "the computer picked" must mean something anyone can recompute, not something
 * that depends on when a job ran or what order a database returned rows in.
 *
 * ## What it ranks on
 *
 * `WEEKLY_PROJECTION` by default: the provider's projection for that week,
 * scored under the league's own rules. A season average cannot know that this
 * week's opponent is the worst run defence in the league, or that the starter
 * ahead of him is out.
 *
 * `SEASON_AVERAGE` is the alternative, and the fallback for any single player
 * with no projection. Average rather than last week: one big game does not make
 * a player the right start, and one injury-shortened game does not make him the
 * wrong one.
 *
 * A projection is an *opinion*, and opinions cannot pass the two-source oracle
 * gate that settlement requires. That is fine here and would not be for scoring:
 * this is a **decision** standing in for a manager's start/sit call, and nobody
 * demands two providers agree on one of those either. What makes it honest is
 * that the number used is recorded, so the decision stays checkable.
 *
 * The tiebreak is the player ID, which is arbitrary — deliberately. Every real
 * criterion has already come up equal, and what matters at that point is only
 * that two machines agree. `docs/RULES.md` §8 says the same.
 *
 * ## Filling order matters, and it is not obvious
 *
 * Scarce slots first: a tight end who also qualifies for the FLEX must be
 * considered for TE before FLEX, or the FLEX takes him and the TE slot goes
 * empty. So slots are filled in order of how few players can fill them.
 */

import type { RosterShape } from "../draft/roster.js";
import type { LineupAssignment, LineupPlayer } from "./lineup.js";
import { startingSlots } from "./lineup.js";

export interface AutolineupCandidate extends LineupPlayer {
  /**
   * Season-to-date average, in milli-points.
   *
   * `null` for a player who has not played — a rookie, or someone just added.
   * They sort last but stay eligible, which is right: an unplayed player is
   * still a better start than an empty slot.
   */
  readonly averageMilliPoints: number | null;
  /**
   * The provider's projection for **this week**, in milli-points, scored under
   * this league's own rules.
   *
   * `null` when there is no projection — a rookie, a player the provider does
   * not cover, or a week not published yet. That falls back to
   * `averageMilliPoints` for this player alone; one missing projection must not
   * decide how the other eight slots get filled.
   *
   * Ignored entirely when the league's `roster.autofill` is `SEASON_AVERAGE`.
   */
  readonly projectedMilliPoints?: number | null;
  /**
   * Whether this player is unavailable — on a bye, or officially out.
   *
   * Not a hard exclusion. A team with nobody else at the position still has to
   * field someone, and an empty slot scores nothing while an inactive player at
   * least scores nothing *and* keeps the lineup legal.
   */
  readonly unavailable?: boolean;
}

/** Which number the autofill ranks on. Mirrors `roster.autofill`. */
export type AutofillMode = "WEEKLY_PROJECTION" | "SEASON_AVERAGE";

export interface AutolineupInput {
  readonly shape: RosterShape;
  readonly roster: readonly AutolineupCandidate[];
  /**
   * Defaults to `SEASON_AVERAGE`, so a caller that has not been taught about
   * projections keeps its old behaviour rather than silently ranking every
   * player on `null`.
   */
  readonly mode?: AutofillMode;
  /**
   * Slots already locked, which must be preserved exactly.
   *
   * An autolineup running on Sunday afternoon cannot move a Thursday player, and
   * must not try.
   */
  readonly locked?: readonly LineupAssignment[];
  /**
   * Unix seconds, at the moment the fill is being decided.
   *
   * **Required, not optional-with-a-fallback**, for the reason `lineup.ts` gives
   * about `KickoffTimes`: an optional filter that defaults to permissive is the
   * shape of the defect, and here the permissive default *is* the bug. A
   * clockless autofill is what let an empty slot be filled from a player whose
   * game had already started, which locked the slot around him and refused the
   * manager his own edit to it.
   *
   * `mode` and `locked` are optional because their defaults are conservative
   * and say so. A clock has no conservative default: the only value meaning "no
   * clock" is the one that admits every player already playing. This file is
   * pure and cannot obtain one itself, so it has to be given one.
   */
  readonly now: number;
}

/**
 * The number a candidate is ranked on, and it is the value that gets recorded
 * with the lineup so the choice stays reproducible.
 *
 * Falls back **per player**: under `WEEKLY_PROJECTION` a player with no
 * projection is ranked on his season average instead of being dumped to the
 * bottom. A rookie with no projection is not therefore a worse start than a
 * veteran averaging two points.
 */
export function rankingValue(
  candidate: AutolineupCandidate,
  mode: AutofillMode = "SEASON_AVERAGE",
): number | null {
  if (mode === "SEASON_AVERAGE") return candidate.averageMilliPoints;
  return candidate.projectedMilliPoints ?? candidate.averageMilliPoints;
}

/**
 * Rank two candidates. Better first.
 *
 * Total order, and no step depends on anything outside the two players — which
 * is what makes the result reproducible.
 */
function compare(a: AutolineupCandidate, b: AutolineupCandidate, mode: AutofillMode): number {
  // Available before unavailable. A player on a bye scores nothing at all, so he
  // loses to anyone who is playing, however poor.
  const availability = Number(a.unavailable ?? false) - Number(b.unavailable ?? false);
  if (availability !== 0) return availability;

  const left = rankingValue(a, mode);
  const right = rankingValue(b, mode);

  // Players with a record beat players without one.
  if (left === null && right !== null) return 1;
  if (right === null && left !== null) return -1;

  if (left !== null && right !== null && left !== right) return right - left;

  // Arbitrary, and that is the point: every real criterion is equal, so all that
  // remains is that two machines agree.
  return a.playerId.localeCompare(b.playerId);
}

/**
 * Choose a starting lineup.
 *
 * Returns an assignment for every starting slot, with `null` where nobody on the
 * roster could fill it.
 */
/**
 * Why the runner-up did not get the slot.
 *
 * Three reasons rather than one number, because they are different instructions
 * to a manager. "Projected lower" says the autofill is working and you may
 * disagree with it; "on a bye or out" says the alternative was never really an
 * alternative; "nothing to rank him on" says the autofill is guessing and your
 * own opinion is worth more than its ordering.
 */
export type RunnerUpReason = "LOWER_RANKED" | "UNAVAILABLE" | "NO_DATA";

export interface AutolineupChoice extends LineupAssignment {
  /**
   * The best eligible player this slot did **not** take, if there was one.
   *
   * Null when the slot had exactly one candidate, or none — in which case the
   * autofill made no choice worth explaining.
   */
  readonly runnerUpId: string | null;
  readonly runnerUpReason: RunnerUpReason | null;
}

/**
 * The fill, with the road not taken.
 *
 * **`autolineup` delegates to this**, rather than the preview reimplementing
 * the fill. A preview that ranked players itself would be the same decision
 * authored twice, and the failure mode is the worst kind: the screen names one
 * player all week and a different one gets started on Sunday, silently, in the
 * league's own records.
 *
 * The runner-up is computed inside the loop because it is only knowable there —
 * it depends on `used`, which changes as scarcer slots are filled first. A tight
 * end taken by TE is genuinely not available to FLEX, and reporting him as
 * FLEX's runner-up would describe a choice nobody could make.
 */
/**
 * Whether this player’s own game has already begun.
 *
 * Deliberately the same three answers `isSlotLocked` gives, because this is the
 * same rule seen from the other side.
 *
 * A bye is **not** started: `kickoffAt === null` means there is no game to have
 * begun, the slot never locks, and the manager keeps every option he had.
 *
 * **Not keyed on `unavailable`.** That flag conflates a bye with an OUT
 * designation, and a player ruled out of a 16:25 game has not started — he is a
 * legal fill, and the ranking already puts him last. Keying the exclusion on the
 * flag would bar him and admit nobody in his place.
 */
function hasStarted(candidate: AutolineupCandidate, now: number): boolean {
  return candidate.kickoffAt !== null && now >= candidate.kickoffAt;
}

export function autolineupChoices(input: AutolineupInput): readonly AutolineupChoice[] {
  const { shape, roster: allCandidates, locked, now, mode = "SEASON_AVERAGE" } = input;

  /*
    The pool, with anyone already playing removed — and removed here, before a
    single slot is looked at.

    `validateLineup` already refuses this move for a manager, and its comment
    says why: "an empty slot — which never locks — would let a manager start a
    player after watching him score." An empty slot is exactly what this function
    fills, and `setLineupUnchecked` writes the result without validating it, so
    this is the only writer in the system able to do what that check exists to
    prevent. This closes a bypass rather than choosing a policy.

    A hard exclusion, not a demotion in `compare`, and the difference is
    load-bearing three times over. A filtered player cannot be picked; cannot be
    named as a runner-up, which would offer an alternative the server would
    refuse; and cannot inflate `eligibleCount`, which decides the order slots
    are filled in and would otherwise make a slot look less scarce than it is.

    Locked slots are unaffected: they come from `locked` and are copied through
    below without consulting the pool, so a player already standing in a slot
    when his game starts stays exactly where he is. This governs which slots the
    autofill *fills*, never which it preserves — the same asymmetry
    `PLAYER_LOCKED` and `SLOT_LOCKED` describe as a pair.
  */
  const roster = allCandidates.filter((candidate) => !hasStarted(candidate, now));

  const slots = startingSlots(shape);

  const assignments = new Map<string, AutolineupChoice>();
  const used = new Set<string>();

  // Locked slots are fixed points: preserved exactly, and their players are
  // unavailable to everything else.
  const lockedKeys = new Set((locked ?? []).map((e) => `${e.slotType}#${e.slotIndex}`));

  for (const entry of locked ?? []) {
    // A locked slot was not chosen by the autofill and has no alternative to
    // report — its player is a fact about a game that has started.
    assignments.set(`${entry.slotType}#${entry.slotIndex}`, {
      ...entry,
      runnerUpId: null,
      runnerUpReason: null,
    });
    if (entry.playerId) used.add(entry.playerId);
  }

  // Scarcest slot first. A tight end who also qualifies for the FLEX has to be
  // considered for TE before FLEX, or the FLEX takes him and TE goes empty.
  //
  // Ties broken by slot type then index, so the order itself is deterministic
  // rather than however `sort` happened to arrange equal keys.
  const eligibleCount = (slot: (typeof slots)[number]): number =>
    roster.filter((player) =>
      player.positions.some((position) => slot.eligiblePositions.includes(position)),
    ).length;

  const order = [...slots].sort((a, b) => {
    const scarcity = eligibleCount(a) - eligibleCount(b);
    if (scarcity !== 0) return scarcity;
    const byType = a.slotType.localeCompare(b.slotType);
    return byType !== 0 ? byType : a.slotIndex - b.slotIndex;
  });

  for (const slot of order) {
    const key = `${slot.slotType}#${slot.slotIndex}`;
    if (assignments.has(key)) continue;

    const best = roster
      .filter((player) => !used.has(player.playerId))
      .filter((player) =>
        player.positions.some((position) => slot.eligiblePositions.includes(position)),
      )
      .sort((a, b) => compare(a, b, mode))[0];

    if (best) {
      used.add(best.playerId);
      assignments.set(key, {
        slotType: slot.slotType,
        slotIndex: slot.slotIndex,
        playerId: best.playerId,
        runnerUpId: null,
        runnerUpReason: null,
      });
    } else {
      assignments.set(key, {
        slotType: slot.slotType,
        slotIndex: slot.slotIndex,
        playerId: null,
        runnerUpId: null,
        runnerUpReason: null,
      });
    }
  }

  // Returned in roster order, not fill order — the caller is writing a lineup a
  // human will read.
  /*
    The runner-up, in a second pass and against the **finished** lineup.

    Computing it inside the fill loop is the obvious approach and is wrong: the
    best player a slot passes over is usually the one the *next* slot of the same
    type takes. RB#0 would report RB#1's starter as "also eligible", so the
    screen would offer a manager somebody already in their own lineup.

    What a manager wants named is the best player who ends up on the **bench** —
    the alternative that really was foregone. That is only knowable once every
    slot is filled, which is why this cannot live in the loop.
  */
  const started = new Set(
    [...assignments.values()]
      .map((entry) => entry.playerId)
      .filter((id): id is string => id !== null),
  );
  const bench = roster.filter((player) => !started.has(player.playerId));

  return slots.map((slot) => {
    const entry = assignments.get(`${slot.slotType}#${slot.slotIndex}`) ?? {
      slotType: slot.slotType,
      slotIndex: slot.slotIndex,
      playerId: null,
      runnerUpId: null,
      runnerUpReason: null,
    };

    // A locked slot was not chosen by the autofill, and an empty one had nobody
    // to pass over. Neither has an alternative worth reporting.
    if (entry.playerId === null) return entry;
    if (lockedKeys.has(`${slot.slotType}#${slot.slotIndex}`)) return entry;

    const winner = roster.find((player) => player.playerId === entry.playerId);
    const runnerUp = bench
      .filter((player) =>
        player.positions.some((position) => slot.eligiblePositions.includes(position)),
      )
      .sort((a, b) => compare(a, b, mode))[0];

    if (!winner || !runnerUp) return entry;

    return {
      ...entry,
      runnerUpId: runnerUp.playerId,
      runnerUpReason: reasonAgainst(winner, runnerUp, mode),
    };
  });
}

/**
 * Why `loser` lost to `winner`.
 *
 * Order matters. Unavailability is checked first because it is the reason a
 * manager can act on — an alternative who is on a bye is not a judgement call,
 * and reporting "projected lower" for a player with no game would be true and
 * useless. `NO_DATA` comes next: a null ranking sorts last by construction, so
 * "projected lower" would imply a comparison that never happened.
 */
function reasonAgainst(
  winner: AutolineupCandidate,
  loser: AutolineupCandidate,
  mode: AutofillMode,
): RunnerUpReason {
  if (loser.unavailable === true && winner.unavailable !== true) return "UNAVAILABLE";
  if (rankingValue(loser, mode) === null) return "NO_DATA";
  return "LOWER_RANKED";
}

/**
 * The fill alone.
 *
 * Kept as the public entry point every existing caller uses, so adding the
 * preview cannot change what gets written. It is a projection of
 * `autolineupChoices`, not a second implementation.
 */
export function autolineup(input: AutolineupInput): readonly LineupAssignment[] {
  return autolineupChoices(input).map(({ slotType, slotIndex, playerId }) => ({
    slotType,
    slotIndex,
    playerId,
  }));
}

/**
 * Season-to-date average in milli-points, or `null` for a player who has not
 * played.
 *
 * Integer division, floored. Averages feed a comparison and never a score, so
 * the lost fraction cannot reach anybody's points total — and staying integer
 * keeps the "no floats near scoring" rule intact without an exception nobody
 * would remember.
 */
export function seasonAverage(weeklyMilliPoints: readonly number[]): number | null {
  if (weeklyMilliPoints.length === 0) return null;

  const total = weeklyMilliPoints.reduce((sum, week) => sum + week, 0);
  return Math.floor(total / weeklyMilliPoints.length);
}
