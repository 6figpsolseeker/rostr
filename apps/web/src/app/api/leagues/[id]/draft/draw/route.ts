import { NextResponse } from "next/server";
import { BeaconError, DraftPersistenceError, drawDraftOrder, SolanaBeacon } from "@rostr/db";
import { db } from "@/lib/db";
import { settlementAccountCheck } from "@/lib/settlement-preflight";
import { draftContext, DraftContextError } from "@/lib/draft-context";

// A code missing from this map falls through to 400, which ships a good message
// under the wrong status — so a new `DraftPersistenceError` code belongs here in
// the same change that introduces it. Kept identical to the start route's map:
// the two share every refusal `drawDraftOrder` can make.
const STATUS: Record<string, number> = {
  DRAFT_NOT_FOUND: 404,
  NO_TEAMS: 409,
  BELOW_MIN_HUMANS: 409,
  ODD_FIELD: 409,
  POT_NOT_FUNDED: 409,
  SEASON_NOT_STARTED: 409,
  SCORES_MISMATCH: 409,
  ORDER_ALREADY_DRAWN: 409,
  TOO_EARLY_TO_DRAW: 425,
};

/**
 * Draw the order, and **do not start the clock**.
 *
 * `/draft/start` does both in one press, and that is right for going straight
 * into the room. It is wrong for the lobby: the moment the order exists the
 * first manager is on the clock, so a league that pressed one button would burn
 * ninety seconds of somebody's pick while twelve people were still reading the
 * blockhash. The lobby draws here, publishes the order and the verification
 * panel, and starts the clock separately.
 *
 * Nothing about `/draft/start` changes — it still draws if the order is missing,
 * so a commissioner who skips the lobby entirely gets the behaviour they had.
 * This route is the *first* half on its own, never a second way to do both.
 *
 * Commissioner only, and that means only *when*. The order itself comes from the
 * first Solana block at or after the league's frozen scheduled time; this
 * refuses before that instant and the draw can happen exactly once.
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
        { error: "Only the commissioner can draw the draft order" },
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

    // Idempotent, like the start route: a second press after a lost response
    // draws nothing new and reports the draw that exists. Anything else would
    // make a dropped connection look like a league whose order was refused,
    // and the trigger makes a genuine second draw impossible anyway.
    try {
      await drawDraftOrder(db(), {
        leagueId: id,
        beacon: new SolanaBeacon({ endpoint }),
        settlement: settlementAccountCheck(),
        now: new Date(),
      });
    } catch (error) {
      if (!(error instanceof DraftPersistenceError) || error.code !== "ORDER_ALREADY_DRAWN") {
        throw error;
      }
    }

    return NextResponse.json({ drawn: true });
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
      // "come back shortly", not a failure — and the lobby renders it as the
      // countdown rather than as an error.
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "NOT_YET" ? 425 : 502 },
      );
    }
    throw error;
  }
}
