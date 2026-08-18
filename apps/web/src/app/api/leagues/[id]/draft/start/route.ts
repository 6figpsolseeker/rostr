import { NextResponse } from "next/server";
import { DraftPersistenceError, drawDraftOrder, SolanaBeacon, startDraft } from "@rostr/db";
import { BeaconError } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

// A code missing from this map falls through to 400 below, which ships a good
// message under the wrong status — so a new `DraftPersistenceError` code belongs
// here in the same change that introduces it.
const STATUS: Record<string, number> = {
  DRAFT_NOT_FOUND: 404,
  NO_TEAMS: 409,
  BELOW_MIN_HUMANS: 409,
  ODD_FIELD: 409,
  POT_NOT_FUNDED: 409,
  SEASON_NOT_STARTED: 409,
  ORDER_ALREADY_DRAWN: 409,
  TOO_EARLY_TO_DRAW: 425,
  ORDER_NOT_DRAWN: 409,
  ALREADY_STARTED: 409,
};

/**
 * Draw the order and start the clock.
 *
 * Commissioner only — but note what that does *not* mean. The commissioner
 * chooses *when* to press this, and nothing else. They cannot influence the
 * order: it comes from the first Solana block at or after the league's frozen
 * scheduled time, this refuses to run before that instant, and the draw can
 * happen exactly once. See `drawDraftOrder`.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.isCommissioner) {
      return NextResponse.json(
        { error: "Only the commissioner can start the draft" },
        { status: 403 },
      );
    }

    const endpoint = process.env["SOLANA_RPC_URL"];
    if (!endpoint) {
      return NextResponse.json(
        {
          error:
            "SOLANA_RPC_URL is not set, so the draft order cannot be drawn. " +
            "See docs/SETUP-REQUIRED.md.",
        },
        { status: 503 },
      );
    }

    const client = db();
    const beacon = new SolanaBeacon({ endpoint });
    const now = new Date();

    // Idempotent: a second press after a failed start draws nothing new and
    // simply starts the clock.
    try {
      await drawDraftOrder(client, { leagueId: id, beacon, now });
    } catch (error) {
      if (!(error instanceof DraftPersistenceError) || error.code !== "ORDER_ALREADY_DRAWN") {
        throw error;
      }
    }

    await startDraft(client, id, now);

    return NextResponse.json({ started: true });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DraftPersistenceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    if (error instanceof BeaconError) {
      // NOT_YET means the chain has not reached the scheduled time. That is a
      // "come back shortly", not a failure.
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "NOT_YET" ? 425 : 502 },
      );
    }
    throw error;
  }
}
