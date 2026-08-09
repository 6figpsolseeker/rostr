import { NextResponse } from "next/server";
import { clusterOf, verifySettlement } from "@rostr/escrow";
import { getOnChainSettlement, recordOnChainSettlement } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";

/**
 * Recording that a league's final standings were posted on-chain.
 *
 * This is the single trusted input to settlement (issue #28): the settle
 * authority — the league creator at creation, rotatable to the Squads multisig —
 * signs `post_final_standings`, naming the five winners off-chain. Everything
 * after it is enforced by the program. As everywhere, a report is not evidence:
 * this reads the `FinalStandings` PDA back and confirms it exists (the winners
 * are frozen) before recording anything.
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

    const existing = await getOnChainSettlement(client, id);
    if (existing) {
      return NextResponse.json({
        settled: true,
        alreadyRecorded: true,
        cluster: existing.cluster,
        signature: existing.standingsSignature,
      });
    }

    const { connection, program } = readOnlyEscrow();
    const verdict = await verifySettlement(program, id);

    if (!verdict.ok) {
      return NextResponse.json(
        { error: "Final standings have not been posted on-chain for this league yet." },
        { status: 409 },
      );
    }

    const cluster = clusterOf(connection);

    await recordOnChainSettlement(client, id, signature, cluster);

    return NextResponse.json({ settled: true, cluster, signature });
  } catch (error) {
    if (error instanceof EscrowConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
