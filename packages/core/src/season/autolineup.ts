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
export function autolineup(input: AutolineupInput): readonly LineupAssignment[] {
  const { shape, roster, locked, mode = "SEASON_AVERAGE" } = input;

  const slots = startingSlots(shape);

  const assignments = new Map<string, LineupAssignment>();
  const used = new Set<string>();

  // Locked slots are fixed points: preserved exactly, and their players are
  // unavailable to everything else.
  for (const entry of locked ?? []) {
    assignments.set(`${entry.slotType}#${entry.slotIndex}`, entry);
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
      });
    } else {
      assignments.set(key, {
        slotType: slot.slotType,
        slotIndex: slot.slotIndex,
        playerId: null,
      });
    }
  }

  // Returned in roster order, not fill order — the caller is writing a lineup a
  // human will read.
  return slots.map(
    (slot) =>
      assignments.get(`${slot.slotType}#${slot.slotIndex}`) ?? {
        slotType: slot.slotType,
        slotIndex: slot.slotIndex,
        playerId: null,
      },
  );
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
