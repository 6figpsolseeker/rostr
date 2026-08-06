import { afterEach, describe, expect, it } from "vitest";
import {
  consumeAll,
  consumeRateLimit,
  hashedIp,
  purgeIdleRateLimits,
  SIGN_IN_PER_EMAIL,
} from "./rate-limit.js";
import type { RateLimitRule } from "./rate-limit.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const NOW = new Date("2026-08-06T12:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const RULE: RateLimitRule = { bucket: "test", limit: 3, windowMs: HOUR };

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

describe("consumeRateLimit", () => {
  it("allows up to the limit", async () => {
    db = await createTestDatabase();

    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit(db, RULE, "someone", NOW)).allowed, `call ${i + 1}`).toBe(
        true,
      );
    }
  });

  it("refuses the one after", async () => {
    db = await createTestDatabase();
    for (let i = 0; i < 3; i++) await consumeRateLimit(db, RULE, "someone", NOW);

    expect((await consumeRateLimit(db, RULE, "someone", NOW)).allowed).toBe(false);
  });

  it("counts down what is left", async () => {
    db = await createTestDatabase();

    expect((await consumeRateLimit(db, RULE, "someone", NOW)).remaining).toBe(2);
    expect((await consumeRateLimit(db, RULE, "someone", NOW)).remaining).toBe(1);
    expect((await consumeRateLimit(db, RULE, "someone", NOW)).remaining).toBe(0);
  });

  it("says when to come back", async () => {
    db = await createTestDatabase();
    for (let i = 0; i < 3; i++) await consumeRateLimit(db, RULE, "someone", NOW);

    const refused = await consumeRateLimit(db, RULE, "someone", NOW);

    // Three per hour is one every twenty minutes.
    expect(refused.retryAfterMs).toBe(20 * MINUTE);
  });

  it("refills gradually rather than all at once", async () => {
    // The point of a token bucket. A fixed window would hand back the whole
    // allowance on the hour, letting someone spend two windows' worth back to
    // back across the boundary.
    db = await createTestDatabase();
    for (let i = 0; i < 3; i++) await consumeRateLimit(db, RULE, "someone", NOW);

    expect((await consumeRateLimit(db, RULE, "someone", at(19 * MINUTE))).allowed).toBe(false);
    expect((await consumeRateLimit(db, RULE, "someone", at(21 * MINUTE))).allowed).toBe(true);
  });

  it("does not refill past full", async () => {
    db = await createTestDatabase();
    await consumeRateLimit(db, RULE, "someone", NOW);

    // A week later, still only three.
    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit(db, RULE, "someone", at(7 * 24 * HOUR))).allowed).toBe(
        true,
      );
    }
    expect((await consumeRateLimit(db, RULE, "someone", at(7 * 24 * HOUR))).allowed).toBe(
      false,
    );
  });

  it("keeps subjects apart", async () => {
    db = await createTestDatabase();
    for (let i = 0; i < 3; i++) await consumeRateLimit(db, RULE, "loud", NOW);

    expect((await consumeRateLimit(db, RULE, "loud", NOW)).allowed).toBe(false);
    expect((await consumeRateLimit(db, RULE, "quiet", NOW)).allowed).toBe(true);
  });

  it("keeps buckets apart", async () => {
    db = await createTestDatabase();
    for (let i = 0; i < 3; i++) await consumeRateLimit(db, RULE, "someone", NOW);

    const other = { ...RULE, bucket: "other" };
    expect((await consumeRateLimit(db, other, "someone", NOW)).allowed).toBe(true);
  });

  it("keeps charging while refusing", async () => {
    // The bucket is written on refusal too. If it were not, `updated_at` would
    // stop moving under sustained load and every refused call would re-credit
    // the same elapsed time — the limit would quietly stop applying to exactly
    // the traffic it exists for.
    db = await createTestDatabase();
    for (let i = 0; i < 3; i++) await consumeRateLimit(db, RULE, "flooder", NOW);

    // Hammer it for ten minutes, then check the refill has not been reset.
    for (let minute = 0; minute < 10; minute++) {
      await consumeRateLimit(db, RULE, "flooder", at(minute * MINUTE));
    }

    expect((await consumeRateLimit(db, RULE, "flooder", at(19 * MINUTE))).allowed).toBe(false);
    expect((await consumeRateLimit(db, RULE, "flooder", at(21 * MINUTE))).allowed).toBe(true);
  });

  it("starts a first-time subject full", async () => {
    db = await createTestDatabase();

    expect((await consumeRateLimit(db, RULE, "new", NOW)).remaining).toBe(2);
  });

  it("handles a clock that goes backwards", async () => {
    // Server clocks do move. Elapsed time is floored at zero, so the worst case
    // is no refill rather than a negative one.
    db = await createTestDatabase();
    await consumeRateLimit(db, RULE, "someone", NOW);

    const earlier = await consumeRateLimit(db, RULE, "someone", at(-HOUR));

    expect(earlier.allowed).toBe(true);
    expect(earlier.remaining).toBe(1);
  });

  it("rejects a nonsensical rule", async () => {
    db = await createTestDatabase();

    await expect(
      consumeRateLimit(db, { bucket: "bad", limit: 0, windowMs: HOUR }, "x", NOW),
    ).rejects.toThrow(/positive/);
  });

  it("survives the real sign-in rule", async () => {
    db = await createTestDatabase();

    for (let i = 0; i < SIGN_IN_PER_EMAIL.limit; i++) {
      expect((await consumeRateLimit(db, SIGN_IN_PER_EMAIL, "a@b.com", NOW)).allowed).toBe(
        true,
      );
    }
    expect((await consumeRateLimit(db, SIGN_IN_PER_EMAIL, "a@b.com", NOW)).allowed).toBe(false);
  });
});

