import { NextResponse } from "next/server";
import { IdentityError, createSession, verifySignInCode } from "@rostr/db";
import { db } from "@/lib/db";
import { byIp, enforceRateLimit } from "@/lib/rate-limit";
import { SIGN_IN_ATTEMPT_PER_IP } from "@rostr/db";
import { setSessionCookie } from "@/lib/session";

/**
 * Exchange a sign-in code for a session.
 *
 * ## Why this replaced a link
 *
 * The old flow was a `GET` carrying a single-use token, and anything that
 * *visited* that URL spent it. Observed on a live deployment in one evening:
 * Chrome's Safe Browsing interstitial consumed three codes and discarded the
 * `Set-Cookie` with the response it refused to show; a mail client's in-app
 * browser put the session in a cookie jar the real browser could not see; and
 * two links in one inbox meant the newer silently invalidated the older.
 *
 * A `POST` from the page the person is already looking at has none of those
 * failure modes, and it is the reason signing in no longer depends on the
 * domain's reputation with a browser vendor.
 *
 * ## Guessing is the threat now, so attempts are limited twice
 *
 * A six-digit code is a million possibilities rather than 2^256. `identity.ts`
 * destroys a code after `MAX_CODE_ATTEMPTS` wrong guesses, which bounds an
 * attacker to a few tries per code they can cause to be issued. This route adds
 * the second half: a per-address ceiling on *attempts*, so an attacker cannot
 * cycle fresh codes and keep guessing. Requesting was already limited; trying
 * was not, because before codes there was nothing to try.
 *
 * Charged before the code is checked, so a refusal costs an attempt too.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as { email?: string; code?: string };

  if (!body.email || !body.code) {
    return NextResponse.json({ error: "email and code are required" }, { status: 400 });
  }

  const limited = await enforceRateLimit([byIp(SIGN_IN_ATTEMPT_PER_IP, request)]);
  if (limited) return limited;

  try {
    const user = await verifySignInCode(db(), body.email, body.code);
    const session = await createSession(db(), user.id);

    // 200 with the cookie, not a redirect. The browser stays where it is and
    // the client decides where to go — a redirect here would reintroduce the
    // open-redirect surface `safeRedirect` existed to guard on the link route.
    const response = NextResponse.json({ signedIn: true });
    setSessionCookie(response, session.token);
    return response;
  } catch (error) {
    if (error instanceof IdentityError) {
      // Expired is told apart from invalid because the next action differs —
      // ask for another code, versus check what you typed. Neither says whether
      // an account exists: `verifySignInCode` answers TOKEN_INVALID for an
      // unknown address exactly as it does for a wrong code.
      const expired = error.code === "TOKEN_EXPIRED";
      return NextResponse.json(
        {
          error: expired
            ? "That code has expired. Request another."
            : "That code is not valid.",
          code: error.code,
        },
        { status: expired ? 410 : 401 },
      );
    }
    throw error;
  }
}
