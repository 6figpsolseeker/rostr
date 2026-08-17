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
