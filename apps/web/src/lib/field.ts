/**
 * Whether the field can draft, and what would fix it.
 *
 * **In `lib`, not in `InvitePanel`, for the reason this repo has paid for
 * repeatedly:** `apps/web` has no jsdom in either vitest project, so a rule
 * written inside a `.tsx` is verified only by being run in production. Every
 * defect found in the `@rostr/escrow` terms mapping was in the mapping rather
 * than in the comparison, and this has the same shape — a small classification
 * with one obviously wrong answer.
 *
 * That wrong answer is **counting the bot as a manager**. `drawDraftOrder`
 * refuses on the count of *humans*; a field of five plus a bot is six rows and
 * five managers. Counting rows makes an odd field look even, which hides exactly
 * the problem this exists to report, and it does so on a league that has already
 * been told it is fine.
 */

export type FieldVerdict =
  /** Even and drawable. Nothing to say, so the screen says nothing. */
  | { readonly kind: "SQUARE" }
  /** Odd, and the league's rules permit the seat that fixes it. */
  | { readonly kind: "ODD_ADD_BOT"; readonly humans: number }
  /**
   * Odd, and no bot is possible — a pot league, where `maxBots` is zero because
   * a bot has no wallet and could not be paid. One more manager is the only fix,
   * and saying so beats a button that exists only to be refused.
   */
  | { readonly kind: "ODD_NEEDS_HUMAN"; readonly humans: number }
  /**
   * Odd *and* a bot is already seated.
   *
   * Reachable, and not a contradiction: a sixth manager joins a five-plus-bot
   * league, making seven humans while the bot still holds a seat. The fix is to
   * drop the bot rather than add another, which is why this is its own verdict
   * and not folded into `ODD_ADD_BOT` — offering "add a bot" to a league that
   * has one would be refused by `BOT_LIMIT` with nothing else on offer.
   */
  | { readonly kind: "ODD_REMOVE_BOT"; readonly humans: number };

export function fieldVerdict(input: {
  /** Managers with an account behind them. Never the row count. */
  readonly humans: number;
  readonly hasBot: boolean;
  /** From the frozen rules. Zero in any league with a pot. */
  readonly maxBots: number;
}): FieldVerdict {
  const { humans, hasBot, maxBots } = input;

  if (humans % 2 === 0) return { kind: "SQUARE" };
  if (hasBot) return { kind: "ODD_REMOVE_BOT", humans };
  if (maxBots > 0) return { kind: "ODD_ADD_BOT", humans };
  return { kind: "ODD_NEEDS_HUMAN", humans };
}
