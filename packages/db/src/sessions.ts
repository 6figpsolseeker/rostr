/**
 * Sessions, and proving a wallet belongs to whoever is signed in.
 *
 * Identity here is **email plus wallet**, deliberately. Email exists before
 * someone opens the app, which invites and notifications need; the wallet is
 * what signs consent and holds a stake. Neither alone is enough.
 *
 * Two things worth not undoing:
 *
 * **Only the hash of a session token is stored.** The token itself lives in the
 * user's cookie and nowhere else. A database leak then exposes no working
 * logins, the same reasoning as hashing passwords.
 *
 * **A wallet is linked by signature, never by typing an address.** Otherwise
 * anyone could claim any address, including one already holding a league stake.
 */

import { randomBytes } from "node:crypto";
import {
  buildWalletLinkMessage,
  isValidWalletAddress,
  sha256Hex,
  verifyWalletLinkSignature,
} from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getUser, linkWallet } from "./identity.js";
import type { User, Wallet } from "./identity.js";

/** How long a session lasts. A fantasy season is long; signing in weekly is not. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a wallet challenge stays signable. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export class SessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "USER_NOT_FOUND"
      | "CHALLENGE_NOT_FOUND"
      | "CHALLENGE_EXPIRED"
      | "BAD_SIGNATURE"
      | "INVALID_WALLET",
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface Session {
  /** Goes in the cookie. Never stored, never logged. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/** Open a session for a user. */
export async function createSession(
  db: SqlClient,
  userId: string,
  now: Date = new Date(),
): Promise<Session> {
  const user = await getUser(db, userId);
  if (!user) throw new SessionError("User not found", "USER_NOT_FOUND");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const [row] = await db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, sha256Hex(token), expiresAt.toISOString()],
  );

  return { token, sessionId: row!.id, expiresAt };
}

/**
 * Who a session token belongs to, or `null`.
 *
 * Returns `null` for expired, revoked, and unknown tokens alike. A caller has
 * nothing useful to do with the distinction, and reporting it would tell an
 * attacker whether a guessed token ever existed.
 */
export async function resolveSession(
  db: SqlClient,
  token: string,
  now: Date = new Date(),
): Promise<User | null> {
  if (!token) return null;

  const [row] = await db.query<{
    user_id: string;
    expires_at: string;
    revoked_at: string | null;
  }>("SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = $1", [
    sha256Hex(token),
  ]);
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null;

  return getUser(db, row.user_id);
}

/** Sign out. Idempotent — revoking an unknown token is not an error. */
export async function revokeSession(
  db: SqlClient,
  token: string,
  now: Date = new Date(),
): Promise<void> {
  await db.query(
    "UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
    [sha256Hex(token), now.toISOString()],
  );
}

/** Sign out everywhere. What a user reaches for after losing a laptop. */
export async function revokeAllSessions(
  db: SqlClient,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = $2
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [userId, now.toISOString()],
  );
  return rows.length;
}

/** Delete sessions that expired long enough ago to be of no forensic use. */
export async function purgeExpiredSessions(
  db: SqlClient,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    "DELETE FROM sessions WHERE expires_at < $1 RETURNING id",
    [now.toISOString()],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Wallet ownership
// ---------------------------------------------------------------------------

export interface WalletChallenge {
  /** The exact text to hand the wallet. Shown to the user before they sign. */
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

/**
 * Issue a challenge for a wallet to sign.
 *
 * Supersedes any outstanding challenge for the same user and address, so a stale
 * nonce cannot sit around waiting to be replayed.
 */
export async function issueWalletChallenge(
  db: SqlClient,
  userId: string,
  address: string,
  now: Date = new Date(),
): Promise<WalletChallenge> {
  if (!isValidWalletAddress(address)) {
    throw new SessionError("Not a valid Solana public key", "INVALID_WALLET");
  }

  const user = await getUser(db, userId);
  if (!user) throw new SessionError("User not found", "USER_NOT_FOUND");

  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);

  await db.query(
    `INSERT INTO wallet_challenges (user_id, address, nonce, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, address)
     DO UPDATE SET nonce = EXCLUDED.nonce,
                   expires_at = EXCLUDED.expires_at,
                   created_at = now(),
                   consumed_at = NULL`,
    [userId, address, nonce, expiresAt.toISOString()],
  );

  return {
    message: buildWalletLinkMessage({ walletAddress: address, email: user.email, nonce }),
    nonce,
    expiresAt,
  };
}

/**
 * Consume a challenge and link the wallet.
 *
 * The message is rebuilt server-side from the stored nonce and the signed-in
 * user's email — never from anything the client sends. A client that composed
 * its own message could sign one thing and be credited with another.
 *
 * The challenge is consumed whether or not the signature checks out, so a wrong
 * signature costs an attacker a fresh round trip rather than unlimited attempts
 * against one nonce.
 */
export async function linkWalletWithSignature(
  db: SqlClient,
  userId: string,
  address: string,
  signatureBase58: string,
  now: Date = new Date(),
): Promise<Wallet> {
  const user = await getUser(db, userId);
  if (!user) throw new SessionError("User not found", "USER_NOT_FOUND");

  const [row] = await db.query<{
    nonce: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT nonce, expires_at, consumed_at FROM wallet_challenges
      WHERE user_id = $1 AND address = $2`,
    [userId, address],
  );
  if (!row || row.consumed_at) {
    throw new SessionError("No pending challenge for this wallet", "CHALLENGE_NOT_FOUND");
  }

  await db.query(
    "UPDATE wallet_challenges SET consumed_at = $3 WHERE user_id = $1 AND address = $2",
    [userId, address, now.toISOString()],
  );

  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new SessionError("Challenge has expired", "CHALLENGE_EXPIRED");
  }

  const valid = verifyWalletLinkSignature(
    { walletAddress: address, email: user.email, nonce: row.nonce },
    signatureBase58,
  );
  if (!valid) {
    throw new SessionError("Signature does not match this wallet", "BAD_SIGNATURE");
  }

  return linkWallet(db, userId, address);
}
