/**
 * Which version of the Leagues hub a visitor gets.
 *
 * Three audiences arrive at one URL and need different pages. The design draws
 * two of them (a returning manager, and a brand-new account) and the third — a
 * signed-out visitor — falls out of the same question.
 *
 * **In `lib` rather than inline in the page** for the reason `field.ts` records:
 * `apps/web` has no jsdom in either vitest project, so a branch written inside
 * the component is verified only by being run in production.
 */

export type HubView =
  /**
   * Signed out. The browse list is public and the two personal sections render
   * nothing, so this is the returning-manager layout minus the parts that need
   * an account — plus the line explaining where private leagues actually go.
   *
   * **Not the empty state**, and the distinction is the whole reason this is a
   * function. A signed-out visitor genuinely has no leagues, so a naive "is it
   * empty" test would tell them *"You are not in a league yet"* — a statement
   * about a person we cannot make, because we do not know who they are. They
   * may have eleven.
   */
  | "ANONYMOUS"
  /**
   * Signed in, in nothing, invited to nothing. The one screen every new account
   * sees first, and the one the shipped page never had — a new user was handed
   * the returning-manager heading and a directory that is usually empty too.
   */
  | "EMPTY"
  /** Signed in with at least one league or one invitation. */
  | "POPULATED";

export function hubView(input: {
  readonly signedIn: boolean;
  readonly leagueCount: number;
  readonly invitationCount: number;
}): HubView {
  if (!input.signedIn) return "ANONYMOUS";

  // An invitation counts as having something. Somebody asked for you
  // specifically, so "you are not in a league yet" is true and beside the point
  // — and the empty state's own "been invited to one?" card would be answering
  // a question the page can already see the answer to.
  if (input.leagueCount > 0 || input.invitationCount > 0) return "POPULATED";

  return "EMPTY";
}
