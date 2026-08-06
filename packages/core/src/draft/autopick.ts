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
 *   1. The manager's queue, skipping anyone taken or unsafe
 *   2. Best available at the most-needed starting slot
 *   3. Best available that still leaves a fillable lineup
 *   4. Best available at all — only reachable if the manager already stranded
 *      their own lineup by hand
 *
 * "Unsafe" means it would leave the starting lineup unfillable. A manager may do
 * that to themselves deliberately; auto-pick never does it on their behalf,
 * because they were not there to choose and the penalty is a forfeited stake.
 */

import type { DraftablePlayer, RosterShape } from "./roster.js";
import { canDraft, unfilledStarterSlots, wouldStrandStarters } from "./roster.js";

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

  const isLegal = (player: DraftablePlayer): boolean => canDraft(roster, player, shape).legal;

  /**
   * Legal *and* leaves a fillable lineup.
   *
   * A manager who picks manually may strand their own starters — that is their
   * call. Auto-pick must not do it on their behalf, because the manager was not
   * there to make the choice and the penalty is a forfeited stake.
   */
  const isSafe = (player: DraftablePlayer): boolean =>
    isLegal(player) && !wouldStrandStarters(roster, player, shape, picksRemainingAfter);

  // 1. The queue. Persistent across the draft, so entries taken by other
  //    managers are skipped rather than treated as an empty queue. A queued
  //    player who would strand the lineup is skipped too — the queue was written
  //    before the board looked like this.
  for (const playerId of queue) {
    const queued = byId.get(playerId);
    if (queued && isSafe(queued)) {
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
        isSafe(player),
    );
    if (best) return { player: best, source: "NEED", slotType: slot.slotType };
  }

  // 3. Starters are covered; take the best player who keeps them covered.
  const safest = ranked.find(isSafe);
  if (safest) return { player: safest, source: "BEST_AVAILABLE" };

  // 4. Nothing keeps the lineup fillable — which happens only when a manager
  //    already stranded it by hand. Auto-pick cannot undo that, so it takes the
  //    best legal player rather than refusing to pick and stalling the draft.
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
