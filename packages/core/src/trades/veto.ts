/**
 * Trades: the veto arithmetic and the windows around it.
 *
 * Pure, like every other rule in this package. What a trade *does* to rosters is
 * the database's job; whether it may happen at all is decided here, so there is
 * one definition and it can be checked without a league.
 *
 * ## Why the threshold is what it is
 *
 * One third of uninvolved managers, matching Yahoo — deliberately harder to
 * trigger than ESPN's majority. Leagues that veto trades they merely dislike are
 * miserable, and the failure mode of a lenient threshold (an occasional lopsided
 * trade) is much cheaper than the failure mode of a strict one (nobody trades).
 *
 * ## Managers, not teams
 *
 * Bots cannot vote. Counting them in the denominator would raise the bar while
 * leaving the pool of possible voters the same, which in a small league makes a
 * trade effectively un-vetoable. `docs/RULES.md` §6 states it and this is where
 * it binds.
 *
 * ## No override
 *
 * There is no commissioner veto and no commissioner force-through. An
 * administrator who can reverse a result is the thing this project exists to
 * remove, so nothing in this file takes a "who is asking" argument.
 */

import type { TradeRules } from "../rules/types.js";

/**
 * How many votes it takes to block a trade.
 *
 * Rounded **up**: at one third of 10 uninvolved managers the answer is 4, not 3.
 * Rounding down would let a minority under the stated threshold succeed, which
 * is a different rule from the one members signed.
 *
 * @param uninvolvedManagers human-managed teams that are not party to the trade
 */
export function vetoesRequired(uninvolvedManagers: number, rules: TradeRules): number {
  if (uninvolvedManagers <= 0) return 0;

  return Math.ceil((uninvolvedManagers * rules.vetoNumerator) / rules.vetoDenominator);
}

/**
 * Whether a trade has been blocked.
 *
 * **A league with nobody to object cannot block a trade.** Two managers and a
 * bot leaves zero uninvolved voters, `vetoesRequired` returns 0, and a threshold
 * of zero would mean every trade is vetoed before anyone votes. That is
 * obviously wrong, so an empty electorate lets the trade stand — the same answer
 * a real league gives when nobody objects.
 */
export function isVetoed(
  vetoes: number,
  uninvolvedManagers: number,
  rules: TradeRules,
): boolean {
  const required = vetoesRequired(uninvolvedManagers, rules);
  if (required <= 0) return false;

  return vetoes >= required;
}

/** When the veto window closes. Unix seconds. */
export function vetoWindowEndsAt(acceptedAt: number, rules: TradeRules): number {
  return acceptedAt + rules.vetoWindowHours * 3600;
}

/** Whether the window has closed and the trade may execute. */
export function vetoWindowHasClosed(
  acceptedAt: number,
  now: number,
  rules: TradeRules,
): boolean {
  return now >= vetoWindowEndsAt(acceptedAt, rules);
}

export type TradeBlock = "TRADES_DISABLED" | "PAST_DEADLINE" | "SAME_TEAM" | "NOTHING_OFFERED";

/**
 * Whether a trade landing in `executionWeek` is past the league's deadline.
 *
 * **One definition, because the rule is enforced twice.** `docs/RULES.md` §6
 * requires both a proposal check — against the earliest week the trade could
 * land in — and a resolution check, since a trade left unaccepted for days
 * slides past the first. Two comparisons written separately are two chances to
 * write it differently, and the deadline exists to stop an eliminated team
 * handing its roster to a contender.
 *
 * **`null` is past every deadline, and that direction is deliberate.** The
 * caller supplies the week a trade would execute in, derived from the schedule;
 * `null` means it could not be determined — the season's games are exhausted,
 * or no schedule is ingested for the league's season at all. Reading that as
 * "not past the deadline" would open the trade window permanently the moment a
 * season ended, which is precisely the January free-for-all the deadline exists
 * to prevent. A rule that cannot be checked is not a rule that does not apply.
 *
 * The cost of the strict direction is that a league whose schedule has never
 * been ingested cannot trade. That league cannot set a lineup either — every
 * lock derives from `games.kickoff_at`, and `setLineup` already refuses without
 * a schedule — so it is not operational in the first place.
 */
export function pastTradeDeadline(executionWeek: number | null, rules: TradeRules): boolean {
  return executionWeek === null || executionWeek > rules.deadlineWeek;
}

/**
 * Whether a trade may be proposed at all.
 *
 * The deadline is checked against the week the trade would *execute*, not the
 * week it was proposed. A trade accepted on the deadline still has a 48-hour
 * window to run, and a trade that executed after the deadline would be exactly
 * what the deadline exists to prevent: an eliminated team handing its roster to
 * a contender.
 *
 * `week` is that execution week, or `null` when the schedule cannot answer —
 * see `pastTradeDeadline` for why that refuses rather than permits.
 */
export function tradeBlockedBecause(input: {
  readonly rules: TradeRules;
  readonly week: number | null;
  readonly proposerTeamId: string;
  readonly receiverTeamId: string;
  readonly proposerGives: readonly string[];
  readonly receiverGives: readonly string[];
}): TradeBlock | null {
  if (!input.rules.enabled) return "TRADES_DISABLED";
  if (pastTradeDeadline(input.week, input.rules)) return "PAST_DEADLINE";
  if (input.proposerTeamId === input.receiverTeamId) return "SAME_TEAM";

  // A trade where one side gives nothing is a gift, and a gift is how an
  // eliminated team hands its roster to a friend without anyone calling it a
  // trade. Both sides must move somebody.
  if (input.proposerGives.length === 0 || input.receiverGives.length === 0) {
    return "NOTHING_OFFERED";
  }

  return null;
}
