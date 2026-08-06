import { NextResponse } from "next/server";
import {
  getWallets,
  IdentityError,
  issueWalletChallenge,
  linkWalletWithSignature,
  SessionError,
} from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

const STATUS: Record<string, number> = {
  USER_NOT_FOUND: 401,
  CHALLENGE_NOT_FOUND: 409,
  CHALLENGE_EXPIRED: 410,
  BAD_SIGNATURE: 403,
  INVALID_WALLET: 400,
  WALLET_TAKEN: 409,
};

/** The wallets this account has proven it holds. */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  return NextResponse.json({ wallets: await getWallets(db(), user.id) });
}

/**
 * Issue a challenge, or consume one.
 *
 * The user always comes from the session cookie, never from the request. A body
 * that named its own user ID would let anyone link a wallet to anyone's account.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json()) as {
    walletAddress?: string;
    signature?: string;
  };

  if (!body.walletAddress) {
    return NextResponse.json({ error: "walletAddress is required" }, { status: 400 });
  }

  try {
    // No signature yet means "give me something to sign".
    if (!body.signature) {
      const challenge = await issueWalletChallenge(db(), user.id, body.walletAddress);
      return NextResponse.json({
        message: challenge.message,
        expiresAt: challenge.expiresAt.toISOString(),
      });
    }

    const wallet = await linkWalletWithSignature(
      db(),
      user.id,
      body.walletAddress,
      body.signature,
    );
    return NextResponse.json({ wallet }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionError || error instanceof IdentityError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}
