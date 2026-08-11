import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { verifyOnChainJoin } from "@rostr/escrow";
import { getChainState, memberWallet, getOnChainJoin, recordOnChainJoin } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";
import { assertRpcCluster, ClusterConfigError } from "@/lib/cluster";

/**
 * Recording that a member has joined a league on-chain.
 *
 * The member signs `join_league` from their own wallet — no key of ours is
 * involved — and then tells us it happened. **A report is not evidence.** A
 * signature proves some transaction occurred, not which; so this reads the
 * `Membership` PDA back before recording anything.
 *
 * ## The wallet is never taken from the request
 *
 * It is read from the caller's own `league_memberships` row. That single choice
 * does three things a body field could not: it proves the caller joined this
 * league in Postgres (the ordering this record depends on), it inherits the
 * signature `joinLeague` already verified over the rules hash, and it makes it
 * impossible to write a record against somebody else's wallet.
 *
 * An earlier version of this route accepted `walletAddress` in the body and
 * checked only its shape. Any signed-in account could then attribute a
 * fabricated signature to another member's wallet, and — because a recorded row
 * short-circuits this handler — the real member could never correct it. That is
 * the same defect `/api/leagues/[id]/join` was fixed for: **if you find yourself
 * reading an identifier out of a body, stop.**
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const user = await currentUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in first" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { signature?: unknown };
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";

    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      return NextResponse.json(
        { error: "A base58 transaction signature is required" },
        { status: 400 },
      );
    }

    const client = db();

    // The consent record is the source of the wallet, so its absence is also
    // the ordering check: no on-chain record without a db-side join behind it.
    const walletAddress = await memberWallet(client, id, user.id);
    if (!walletAddress) {
      return NextResponse.json(
        { error: "You have not joined this league yet", reason: "NOT_A_MEMBER" },
        { status: 403 },
      );
    }

    // Which chain this league lives on was fixed when it was anchored, and the
    // db-side join already refuses a league that is not anchored. Recording an
    // on-chain join for an unanchored league would assert a fact about a chain
    // nobody has committed to; recording one observed on a *different* cluster
    // would be worse, because the PDA is byte-identical everywhere and the row
    // would look right.
    const chain = await getChainState(client, id);
    if (!chain?.anchoredAt) {
      return NextResponse.json(
        { error: "This league is not anchored on-chain yet", reason: "NOT_ANCHORED" },
        { status: 409 },
      );
    }

    // Already recorded is success, not an error — re-posting after a lost
    // response is the ordinary case, and only this member can write this row.
    const existing = await getOnChainJoin(client, id, walletAddress);
    if (existing?.joinedAt) {
      return NextResponse.json({
        joined: true,
        alreadyRecorded: true,
        cluster: existing.cluster,
        signature: existing.signature,
      });
    }

    // The signature is an audit breadcrumb, not the proof. The join is accepted
    // or refused entirely on whether the Membership account exists.
    const { connection, program } = readOnlyEscrow();
    // Two different questions, and both have to be asked.
    //
    // `assertRpcCluster` confirms the endpoint really is the chain this
    // deployment declares — by genesis hash, because a private RPC’s hostname
    // says nothing about what is behind it.
    //
    // The comparison below then confirms that chain is also the one this
    // *league* was anchored on. A correctly configured server reading the right
    // chain can still be looking at a league anchored somewhere else, and the
    // PDA is byte-identical everywhere, so the row would look right.
    const cluster = await assertRpcCluster(connection);

    if (chain.cluster && chain.cluster !== cluster) {
      return NextResponse.json(
        {
          error:
            `This league is anchored on ${chain.cluster}, but the server is reading ` +
            `${cluster}. Refusing to record a join observed on the wrong chain.`,
          reason: "WRONG_CLUSTER",
        },
        { status: 409 },
      );
    }

    const verdict = await verifyOnChainJoin(program, id, new PublicKey(walletAddress));

    if (!verdict.ok) {
      return NextResponse.json(
        {
          error:
            "No membership account exists on-chain yet. If the transaction was just sent, " +
            "give it a moment and try again.",
          reason: verdict.reason,
        },
        { status: 409 },
      );
    }

    await recordOnChainJoin(client, id, walletAddress, user.id, signature, cluster);

    return NextResponse.json({
      joined: true,
      cluster,
      signature,
      walletAddress,
      league: verdict.membership.league.toBase58(),
      member: verdict.membership.member.toBase58(),
    });
  } catch (error) {
    if (error instanceof EscrowConfigError || error instanceof ClusterConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
