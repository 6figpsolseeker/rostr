/**
 * Users, email verification, and wallet linking.
 *
 * A wallet is an address, not a person. Email gives an identity that exists
 * before someone opens the app — which invites, display names, and time-boxed
 * notifications all need.
 */

import { randomInt, timingSafeEqual } from "node:crypto";
import { isValidWalletAddress, sha256Hex } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { isUniqueViolation } from "./pg-errors.js";

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EMAIL_TAKEN"
      | "USER_NOT_FOUND"
      | "INVALID_WALLET"
      | "WALLET_TAKEN"
      | "TOKEN_INVALID"
      | "TOKEN_EXPIRED"
      | "INVALID_USERNAME"
      | "USERNAME_TAKEN",
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  /**
   * The name other people can type — see `usernames.ts`.
   *
   * **Nullable, and that is not the same as optional.** An account is not usable
   * until it has one: it is what a commissioner types to invite you, and
   * `accountGaps` in the web app refuses to let an incomplete account create,
   * join or invite. What it cannot be is a precondition of *signing in*, because
   * every account created before this column existed has none, and because
   * demanding it during sign-in would mean the flow behaves differently for a
   * new email than for a known one — which is exactly the tell
   * `beginEmailSignIn` goes to some trouble not to give.
   */
  readonly username: string | null;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  email_verified_at: string | null;
  username: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified_at !== null,
    username: row.username,
  };
}

