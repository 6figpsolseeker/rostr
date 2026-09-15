import { NextResponse } from "next/server";
import {
  createSession,
  getWallets,
  PRIVY_SIGN_IN_PER_IP,
  PrivySignInError,
  signInWithPrivy,
} from "@rostr/db";
import { accountGaps } from "@/lib/account";
import { db } from "@/lib/db";
import { PrivyLoginError, privyLogin } from "@/lib/privy";
import { byIp, enforceRateLimit } from "@/lib/rate-limit";
import { currentUser, setSessionCookie } from "@/lib/session";

/**
 * Exchange a Privy login for a rostr session.
 *
 * The browser finishes Privy's login, then posts the access token here. The
 * token is verified and the user record read from Privy (`lib/privy.ts`), the
 * rostr account is found or created from those facts (`signInWithPrivy`), and
 * the ordinary `rostr_session` cookie is set — so nothing downstream of
 * `currentUser()` changes.
 *
 * **Post it again whenever the Privy account changes.** The embedded wallet is
 * created a moment *after* login, and X is linked later still, so the first
 * post of a new person usually records neither. Every post re-reads Privy's
 * record and brings the account up to date; a post from somebody already
 * signed in as that account refreshes it without minting another session.
 *
 * **JSON only, and that is the login-CSRF defence.** A page on another site can
 * submit a form here carrying *its own* token, signing the visitor into an
 * account the attacker controls. A cross-site request cannot send
 * `Content-Type: application/json` without a CORS preflight, which this route
 * does not answer, so requiring it closes that door.
 */

const STATUS: Record<string, number> = {
  TOKEN_INVALID: 401,
  PRIVY_UNAVAILABLE: 503,
  // The request is well-formed; the Privy account simply lacks what an
  // account here needs.
  EMAIL_REQUIRED: 422,
  ACCOUNT_CONFLICT: 409,
  WALLET_TAKEN: 409,
};

export async function POST(request: Request): Promise<NextResponse> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  const body = (await request.json().catch(() => ({}))) as { accessToken?: unknown };
  if (typeof body.accessToken !== "string" || body.accessToken.trim() === "") {
    return NextResponse.json({ error: "accessToken is required" }, { status: 400 });
  }

  const login = privyLogin();
  if (!login) {
    return NextResponse.json(
      { error: "Sign-in is not configured here", code: "NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  // Per address only: there is no account to charge until this succeeds.
  const limited = await enforceRateLimit([byIp(PRIVY_SIGN_IN_PER_IP, request)]);
  if (limited) return limited;

  try {
    const account = await login.verify(body.accessToken);
    const { user, isNew } = await signInWithPrivy(db(), account);

    const gaps = accountGaps({
      username: user.username,
      verifiedWallets: (await getWallets(db(), user.id)).length,
    });
    // `userId` is the caller's own id, returned so the tab can tell on a later
    // page load whether rostr's session is still this account (`canSkipExchange`).
    const response = NextResponse.json({ signedIn: true, isNew, gaps, userId: user.id });

    if ((await currentUser())?.id !== user.id) {
      const session = await createSession(db(), user.id);
      setSessionCookie(response, session.token);
    }
    return response;
  } catch (error) {
    if (error instanceof PrivyLoginError || error instanceof PrivySignInError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}
