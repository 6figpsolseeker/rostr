import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  anchorTermMismatches,
  expectedTermsFromRules,
  verifyLeagueAnchor,
} from "@rostr/escrow";
import {
  commissionerOwnsWallet,
  getChainState,
  getLeagueRules,
  recordChainAnchor,
} from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";
import { assertRpcCluster, ClusterConfigError } from "@/lib/cluster";

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
 * suite, which needs no credentials and no chain. What is left here is the session,
 * the write, and the status codes.
 *
 * **Which wallet anchored is recorded too, and it is checked before it is.** The
 * league's address derives from its id *and* the paying wallet, so that knowing
 * an id — which the lobby and every invite link publish — is not enough to
 * create its account. That makes the wallet the input every later instruction
 * needs. The browser names it; this accepts it only if it is one of the
 * commissioner's own verified wallets (`commissionerOwnsWallet`), and then reads
 * the account at the address *that* wallet derives. A stranger's copy of the
 * league sits at an address derived from the stranger's key, and nothing here
 * ever looks there.
 *
 * `apps/web` does now have a test project (`pnpm test:web`), but it requires a
 * database and would require a validator to reach this route — so keeping the
 * checkable parts checkable without either is still the right split.
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

    // Before reading a single account, confirm we are reading the right chain.
    //
    // This is first, not just before the write, because every check below is
    // taken against whatever `connection` is talking to: `verifyLeagueAnchor`
    // reading the wrong cluster answers `NOT_FOUND` for a league that is
    // correctly anchored, and the route documents `NOT_FOUND` as "retry". The
    // commissioner would retry forever against a chain their wallet never
    // touched.
    //
    // It also decides the value recorded, so there is no path by which an
    // unverified cluster reaches the write-once column.
    const cluster = await assertRpcCluster(connection);

    /**
     * What the chain says, checked against what members signed.
     *
     * Both the hash and the terms, in one place, because a caller that checked
     * one and not the other is exactly the hole this route exists to close.
     */
    const inspect = async (commissioner: PublicKey) => {
      const verdict = await verifyLeagueAnchor(program, id, commissioner, stored.hash);
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
    //
    // **Checked at the recorded wallet, never one in the request.** The caller
    // could otherwise name any account and have this report the league healthy.
    const existing = await getChainState(client, id);
    if (existing?.anchoredAt) {
      // Anchored under the old program, whose address derived from the id alone.
      // No wallet seeds it, so nothing can derive it any more, and guessing the
      // old address would vouch for an account no instruction can use.
      if (!existing.commissioner) {
        return NextResponse.json(
          {
            error:
              "This league was anchored by an earlier version of the escrow program, " +
              "which this one cannot reach. Create the league again.",
            reason: "LEGACY_ANCHOR",
          },
          { status: 409 },
        );
      }

      const { verdict, mismatches } = await inspect(new PublicKey(existing.commissioner));

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
        commissioner: existing.commissioner,
      });
    }

    // The signature is an audit breadcrumb, not the proof. It records *which*
    // transaction created the account so a stranger can go and look at it — but
    // nothing here trusts it, and the anchor is accepted or refused entirely on
    // what the account says. Shape-checked only, because a malformed one would
    // be recorded forever in a write-once column.
    const body = (await request.json().catch(() => ({}))) as {
      signature?: unknown;
      commissioner?: unknown;
    };
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";

    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      return NextResponse.json(
        { error: "A base58 transaction signature is required" },
        { status: 400 },
      );
    }

    // The wallet the browser anchored with. Off the curve cannot sign, so it
    // cannot have paid for `initialize_league` — refused before any lookup.
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(typeof body.commissioner === "string" ? body.commissioner : "");
    } catch {
      wallet = PublicKey.default;
    }
    if (wallet.equals(PublicKey.default) || !PublicKey.isOnCurve(wallet.toBytes())) {
      return NextResponse.json(
        { error: "The wallet that anchored the league is required", reason: "INVALID_WALLET" },
        { status: 400 },
      );
    }

    // Never an identifier from a body without proving it belongs to the caller.
    // The session already proved the caller is the commissioner; this proves the
    // wallet is theirs. Before the RPC read because it is the cheaper refusal.
    if (!(await commissionerOwnsWallet(client, id, wallet.toBase58()))) {
      return NextResponse.json(
        {
          error:
            "Anchor from a wallet linked to your account. This one is not, so the league " +
            "could not be found at its address.",
          reason: "WALLET_NOT_COMMISSIONERS",
        },
        { status: 403 },
      );
    }

    const { verdict, mismatches } = await inspect(wallet);

    if (!verdict.ok) {
      // Deliberately specific. "Not found" means the transaction has not landed
      // — retry. "Hash mismatch" means the chain holds a different rule set,
      // which is not a retry, it is a league nobody should join.
      if (verdict.reason === "NOT_FOUND") {
        return NextResponse.json(
          {
            error:
              "No league account exists on-chain yet. If the transaction was just sent, " +
              "give it a moment and try again.",
            reason: verdict.reason,
          },
          { status: 409 },
        );
      }

      /*
        An account is there and this build cannot read it.

        The third refusal, and it is the one that must not be confused with the
        first: they are indistinguishable from a distance and mean opposite
        things. `NOT_FOUND` invites a retry; this one has to say plainly that
        retrying is the single action guaranteed not to work. The program has
        no `close`, so those bytes are at that address for good. The wallet is
        a seed of the address, so anchoring from another of the commissioner's
        wallets reaches a fresh one — nothing has been recorded yet.

        Reachable when the program's account layout moves and a league was
        anchored under the older one. Before this it escaped as a 500.
      */
      if (verdict.reason === "INCOMPATIBLE") {
        return NextResponse.json(
          {
            error:
              "This league was anchored by a different version of the escrow program and " +
              "cannot be read. That account can never be freed, but anchoring again from " +
              "another wallet linked to your account creates a fresh one.",
            reason: verdict.reason,
            detail: verdict.detail,
          },
          { status: 409 },
        );
      }

      return NextResponse.json(
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

    // Conditional on nothing being recorded yet. Losing means a concurrent request
    // anchored first — reachable now that a commissioner with two verified wallets
    // can produce two valid accounts — and the league is whatever it recorded.
    const recorded = await recordChainAnchor(client, id, {
      signature,
      cluster,
      commissioner: wallet.toBase58(),
    });
    if (!recorded) {
      const winner = await getChainState(client, id);
      return NextResponse.json(
        {
          error: "This league was anchored by another request a moment ago.",
          reason: "ALREADY_ANCHORED",
          commissioner: winner?.commissioner ?? null,
          signature: winner?.signature ?? null,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      anchored: true,
      cluster,
      signature,
      commissioner: wallet.toBase58(),
      address: verdict.league.address.toBase58(),
      rulesHash: verdict.league.rulesHash,
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EscrowConfigError || error instanceof ClusterConfigError) {
      // 503, not 500: the deployment is misconfigured, the request was sound,
      // and nothing was written. A retry after the config is fixed succeeds.
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
