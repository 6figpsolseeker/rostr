/**
 * Users, email verification, and wallet linking.
 *
 * A wallet is an address, not a person. Email gives an identity that exists
 * before someone opens the app — which invites, display names, and time-boxed
 * notifications all need.
 */

import { randomBytes } from "node:crypto";
import { isValidWalletAddress, sha256Hex } from "@rostr/core";
import type { SqlClient } from "./client.js";

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EMAIL_TAKEN"
      | "USER_NOT_FOUND"
      | "INVALID_WALLET"
      | "WALLET_TAKEN"
      | "TOKEN_INVALID"
      | "TOKEN_EXPIRED",
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
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  email_verified_at: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified_at !== null,
  };
}

export async function createUser(
  db: SqlClient,
  email: string,
  displayName: string,
): Promise<User> {
  const existing = await db.query<UserRow>(
    "SELECT id, email, display_name, email_verified_at FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  if (existing.length > 0) {
    throw new IdentityError("Email is already registered", "EMAIL_TAKEN");
  }

  const [row] = await db.query<UserRow>(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     RETURNING id, email, display_name, email_verified_at`,
    [email, displayName],
  );
  return toUser(row!);
}

export async function getUser(db: SqlClient, userId: string): Promise<User | null> {
  const [row] = await db.query<UserRow>(
    "SELECT id, email, display_name, email_verified_at FROM users WHERE id = $1",
    [userId],
  );
  return row ? toUser(row) : null;
}

export async function findUserByEmail(db: SqlClient, email: string): Promise<User | null> {
  const [row] = await db.query<UserRow>(
    "SELECT id, email, display_name, email_verified_at FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  return row ? toUser(row) : null;
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/** How long a verification link stays usable. */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface VerificationToken {
  /** Send this to the user. It is never stored. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Issue an email verification token.
 *
 * Only the SHA-256 of the token is stored, so a database leak does not hand an
 * attacker working verification links — the same reasoning as password hashing.
 */
export async function issueVerificationToken(
  db: SqlClient,
  userId: string,
  now: Date = new Date(),
): Promise<VerificationToken> {
  const user = await getUser(db, userId);
  if (!user) throw new IdentityError("User not found", "USER_NOT_FOUND");

  const token = randomBytes(32).toString("base64url");
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
 * Consume a verification token and mark the email verified.
 *
 * Single use: the token is deleted whether or not it had expired.
 */
export async function verifyEmail(
  db: SqlClient,
  token: string,
  now: Date = new Date(),
): Promise<User> {
  const [row] = await db.query<{ user_id: string; expires_at: string }>(
    "SELECT user_id, expires_at FROM email_verification_tokens WHERE token_hash = $1",
    [sha256Hex(token)],
  );
  if (!row) throw new IdentityError("Verification token is not valid", "TOKEN_INVALID");

  await db.query("DELETE FROM email_verification_tokens WHERE token_hash = $1", [
    sha256Hex(token),
  ]);

  if (new Date(row.expires_at).getTime() < now.getTime()) {
    throw new IdentityError("Verification token has expired", "TOKEN_EXPIRED");
  }

  const [updated] = await db.query<UserRow>(
    // COALESCE, not assignment: these tokens double as sign-in links, so this
    // runs on every login. Overwriting would keep resetting "verified since" to
    // the most recent sign-in.
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1
     RETURNING id, email, display_name, email_verified_at`,
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

  const [row] = await db.query<{ id: string; address: string; is_primary: boolean }>(
    `INSERT INTO wallets (user_id, address, is_primary)
     VALUES ($1, $2, $3)
     RETURNING id, address, is_primary`,
    [userId, address, isFirst],
  );
  return { id: row!.id, address: row!.address, isPrimary: row!.is_primary };
}

export async function getWallets(db: SqlClient, userId: string): Promise<Wallet[]> {
  const rows = await db.query<{ id: string; address: string; is_primary: boolean }>(
    "SELECT id, address, is_primary FROM wallets WHERE user_id = $1 ORDER BY is_primary DESC, id",
    [userId],
  );
  return rows.map((r) => ({ id: r.id, address: r.address, isPrimary: r.is_primary }));
}
