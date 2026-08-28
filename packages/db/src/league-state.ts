/**
 * When a league is playing, and therefore when its rosters may move.
 *
 * One fact, in one place, because two files enforce it and they must not be
 * able to disagree. `waivers.ts` refuses free-agent adds, drops and claims
 * outside these states (issue #279); `trades.ts` refuses proposals and
 * acceptances. If those two ever answered differently, a manager could reach
 * the same roster through the door that had not been told.
 *
 * It lives in its own module rather than in either of them because `waivers.ts`
 * already imports from `trades.ts`, so the reverse import would close a cycle —
 * and a module-level `Set` inside a cycle is a temporal-dead-zone hazard that
 * depends on which file the bundler loads first. This module imports nothing.
 *
 * **The SQL predicates are deliberately not derived from this.** A query cannot
 * import a `Set`, and the two selection queries do not even ask the same
 * question: `leaguesDueForWaivers` names the states it wants, while
 * `leaguesWithDueTrades` names the two it must avoid. See that function for why
 * the difference is not an oversight.
 */
const TRANSACTING_STATES = new Set(["IN_SEASON", "PLAYOFFS"]);

/**
 * Whether this league is playing.
 *
 * `state` is a `string` rather than a union because nothing in this repo has
 * ever given `leagues.state` one — every boundary that carries it types it as
 * `string`, unlike `TradeState` or `CronJobState`, which are declared unions.
 * Narrowing it is worth doing and is worth doing everywhere at once, which is a
 * larger change than the one this file arrived with.
 */
export function isTransacting(state: string): boolean {
  return TRANSACTING_STATES.has(state);
}
