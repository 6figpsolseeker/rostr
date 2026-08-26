/**
 * Roster legality during a draft.
 *
 * ## Why this is a matching problem, not a counting problem
 *
 * The obvious implementation counts players per position and compares against
 * slot counts. It is wrong, because of FLEX.
 *
 * Consider a roster of one RB and two WRs against slots RB, WR, WR, FLEX. Naive
 * counting says WR is "full" after two, so a third WR looks useless. In fact the
 * third WR fills FLEX, and the lineup is legal. Invert it — three RBs against
 * RB, RB, WR, FLEX — and counting says RB is over-filled while the lineup is
 * actually one WR short.
 *
 * Deciding whether a set of players can fill a set of slots is exactly
 * **maximum bipartite matching**. With a dozen players and ten slots it is
 * instant, and unlike counting it is correct in every configuration, including
 * ones a future sport invents.
 */

import type { SportDef } from "../sports/types.js";
import type { RosterRules } from "../rules/types.js";

export interface DraftablePlayer {
  readonly playerId: string;
  /** Every position this player may fill. */
  readonly positions: readonly string[];
  /** Lower is better. Ranking comes from the provider, not from here. */
  readonly rank: number;
}

/** One concrete starting slot — expanded, so `RB x2` becomes two entries. */
export interface StartingSlot {
  readonly slotType: string;
  readonly eligiblePositions: readonly string[];
  /** Position in the league's roster ordering, for stable tie-breaking. */
  readonly ordinal: number;
}

export interface RosterShape {
  readonly starters: readonly StartingSlot[];
  readonly benchSlots: number;
  readonly irSlots: number;
  /** Starters plus bench. IR is excluded — it does not count against the limit. */
  readonly totalSlots: number;
}

/**
 * Expand a league's roster rules into concrete slots.
 *
 * Reads eligibility from the sport definition, so the draft never learns which
 * positions a FLEX accepts.
 */
export function buildRosterShape(roster: RosterRules, sport: SportDef): RosterShape {
  const slotTypes = new Map(sport.slotTypes.map((slot) => [slot.key, slot]));
  const starters: StartingSlot[] = [];

  let ordinal = 0;
  for (const rule of roster.starters) {
    const definition = slotTypes.get(rule.slotType);
    if (!definition) {
      throw new Error(
        `Roster references slot type "${rule.slotType}", which ${sport.key} does not define`,
      );
    }
    for (let i = 0; i < rule.count; i++) {
      starters.push({
        slotType: rule.slotType,
        eligiblePositions: definition.eligiblePositions,
        ordinal: ordinal++,
      });
    }
  }

  return {
    starters,
    benchSlots: roster.benchSlots,
    irSlots: roster.irSlots,
    totalSlots: starters.length + roster.benchSlots,
  };
}

function eligible(player: DraftablePlayer, slot: StartingSlot): boolean {
  return player.positions.some((position) => slot.eligiblePositions.includes(position));
}

/**
 * Maximum bipartite matching between players and starting slots.
 *
 * Kuhn's algorithm. `slotForPlayer[p]` is the slot index assigned to player `p`,
 * or -1 if that player is a bench piece under this assignment.
 */
function match(
  players: readonly DraftablePlayer[],
  slots: readonly StartingSlot[],
): { size: number; playerForSlot: readonly number[] } {
  const playerForSlot: number[] = new Array<number>(slots.length).fill(-1);

  const augment = (playerIndex: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slots.length; s++) {
      if (seen[s]) continue;
      if (!eligible(players[playerIndex]!, slots[s]!)) continue;

      seen[s] = true;
      const incumbent = playerForSlot[s]!;
      if (incumbent === -1 || augment(incumbent, seen)) {
        playerForSlot[s] = playerIndex;
        return true;
      }
    }
    return false;
  };

  let size = 0;
  for (let p = 0; p < players.length; p++) {
    if (augment(p, new Array<boolean>(slots.length).fill(false))) size++;
  }

  return { size, playerForSlot };
}

/** How many starting slots this roster can fill, at best. */
export function startersFilled(
  players: readonly DraftablePlayer[],
  shape: RosterShape,
): number {
  return match(players, shape.starters).size;
}

/**
 * Starting slots this roster cannot fill, in roster order.
 *
 * The first entry is the team's most pressing need — which is what auto-pick and
 * the bots draft for.
 */
