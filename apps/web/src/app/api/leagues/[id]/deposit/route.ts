import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { verifyOnChainDeposit } from "@rostr/escrow";
import {
  getLeagueRules,
  getOnChainDeposit,
  memberWallet,
  recordOnChainDeposit,
} from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { assertRpcCluster, ClusterConfigError } from "@/lib/cluster";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";
import { depositsOpen } from "@/lib/pot";

/**
 * Recording that a member has staked into a league on-chain.
 *
 * The member signs `deposit` from their own wallet — no key of ours is
 * involved — and then tells us it happened. **A report is not evidence.** This
 * reads the `Membership` PDA back before recording anything, and the amount
 * recorded is what the program wrote to `Membership.deposited` (which equals
 * `league.buy_in` by construction), not anything the client claimed.
 *
 * **`deposited > 0` does not mean "currently staked".** `refund_stake` leaves
 * `deposited` in place as history and sets `refunded`, so a member who has taken
 * their money back out still reads `deposited > 0`. `verifyOnChainDeposit` now
 * checks both; see `packages/escrow/src/membership.test.ts` for the four states.
 *
 * **The wallet is derived from this user's own membership row**, never taken
 * from the request. See `memberWallet`.
 *
 * ## This route was inert until on-chain join shipped. It is not any more
 *
 * It used to say, here, that the path was inert **structurally**: `deposit`
 * needs a `Membership` account, only `join_league` creates one, and the app did
 * not invoke `join_league` — so `verifyOnChainDeposit` answered `NOT_JOINED` for
 * everyone and nothing could be recorded. That was true, and it stopped being
 * true when `JoinPanel` began sending `join_league`. The sentence outlived the
 * property it described.
 *
 * What replaces it is `potDepositGate` (`@rostr/escrow`), read through
 * `depositsOpen()`, and it is applied where a deposit is **invited** — the stake
 * button — not here.
 *
 * ## Why this route does not refuse when that gate is closed
 *
 * Deliberate, and the opposite of the obvious move.
 *
 * By the time anything reaches this handler the tokens have already moved: the
 * browser builds `deposit`, signs it, and sends it to the chain itself, and only
 * then reports it. Refusing to record does not empty a vault. It produces a
 * member whose money is in escrow and a database that has never heard of it —
 * so nobody can tell them when their timelock opens, and the record disagrees
 * with the chain, which is its own kind of serious in a project whose whole
 * claim is that the two agree.
 *
 * Recording a deposit we would rather not have taken is strictly better than not
 * knowing about it. So this route's job is to record the truth and say what is
 * true: `settlementPending` tells the member the program cannot pay out yet, and
 * the refund unlock is the date that matters to them.
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

    // Shape-checked only, as in the anchor route: it records *which* transaction
    // moved the money so a stranger can go and look at it. Nothing trusts it.
    const body = (await request.json().catch(() => ({}))) as { signature?: unknown };
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";

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

    // A free league has no vault and no buy-in, so there is nothing to stake and
    // the program has no instruction that would accept one. Refusing here says
    // so plainly rather than letting it surface as `NOT_DEPOSITED`, which reads
    // like a transaction that failed.
    if (!stored.rules.pot) {
      return NextResponse.json(
        { error: "This league is free — there is no pot to stake into." },
        { status: 409 },
      );
    }

    const walletAddress = await memberWallet(client, id, user.id);
    if (!walletAddress) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
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
    const cluster = await assertRpcCluster(connection);

    const verdict = await verifyOnChainDeposit(program, id, new PublicKey(walletAddress));

    if (!verdict.ok) {
      const message =
        verdict.reason === "NOT_JOINED"
          ? "This wallet has not joined this league on-chain yet. Join first, then stake."
          : verdict.reason === "ALREADY_REFUNDED"
            ? "This stake has already been refunded. A refunded membership cannot stake again."
            : "No stake has landed on-chain for this wallet yet. If the transaction was " +
              "just sent, give it a moment and try again.";

      return NextResponse.json({ error: message, reason: verdict.reason }, { status: 409 });
    }

    await recordOnChainDeposit(
      client,
      id,
      walletAddress,
      verdict.deposited.toString(),
      signature,
      cluster,
    );

    return NextResponse.json({
      deposited: true,
      baseUnits: verdict.deposited.toString(),
      cluster,
      signature,
      // Recorded, and said out loud: this stake is in a vault the program has no
      // instruction to pay out, so the timelock refund is the only way it moves
      // until D6 ships. A member who got here past a closed gate is owed that
      // sentence rather than a bare success.
      settlementPending: !depositsOpen(),
      refundUnlockAt: stored.rules.pot.refundUnlockAt,
    });
  } catch (error) {
    if (error instanceof EscrowConfigError || error instanceof ClusterConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
