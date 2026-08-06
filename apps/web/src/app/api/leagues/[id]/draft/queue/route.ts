import { NextResponse } from "next/server";
import { getQueue, setQueue } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

/** Your queue, in order. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    return NextResponse.json({ queue: await getQueue(db(), context.myTeamId) });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Replace your queue.
 *
 * Wholesale, not a patch — see `setQueue`. If a clock expires mid-write, the
 * auto-pick sees either the old queue or the new one, never a half-reordered
 * mix.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json()) as { playerIds?: string[] };
    if (!Array.isArray(body.playerIds)) {
      return NextResponse.json({ error: "playerIds must be an array" }, { status: 400 });
    }

    // Deduplicate rather than reject: a queue with the same player twice is a
    // UI slip, not an attack, and the second entry could never be used anyway.
    const unique = [...new Set(body.playerIds)];

    await setQueue(db(), context.myTeamId, unique);
    return NextResponse.json({ queue: unique });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
