import { NextResponse } from "next/server";
import {
  anchorTermMismatches,
  clusterOf,
  expectedTermsFromRules,
  verifyLeagueAnchor,
} from "@rostr/escrow";
import { getChainState, getLeagueRules, recordChainAnchor } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";

/**
 * Recording that a league's rules are anchored on-chain.
 *
 * The commissioner signs `initialize_league` from their own wallet — no key of
 * ours is involved — and then tells us it happened. **A report is not evidence.**
 * A signature proves some transaction occurred, not which, and a client can claim
 * anything. So this reads the account back and confirms it holds *our* rules hash
 * before recording anything.
 *
 * **A matching hash is not enough.** The program stores the economic terms as a
 * separate copy it has no way to check against the hash, so a creator can anchor
 * the benign document members sign while initialising a hostile buy-in, refund
 * unlock, fee recipient or payout split. The hash would verify and the money
 * would not be the money anyone agreed to.
 *
 * Both checks live in `@rostr/escrow` rather than inline here — `verifyLeagueAnchor`
 * so it can be exercised against a real validator, `expectedTermsFromRules` and
 * `anchorTermMismatches` so the mapping and the comparison are covered by the fast
 * suite. `apps/web` has no test project, so anything inline in this file would be
 * verified only by being run in production. What is left here is the session, the
 * write, and the status codes.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.userId) {
      return NextResponse.json({ error: "Sign in first" }, { status: 401 });
    }

    // Anyone may *verify* an anchor; only the commissioner's action creates one,
    // and recording it is part of creating a league. It takes no argument from
    // the caller beyond the league, so the worst a non-commissioner could do is
    // record something true — but league setup is the commissioner's, and a
    // narrower door is the right default.
    if (!context.isCommissioner) {
      return NextResponse.json(
        { error: "Only the commissioner can anchor this league" },
        { status: 403 },
      );
    }

    const client = db();

    const stored = await getLeagueRules(client, id);
    if (!stored) {
      return NextResponse.json({ error: "League has no stored rules" }, { status: 404 });
    }

    const { connection, program } = readOnlyEscrow();

    /**
     * What the chain says, checked against what members signed.
     *
     * Both the hash and the terms, in one place, because a caller that checked
     * one and not the other is exactly the hole this route exists to close.
     */
    const inspect = async () => {
      const verdict = await verifyLeagueAnchor(program, id, stored.hash);
      return {
        verdict,
        mismatches: verdict.ok
          ? anchorTermMismatches(verdict.league, expectedTermsFromRules(stored.rules))
          : [],
      };
    };

    // Already anchored is success, not an error. Anchoring is a second
    // transaction the commissioner signs, so a retry after a lost response is
    // the ordinary case — and the record is write-once anyway, so a second
    // write would raise from a trigger rather than quietly re-point it.
    //
    // **It is still re-checked.** Returning early on the stored boolean alone
    // would mean the terms check never runs for any league anchored before it
    // existed, and nothing else in the system ever reads the account again —
    // so a league recorded once would be trusted forever on the strength of a
    // check that may never have happened.
    const existing = await getChainState(client, id);
    if (existing?.anchoredAt) {
      const { verdict, mismatches } = await inspect();

      if (!verdict.ok || mismatches.length > 0) {
        return NextResponse.json(
          {
            error:
              "This league is recorded as anchored, but the account on-chain no longer " +
              "matches the rules shown here. Nobody should join or deposit.",
            reason: verdict.ok ? "TERMS_MISMATCH" : verdict.reason,
            mismatches,
          },
          { status: 409 },
        );
      }

      return NextResponse.json({
        anchored: true,
        alreadyRecorded: true,
        cluster: existing.cluster,
        signature: existing.signature,
      });
    }

    // The signature is an audit breadcrumb, not the proof. It records *which*
    // transaction created the account so a stranger can go and look at it — but
    // nothing here trusts it, and the anchor is accepted or refused entirely on
    // what the account says. Shape-checked only, because a malformed one would
    // be recorded forever in a write-once column.
    const body = (await request.json().catch(() => ({}))) as { signature?: unknown };
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";

    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      return NextResponse.json(
        { error: "A base58 transaction signature is required" },
        { status: 400 },
      );
    }

    const { verdict, mismatches } = await inspect();

    if (!verdict.ok) {
      // Deliberately specific. "Not found" means the transaction has not landed
      // — retry. "Hash mismatch" means the chain holds a different rule set,
      // which is not a retry, it is a league nobody should join.
      return verdict.reason === "NOT_FOUND"
        ? NextResponse.json(
            {
              error:
                "No league account exists on-chain yet. If the transaction was just sent, " +
                "give it a moment and try again.",
              reason: verdict.reason,
            },
            { status: 409 },
          )
        : NextResponse.json(
            {
              error:
                "The on-chain rules hash does not match this league's. Do not let anyone " +
                "join: the chain holds a different rule set than the one shown here.",
              reason: verdict.reason,
              onChain: verdict.onChain,
              expected: verdict.expected,
            },
            { status: 409 },
          );
    }

    // The hash matches, but the program stores the economic terms as a separate
    // copy it cannot check against the hash — so a matching hash does not prove a
    // matching buy-in, refund unlock, fee recipient or payout split. Compare the
    // terms the signed rules imply against what the account actually holds, and
    // refuse an anchor that diverges: like a hash mismatch, it is a league nobody
    // should join or deposit into, and the account can never be corrected.
    if (mismatches.length > 0) {
      return NextResponse.json(
        {
          error:
            "The on-chain league holds different terms than the rules shown here. Do not let " +
            "anyone join or deposit: the account was initialised with terms nobody agreed to.",
          reason: "TERMS_MISMATCH",
          mismatches,
        },
        { status: 409 },
      );
    }

    // The cluster is read off the endpoint we just queried, not accepted from
    // the caller. The PDA is identical on every chain, so without it a devnet
    // anchor is indistinguishable from a mainnet one.
    const cluster = clusterOf(connection);

    await recordChainAnchor(client, id, { signature, cluster });

    return NextResponse.json({
      anchored: true,
      cluster,
      signature,
      address: verdict.league.address.toBase58(),
      rulesHash: verdict.league.rulesHash,
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EscrowConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
