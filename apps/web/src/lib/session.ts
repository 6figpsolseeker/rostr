import "server-only";

import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { resolveSession, SESSION_TTL_MS } from "@rostr/db";
import type { User } from "@rostr/db";
import { db } from "./db";

export const SESSION_COOKIE = "rostr_session";

/**
 * Cookie settings, in one place.
 *
 * `httpOnly` is the important one: script cannot read the token, so an injected
 * script cannot exfiltrate a session. `sameSite: lax` stops another site posting
 * to our endpoints with the user's cookie attached, while still letting the
 * email sign-in link work — that arrives as a top-level navigation, which lax
 * permits and `strict` would not.
 */
function cookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/**
 * Who is signed in, or `null`.
 *
 * The single source of identity on the server. Nothing may take a user ID from
 * a request body — a client that names its own user ID is a client that can be
 * anyone.
 */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  return resolveSession(db(), token);
}

/** The raw token, for sign-out. */
export async function currentSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE, token, cookieOptions());
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
}

/**
 * Whether a post-sign-in redirect target is safe to follow.
 *
 * Only same-site paths. Without this, `/api/auth/verify?next=https://evil.example`
 * would land a freshly signed-in user on someone else's site straight from a
 * link in their inbox — which is exactly the shape of a convincing phish.
 */
export function safeRedirect(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  // `//host` and `/\host` are protocol-relative; browsers treat them as absolute.
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