export async function createUser(
  db: SqlClient,
  email: string,
  displayName: string,
): Promise<User> {
  const existing = await db.query<UserRow>(
    "SELECT id, email, display_name, email_verified_at, username FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  if (existing.length > 0) {
    throw new IdentityError("Email is already registered", "EMAIL_TAKEN");
  }

  const [row] = await db.query<UserRow>(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     RETURNING id, email, display_name, email_verified_at, username`,
    [email, displayName],
  );
  return toUser(row!);
}

export async function getUser(db: SqlClient, userId: string): Promise<User | null> {
  const [row] = await db.query<UserRow>(
    "SELECT id, email, display_name, email_verified_at, username FROM users WHERE id = $1",
    [userId],
  );
  return row ? toUser(row) : null;
}

export async function findUserByEmail(db: SqlClient, email: string): Promise<User | null> {
  const [row] = await db.query<UserRow>(
    "SELECT id, email, display_name, email_verified_at, username FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  return row ? toUser(row) : null;
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * How long a sign-in code stays usable.
 *
 * Ten minutes, where the link it replaced lasted twenty-four hours. The link
 * could afford that: `randomBytes(32)` is 2^256 possibilities and guessing was
 * never the threat. A six-digit code is 1,000,000, so the window in which
 * guessing is possible at all is part of what keeps it safe — along with
 * {@link MAX_CODE_ATTEMPTS} and the per-address limit in the rate limiter.
 *
 * Ten minutes is also about as long as anyone waits for an email before giving
 * up and asking for another, so it costs almost nothing in practice.
 */
export const VERIFICATION_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses before a code is destroyed.
 *
 * With this, an attacker gets five tries per issued code rather than unlimited
 * tries against a million possibilities — and issuing codes is itself capped by
 * `SIGN_IN_PER_EMAIL`. Without it, six digits would be guessable in an
 * afternoon and this whole change would be a downgrade.
 *
 * Five rather than three: people mistype, and a code that dies on a fat-fingered
 * digit sends them back to their inbox for another one, which is its own kind of
 * broken.
 */
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Six digits, uniformly random.
 *
 * `randomInt` rather than `randomBytes` and a modulo: taking a byte modulo 10
 * makes the low digits likelier than the high ones, which shrinks the search
 * space for free. Padded, so `000042` stays six characters and cannot be
 * confused with a shorter code.
 */
function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Compare two hex digests without leaking how far they matched.
 *
 * Both sides are SHA-256 of something, so they are always the same length and
 * `timingSafeEqual` cannot throw here. Comparing hashes rather than the codes
 * themselves already blunts a timing attack — but the attacker supplies one
 * side, and an early-exit `===` over a value they control is the shape worth
 * never writing.
 */
function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface VerificationToken {
  /** Send this to the user. It is never stored — only its SHA-256 is. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Issue a sign-in code.
 *
 * Only the SHA-256 is stored, so a database leak does not hand an attacker
 * working credentials — the same reasoning as password hashing. The attempt
 * counter resets here by construction, since the row is deleted and rewritten:
 * a fresh code deserves a fresh five tries.
 */
export async function issueVerificationToken(
  db: SqlClient,
  userId: string,
  now: Date = new Date(),
): Promise<VerificationToken> {
  const user = await getUser(db, userId);
  if (!user) throw new IdentityError("User not found", "USER_NOT_FOUND");

  const token = generateCode();
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);

  // Supersede any outstanding token so an old link cannot be reused.
  await db.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [userId]);
  await db.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, sha256Hex(token), expiresAt.toISOString()],
  );

  return { token, expiresAt };
}

/**
 * Consume a sign-in code and mark the email verified.
 *
 * ## Looked up by user, not by credential
 *
 * The link version found its row by hashing the token, which works when the
 * token is unguessable and cannot work here: a wrong guess simply matches no
 * row, and there would be nothing to count the attempt against. So this takes
 * the address as well, finds that user's outstanding code, and compares.
 *
 * ## A wrong guess costs an attempt, not the code
 *
 * Deleting on the first mistake would make a mistyped digit indistinguishable
 * from an expired code, and send people back to their inbox constantly. The row
 * survives until {@link MAX_CODE_ATTEMPTS} is reached and is then destroyed —
 * which is what makes six digits safe.
 *
 * ## Every failure says the same thing
 *
 * Wrong code, no code outstanding, unknown address, too many attempts: all
 * `TOKEN_INVALID`. Distinguishing them would say whether an account exists, and
 * `beginEmailSignIn` goes to some trouble not to. Expiry is the one exception —
 * it is reported, because the user's next action differs and it reveals nothing
 * they did not already know.
 */
export async function verifySignInCode(
  db: SqlClient,
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<User> {
  const user = await findUserByEmail(db, email);
  if (!user) throw new IdentityError("That code is not valid", "TOKEN_INVALID");

  const [row] = await db.query<{
    user_id: string;
    expires_at: string;
    token_hash: string;
    attempts: number;
  }>(
    `SELECT user_id, expires_at, token_hash, attempts
       FROM email_verification_tokens WHERE user_id = $1`,
    [user.id],
  );
  if (!row) throw new IdentityError("That code is not valid", "TOKEN_INVALID");

  if (!sameHash(row.token_hash, sha256Hex(code.trim()))) {
    const attempts = Number(row.attempts) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await db.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [user.id]);
    } else {
      await db.query("UPDATE email_verification_tokens SET attempts = $2 WHERE user_id = $1", [
        user.id,
        attempts,
      ]);
    }
    throw new IdentityError("That code is not valid", "TOKEN_INVALID");
  }

  // Correct: single use, gone whether or not it had expired.
  await db.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [user.id]);

  if (new Date(row.expires_at).getTime() < now.getTime()) {
    throw new IdentityError("That code has expired", "TOKEN_EXPIRED");
  }

  const [updated] = await db.query<UserRow>(
    // COALESCE, not assignment: these tokens double as sign-in links, so this
    // runs on every login. Overwriting would keep resetting "verified since" to
    // the most recent sign-in.
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1
     RETURNING id, email, display_name, email_verified_at, username`,
    [row.user_id, now.toISOString()],
  );
  return toUser(updated!);
}

/**
 * Start an email sign-in, registering the account if it is new.
 *
 * One entry point for both cases on purpose. Separate "register" and "sign in"
 * routes would differ in their responses, and the difference tells anyone who
 * asks whether a given email has an account here.
 */
export async function beginEmailSignIn(
  db: SqlClient,
  email: string,
  displayName?: string,
  now: Date = new Date(),
): Promise<{ user: User; token: VerificationToken; isNew: boolean }> {
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new IdentityError("Not a valid email address", "TOKEN_INVALID");
  }

  const existing = await findUserByEmail(db, trimmed);
  const user =
    existing ?? (await createUser(db, trimmed, displayName?.trim() || trimmed.split("@")[0]!));

  return {
    user,
    token: await issueVerificationToken(db, user.id, now),
    isNew: existing === null,
  };
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export interface Wallet {
  readonly id: string;
  readonly address: string;
  readonly isPrimary: boolean;
}

/**
 * Link a wallet to a user.
 *
 * The first wallet linked becomes primary. An address may belong to only one
 * user — enforced by a unique index, checked here for a usable error.
 */
