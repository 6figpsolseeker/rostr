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
 *
 * ## Which paths apply the roster limit
 *
 * `RULES.md` §2 promises IR slots "do not count against the roster limit",
 * unqualified, so every path that applies that limit must subtract them. There
 * are two, and until #237 only one did:
 *
 * - `addFreeAgent` — has always used `countedRosterSize`.
 * - `resolveWaiverClaims`, through `processWaivers` — loaded rosters without
 *   the IR columns and counted stashed players against the limit, so a signed
 *   allowance bought room in the first-come market and none in the
 *   priority-allocated one. Fixed by passing an exempt set and counting it
 *   against the roster a claim's drop would leave.
 *
 * **Trades apply no roster limit at all**, so there is nothing there for this to
 * be subtracted from — a trade can leave a team over `totalSlots` and nothing
 * refuses or reports it. That is a separate gap, and a larger one.
 *
 * Migration `0038` says the stash count is what "both the capacity rule and the
 * IR limit consult on every transaction". That was never true and cannot be
 * corrected in place — the runner compares a checksum over the file and the
 * deployed database is past it — so the correction lives here.
 */

/**
 * Designations that mean a player may still take the field.
 *
 * **A deny-list, and the inversion is the point.** This was an allow-list of
 * seven short codes — OUT, IR, INACTIVE, SUSPENDED, DOUBTFUL, PUP, NFI — and
 * the column it matches against holds the provider's wording verbatim. Tank01
 * writes `"Injured Reserve"`, which is in none of them, so the players the
 * feature exists for were the ones it refused. Issue 251.
 *
 * An allow-list is correct only if the enumeration is complete, and nobody can
 * complete this one: it is another company's vocabulary and it can change
 * mid-season. A deny-list is correct if no unlisted designation means "may
 * still play", which is a far smaller claim — and `docs/TANK01.md` records the
 * evidence for it: of 383 designated players on 2026-08-27, the field held
 * exactly four values, and `"Questionable"` was the only one of them meaning a
 * player might appear.
 *
 * **The failure directions are not symmetric, which is what licenses this.**
 * Refusing wrongly strands a player who is genuinely on injured reserve, with
 * no bound and no recourse. Admitting wrongly lets a manager spend an IR slot
 * on somebody who might play — and {@link capped} holds the exemption to
 * `roster.irSlots` however many are stashed, while `onIr` means he stashed the
 * player deliberately. So the cost is bounded by a number in the signed rules
 * and paid by the manager who chose it. That is the same trade `DOUBTFUL` has
 * always carried here, described two paragraphs down.
 *
 * `syncInjuries` warns on any designation not yet recorded in `docs/TANK01.md`,
 * so a new value arrives in the logs rather than silently changing a rule.
 */
export const MAY_STILL_PLAY = new Set(["QUESTIONABLE"]);

/**
 * Whether this designation permits a player to occupy an IR slot.
 *
 * **Decided by the owner, 2026-08-23: "whenever a player is on IR they need to
 * be actually injured."** So this is asked continuously rather than only at the
 * moment somebody is placed there — which is also why a designation that gets
 * *worse* must never cost a manager the slot. Before issue 251 it did: a player
 * stashed as `"Out"` who progressed to `"Injured Reserve"` stopped being exempt,
 * had his waiver claims refused for a full roster, and was labelled as no longer
 * out. One predicate, five faces.
 *
 * `DOUBTFUL` remains eligible, and is the debatable one. It is kept because the
 * question is "will he appear this week", and a manager should not have to
 * re-litigate a designation the provider already made.
 *
 * A null or empty designation is a healthy player. Note this reads the
 * designation column, which `CLAUDE.md` records as *shown and never enforced* —
 * that rule exists so a designation arriving on a Sunday cannot invalidate a
 * lineup that was legal when it was set, and nothing here touches a lineup.
 * **Do not reuse this predicate for the autofill.** It reads as the same
 * question and is not: that path writes starting slots from a cron with nobody
 * watching, and is exactly what the invariant forbids.
 * See {@link irExemptCount} for how the continuous check avoids doing anything
 * destructive when a player recovers.
 */
export function isIrEligible(designation: string | null | undefined): boolean {
  if (designation === null || designation === undefined) return false;
  const normalised = designation.trim().toUpperCase();
  if (normalised === "") return false;
  return !MAY_STILL_PLAY.has(normalised);
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
/*
 * The cap, in one place, because two entry points now apply it.
 *
 * Being injured is a condition of occupying a slot, not a way to conjure more
 * of them — so however many genuinely-injured players a roster holds, only
 * `irSlots` of them are exempt.
 */
function capped(genuine: number, irSlots: number): number {
  return Math.min(genuine, Math.max(0, irSlots));
}

export function irExemptCount(roster: readonly IrRosterEntry[], irSlots: number): number {
  return capped(
    roster.filter((entry) => entry.onIr && isIrEligible(entry.injuryDesignation)).length,
    irSlots,
  );
}

/*
 * The same cap, for a caller that already knows which players qualify.
 *
 * **Counts against the array it is given, never against the set.** A player in
 * the set who is not in this array exempts nothing, and that is the whole
 * reason this shape was chosen over carrying a per-team count: the waiver
 * resolver applies it to a *hypothetical* roster — the one a claim's drop would
 * leave behind — so the answer has to be recomputed there rather than decided
 * in advance.
 *
 * Dropping an exempt player frees an IR slot, not a roster slot. A precomputed
 * count gets that backwards and awards a claim that should be refused, because
 * it keeps subtracting for somebody who has just left.
 *
 * It also makes the count immune to a roster array that is short of rows for an
 * unrelated reason: intersecting cannot subtract a player who is not there.
 */
export function irExemptOnRoster(
  roster: readonly { readonly playerId: string }[],
  exempt: ReadonlySet<string>,
  irSlots: number,
): number {
  return capped(roster.filter((entry) => exempt.has(entry.playerId)).length, irSlots);
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
