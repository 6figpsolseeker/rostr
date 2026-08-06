import { NextResponse } from "next/server";
import { createSession, IdentityError, verifyEmail } from "@rostr/db";
import { db } from "@/lib/db";
import { safeRedirect, setSessionCookie } from "@/lib/session";

/**
 * Follow a sign-in link: verify the email, open a session, set the cookie.
 *
 * A GET that changes state, which is normally wrong — but this is a link in an
 * email and there is nothing else it could be. The token is single-use, so a
 * link prefetched by a mail client burns itself rather than leaving a reusable
 * credential lying in an inbox.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const next = safeRedirect(url.searchParams.get("next"));

  if (!token) {
    return NextResponse.redirect(new URL("/signin?error=missing", url.origin));
  }

  try {
    const user = await verifyEmail(db(), token);
    const session = await createSession(db(), user.id);

    const response = NextResponse.redirect(new URL(next, url.origin));
    setSessionCookie(response, session.token);
    return response;
  } catch (error) {
    if (error instanceof IdentityError) {
      // Expired and invalid are told apart here, and only here: the user needs
      // to know whether to request a fresh link or check they used the right
      // address. Neither reveals whether an account exists.
      const reason = error.code === "TOKEN_EXPIRED" ? "expired" : "invalid";
      return NextResponse.redirect(new URL(`/signin?error=${reason}`, url.origin));
    }
    throw error;
  }
}
