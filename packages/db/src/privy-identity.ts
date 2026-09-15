/**
 * Signing in through Privy, from facts the web app has already verified.
 *
 * Privy runs the login ceremony and rostr owns the account: this module never
 * sees a token and holds no Privy dependency. The caller verifies the access
 * token, fetches the Privy user record with the app secret, and hands over
 * {@link VerifiedPrivyAccount} — so everything here may be trusted exactly as
 * far as that verification, and no field may ever come out of a request body.
 */

import type { SqlClient } from "./client.js";
import { IdentityError, linkWallet, type User } from "./identity.js";
import { isDeadlock, isUniqueViolation } from "./pg-errors.js";
import { withTransaction } from "./transaction.js";

export class PrivySignInError extends Error {
  constructor(
    message: string,
    readonly code:
      /** The Privy account carries no email Privy verified. */
      | "EMAIL_REQUIRED"
      /** The email belongs to a rostr account already joined to a different Privy account. */
      | "ACCOUNT_CONFLICT"
      /** The embedded wallet is linked to another rostr account. */
      | "WALLET_TAKEN",
  ) {
    super(message);
    this.name = "PrivySignInError";
  }
}

/** What Privy vouches for, after the web app has checked it. */
export interface VerifiedPrivyAccount {
  /** Privy's user id, taken from a verified token's subject. */
  readonly privyUserId: string;
  /**
   * An email address Privy verified by code, or `null`.
   *
   * **Only a verified address may be passed**, because it is what attaches an
   * existing rostr account. An address from an OAuth profile is somebody's
   * claim about an inbox, and matching on it would let anyone who typed a
   * victim's email into a provider sign in to the victim's leagues.
   */
  readonly verifiedEmail: string | null;
  /** Solana addresses of wallets Privy generated for this user and holds the keys to. */
  readonly embeddedSolanaWallets: readonly string[];
  /** The linked X account, or `null` when there is none — which clears a stale one. */
  readonly x: { readonly subject: string; readonly username: string | null } | null;
}

export interface PrivySignIn {
  readonly user: User;
  /** True when this sign-in created the rostr account. */
  readonly isNew: boolean;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  email_verified_at: string | null;
  username: string | null;
  privy_user_id: string | null;
}

const USER_COLUMNS = "id, email, display_name, email_verified_at, username, privy_user_id";

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified_at !== null,
    username: row.username,
  };
}

/**
 * Find or create the rostr account behind a Privy login, and bring its wallets
 * and X account up to date.
 *
 * ## Which account
 *
 * 1. **The one already joined to this Privy user.** Its email is left alone:
 *    rostr's address is what invitations and notices go to, and a change in
 *    Privy is not a request to change it here.
 * 2. Otherwise **the one holding the same email**, attached only when Privy
 *    verified that email. Refused when that account is already joined to a
 *    *different* Privy user — two Privy accounts reaching one rostr account is
 *    the shape of a takeover, and nothing about this login says which is real.
 * 3. Otherwise **a new account**, which needs a verified email too: `users.email`
 *    is how an invitation reaches somebody.
 *
 * ## Safe to run twice at once
 *
 * The first sign-in of a new person usually arrives twice — the wallet is created
 * a moment after login, and the browser syncs again. Two transactions can then
 * both find nothing and both insert; the unique indexes refuse the loser, and
 * it runs once more, now finding the winner's row. One retry, because the second
 * attempt cannot meet the same race: the row it lost to is committed.
 *
 * The retry wraps the whole attempt rather than one statement, against the advice
 * in `pg-errors.ts`, and that is deliberate: every unique index this attempt can
 * trip — a users email or Privy id, an X subject — is the trace of a concurrent
 * sign-in, and the fix in each case is to re-read. A wallet collision is not one
 * of them; `linkWallet` turns it into `WALLET_TAKEN` before it gets here.
 *
 * A deadlock is retried too. Clearing a stale X holder locks *another* account's
 * row after this login's own, so two people whose Privy users swapped X accounts,
 * signing in at the same instant, lock in opposite orders; Postgres aborts one,
 * and re-running it after the other has committed finds nothing left to clear.
 *
 * **Two posts for one existing account race differently, and that case is not a
 * unique violation.** Both miss on the Privy id; the first locks the row by email
 * and attaches it; the second waits on that lock and, at READ COMMITTED, re-reads
 * the committed row — already carrying this same Privy id. That is the account
 * this login owns, so it is carried on with, not refused as a conflict.
 */
