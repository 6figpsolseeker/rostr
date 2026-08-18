import { NextResponse } from "next/server";
import { beginEmailSignIn, IdentityError, SIGN_IN_PER_EMAIL, SIGN_IN_PER_IP } from "@rostr/db";
import { db } from "@/lib/db";
import { EmailDeliveryError, EmailNotConfiguredError, sendSignInCode } from "@/lib/email";
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

  try {
    const { token } = await beginEmailSignIn(db(), body.email, body.displayName);

    // The code goes in the body of the email and nowhere near a URL. That is
    // the entire point: a credential in a link is spent by whatever follows the
    // link, and plenty of things follow a link without a person deciding to.
    const result = await sendSignInCode(body.email, token.token);

    return NextResponse.json({
      sent: true,
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (error) {
    if (error instanceof EmailNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    // A provider refusing to send is expected, not exceptional — a suppressed
    // address, an exhausted quota, a sender the account may not use. It used to
    // fall through to the rethrow below, and an unhandled throw here is a 500
    // with **no body**, which the client then tries to parse as JSON: the user
    // was shown "Unexpected end of JSON input" for a mail problem.
    //
    // 502 rather than 500: the failure is upstream of us and retrying may well
    // work. The provider's own text is deliberately not forwarded — it can name
    // the recipient and the sending domain, and this endpoint answers
    // identically whether or not an account exists.
    if (error instanceof EmailDeliveryError) {
      // eslint-disable-next-line no-console
      console.error(`[auth] provider refused (${error.status}): ${error.detail}`);
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    if (error instanceof IdentityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }
}
