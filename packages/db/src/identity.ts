/**
 * Users and wallet linking.
 *
 * Signing in lives in `privy-identity.ts` since 2026-09-14; the emailed-code
 * functions that used to be here were removed with it.
 *
 * A wallet is an address, not a person. Email gives an identity that exists
 * before someone opens the app — which invites, display names, and time-boxed
 * notifications all need.
 */

import { isValidWalletAddress } from "@rostr/core";
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
   * new email than for a known one — a tell that would reveal which emails
   * already have accounts here.
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
     * **Only two callers may pass true.** `linkWalletWithSignature`, which has
     * checked a signature over a server-issued nonce; and `signInWithPrivy`,
     * for a wallet Privy generated and holds, whose address came from Privy's
     * own user record over a call authenticated with our app secret. Neither
     * address was typed by anybody. Everything reading
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
 * `linkWalletWithSignature`, and — since 2026-09-13 — by `signInWithPrivy`
 * for a wallet Privy generated and holds. Nothing else sets it.
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
