import { NextResponse } from "next/server";
import { beginEmailSignIn, IdentityError, SIGN_IN_PER_EMAIL, SIGN_IN_PER_IP } from "@rostr/db";
import { db } from "@/lib/db";
import { EmailNotConfiguredError, sendSignInLink } from "@/lib/email";
import { byIp, enforceRateLimit } from "@/lib/rate-limit";
import { safeRedirect } from "@/lib/session";

/**
 * Start an email sign-in.
 *
 * **Always answers the same way**, whether or not the address has an account.
 * Two different responses would turn this into a way to test whether someone is
 * a member here, which is nobody's business but theirs.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as {
    email?: string;
    displayName?: string;
    next?: string;
  };

  if (!body.email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  // Before anything is sent. A limiter that runs after the email has gone out
  // has limited nothing.
  //
  // Normalised, so casing cannot be used to open a second bucket for the same
  // inbox. Two rules: one protects a person's inbox from being flooded, the
  // other caps total volume from one place. Both are charged even when one
  // refuses — see `consumeAll`.
  const normalised = body.email.trim().toLowerCase();
  const limited = await enforceRateLimit([
    { rule: SIGN_IN_PER_EMAIL, subject: normalised },
    byIp(SIGN_IN_PER_IP, request),
  ]);
  if (limited) return limited;

  const origin = new URL(request.url).origin;
  const next = safeRedirect(body.next ?? null);

  try {
    const { token } = await beginEmailSignIn(db(), body.email, body.displayName);

    const link = `${origin}/api/auth/verify?token=${encodeURIComponent(token.token)}&next=${encodeURIComponent(next)}`;
    const result = await sendSignInLink(body.email, link);

    return NextResponse.json({
      sent: true,
      ...(result.devLink ? { devLink: result.devLink } : {}),
    });
  } catch (error) {
    if (error instanceof EmailNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof IdentityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }
}
