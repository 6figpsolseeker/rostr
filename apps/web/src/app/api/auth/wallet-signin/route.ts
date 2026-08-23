import { NextResponse } from "next/server";
import {
  getWallets,
  issueWalletSignInChallenge,
  SessionError,
  signInWithWallet,
  WALLET_CHALLENGE_PER_IP,
} from "@rostr/db";
import { db } from "@/lib/db";
import { accountGaps } from "@/lib/account";
import { byIp, enforceRateLimit } from "@/lib/rate-limit";
import { setSessionCookie } from "@/lib/session";

/**
 * Sign in with a wallet you have already linked.
 *
 * Two steps on one route: `POST` with an address issues a challenge, `POST` with
 * an address **and** a signature spends it and opens a session. One file because
 * they are one exchange, and splitting them would put the challenge's rate limit
 * somewhere the verification could not see.
 *
 * **Separate from `/api/auth/wallet`**, which links a wallet to an account you
 * are already inside. That one requires a session; this one issues one. Sharing
 * a route would mean a single handler where being signed in is sometimes
 * required and sometimes forbidden.
 */

const STATUS: Record<string, number> = {
  INVALID_WALLET: 400,
  // Not 404. The address is well-formed and the request is understood — there
  // is simply no account behind it, and the screen turns this into "sign in by
  // email once and link it".
  WALLET_NOT_LINKED: 409,
  CHALLENGE_NOT_FOUND: 409,
  CHALLENGE_USED: 409,
  CHALLENGE_EXPIRED: 410,
  BAD_SIGNATURE: 403,
  USER_NOT_FOUND: 401,
};

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    address?: unknown;
    signature?: unknown;
  };

  if (typeof body.address !== "string") {
    return NextResponse.json({ error: "address is required" }, { status: 400 });
  }

  /*
    Per-address rate limiting is not possible here and per-IP is.

    The other wallet route charges a per-user bucket as well, because it knows
    who is asking. This one is the thing that establishes that, so there is no
    account to charge until the exchange succeeds. Per-IP alone is weaker and it
    is what there is — noted rather than left to be discovered, and the same
    caveat `clientIp` already carries about spoofing behind a proxy we do not
    control.
  */
  const limited = await enforceRateLimit([byIp(WALLET_CHALLENGE_PER_IP, request)]);
  if (limited) return limited;

  try {
    if (typeof body.signature !== "string") {
      const challenge = await issueWalletSignInChallenge(db(), body.address);
      return NextResponse.json({
        message: challenge.message,
        expiresAt: challenge.expiresAt.toISOString(),
      });
    }

    const { user, session } = await signInWithWallet(db(), body.address, body.signature);

    // `gaps` rides along exactly as the emailed-code route sends it, and for the
    // same reason: fetched afterwards, an account still needing a username would
    // briefly land somewhere that immediately bounces it.
    const gaps = accountGaps({
      username: user.username,
      verifiedWallets: (await getWallets(db(), user.id)).length,
    });

    const response = NextResponse.json({ signedIn: true, gaps });
    setSessionCookie(response, session.token);
    return response;
  } catch (error) {
    if (error instanceof SessionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}
