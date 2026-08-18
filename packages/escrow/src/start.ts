/**
 * When a league must have declared its season started, and what happens if it
 * never does.
 *
 * ## The rule
 *
 * A league that is not ready at its draft time — short of its buy-ins, or with
 * an odd field — gives everyone their money back **then**, not in six months.
 * The ordinary timelock is a season and sixty days past the draft (see
 * `earliestRefundUnlock`), which is right for a pot being played for and absurd
 * for a league that never started.
 *
 * The program cannot tell those apart: the roster, the draft and who has paid
 * are Postgres facts, and `rules_hash` is 32 opaque bytes to it. So the default
 * is failure. A league that was ready calls `start_season` inside its window; a
 * league that was not never does, and its members are released automatically.
 * **Doing nothing is what returns the money.**
 *
 * ## Why the deadline is derived here rather than on-chain
 *
 * `League.start_deadline` is an explicit instant, not a draft time the program
 * adds a constant to — for the same reason `refund_unlock_at` is. The program
 * has no schedule and no view of a league's calendar, so a deadline it computed
 * would be computed from something it was handed anyway.
 *
 * What makes that safe is the same thing that makes every other term safe: the
 * anchor route derives the expected value from the **signed rule set** and
 * refuses an account that disagrees (`anchorTermMismatches`). A creator can no
 * more anchor a deadline nobody agreed to than a buy-in nobody agreed to.
 */

/**
 * How long after its draft time a league has to declare itself started. 48
 * hours.
 *
 * Two days rather than minutes, because the commissioner has to be awake: the
 * draft time is a moment they chose months earlier, and drawing the order is a
 * button somebody presses. Two days rather than a week, because every hour here
 * is an hour a failed league's members wait for money that is already theirs.
 *
 * It bounds a *window*, never the refund. Once the failed-league refund opens it
 * never closes again — a refund that expires is a way for money to become
 * permanently stuck, which is the one outcome the escrow exists to prevent.
 */
export const START_GRACE_SECONDS = 48 * 60 * 60;

/**
 * The instant a league must have started by, from its frozen draft time.
 *
 * Unix seconds in, unix seconds out. Both the anchor instruction and the check
 * that verifies it read this, so the value written on-chain and the value
 * expected from the rules cannot drift apart.
 */
export function startDeadlineFor(draftScheduledAt: number): number {
  return draftScheduledAt + START_GRACE_SECONDS;
}

/**
 * Where a league stands in its start window.
 *
 * - `NOT_REQUIRED` — a free league. `start_season` requires `has_pot`, so there
 *   is no instruction to send and no vault for it to protect.
 * - `STARTED` — the chain says so. The failed-league refund is shut and the
 *   ordinary timelock is the only way out, which is the point.
 * - `OPEN` — not started, and it still can be.
 * - `MISSED` — not started, and it no longer can be. Every stake is refundable
 *   from this instant and the season cannot begin. See below.
 */
export type SeasonStartState = "NOT_REQUIRED" | "STARTED" | "OPEN" | "MISSED";

export interface SeasonStartInput {
  readonly hasPot: boolean;
  /** Whether `start_season` has landed. */
  readonly started: boolean;
  /** Unix seconds — `startDeadlineFor(rules.draft.scheduledAt)`. */
  readonly startDeadline: number;
  /** Unix seconds. */
  readonly now: number;
}

/**
 * Which of the four states a league's season start is in.
 *
 * ## `MISSED` is a real state, not an error case
 *
 * `start_season` is refused from exactly the instant the failed-league refund
 * opens — `require!(now < league.start_deadline)` against
 * `!started && now >= start_deadline` — so the two are complements and can never
 * both be legal. That is what makes the design safe: a league cannot be declared
 * started with a partly-drained vault.
 *
 * The cost of that safety is a commissioner who leaves it late. Two days after
 * the draft time the season **cannot** be started, the field has been locked
 * since the draft time and nothing can dissolve the league — so what remains is
 * a league that will never play and stakes that are all refundable. There is no
 * recovery instruction and there should not be one; every extra condition on
 * `refund_stake` is a new way for money to become permanently stuck.
 *
 * So this state exists to be **rendered**, not handled. A screen that shows only
 * a dead button leaves people waiting for a draft that is not coming while their
 * money sits recoverable and unclaimed.
 *
 * The boundary is taken from the program: `<` opens, `>=` closes. A UI that
 * offered the button at the deadline would send a transaction the chain rejects.
 */
export function seasonStartState(input: SeasonStartInput): SeasonStartState {
  if (!input.hasPot) return "NOT_REQUIRED";
  if (input.started) return "STARTED";
  return input.now < input.startDeadline ? "OPEN" : "MISSED";
}
