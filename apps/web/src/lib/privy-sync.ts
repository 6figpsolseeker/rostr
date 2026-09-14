/**
 * When the browser should tell the server about a Privy account again.
 *
 * `POST /api/auth/privy` mints the session *and* brings the rostr account up to
 * date from Privy's record. The record changes after login on its own: the
 * embedded wallet is created a moment later on a person's first sign-in, and X
 * is linked whenever they get round to it. So the browser re-posts whenever the
 * set of linked accounts changes, and not otherwise.
 *
 * Kept out of the component because `apps/web` cannot render one in a test.
 * The key is deliberately coarse — every linked account, not only the ones the
 * server keeps — so that which facts matter is decided in one place, on the
 * server, and a new one needs no change here.
 */

/** The parts of Privy's browser-side `User` this reads. */
export interface PrivySyncUser {
  readonly id: string;
  readonly linkedAccounts: ReadonlyArray<{
    readonly type: string;
    readonly address?: string | null;
    readonly subject?: string | null;
    readonly username?: string | null;
  }>;
}

/**
 * A string that changes exactly when the account is worth re-posting.
 *
 * Sorted, so Privy returning the same accounts in another order is not a
 * change. The username is included because a renamed X handle is one.
 */
export function privySyncKey(user: PrivySyncUser): string {
  const parts = user.linkedAccounts.map((account) =>
    [account.type, account.address ?? account.subject ?? "", account.username ?? ""].join("|"),
  );
  return [user.id, ...parts.sort()].join("\n");
}
