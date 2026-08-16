import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * The shared guard on the six cron routes.
 *
 * Extracted because it was four identical copies, and a guard that exists four
 * times is a guard that will be tightened three times.
 *
 * ## What it is actually for
 *
 * Not much, and that is worth saying plainly rather than letting the word
 * "secret" imply otherwise. These endpoints only do what the clock already
 * permits: `catchUpExpiredPicks` is deterministic and stamped at the missed
 * deadline, scoring rewrites an unfinalised week and is refused a finalised one
 * by `AND finalized_at IS NULL` on the write in `resolveLeagueWeek`, and
 * `finalizationHold` decides finalisation independently of who asked. An
 * unauthorised call cannot produce a wrong pick, a wrong score, or an early
 * settlement. **The guard is about database load**, and about not handing
 * anonymous callers a lever on every league at once.
 *
 * ## `stats` and `season-sync` are the exception, and it is a real one
 *
 * They call a **metered** third-party API. The reasoning above says an
 * unauthorised call is merely load; for these two it is money, and it does not
 * take many requests a second to exhaust a daily quota — after which live
 * scoring stops for everyone until the quota resets. Their per-run ceilings
 * (`MAX_GAMES_PER_RUN`, and the work list only covering seasons some league is
 * actually playing) bound one run, not the number of runs.
 *
 * So on those two the secret is the only thing standing between an anonymous
 * caller and the provider bill. Do not describe it there as being about
 * database load.
 *
 * That middle clause used to read "scoring is idempotent and rewrites the same
 * numbers", which was the whole justification for the guard being deliberately
 * weak and was not true. An extra caller overlapping the scheduled sweep raced
 * it: both passed the `ALREADY_FINAL` check, and the slower one wrote its older
 * stat snapshot over the settled result. Naming the enforcement point rather
 * than asserting idempotence is the difference — the property now holds because
 * a specific predicate refuses the write, which is checkable against `week.ts`.
 *
 * ## Why it refuses when the secret is missing in production
 *
 * It used to run wide open — `if (secret)` and no `else`. That reads as a
 * convenience for local development and behaves as a silent misconfiguration in
 * production: forget the variable on a deploy and every cron route is public,
 * with nothing anywhere saying so. A missing secret is not evidence that no
 * secret was wanted.
 *
 * So: open when unset in development, refused when unset in production. That is
 * the same shape as the creation route's `FEE_RECIPIENT` check, and for the same
 * reason — better to fail loudly at the boundary than to run in a state nobody
 * chose.
 */
export function cronForbidden(request: Request): NextResponse | null {
  const secret = process.env["CRON_SECRET"];

  if (!secret) {
    if (process.env.NODE_ENV !== "production") return null;

    return NextResponse.json(
      {
        error:
          "CRON_SECRET is not set, so this endpoint refuses rather than running " +
          "unauthenticated. Set it on the deployment; Vercel sends it as a bearer token.",
      },
      { status: 503 },
    );
  }

  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(request.url).searchParams.get("secret");

  if (provided === null || !sameSecret(provided, secret)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  return null;
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` requires equal lengths — and would otherwise leak the
 * secret's length by throwing — so both sides are hashed first. Hashing is what
 * makes the comparison safe to perform at all, not an extra precaution on top
 * of it.
 *
 * Honestly: a remote timing attack on a string compare across HTTP is not a
 * realistic recovery channel, and this is not the part of the change that
 * matters. It is here because it costs two lines and removes the question.
 */
function sameSecret(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();

  return timingSafeEqual(a, b);
}
