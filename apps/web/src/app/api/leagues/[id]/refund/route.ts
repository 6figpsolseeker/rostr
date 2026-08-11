import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { verifyOnChainRefund } from "@rostr/escrow";
import { getOnChainRefund, memberWallet, recordOnChainRefund } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { assertRpcCluster, ClusterConfigError } from "@/lib/cluster";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";

/**
 * Recording that a member has withdrawn their stake on-chain.
 *
 * `refund_stake` is unconditional after the timelock and signed by the member
 * alone — nobody can trigger someone else's refund, and that property is in the
 * program, not here. This route only writes down what the chain already did.
 *
 * ## Two things this gets right that the first version did not
 *
 * **The wallet is derived, never accepted.** It comes from this user's own
 * `league_memberships` row — the one carrying their signature over the rules
 * hash. Taking it from the request body meant any signed-in account could name
 * any wallet.
 *
 * **`verifyOnChainRefund` was inverted.** `refund_stake` sets `refunded = true`
 * and keeps `deposited` as history, so a genuine refund landed in exactly the
 * state the verifier rejected: no real refund could be recorded, while a member
 * who was still staked verified as refunded. Composed with the wallet coming
 * from the body, that let anyone mark anyone's live stake as returned.
 *
 * The on-chain guarantee was never touched by either — the money is where the
 * program says it is. This is the accounting agreeing with it.
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

    // Shape-checked only, exactly as the anchor route does it and for the same
    // reason: this records *which* transaction returned the money so a stranger
    // can go and look at it. Nothing here trusts it — the refund is accepted or
    // refused entirely on what the `Membership` account says.
    const body = (await request.json().catch(() => ({}))) as { signature?: unknown };
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";

    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      return NextResponse.json(
        { error: "A base58 transaction signature is required" },
        { status: 400 },
      );
    }

    const client = db();

    const walletAddress = await memberWallet(client, id, user.id);
    if (!walletAddress) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    // Already recorded is success, not an error: a refund is a transaction the
    // member signs, so a re-post after a lost response is the ordinary case.
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
    const cluster = await assertRpcCluster(connection);

    const verdict = await verifyOnChainRefund(program, id, new PublicKey(walletAddress));

    if (!verdict.ok) {
      // `NOT_REFUNDED` is the ordinary "not yet" and deserves saying so plainly:
      // the transaction may still be confirming, or the timelock may not have
      // passed. The other two mean this member was never in a position to
      // refund at all.
      const message =
        verdict.reason === "NOT_JOINED"
          ? "This wallet has not joined this league on-chain yet."
          : verdict.reason === "NOTHING_DEPOSITED"
            ? "There is no stake to refund — this wallet never deposited."
            : "No refund has landed on-chain for this stake yet. If the transaction " +
              "was just sent, give it a moment and try again.";

      return NextResponse.json({ error: message, reason: verdict.reason }, { status: 409 });
    }

    await recordOnChainRefund(client, id, walletAddress, signature, cluster);

    return NextResponse.json({
      refunded: true,
      cluster,
      signature,
      baseUnits: verdict.refunded.toString(),
    });
  } catch (error) {
    if (error instanceof EscrowConfigError || error instanceof ClusterConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
