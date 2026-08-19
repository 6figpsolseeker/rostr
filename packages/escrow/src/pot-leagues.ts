/**
 * Whether this deployment offers pot leagues at all.
 *
 * ## Why this exists
 *
 * **Decided by the owner on 2026-08-18: no pot leagues for the 2026 season, on
 * any cluster.** Not a configuration gap, not a temporary consequence of some
 * other thing being unfinished — a product decision, recorded here because the
 * alternative is a deployment where pot leagues are off because somebody forgot
 * to set an environment variable, which is a guarantee that holds by accident.
 *
 * The money path is finished and tested: join, stake, settle and the timelock
 * refund all work, and `settle.bankrun.test.ts` watches a pot actually pay out.
 * This closes the door in front of all of it, deliberately and reversibly.
 *
 * ## Its relationship to `potDepositGate`
 *
 * `potDepositGate` next door asks "can the program pay a pot back out", and
 * opened by itself the day settlement shipped. This gate sits **in front** of
 * it and is strictly stronger: a league that cannot be created can never reach
 * a deposit, so while this is shut the deposit gate decides nothing about new
 * leagues.
 *
 * They are kept separate rather than collapsed because they answer different
 * questions and will stop agreeing. This one is a season's product decision and
 * flips by editing this file; that one is a fact about the committed IDL and
 * flips by shipping Rust. Folding a decision into a derivation would make the
 * derived one untrue.
 *
 * ## What it deliberately does not touch
 *
 * **Leagues that already exist.** `validateLeagueRules` is a pure function of
 * the frozen document and must stay one: a rule set that was valid when it was
 * hashed and signed has to stay valid forever, or every league frozen before
 * today stops verifying. So this gate lives at the point of *creation* and
 * nowhere near validation, and the devnet pot leagues already drafted go on
 * working — including their deposits, their draws and their settlement.
 *
 * That is also why it is not a migration and not a column. Nothing about a
 * stored league changes; only what this app will agree to create.
 *
 * ## Reversing it
 *
 * Set `POT_LEAGUES_OPEN` to `true`. There is nothing else — no environment
 * variable, no database state, no on-chain condition. `pot-leagues.test.ts`
 * pins both directions so the open path cannot rot while the door is shut.
 */

/**
 * The switch itself.
 *
 * A plain constant rather than a function of the environment, because the
 * decision is the same in every environment and a per-deployment answer would
 * mean production and a developer's laptop could disagree about which product
 * this is.
 *
 * Annotated `boolean` rather than left to infer `false`. The literal type would
 * narrow every `if (!POT_LEAGUES_OPEN)` to always-true and mark the reopen path
 * unreachable — which is exactly how the path rots while the door is shut, and
 * the whole point of a switch is that the other side of it still works.
 */
export const POT_LEAGUES_OPEN: boolean = false;

export type PotLeagueGate =
  { readonly open: true } | { readonly open: false; readonly reason: "NOT_THIS_SEASON" };

/**
 * What every caller reads.
 *
 * The reason code exists so the two callers — the create route and the create
 * form — cannot drift into explaining the refusal differently. It is a union
 * rather than a boolean for the same reason `DepositGate` is: a future second
 * reason should force every call site to be revisited.
 */
export function potLeagueGate(open: boolean = POT_LEAGUES_OPEN): PotLeagueGate {
  return open ? { open: true } : { open: false, reason: "NOT_THIS_SEASON" };
}

/**
 * The one sentence the product says about it.
 *
 * Shared so the screen and the API give the same answer. A creator who is told
 * "coming soon" by the form and something else by a 503 has been told the
 * feature is broken rather than deferred.
 */
export const POT_LEAGUES_COMING_SOON =
  "Pot leagues are coming soon. Every league this season is free to play — " +
  "the rules are still frozen on-chain and everything else works exactly the same.";
