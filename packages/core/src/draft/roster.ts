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

export type IllegalPickReason = "ROSTER_FULL" | "ALREADY_ROSTERED" | "CANNOT_FILL_STARTERS";

export interface PickLegality {
  readonly legal: boolean;
  readonly reason?: IllegalPickReason;
}

/**
 * Whether a team may draft this player.
 *
 * Three conditions, in the order a manager would think of them:
 *
 * 1. There is room on the roster.
 * 2. They do not already have him.
 * 3. **Taking him still leaves enough picks to field a legal lineup.** This is
 *    the rule that stops someone drafting six quarterbacks and arriving at Week 1
 *    unable to start a kicker. Every real platform enforces it; it is easy to
 *    miss because it only bites near the end of the draft.
 *
 * @param picksRemainingAfter picks this team has left *after* this one
 */
export function canDraft(
  roster: readonly DraftablePlayer[],
  player: DraftablePlayer,
  shape: RosterShape,
  picksRemainingAfter: number,
): PickLegality {
  if (roster.length >= shape.totalSlots) {
    return { legal: false, reason: "ROSTER_FULL" };
  }
  if (roster.some((p) => p.playerId === player.playerId)) {
    return { legal: false, reason: "ALREADY_ROSTERED" };
  }

  const after = [...roster, player];
  const shortfall = shape.starters.length - startersFilled(after, shape);

  if (shortfall > picksRemainingAfter) {
    return { legal: false, reason: "CANNOT_FILL_STARTERS" };
  }

  return { legal: true };
}
