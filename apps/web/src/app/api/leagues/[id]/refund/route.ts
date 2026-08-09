import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { clusterOf, verifyOnChainRefund } from "@rostr/escrow";
import { getOnChainRefund, recordOnChainRefund } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";

/**
 * Recording that a member has withdrawn their stake on-chain.
 *
 * The refund instruction is unconditional after the timelock and signed by the
 * member alone — nobody can trigger someone else's refund. As everywhere, a
 * report is not evidence: this reads the `Membership` PDA back and confirms
 * `refunded == true` before recording anything.
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

    const existing = await getOnChainRefund(client, id, walletAddress);
    if (existing?.refundedAt) {
      return NextResponse.json({
        refunded: true,
        alreadyRecorded: true,
        cluster: existing.refundCluster,
        signature: existing.refundSignature,
      });
    }

    const { connection, program } = readOnlyEscrow();
    const verdict = await verifyOnChainRefund(program, id, new PublicKey(walletAddress));

    if (!verdict.ok) {
      const message =
        verdict.reason === "NOT_JOINED"
          ? "This wallet has not joined this league on-chain yet."
          : verdict.reason === "NOTHING_DEPOSITED"
            ? "There is no stake to refund — this wallet never deposited."
            : "This stake has already been refunded on-chain.";
      return NextResponse.json({ error: message, reason: verdict.reason }, { status: 409 });
    }

    const cluster = clusterOf(connection);

    await recordOnChainRefund(client, id, walletAddress, signature, cluster);

    return NextResponse.json({ refunded: true, cluster, signature });
  } catch (error) {
    if (error instanceof EscrowConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
