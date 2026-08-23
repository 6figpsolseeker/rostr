import { randomBytes } from "node:crypto";
import {
  buildWalletSignInMessage,
  isValidWalletAddress,
  verifyWalletSignInSignature,
} from "@rostr/core";
import type { SqlClient } from "./client.js";
import { findUserByWallet } from "./identity.js";
import type { User } from "./identity.js";
import { CHALLENGE_TTL_MS, createSession, SessionError } from "./sessions.js";
import type { Session } from "./sessions.js";

/**
 * Signing in with a wallet you have already linked.
 *
 * An emailed code is the right way to prove an account is yours the first time
 * and a poor way to do it the hundredth. A returning member already holds a key
 * this account has verified — asking them to leave the browser, open a mail
 * client and copy a code is asking for a weaker proof by a slower route.
 *
 * **This cannot create an account, and that is the whole boundary.** Sign-up
 * stays email-first (decided by the owner, 2026-08-23). A wallet nobody has
 * linked is told to sign in by email once; after that, the wallet alone is
 * enough forever. Letting it register would produce accounts with no email —
 * nothing to send an invitation notice to, and the username flow gated behind an
 * account that has no other way to be reached.
 */

export interface WalletSignInChallenge {
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

/**
 * Issue a nonce for a wallet that already belongs to somebody.
 *
 * **The account is looked up before the challenge is written**, which is what
 * lets this reuse `wallet_challenges` unchanged: there genuinely is a user, we
 * simply had not identified them yet. No migration, and one table holding every
 * live wallet nonce.
 *
 * `WALLET_NOT_LINKED` is deliberately distinguishable from every other refusal,
 * because the owner's chosen flow is to send that person to email sign-in and a
 * screen cannot say so without being told. **It does disclose that a given
 * address has an account here** — a real tradeoff, accepted rather than
 * overlooked. Two things make it a small one: a wallet address is a public
 * identifier, and any wallet that has ever joined a pot league already announces
 * the same fact on-chain through its `Membership` PDA. Email sign-in makes the
 * opposite choice for the opposite reason — an email address is not public, and
 * `/api/auth/request` answers identically either way.
 */
export async function issueWalletSignInChallenge(
  db: SqlClient,
  address: string,
  now: Date = new Date(),
): Promise<WalletSignInChallenge> {
  if (!isValidWalletAddress(address)) {
    throw new SessionError("Not a valid Solana public key", "INVALID_WALLET");
  }

  // Requires `verified_at IS NOT NULL`, so an address somebody typed but never
  // proved cannot open a session.
  const user = await findUserByWallet(db, address);
  if (!user) {
    throw new SessionError("This wallet is not linked to an account yet.", "WALLET_NOT_LINKED");
  }

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
    [user.id, address, nonce, expiresAt.toISOString()],
  );

  return {
    message: buildWalletSignInMessage({ walletAddress: address, nonce }),
    nonce,
    expiresAt,
  };
}

/**
 * Consume the challenge and open a session.
 *
 * The message is rebuilt server-side from the stored nonce — never from anything
 * the client sends — for the same reason `linkWalletWithSignature` does it: a
 * client that composed its own message could sign one thing and be credited with
 * another.
 *
 * **The challenge is consumed whether or not the signature checks out**, so a
 * wrong signature costs a fresh round trip rather than unlimited attempts
 * against one live nonce. Same rule as linking, and it matters more here — this
 * one hands out a session.
 */
export async function signInWithWallet(
  db: SqlClient,
  address: string,
  signatureBase58: string,
  now: Date = new Date(),
): Promise<{ user: User; session: Session }> {
  const user = await findUserByWallet(db, address);
  if (!user) {
    throw new SessionError("This wallet is not linked to an account yet.", "WALLET_NOT_LINKED");
  }

  const [row] = await db.query<{
    nonce: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT nonce, expires_at, consumed_at FROM wallet_challenges
      WHERE user_id = $1 AND address = $2`,
    [user.id, address],
  );

  if (!row)
    throw new SessionError("No sign-in challenge for that wallet", "CHALLENGE_NOT_FOUND");
  if (row.consumed_at !== null) {
    throw new SessionError("That challenge has already been used", "CHALLENGE_USED");
  }
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new SessionError("That challenge has expired", "CHALLENGE_EXPIRED");
  }

  await db.query(
    "UPDATE wallet_challenges SET consumed_at = $3 WHERE user_id = $1 AND address = $2",
    [user.id, address, now.toISOString()],
  );

  const ok = verifyWalletSignInSignature(
    { walletAddress: address, nonce: row.nonce },
    signatureBase58,
  );
  if (!ok) throw new SessionError("That signature does not match", "BAD_SIGNATURE");

  const session = await createSession(db, user.id, now);

  return { user, session };
}
