import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { clusterOf, verifyOnChainDeposit } from "@rostr/escrow";
import { getOnChainDeposit, getLeagueRules, recordOnChainDeposit } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";

/**
 * Recording that a member has staked into a league on-chain.
 *
 * The member signs `deposit` from their own wallet — no key of ours is
 * involved — and then tells us it happened. **A report is not evidence.** This
 * reads the `Membership` PDA back and confirms `deposited > 0` before recording
 * anything. The amount recorded is what the program wrote to `Membership.deposited`
 * (which equals `league.buy_in`), not anything the client claimed.
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

    const stored = await getLeagueRules(client, id);
    if (!stored) {
      return NextResponse.json({ error: "League has no stored rules" }, { status: 404 });
    }

    const existing = await getOnChainDeposit(client, id, walletAddress);
    if (existing?.depositedSignature) {
      return NextResponse.json({
        deposited: true,
        alreadyRecorded: true,
        baseUnits: existing.depositedBaseUnits,
        cluster: existing.depositedCluster,
        signature: existing.depositedSignature,
      });
    }

    const { connection, program } = readOnlyEscrow();
    const verdict = await verifyOnChainDeposit(program, id, new PublicKey(walletAddress));

    if (!verdict.ok) {
      return verdict.reason === "NOT_JOINED"
        ? NextResponse.json(
            {
              error:
                "This wallet has not joined this league on-chain yet. Join first, then stake.",
              reason: verdict.reason,
            },
            { status: 409 },
          )
        : NextResponse.json(
            {
              error:
                "This wallet has already deposited into this league. A second deposit is refused on-chain.",
              reason: verdict.reason,
            },
            { status: 409 },
          );
    }

    const cluster = clusterOf(connection);

    await recordOnChainDeposit(client, id, walletAddress, verdict.deposited.toString(), signature, cluster);

    return NextResponse.json({
      deposited: true,
      baseUnits: verdict.deposited.toString(),
      cluster,
      signature,
    });
  } catch (error) {
    if (error instanceof EscrowConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
