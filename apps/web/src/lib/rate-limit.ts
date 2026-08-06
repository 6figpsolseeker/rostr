import "server-only";

import { NextResponse } from "next/server";
import { consumeAll, hashedIp } from "@rostr/db";
import type { RateLimitRule } from "@rostr/db";
import { db } from "./db";

/**
 * The client's address, as best it can be known.
 *
 * `x-forwarded-for` is **client-supplied** and trivially spoofed unless a proxy
 * we control rewrites it. Vercel and every managed host do rewrite it, which is
 * why it is usable here — but if this app is ever put behind something that does
 * not, per-address limiting silently becomes worthless while still appearing to
 * work. The per-account limits do not depend on this.
 *
 * The leftmost entry is the original client; anything after it was appended by
 * intermediaries.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  return request.headers.get("x-real-ip")?.trim() ?? "unknown";
}

export interface RateLimitCheck {
  readonly rule: RateLimitRule;
  readonly subject: string;
}

/**
 * Apply rate limits, returning a 429 to send back if any is exceeded.
 *
 * Returns `null` when the request may proceed. Call it **before** doing the work
 * — a limiter that runs after the email is sent has limited nothing.
 */
export async function enforceRateLimit(
  checks: readonly RateLimitCheck[],
): Promise<NextResponse | null> {
  const result = await consumeAll(db(), checks);
  if (result.allowed) return null;

  const seconds = Math.ceil(result.retryAfterMs / 1000);

  return NextResponse.json(
    {
      error: `Too many requests. Try again in ${describe(seconds)}.`,
      code: "RATE_LIMITED",
      retryAfterSeconds: seconds,
    },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

/** Helper so a route reads as intent rather than plumbing. */
export function byIp(rule: RateLimitRule, request: Request): RateLimitCheck {
  return { rule, subject: hashedIp(clientIp(request)) };
}

function describe(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