describe("consumeAll", () => {
  const perSubject: RateLimitRule = { bucket: "multi:subject", limit: 2, windowMs: HOUR };
  const perAddress: RateLimitRule = { bucket: "multi:address", limit: 5, windowMs: HOUR };

  it("allows while every rule allows", async () => {
    db = await createTestDatabase();

    const result = await consumeAll(
      db,
      [
        { rule: perSubject, subject: "a@b.com" },
        { rule: perAddress, subject: "ip" },
      ],
      NOW,
    );

    expect(result.allowed).toBe(true);
  });

  it("refuses as soon as any rule refuses", async () => {
    db = await createTestDatabase();
    const checks = [
      { rule: perSubject, subject: "a@b.com" },
      { rule: perAddress, subject: "ip" },
    ];

    await consumeAll(db, checks, NOW);
    await consumeAll(db, checks, NOW);

    // The per-subject rule is spent even though the per-address one is not.
    expect((await consumeAll(db, checks, NOW)).allowed).toBe(false);
  });

  it("charges every rule even after one has refused", async () => {
    // Otherwise someone who has already exhausted the per-address bucket could
    // keep hammering a victim's per-account bucket for free, because it would
    // never be charged again.
    db = await createTestDatabase();
    const tight: RateLimitRule = { bucket: "tight", limit: 1, windowMs: HOUR };
    const loose: RateLimitRule = { bucket: "loose", limit: 10, windowMs: HOUR };

    const checks = [
      { rule: tight, subject: "s" },
      { rule: loose, subject: "s" },
    ];

    await consumeAll(db, checks, NOW); // tight now empty
    await consumeAll(db, checks, NOW); // refused, but loose must still be charged
    await consumeAll(db, checks, NOW);

    expect((await consumeRateLimit(db, loose, "s", NOW)).remaining).toBe(6);
  });

  it("reports the longest wait", async () => {
    // So a caller told to come back does not immediately hit a different rule
    // that had longer to run.
    db = await createTestDatabase();
    const slow: RateLimitRule = { bucket: "slow", limit: 1, windowMs: 4 * HOUR };
    const fast: RateLimitRule = { bucket: "fast", limit: 1, windowMs: HOUR };

    const checks = [
      { rule: slow, subject: "s" },
      { rule: fast, subject: "s" },
    ];
    await consumeAll(db, checks, NOW);

    expect((await consumeAll(db, checks, NOW)).retryAfterMs).toBe(4 * HOUR);
  });
});

describe("hashedIp", () => {
  it("is stable", () => {
    expect(hashedIp("203.0.113.7")).toBe(hashedIp("203.0.113.7"));
  });

  it("separates different addresses", () => {
    expect(hashedIp("203.0.113.7")).not.toBe(hashedIp("203.0.113.8"));
  });

  it("does not contain the address", () => {
    // Not anonymisation — IPv4 is brute-forceable and the doc comment says so.
    // What it buys is that a leaked dump is not a readable list of member IPs.
    expect(hashedIp("203.0.113.7")).not.toContain("203.0.113.7");
  });
});

describe("purgeIdleRateLimits", () => {
  it("drops buckets nobody has touched", async () => {
    // A full bucket is indistinguishable from no bucket, and keeping a hashed
    // IP longer than it is useful serves nothing.
    db = await createTestDatabase();
    await consumeRateLimit(db, RULE, "someone", NOW);

    expect(await purgeIdleRateLimits(db, at(24 * HOUR))).toBe(1);
  });

  it("leaves recent buckets alone", async () => {
    db = await createTestDatabase();
    await consumeRateLimit(db, RULE, "someone", NOW);

    expect(await purgeIdleRateLimits(db, at(-HOUR))).toBe(0);
    expect((await consumeRateLimit(db, RULE, "someone", NOW)).remaining).toBe(1);
  });
});
