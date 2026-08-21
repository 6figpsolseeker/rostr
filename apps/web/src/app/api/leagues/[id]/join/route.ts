import { NextResponse } from "next/server";
import { getJoinMessage, JoinError, joinLeague } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { ClusterConfigError, declaredCluster } from "@/lib/cluster";

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

  /**
   * A username is required, decided by the owner on 2026-08-21.
   *
   * It is what a commissioner types to invite you, so an account without one
   * cannot be reached by either of the two ways of asking — and joining a
   * league without being reachable is how somebody ends up alone in one.
   *
   * **This is the enforcement `lib/account.ts` said did not exist.** The gate
   * reported and refused nothing; it now refuses here, at the two points where
   * being unreachable actually costs something. `422` rather than `403`: the
   * request is well-formed and the account is simply unfinished, and the code
   * tells the client where to send them.
   */
  if (user.username === null || user.username.trim() === "") {
    return NextResponse.json(
      {
        error: "Pick a username first — it is how people invite you.",
        code: "USERNAME_REQUIRED",
      },
      { status: 422 },
    );
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
      //
      // **No longer a conditional spread.** An unset `SOLANA_CLUSTER` did not
      // relax this check, it deleted it — and the deployment guaranteed to have
      // it unset is the one nobody configured, which is exactly the one that
      // needs it. `declaredCluster` refuses in production rather than assuming.
      requireCluster: declaredCluster(),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ClusterConfigError) {
      // 503 and not 500: nothing about the request was wrong, and no member
      // should be admitted to a league whose chain this deployment cannot name.
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
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
