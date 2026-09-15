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

/** What this tab remembers about its last successful exchange. */
export interface ExchangeMemo {
  readonly key: string;
  readonly userId: string;
}

/**
 * Whether a page load can skip `POST /api/auth/privy`.
 *
 * Every full page load remounts the provider, and without this each one cost a
 * token from the per-address sign-in bucket, a call to Privy's API and a locking
 * transaction — enough, on a shared address, to lock the next person out.
 *
 * Skipping is safe only when **both** still hold: the linked accounts are the
 * ones this tab last exchanged (so there is nothing new for the server to
 * record), **and** rostr's session is still that same account. The second is
 * checked against the server rather than remembered, because a session can be
 * revoked or replaced by another tab — and a remembered "already signed in"
 * would then leave someone logged in to Privy with no rostr session at all.
 */
export function canSkipExchange(
  memo: ExchangeMemo | null,
  key: string,
  sessionUserId: string | null,
): boolean {
  return (
    memo !== null && sessionUserId !== null && memo.key === key && memo.userId === sessionUserId
  );
}

/** Parse a stored memo, treating anything malformed as absent. */
export function parseExchangeMemo(raw: string | null): ExchangeMemo | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as ExchangeMemo).key === "string" &&
      typeof (value as ExchangeMemo).userId === "string"
    ) {
      return { key: (value as ExchangeMemo).key, userId: (value as ExchangeMemo).userId };
    }
  } catch {
    // fall through
  }
  return null;
}