export async function linkWallet(
  db: SqlClient,
  userId: string,
  address: string,
  options: {
    /**
     * Whether the caller has proved the holder controls this key.
     *
     * **Only `linkWalletWithSignature` may pass true**, and it is the only
     * caller that has checked a signature. Everything reading
     * `wallets.verified_at` — `findUserByWallet`, and through it invite-by-
     * address and wallet sign-in — is asking exactly that question.
     */
    readonly verified?: boolean;
  } = {},
): Promise<Wallet> {
  if (!isValidWalletAddress(address)) {
    throw new IdentityError("Not a valid Solana public key", "INVALID_WALLET");
  }

  const [claimed] = await db.query<{ user_id: string }>(
    "SELECT user_id FROM wallets WHERE address = $1",
    [address],
  );
  if (claimed) {
    if (claimed.user_id === userId) {
      // Re-linking upgrades an unproven row rather than leaving it. Somebody who
      // linked before verification existed, or whose first attempt failed after
      // the insert, gets the same outcome as anyone else — and `COALESCE` keeps
      // the original moment rather than restamping it on every re-link.
      if (options.verified === true) {
        await db.query(
          "UPDATE wallets SET verified_at = COALESCE(verified_at, now()) WHERE address = $1",
          [address],
        );
      }

      const [existing] = await db.query<{ id: string; address: string; is_primary: boolean }>(
        "SELECT id, address, is_primary FROM wallets WHERE address = $1",
        [address],
      );
      return { id: existing!.id, address: existing!.address, isPrimary: existing!.is_primary };
    }
    throw new IdentityError("Wallet is already linked to another account", "WALLET_TAKEN");
  }

  const [count] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM wallets WHERE user_id = $1",
    [userId],
  );
  const isFirst = Number(count?.n ?? 0) === 0;

  // The claimed-check above ran on its own, outside any transaction, so two tabs
  // linking the same address can both pass it. `UNIQUE (chain, address)` refuses
  // the loser — which is the right outcome and the wrong error, because the
  // reason is the one this function already has a name for.
  let row: { id: string; address: string; is_primary: boolean } | undefined;
  try {
    [row] = await db.query<{ id: string; address: string; is_primary: boolean }>(
      `INSERT INTO wallets (user_id, address, is_primary, verified_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)
       RETURNING id, address, is_primary`,
      [userId, address, isFirst, options.verified === true],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new IdentityError("Wallet is already linked to another account", "WALLET_TAKEN");
    }
    throw error;
  }

  return { id: row!.id, address: row!.address, isPrimary: row!.is_primary };
}

/**
 * Find the account holding a wallet address, if any.
 *
 * The second way to address an invitation: a commissioner who knows a friend's
 * address but not their username can still reach them. Exact match rather than
 * case-insensitive — base58 is case-sensitive, and two addresses differing only
 * in case are two different keys, so lowercasing here would be a way to invite
 * the wrong person.
 *
 * **Only a verified wallet counts.** `wallets.verified_at` is set by
 * `linkWalletWithSignature` and by nothing else.
 *
 * **That sentence was false until 2026-08-23, and this function never returned
 * anybody.** `linkWalletWithSignature` ended by calling `linkWallet`, which
 * did not write the column — so no wallet in the database had ever been marked
 * verified, and the check below excluded every row. Inviting somebody by wallet
 * address, the feature this exists for, answered "no such user" for every
 * address including correct ones. Nothing failed loudly; it simply never found
 * anyone.
 *
 * Reading it explicitly is still what stops a future path that writes an
 * unverified row from silently making addresses claimable.
 * Inviting somebody is a small thing; being *reachable* at an address you never
 * proved you hold is the part worth being strict about.
 */
export async function findUserByWallet(db: SqlClient, address: string): Promise<User | null> {
  const [row] = await db.query<UserRow>(
    `SELECT u.id, u.email, u.display_name, u.email_verified_at, u.username
       FROM wallets w
       JOIN users u ON u.id = w.user_id
      WHERE w.address = $1 AND w.verified_at IS NOT NULL`,
    [address.trim()],
  );
  return row ? toUser(row) : null;
}

export async function getWallets(db: SqlClient, userId: string): Promise<Wallet[]> {
  const rows = await db.query<{ id: string; address: string; is_primary: boolean }>(
    "SELECT id, address, is_primary FROM wallets WHERE user_id = $1 ORDER BY is_primary DESC, id",
    [userId],
  );
  return rows.map((r) => ({ id: r.id, address: r.address, isPrimary: r.is_primary }));
}
