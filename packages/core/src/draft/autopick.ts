/**
 * Auto-pick.
 *
 * One routine, two callers: a human whose clock expired, and a bot on every
 * pick. Deliberately not two implementations — a bot that drafted by different
 * logic than the auto-pick would be a second thing to get right, and the
 * difference would show up as "the bot outdrafted me while I was asleep".
 *
 * The order is:
 *
 *   1. The manager's queue, skipping anyone taken or illegal
 *   2. Best available at the most-needed starting slot
 *   3. Best available that is legal at all
 *
 * Step 3 exists because late in a draft, needs are met and the only requirement
 * is a legal roster.
 */

import type { DraftablePlayer, RosterShape } from "./roster.js";
import { canDraft, unfilledStarterSlots } from "./roster.js";

export interface AutoPickContext {
  /** Available players, best first. Ranking comes from the provider. */
  readonly available: readonly DraftablePlayer[];
  readonly roster: readonly DraftablePlayer[];
  /** The manager's ordered queue, as player IDs. Empty for bots. */
  readonly queue: readonly string[];
  readonly shape: RosterShape;
  readonly picksRemainingAfter: number;
}

export type AutoPickSource = "QUEUE" | "NEED" | "BEST_AVAILABLE";

export interface AutoPickResult {
  readonly player: DraftablePlayer;
  readonly source: AutoPickSource;
  /** Set when `source` is `NEED`. */
  readonly slotType?: string;
}

/**
 * Choose a player automatically.
 *
 * @returns `null` only when no legal pick exists at all, which means the roster
 * is full — the draft should have ended.
 */
export function autoPick(context: AutoPickContext): AutoPickResult | null {
  const { available, roster, queue, shape, picksRemainingAfter } = context;

  const byId = new Map(available.map((player) => [player.playerId, player]));
  const isLegal = (player: DraftablePlayer): boolean =>
    canDraft(roster, player, shape, picksRemainingAfter).legal;

  // 1. The queue. Persistent across the whole draft, so entries taken by other
  //    managers are skipped rather than treated as an empty queue.
  for (const playerId of queue) {
    const queued = byId.get(playerId);
    if (queued && isLegal(queued)) {
      return { player: queued, source: "QUEUE" };
    }
  }

  // 2. Most-needed starting slot. `unfilledStarterSlots` returns roster order,
  //    so a team missing both a QB and a kicker takes the QB first.
  const ranked = [...available].sort((a, b) => a.rank - b.rank);

  for (const slot of unfilledStarterSlots(roster, shape)) {
    const best = ranked.find(
      (player) =>
        player.positions.some((position) => slot.eligiblePositions.includes(position)) &&
        isLegal(player),
    );
    if (best) return { player: best, source: "NEED", slotType: slot.slotType };
  }

  // 3. Starters are covered; take the best legal player left.
  const best = ranked.find(isLegal);
  return best ? { player: best, source: "BEST_AVAILABLE" } : null;
}

/**
 * Remove players from a queue who are no longer available.
 *
 * Cosmetic — `autoPick` already skips them — but managers should not be shown a
 * queue full of players somebody else drafted.
 */
export function pruneQueue(
  queue: readonly string[],
  available: readonly DraftablePlayer[],
): readonly string[] {
  const availableIds = new Set(available.map((player) => player.playerId));
  return queue.filter((playerId) => availableIds.has(playerId));
}