export function unfilledStarterSlots(
  players: readonly DraftablePlayer[],
  shape: RosterShape,
): readonly StartingSlot[] {
  const { playerForSlot } = match(players, shape.starters);

  return shape.starters
    .filter((_, index) => playerForSlot[index] === -1)
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * How many of a position a team should carry.
 *
 * Derived from the roster shape, never hardcoded — a sport with different slots
 * gets sensible caps for free.
 *
 * Each position gets its starting slots, plus a share of the bench proportional
 * to how many slots accept it. Positions you start several of earn depth;
 * positions with a single dedicated slot do not.
 *
 * In football that is:
 *
 *     QB 1    RB 4    WR 4    TE 3    K 1    DEF 1
 *
 * A first version gave every position `slots + 1`, which let a bot draft **two
 * kickers and one tight end** — ADP-optimal at the moment of the pick, and
 * something no manager would ever do. You can only start one kicker and there
 * is no flex to hide a second in, so the second is a wasted roster spot.
 *
 * These are guidance for auto-pick, **not** a rule. A human may draft whatever
 * they like; `canDraft` does not consult this.
 */
export function defaultPositionCaps(shape: RosterShape): ReadonlyMap<string, number> {
  const accepting = new Map<string, number>();

  for (const slot of shape.starters) {
    for (const position of slot.eligiblePositions) {
      accepting.set(position, (accepting.get(position) ?? 0) + 1);
    }
  }

  const totalStarterSlots = shape.starters.length;
  if (totalStarterSlots === 0) return accepting;

  return new Map(
    [...accepting].map(([position, slots]) => [
      position,
      // Floor, deliberately. Rounding up hands a bench spot to every position,
      // which is how the second kicker got in.
      slots + Math.floor((shape.benchSlots * slots) / totalStarterSlots),
    ]),
  );
}

/** How many players a roster already holds at a position. */
export function countAtPosition(roster: readonly DraftablePlayer[], position: string): number {
  return roster.filter((player) => player.positions.includes(position)).length;
}

/** Whether a player's positions are all at or over their cap. */
export function isAtPositionCap(
  roster: readonly DraftablePlayer[],
  player: DraftablePlayer,
  caps: ReadonlyMap<string, number>,
): boolean {
  return player.positions.every((position) => {
    const cap = caps.get(position);
    return cap !== undefined && countAtPosition(roster, position) >= cap;
  });
}

export type IllegalPickReason = "ROSTER_FULL" | "ALREADY_ROSTERED";

export interface PickLegality {
  readonly legal: boolean;
  readonly reason?: IllegalPickReason;
}

/**
 * Whether a team may draft this player at all.
 *
 * Only the two conditions that are genuinely impossible: there is no room, or
 * they already have him.
 *
 * **Drafting badly is deliberately permitted.** If a manager wants nothing but
 * wide receivers, that is their draft to lose. Blocking it would be the app
 * overruling a decision that is theirs to make, and both ESPN and Sleeper allow
 * it — Sleeper calls its version "lazy enforcement".
 *
 * The consequence is real and must be surfaced rather than hidden: see
 * {@link wouldStrandStarters}.
 */
export function canDraft(
  roster: readonly DraftablePlayer[],
  player: DraftablePlayer,
  shape: RosterShape,
  /*
    How many of `roster` do not count against `totalSlots` — injured reserve,
    per the league's signed `roster.irSlots`.

    They stay in the array. This function's identity check needs them, and so do
    its callers' drop lookups; only the count moves. Handing a filtered array
    instead would silently disable the `ALREADY_ROSTERED` branch below, and a
    caller that happens to duplicate that check today would become the only
    thing performing it.

    **Required, not defaulted**, and the argument for that is issue #237
    itself. A default of zero fails *closed* — it counts injured players against
    the limit — which sounds safe and is exactly the bug: the waiver resolver
    omitted this subtraction and refused claims a signed allowance entitled
    members to win. "A capacity rule that is right unless somebody remembers" is
    the shape that produced the defect, and this repo has paid for it once
    before, where an optional source filter defaulting to "all" was not a
    filter. Two call sites in the draft pass an explicit zero.

    Deliberately a bare count rather than an injury concept: this file decides
    roster legality and should not learn what an injury is.
  */
  exemptFromCount: number,
): PickLegality {
  if (roster.length - exemptFromCount >= shape.totalSlots) {
    return { legal: false, reason: "ROSTER_FULL" };
  }
  if (roster.some((p) => p.playerId === player.playerId)) {
    return { legal: false, reason: "ALREADY_ROSTERED" };
  }
  return { legal: true };
}

/**
 * Whether this pick would leave the team unable to field a legal lineup.
 *
 * Advisory, not a block. A manual pick may proceed anyway; auto-pick avoids it.
 *
 * The stakes are worth stating plainly wherever this surfaces in a UI: a roster
 * that cannot fill its starting slots leaves one empty, so the autofill has
 * nobody to put in it and it scores nothing every week until somebody signs or
 * trades their way out of it. On ESPN that is an embarrassment; here it is a
 * team that cannot compete in a league other people are playing.
 *
 * **Not "cannot field a legal lineup", and not "for the rest of the season."**
 * This said both, and both are stronger than the code. `validateLineup` refuses
 * an empty starter only under `requireFull`, which no production caller sets —
 * and the paragraph below says as much, that the autofill runs before a week is
 * scored so a lineup is never invalid at that moment. A hole drafted on Sunday
 * is fillable from free agency on Monday. This comment was rewritten once
 * already, to remove a forfeited-stake rule that no longer exists; the
 * replacement overshot in the other direction and contradicted its own next
 * paragraph.
 *
 * **This used to say the team would be abandoned and its stake forfeited. That
 * rule was removed in schema 4 on 2026-08-08 and is not coming back** — see
 * `DECISIONS.md` and `CLAUDE.md`'s "Abandonment is gone. Do not bring it back".
 * It could never fire: it counted consecutive weeks with an *invalid* lineup,
 * and the autofill runs before a week is scored, so a lineup is never invalid at
 * that moment. It was removed rather than repaired, because a manager who stops
 * setting lineups is not defrauding anyone and a stake forfeited for inattention
 * is a rule people would only ever meet by losing money to it.
 *
 * A comment describing a punishment the system deliberately no longer has is the
 * defect class this repo treats as real in its own right, and this one had the
 * added cost of making the consequence sound worse than it is — which is exactly
 * the kind of sentence a UI would have copied.
 *
 * @param picksRemainingAfter picks this team has left *after* this one
 */
export function wouldStrandStarters(
  roster: readonly DraftablePlayer[],
  player: DraftablePlayer,
  shape: RosterShape,
  picksRemainingAfter: number,
): boolean {
  const after = [...roster, player];
  const shortfall = shape.starters.length - startersFilled(after, shape);
  return shortfall > picksRemainingAfter;
}
