/**
 * What an account still needs before it can do anything.
 *
 * An account here is three things: an **email**, which is how you sign in; a
 * **username**, which is how other people reach you; and a **wallet**, which is
 * how you consent to anything. Signing up collects all three.
 *
 * **They are not collected in one form, and that is deliberate.** Sign-in stays
 * exactly as it was — an email, then a code — because `beginEmailSignIn` goes to
 * some trouble to answer identically whether or not the address has an account,
 * and a sign-up form that asked for a username up front would tell anyone who
 * asked which emails are registered. So the other two are collected immediately
 * *after* the code is accepted, at `/welcome`.
 *
 * ## What this does and does not enforce
 *
 * **Nothing here refuses anything.** Every caller below *reports* — the sign-in
 * redirect, the header's "finish setting up", the empty-invitations notice. An
 * earlier draft of this comment claimed the opposite, and a comment asserting a
 * guarantee the code does not provide is the defect class `CLAUDE.md` names by
 * hand, so it is worth being exact about which half is real:
 *
 * - **The wallet half is enforced, structurally and elsewhere.** `joinLeague`
 *   needs a wallet to sign the rules hash with, and there is no path that fakes
 *   one. An account with no wallet cannot join anything, whatever this file
 *   says.
 * - **The username half is enforced nowhere.** Somebody who navigates away from
 *   `/welcome` can still create a league and still join one. What they cannot do
 *   is be *found*: a commissioner invites by username or by a verified address,
 *   so an account with neither is unreachable — which is a real consequence, and
 *   not the same thing as a refusal.
 *
 * Making the username a precondition of creating or joining is a product
 * decision rather than an oversight, and it belongs to the owner: it would put a
 * new failure mode on the join path, which is the one path 22 August depends on.
 *
 * The rule lives here rather than in a component because `apps/web` cannot
 * render a component in a test — both vitest projects are node-environment with
 * no jsdom — so a gate written in `.tsx` is verified only by being run in
 * production. `lib/pot.ts` and `lib/setup.ts` are the pattern.
 */

/** What is missing, in the order it should be asked for. */
export type AccountGap = "USERNAME" | "WALLET";

export interface AccountState {
  /** `null` until they pick one. */
  readonly username: string | null;
  /** How many wallets this account has proven it holds. */
  readonly verifiedWallets: number;
}

/**
 * The gaps, in asking order — username first.
 *
 * Username comes first because it costs a keystroke and no popup, and because a
 * person who abandons the flow after picking one is still reachable: a
 * commissioner can invite them, and the invitation is waiting when they come
 * back. Someone who linked a wallet but skipped the username is reachable by
 * nothing but an address a friend would have to be told.
 *
 * An empty array means the account is complete.
 */
export function accountGaps(state: AccountState): readonly AccountGap[] {
  const gaps: AccountGap[] = [];
  if (state.username === null || state.username.trim() === "") gaps.push("USERNAME");
  if (state.verifiedWallets < 1) gaps.push("WALLET");
  return gaps;
}

export function accountComplete(state: AccountState): boolean {
  return accountGaps(state).length === 0;
}

/**
 * Why a screen is refusing, in words that name the next action.
 *
 * One sentence per gap rather than a generic "complete your profile", because
 * the two are genuinely different jobs: one is a text box, the other is a wallet
 * popup, and a person who has done the first should not be told they have done
 * nothing.
 */
export function accountGapMessage(gap: AccountGap): string {
  switch (gap) {
    case "USERNAME":
      return "Pick a username so people can invite you.";
    case "WALLET":
      return "Connect a wallet — it is what signs your consent to a league's rules.";
  }
}

/**
 * Where to send somebody who is not finished, or `null` if they are.
 *
 * `next` is carried through so the flow returns them to what they were trying
 * to do. It is passed to `safeRedirect` on the way back out — an unchecked
 * `next` on a redirect is an open redirect, and this one is reachable from a
 * link somebody could be sent.
 */
export function completionPath(state: AccountState, next?: string): string | null {
  if (accountComplete(state)) return null;
  return next ? `/welcome?next=${encodeURIComponent(next)}` : "/welcome";
}
