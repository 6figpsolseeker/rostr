import { NextResponse } from "next/server";
import { getWallets } from "@rostr/db";
import { db } from "@/lib/db";
import { accountGaps } from "@/lib/account";
import { currentUser } from "@/lib/session";

/**
 * Who you are, and what your account still needs.
 *
 * One request rather than three, because every client of it wants the same
 * three facts together — the header, the welcome flow, and the invite box all
 * ask "is this account finished, and what is it called".
 *
 * **The user comes from the session cookie and never from the request.** That
 * rule is the reason the join route stopped taking a `userId`; it applies to a
 * read as much as to a write, because a read that took an id would publish
 * anyone's email to anyone who asked for it.
 */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) {
    // 200 with a null user rather than 401. The header renders for signed-out
    // visitors too, and a 401 there would put an error in the console of every
    // logged-out page load — training everyone to ignore the console.
    return NextResponse.json({ user: null, gaps: [] });
  }

  const wallets = await getWallets(db(), user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      wallets: wallets.map((wallet) => ({
        address: wallet.address,
        isPrimary: wallet.isPrimary,
      })),
    },
    gaps: accountGaps({ username: user.username, verifiedWallets: wallets.length }),
  });
}
