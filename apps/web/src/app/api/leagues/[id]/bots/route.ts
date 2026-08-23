import { NextResponse } from "next/server";
import { addBot, JoinError, removeBot } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * The bot seat, added and removed.
 *
 * **This route is why an odd league could not draft.** `drawDraftOrder` refuses
 * an odd field — a bye every week is a free result, and a free result decides a
 * season — and both the create form and the draft lobby told the commissioner to
 * "add a bot from the league page". `addBot` and `removeBot` have existed in
 * `@rostr/db` throughout, with every rule enforced. Nothing in the app called
 * either, and no route existed to. So five friends were told to do the one thing
 * the product could not do, and the instruction had nowhere to lead.
 *
 * **Commissioner only, and the check has to be here.** Unlike `removeMember`,
 * neither `addBot` nor `removeBot` takes an acting user or consults
 * `commissioner_id` — they enforce the league's *rules* (pot, limit, parity,
 * open field) and say nothing about who is asking. That is a reasonable split,
 * because the field is locked by trigger for everyone once the draw lands, but
 * it means this route is the only thing standing between any signed-in stranger
 * and another league's field. Do not remove the gate on the grounds that the
 * database checks it, because it does not.
 */

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  RULES_MISSING: 500,
  // The league's frozen rules refuse it: a pot league, or one already holding
  // its bot. Not retryable, and not the caller's mistake.
  BOTS_NOT_ALLOWED: 409,
  BOT_LIMIT: 409,
  // The count is even. Adding one would *cause* the bye it exists to prevent,
  // so this is a 409 rather than a 422 — the request is well formed and the
  // league is simply not in a state that wants a bot.
  EVEN_WITHOUT_BOT: 409,
  LEAGUE_FULL: 409,
  BOT_NOT_FOUND: 404,
  // Both terminal. `0028` locks the field at the frozen draft time on INSERT and
  // DELETE, and the draw is write-once by trigger, so neither will come back.
  DRAFT_ALREADY_DRAWN: 409,
  FIELD_LOCKED: 409,
};

/** The seat's name when the commissioner does not supply one. */
const DEFAULT_BOT_NAME = "Autodraft";

function fail(error: unknown): NextResponse {
  if (error instanceof JoinError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: STATUS[error.code] ?? 400 },
    );
  }
  if (error instanceof DraftContextError) {
    return NextResponse.json(
      { error: error.message, code: "CONTEXT" },
      { status: error.status },
    );
  }
  throw error;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.isCommissioner) {
      return NextResponse.json({ error: "Not your league" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    // A name is a label on a seat, not an identity — there is no account behind
    // it and nothing joins by it. So an absent or unusable one is defaulted
    // rather than refused: failing here would block a draft over a cosmetic.
    const name =
      typeof body.name === "string" && body.name.trim() !== ""
        ? body.name.trim().slice(0, 40)
        : DEFAULT_BOT_NAME;

    const bot = await addBot(db(), id, name);
    return NextResponse.json({ teamId: bot.teamId, slot: bot.slot, name });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Give the seat back.
 *
 * No body: a league holds at most one bot, so there is nothing to name. It is
 * `removeBot` that picks the row, which also means this cannot be pointed at a
 * human's team — `removeMember` is that, and it refuses a bot with `IS_A_BOT`.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.isCommissioner) {
      return NextResponse.json({ error: "Not your league" }, { status: 403 });
    }

    const removed = await removeBot(db(), id);
    return NextResponse.json(removed);
  } catch (error) {
    return fail(error);
  }
}
