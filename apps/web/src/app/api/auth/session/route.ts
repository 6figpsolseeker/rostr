import { NextResponse } from "next/server";
import { getWallets, revokeSession } from "@rostr/db";
import { db } from "@/lib/db";
import { clearSessionCookie, currentSessionToken, currentUser } from "@/lib/session";

/** Who is signed in, and which wallets they have proven they hold. */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ user: null, wallets: [] });

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
    },
    wallets: await getWallets(db(), user.id),
  });
}

/** Sign out. */
export async function DELETE(): Promise<NextResponse> {
  const token = await currentSessionToken();
  if (token) await revokeSession(db(), token);

  // The cookie clears whether or not the token was known, so a stale cookie
  // cannot leave someone stuck looking signed in.
  const response = NextResponse.json({ signedOut: true });
  clearSessionCookie(response);
  return response;
}
