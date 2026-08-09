import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { clusterOf, verifyOnChainJoin } from "@rostr/escrow";
import { getOnChainJoin, getLeagueRules, recordOnChainJoin } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";

/**
 * Recording that a member has joined a league on-chain.
 *
 * The member signs `join_league` from their own wallet — no key of ours is
 * involved — and then tells us it happened. **A report is not evidence.** A
 * signature proves some transaction occurred, not which; and a client can claim
 * anything. So this reads the `Membership` PDA back and confirms it holds this
 * member's key before recording anything.
 *
 * That check is `verifyOnChainJoin` in `@rostr/escrow` rather than inline here,
 * so it is tested against a real validator instead of only in production — the
 * same discipline as the anchor route one level up.
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

    const body = (await request.json().catch(() => ({}))) as {
      walletAddress?: unknown;
      signature?: unknown;
    };
    const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      return NextResponse.json({ error: "A Solana wallet address is required" }, { status: 400 });
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      return NextResponse.json(
        { error: "A base58 transaction signature is required" },
        { status: 400 },
      );
    }

    const client = db();

    // The member must exist in Postgres (the db-side join) before the on-chain
    // half is recorded. This keeps the two facts independent but ordered: no
    // on-chain record without a consent record behind it.
    const stored = await getLeagueRules(client, id);
    if (!stored) {
      return NextResponse.json({ error: "League has no stored rules" }, { status: 404 });
    }

    // Already recorded on-chain is success, not an error — re-posting after a
    // lost response is the ordinary case, and the record is upserted.
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
    // or refused entirely on what the Membership account says.
    const { connection, program } = readOnlyEscrow();
    const verdict = await verifyOnChainJoin(program, id, new PublicKey(walletAddress));

    if (!verdict.ok) {
      // Deliberately specific. "Not found" means the transaction has not landed
      // — retry. "Member mismatch" means the chain holds a different wallet,
      // which is not a retry, it is a record nobody should trust.
      return verdict.reason === "NOT_FOUND"
        ? NextResponse.json(
            {
              error:
                "No membership account exists on-chain yet. If the transaction was just sent, " +
                "give it a moment and try again.",
              reason: verdict.reason,
            },
            { status: 409 },
          )
        : NextResponse.json(
            {
              error:
                "The on-chain membership belongs to a different wallet than the one that joined " +
                "here. Do not trust this join.",
              reason: verdict.reason,
              onChain: verdict.onChainMember,
              expected: verdict.expectedMember,
            },
            { status: 409 },
          );
    }

    const cluster = clusterOf(connection);

    await recordOnChainJoin(client, id, walletAddress, signature, cluster);

    return NextResponse.json({
      joined: true,
      cluster,
      signature,
      league: verdict.membership.league.toBase58(),
      member: verdict.membership.member.toBase58(),
    });
  } catch (error) {
    if (error instanceof EscrowConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
