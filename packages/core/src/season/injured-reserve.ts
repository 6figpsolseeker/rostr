/**
 * Injured reserve: who may occupy it, and what it does to roster capacity.
 *
 * `roster.irSlots` has sat in the frozen, hashed, member-signed rule set since
 * the schema was written and was **read by nothing**. `RulesView` renders it
 * above the join control, so every member has agreed to a number that did not
 * exist anywhere else in the system — the `botsAllowed` failure exactly, and the
 * reason that field was deleted rather than left lying.
 *
 * Pure, and in `@rostr/core` rather than in the database layer, because it is a
 * rule rather than a query: the same answer has to govern a manager's own
 * placement, an add that needs the room, and whatever screen explains why.
 */

/**
 * Designations that mean a player is genuinely unavailable.
 *
 * The same set the autofill treats as unavailable, restated here rather than
 * imported from `@rostr/db` — this package must not depend on that one, and the
 * two are the same list for the same reason rather than by coincidence. If they
 * drift, the symptom is a player the autofill benches but IR refuses to hold.
 *
 * `DOUBTFUL` is included, and is the debatable one. It is kept because the whole
 * set answers "will not appear this week", and a manager should not have to
 * re-litigate a designation the provider already made.
 */
export const IR_ELIGIBLE_DESIGNATIONS = new Set([
  "OUT",
  "IR",
  "INACTIVE",
  "SUSPENDED",
  "DOUBTFUL",
  "PUP",
  "NFI",
]);

/**
 * Whether this designation permits a player to occupy an IR slot.
 *
 * **Decided by the owner, 2026-08-23: "whenever a player is on IR they need to
 * be actually injured."** So this is asked continuously rather than only at the
 * moment somebody is placed there.
 *
 * A null or empty designation is a healthy player. Note this reads the
 * designation column, which `CLAUDE.md` records as *shown and never enforced* —
 * that rule exists so a designation arriving on a Sunday cannot invalidate a
 * lineup that was legal when it was set, and nothing here touches a lineup.
 * See {@link irExemptCount} for how the continuous check avoids doing anything
 * destructive when a player recovers.
 */
export function isIrEligible(designation: string | null | undefined): boolean {
  if (designation === null || designation === undefined) return false;
  const normalised = designation.trim().toUpperCase();
  if (normalised === "") return false;
  return IR_ELIGIBLE_DESIGNATIONS.has(normalised);
}

export interface IrRosterEntry {
  readonly playerId: string;
  readonly onIr: boolean;
  /** The provider's current designation, or null for a healthy player. */
  readonly injuryDesignation: string | null;
}

/**
 * How many of this team's players are genuinely exempt from the roster limit.
 *
 * **The exemption is conditional, and that is what makes continuous enforcement
 * safe.** A player who recovers while on IR is not forced off, auto-dropped, or
 * silently moved — all three are destructive, and this repo does not do
 * destructive things to a roster on a provider's say-so. He simply stops being
 * exempt, so he counts against the limit again from that moment.
 *
 * The team is then in the ordinary "roster full" state: they cannot add anybody
 * until they activate him and drop somebody, which is a decision only they
 * should make. No new rule is needed for it, and no state is reachable in which
 * a healthy player is quietly buying his team an extra roster spot.
 *
 * Capped at `irSlots` regardless. Being injured is a condition of occupying the
 * slot, not a way to conjure more of them.
 */
export function irExemptCount(roster: readonly IrRosterEntry[], irSlots: number): number {
  const genuine = roster.filter(
    (entry) => entry.onIr && isIrEligible(entry.injuryDesignation),
  ).length;

  return Math.min(genuine, Math.max(0, irSlots));
}

/**
 * How many players this team counts as holding, for the roster limit.
 *
 * `totalSlots` already excludes IR (`starters + bench`), so the comparison this
 * feeds is unchanged — what changes is that genuinely-stashed players are
 * subtracted before it.
 */
export function countedRosterSize(roster: readonly IrRosterEntry[], irSlots: number): number {
  return roster.length - irExemptCount(roster, irSlots);
}

export type IrPlacementRefusal =
  /** The player is healthy, or carries a designation that does not qualify. */
  | "NOT_INJURED"
  /** Every IR slot the league's rules provide is already genuinely occupied. */
  | "IR_FULL"
  /** He is on this roster twice, or not on it at all. */
  | "NOT_ON_ROSTER";

/**
 * Whether this player may be moved onto IR right now.
 *
 * Returns the refusal rather than throwing, so a caller can render it. `null`
 * means the move is legal.
 */
export function refuseIrPlacement(input: {
  readonly roster: readonly IrRosterEntry[];
  readonly playerId: string;
  readonly irSlots: number;
}): IrPlacementRefusal | null {
  const player = input.roster.find((entry) => entry.playerId === input.playerId);
  if (!player) return "NOT_ON_ROSTER";

  if (!isIrEligible(player.injuryDesignation)) return "NOT_INJURED";

  // Counted against the *genuine* occupancy, so a recovered player sitting on
  // IR does not block the slot he is no longer entitled to.
  if (irExemptCount(input.roster, input.irSlots) >= input.irSlots) return "IR_FULL";

  return null;
}
