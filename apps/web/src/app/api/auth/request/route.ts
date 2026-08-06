import { NextResponse } from "next/server";
import { beginEmailSignIn, IdentityError } from "@rostr/db";
import { db } from "@/lib/db";
import { EmailNotConfiguredError, sendSignInLink } from "@/lib/email";
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
