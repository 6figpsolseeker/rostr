import { NextResponse } from "next/server";
import { verifyOnChainSeasonStart } from "@rostr/escrow";
import { getChainState, getLeagueRules, recordSeasonStart } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";
import { EscrowConfigError, readOnlyEscrow } from "@/lib/escrow";
import { assertRpcCluster, ClusterConfigError } from "@/lib/cluster";

/**
 * Recording that a league's season has been declared started on-chain.
 *
 * The commissioner signs `start_season` from their own wallet — **no key of ours
 * is involved and none may be introduced** — and then tells us it happened. A
 * report is not evidence: a signature proves some transaction occurred, not
 * which. So this reads `League.started` back off the account before recording
 * anything, the same shape as `/anchor`, `/join-onchain` and `/deposit`.
 *
 * ## What it is protecting
 *
 * `refund_stake` has two openings and `League.started` is the only thing between
 * them: the ordinary timelock, months out, and `!started && now >=
 * start_deadline` — the draft time plus 48 hours — for a league that never
 * began. The second exists so a league that fails to fill returns everyone's
 * money in days.
 *
 * A pot league that drafts successfully and is never marked started stays on
 * that second schedule for its whole season. Any member could withdraw their
 * entire stake in week 3 while keeping their roster, their standings place and
 * their claim on the pot. `drawDraftOrder` therefore refuses a pot league until
 * this record exists — **mark first, draw second**, because drawing first and
 * failing to mark is unrecoverable (the draw is write-once) while marking first
 * and failing to draw simply means pressing the button again.
 *
 * ## Free leagues never come here
 *
 * `start_season` requires `has_pot`, so a free league has no transaction to send
 * and nothing to protect — no vault, no stakes, no refund schedule to choose
 * between. It draws with no extra wallet interaction, and the `NO_POT` verdict
 * below is what says so rather than letting it surface as "not started yet".
 *
 * ## There is no gate here, and that is deliberate
 *
 * By the time this handler runs the transaction has landed. Refusing to record a
 * `start_season` that the chain has already accepted would not un-start the
 * season — it would leave a league whose chain says started and whose database
 * does not, and since `drawDraftOrder` reads the database, that league could
 * never draw. The same reasoning `/deposit` gives for not applying the deposit
 * gate: record the truth, and say what is true.
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

    // The instruction itself is commissioner-only on-chain — `StartSeason`
    // constrains `league.commissioner == commissioner.key()` — so the worst a
    // member could do here is record something true. The narrower door is still
    // the right default, and it matches `/anchor`.
    if (!context.isCommissioner) {
      return NextResponse.json(
        { error: "Only the commissioner can start this league's season" },
        { status: 403 },
      );
    }

    const client = db();

    const stored = await getLeagueRules(client, id);
    if (!stored) {
      return NextResponse.json({ error: "League has no stored rules" }, { status: 404 });
    }

    // Answered from the signed rules rather than from the account, so a free
    // league gets a sentence about itself instead of a verdict about a field it
    // does not have. The account is still checked below for a pot league.
    if (!stored.rules.pot) {
      return NextResponse.json(
        {
          error:
            "This league plays for nothing, so there is no season to declare started. " +
            "Free leagues draft with no extra approval.",
          reason: "NO_POT",
        },
        { status: 409 },
      );
    }

    const chain = await getChainState(client, id);
    if (!chain?.anchoredAt) {
      return NextResponse.json(
        { error: "This league is not anchored on-chain yet", reason: "NOT_ANCHORED" },
        { status: 409 },
      );
    }

    // Already recorded is success, not an error. `start_season` cannot run twice
    // — the program refuses `AlreadyStarted` — so a re-post after a lost
    // response is the only way anyone gets here twice, and the record is
    // write-once by trigger anyway.
    if (chain.seasonStartedAt) {
      return NextResponse.json({
        started: true,
        alreadyRecorded: true,
        cluster: chain.seasonStartCluster,
        signature: chain.seasonStartSignature,
      });
    }

    // Shape-checked only, as in the anchor route: it records *which* transaction
    // declared the season started so a stranger can go and look at it. Nothing
    // trusts it, and a malformed one would sit in a write-once column forever.
    const body = (await request.json().catch(() => ({}))) as { signature?: unknown };
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";

    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      return NextResponse.json(
        { error: "A base58 transaction signature is required" },
        { status: 400 },
      );
    }

    const { connection, program } = readOnlyEscrow();

    // Before reading a single account, confirm we are reading the right chain —
    // the same ordering the anchor route keeps, and for the same reason. The PDA
    // is byte-identical everywhere, so a wrong cluster answers `NOT_FOUND` for a
    // league that is correctly started, and this route calls that a retry.
    const cluster = await assertRpcCluster(connection);

    if (chain.cluster && chain.cluster !== cluster) {
      return NextResponse.json(
        {
          error:
            `This league is anchored on ${chain.cluster}, but the server is reading ` +
            `${cluster}. Refusing to record a season start observed on the wrong chain.`,
          reason: "WRONG_CLUSTER",
        },
        { status: 409 },
      );
    }

    const verdict = await verifyOnChainSeasonStart(program, id);

    if (!verdict.ok) {
      // Three refusals that look alike from a distance and mean different
      // things. `NOT_FOUND` and `NOT_STARTED` are retries — the transaction has
      // not landed, or has not confirmed. `INCOMPATIBLE` is not: the account was
      // written by another build of the program, the address derives from the
      // league's id, and there is no `close`.
      const message =
        verdict.reason === "NOT_FOUND"
          ? "No league account exists on-chain yet. If the transaction was just sent, give " +
            "it a moment and try again."
          : verdict.reason === "INCOMPATIBLE"
            ? "This league was anchored by a different version of the escrow program and " +
              "cannot be read. It cannot be re-anchored — the on-chain address comes from " +
              "the league's id and nothing can free it."
            : verdict.reason === "NO_POT"
              ? "The on-chain account for this league holds no pot, so start_season does not " +
                "apply to it. The rules here say otherwise, which means the anchor and the " +
                "rules disagree — nobody should join or deposit."
              : "The chain does not say this season has started yet. If the transaction was " +
                "just sent, give it a moment and try again.";

      return NextResponse.json({ error: message, reason: verdict.reason }, { status: 409 });
    }

    await recordSeasonStart(client, id, { signature, cluster });

    return NextResponse.json({
      started: true,
      cluster,
      signature,
      startDeadline: verdict.startDeadline,
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
