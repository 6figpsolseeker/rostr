/**
 * Rate limiting.
 *
 * Not an access control — nothing here decides who may do what. It exists to
 * stop the endpoints that *send email* or *do crypto on demand* being turned
 * into someone else's tool.
 *
 * The one that matters most is the sign-in link. Left open, anyone can point it
 * at a stranger's address and flood their inbox using our sender. That destroys
 * a sending domain's reputation, at which point our mail lands in spam for
 * everybody — a failure that outlives the attack by months.
 *
 * See the migration for why this is a token bucket in Postgres rather than a
 * counter in memory.
 */

import { sha256Hex } from "@rostr/core";
import type { SqlClient } from "./client.js";

/** Micro-tokens per whole request. Integers only, as everywhere else. */
const MICRO = 1_000_000;

export interface RateLimitRule {
  /** What is being limited, e.g. `auth:request:email`. */
  readonly bucket: string;
  /** How many requests are allowed per window. */
  readonly limit: number;
  /** Time to refill from empty to full. */
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Whole requests left, rounded down. */
  readonly remaining: number;
  /** Milliseconds until the next request would be allowed. Zero when allowed. */
  readonly retryAfterMs: number;
}

/**
 * Take one token from a subject's bucket.
 *
 * @param subject who is being limited — an email, a user ID, or a hashed IP
 */
export async function consumeRateLimit(
  db: SqlClient,
  rule: RateLimitRule,
  subject: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const [row] = await db.query<{
    allowed: boolean;
    micro_remaining: string | number;
    retry_after_ms: string | number;
  }>("SELECT * FROM consume_rate_limit($1, $2, $3, $4, $5)", [
    rule.bucket,
    subject,
    rule.limit * MICRO,
    rule.windowMs,
    now.toISOString(),
  ]);

  return {
    allowed: row!.allowed,
    remaining: Math.floor(Number(row!.micro_remaining) / MICRO),
    retryAfterMs: Number(row!.retry_after_ms),
  };
}

/**
 * Check several rules at once — typically one per subject and one per address.
 *
 * **Every rule is consumed, even after one refuses.** Stopping at the first
 * refusal would let an attacker who has already exhausted the per-address bucket
 * keep hammering a victim's per-account bucket for free, because that one would
 * never be charged.
 */
export async function consumeAll(
  db: SqlClient,
  checks: readonly { rule: RateLimitRule; subject: string }[],
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const results: RateLimitResult[] = [];
  for (const check of checks) {
    results.push(await consumeRateLimit(db, check.rule, check.subject, now));
  }

  const refused = results.filter((result) => !result.allowed);
  if (refused.length === 0) {
    return {
      allowed: true,
      remaining: Math.min(...results.map((r) => r.remaining)),
      retryAfterMs: 0,
    };
  }

  // The longest wait, so a caller told to come back does not immediately hit a
  // different rule that had longer to run.
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: Math.max(...refused.map((r) => r.retryAfterMs)),
  };
}

/**
 * A stable, non-obvious key for an IP address.
 *
 * **This is not anonymisation, and should not be described as such.** IPv4 is
 * only four billion values, so anyone holding this table and a little compute
 * can recover the addresses. What it does buy is that a leaked dump is not a
 * readable list of where members live, and that nothing downstream can casually
 * start treating these rows as an identity signal.
 *
 * Related: IP-based duplicate-account blocking was proposed and **rejected** —
 * it breaks households and any VPN defeats it. Limiting a burst is a different
 * job from deciding who someone is, and this is only the former.
 */
export function hashedIp(ip: string): string {
  return sha256Hex(`rostr:rate-limit:ip:${ip}`).slice(0, 32);
}

/**
 * Drop buckets that have sat full and untouched.
 *
 * A full bucket is indistinguishable from no bucket, so keeping the row serves
 * no purpose and keeping a hashed IP longer than it is useful serves less.
 */
export async function purgeIdleRateLimits(db: SqlClient, olderThan: Date): Promise<number> {
  const rows = await db.query<{ subject: string }>(
    "DELETE FROM rate_limits WHERE updated_at < $1 RETURNING subject",
    [olderThan.toISOString()],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/**
 * Sign-in links, per email address.
 *
 * Generous enough that a real person who mistypes their address twice and then
 * loses the mail is not locked out; tight enough that nobody's inbox becomes a
 * target. The subject is the normalised address, so casing cannot be used to
 * open a second bucket.
 */
export const SIGN_IN_PER_EMAIL: RateLimitRule = {
  bucket: "auth:request:email",
  limit: 5,
  windowMs: HOUR,
};

/**
 * Sign-in links, per address.
 *
 * Looser than the per-email rule on purpose: a household, an office, or a campus
 * shares one address, and several people signing in on the same evening is
 * ordinary. It is a ceiling on volume, not a per-person limit.
 */
export const SIGN_IN_PER_IP: RateLimitRule = {
  bucket: "auth:request:ip",
  limit: 20,
  windowMs: HOUR,
};

/** Wallet challenges, per signed-in account. */
export const WALLET_CHALLENGE_PER_USER: RateLimitRule = {
  bucket: "auth:wallet:user",
  limit: 20,
  windowMs: HOUR,
};

export const WALLET_CHALLENGE_PER_IP: RateLimitRule = {
  bucket: "auth:wallet:ip",
  limit: 60,
  windowMs: HOUR,
};