export async function signInWithPrivy(
  db: SqlClient,
  account: VerifiedPrivyAccount,
  now: Date = new Date(),
): Promise<PrivySignIn> {
  try {
    return await withTransaction(db, (tx) => attempt(tx, account, now));
  } catch (error) {
    if (!isUniqueViolation(error) && !isDeadlock(error)) throw error;
    return withTransaction(db, (tx) => attempt(tx, account, now));
  }
}

async function attempt(
  tx: SqlClient,
  account: VerifiedPrivyAccount,
  now: Date,
): Promise<PrivySignIn> {
  const { row, isNew } = await resolveAccount(tx, account, now);

  for (const address of account.embeddedSolanaWallets) {
    try {
      // `verified` is honest here for a different reason than a signature:
      // Privy generated this key for this user and holds it, and we learned
      // the address from Privy's own record over an authenticated call. Nobody
      // typed it.
      await linkWallet(tx, row.id, address, { verified: true });
    } catch (error) {
      if (error instanceof IdentityError && error.code === "WALLET_TAKEN") {
        throw new PrivySignInError(error.message, "WALLET_TAKEN");
      }
      throw error;
    }
  }

  await syncX(tx, row.id, account.x);

  return { user: toUser(row), isNew };
}

async function resolveAccount(
  tx: SqlClient,
  account: VerifiedPrivyAccount,
  now: Date,
): Promise<{ row: UserRow; isNew: boolean }> {
  const [joined] = await tx.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE privy_user_id = $1 FOR UPDATE`,
    [account.privyUserId],
  );
  if (joined) return { row: joined, isNew: false };

  const email = account.verifiedEmail?.trim() ?? "";
  if (email === "") {
    throw new PrivySignInError("Sign in with an email address", "EMAIL_REQUIRED");
  }

  const [byEmail] = await tx.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1) FOR UPDATE`,
    [email],
  );
  if (byEmail) {
    // Attached a moment ago by this same login's other request — see above.
    if (byEmail.privy_user_id === account.privyUserId) return { row: byEmail, isNew: false };
    if (byEmail.privy_user_id !== null) {
      throw new PrivySignInError(
        "This email belongs to an account that signs in another way",
        "ACCOUNT_CONFLICT",
      );
    }
    // COALESCE: the first proof of the inbox is the one worth keeping.
    const [attached] = await tx.query<UserRow>(
      `UPDATE users
          SET privy_user_id = $2,
              email_verified_at = COALESCE(email_verified_at, $3)
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [byEmail.id, account.privyUserId, now.toISOString()],
    );
    return { row: attached!, isNew: false };
  }

  const [created] = await tx.query<UserRow>(
    `INSERT INTO users (email, display_name, email_verified_at, privy_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING ${USER_COLUMNS}`,
    [email, email.split("@")[0] || email, now.toISOString(), account.privyUserId],
  );
  return { row: created!, isNew: true };
}

async function syncX(
  tx: SqlClient,
  userId: string,
  x: VerifiedPrivyAccount["x"],
): Promise<void> {
  // Another account still holding this X subject is holding a stale copy. Privy
  // lets one X account belong to one Privy user at a time, and this record — read
  // from Privy with our app secret — says it belongs to this login now; the other
  // copy is left over from an unlink or a deleted Privy user whose follow-up sync
  // never landed. It is cleared rather than refused: X is optional and never a
  // way in, so an old copy of it must not be able to lock somebody out.
  if (x !== null) {
    await tx.query(
      "UPDATE users SET x_subject = NULL, x_username = NULL WHERE x_subject = $1 AND id <> $2",
      [x.subject, userId],
    );
  }

  await tx.query("UPDATE users SET x_subject = $2, x_username = $3 WHERE id = $1", [
    userId,
    x?.subject ?? null,
    x?.username ?? null,
  ]);
}
