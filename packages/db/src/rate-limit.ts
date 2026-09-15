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

/**
 * Privy sign-ins, per address.
 *
 * Nothing here is guessable — the token is a signed JWT, and a forged one fails
 * locally for free. What this bounds is the call each *valid* token costs us to
 * Privy's API, and the writes behind it. Looser than the code routes because a
 * normal sign-in posts more than once: at login, and again when the new wallet
 * or a linked X account appears.
 */
export const PRIVY_SIGN_IN_PER_IP: RateLimitRule = {
  bucket: "auth:privy:ip",
  limit: 60,
  windowMs: HOUR,
};

/**
 * Username changes, per account.
 *
 * Not about abuse of the name itself — a username is meant to be public and
 * typed at. It bounds **squatting through churn**: without a limit, one account
 * could cycle through thousands of names an hour, holding each just long enough
 * that nobody else can take it, and every attempt writes to `users`.
 *
 * Twelve an hour is far more than a person deciding what to call themselves and
 * far less than a script working through a dictionary.
 */
export const USERNAME_SET_PER_USER: RateLimitRule = {
  bucket: "account:username:user",
  limit: 12,
  windowMs: HOUR,
};

/**
 * Availability checks, per address.
 *
 * The form asks on every pause in typing, so this is generous — it exists so a
 * script cannot enumerate the whole namespace cheaply, not to interrupt anyone
 * choosing a name. Per address rather than per account because the check is
 * available to anyone signed in, and the machine is what needs bounding.
 */
export const USERNAME_CHECK_PER_IP: RateLimitRule = {
  bucket: "account:username:ip",
  limit: 240,
  windowMs: HOUR,
};

/**
 * Invitations sent, per commissioner.
 *
 * An invitation is a message addressed to somebody else, which is the shape of
 * thing that gets used to harass people. A league has at most a few dozen seats
 * across every league one person runs, so sixty an hour is unreachable by
 * ordinary use and low enough that this cannot be a broadcast channel.
 */
export const INVITE_PER_USER: RateLimitRule = {
  bucket: "league:invite:user",
  limit: 60,
  windowMs: HOUR,
};

/**
 * Creating a league.
 *
 * **This exists because a league now costs a third-party upload.** Before the
 * rule document was pinned, an unbounded creation loop cost a few rows and
 * nothing else. It now spends a metered Pinata quota per league — and when that
 * quota is gone, every *other* commissioner's league is created unpublished,
 * permanently: `0044` freezes `rules_uri` on first write, `league_rules`
 * refuses its own DELETE, and nothing re-pins. So one account's loop degrades
 * everybody else's leagues with no automated recovery. That is the consequence
 * being bounded here, not the row count.
 *
 * Twelve an hour: a commissioner runs a handful of leagues a season and creates
 * them one at a time in a form that freezes the rules irreversibly, so this is
 * far above ordinary use and far below a quota worth draining. Per user rather
 * than per address, because creation already requires a session and a username —
 * an address bucket would only punish households.
 */
export const LEAGUE_CREATE_PER_USER: RateLimitRule = {
  bucket: "league:create:user",
  limit: 12,
  windowMs: HOUR,
};
