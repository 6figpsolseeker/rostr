import { NextResponse } from "next/server";
import { getJoinMessage, JoinError, joinLeague } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

/**
 * The message to sign.
 *
 * Built server-side and returned to the client, which shows it and signs it.
 * The client never composes this itself — if it did, it could sign one thing and
 * have the server verify another.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const wallet = new URL(request.url).searchParams.get("wallet");

  if (!wallet) {
    return NextResponse.json({ error: "wallet query parameter is required" }, { status: 400 });
  }

  try {
    return NextResponse.json({ message: await getJoinMessage(db(), id, wallet) });
  } catch (error) {
    if (error instanceof JoinError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 404 });
    }
    throw error;
  }
}

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  RULES_MISSING: 500,
  LEAGUE_CLOSED: 409,
  LEAGUE_FULL: 409,
  ALREADY_JOINED: 409,
  INVALID_WALLET: 400,
  WALLET_NOT_LINKED: 403,
  INVALID_SIGNATURE: 403,
  // Not an error the joiner caused, and not permanent — the commissioner has to
  // anchor first. 409 rather than 403 says "wrong state", not "not allowed".
  LEAGUE_NOT_ANCHORED: 409,
  WRONG_CLUSTER: 409,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // From the session cookie, never from the body. This route used to accept a
  // `userId` the client supplied, which meant anyone could join any league as
  // anyone — the wallet signature proved they held a key, but nothing tied that
  // key to the account being credited.
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to join a league" }, { status: 401 });
  }

  const body = (await request.json()) as {
    walletAddress?: string;
    signature?: string;
    teamName?: string;
  };

  if (!body.walletAddress || !body.signature || !body.teamName) {
    return NextResponse.json(
      { error: "walletAddress, signature, and teamName are required" },
      { status: 400 },
    );
  }

  const pool = db();
  const { client, release } = await pool.connect();

  try {
    const result = await joinLeague(client, {
      leagueId: id,
      userId: user.id,
      walletAddress: body.walletAddress,
      signature: body.signature,
      teamName: body.teamName,
      // The cluster this deployment considers real. Without it a league
      // anchored on devnet would satisfy a mainnet join, since the PDA is the
      // same everywhere.
      ...(process.env["SOLANA_CLUSTER"]
        ? { requireCluster: process.env["SOLANA_CLUSTER"] }
        : {}),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof JoinError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  } finally {
    release();
  }
}
