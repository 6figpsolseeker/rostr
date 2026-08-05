import { NextResponse } from "next/server";
import { buildNflPprRules, NFL, NFL_DEFAULT_PAYOUT } from "@rostr/core";
import type { PotRules } from "@rostr/core";
import { createLeague, LeagueValidationError, seedSport } from "@rostr/db";
import { db } from "@/lib/db";

export async function GET(): Promise<NextResponse> {
  const rows = await db().query<{
    id: string;
    name: string;
    season: number;
    state: string;
    team_count: number;
  }>(
    `SELECT l.id, l.name, l.season, l.state,
            (SELECT count(*)::int FROM teams t WHERE t.league_id = l.id) AS team_count
       FROM leagues l
      WHERE l.visibility = 'PUBLIC' AND l.state = 'FORMING'
      ORDER BY l.created_at DESC
      LIMIT 50`,
  );

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      season: r.season,
      state: r.state,
      teamCount: Number(r.team_count),
    })),
  );
}

interface CreateBody {
  name?: string;
  commissionerId?: string;
  visibility?: "PRIVATE" | "PUBLIC";
  seasonYear?: number;
  draftMode?: "FAST" | "SLOW";
  pickSeconds?: number;
  draftAt?: number;
  pot?: {
    tokenMint: string;
    buyInBaseUnits: string;
    refundUnlockAt: number;
  } | null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as CreateBody;

  if (!body.name || !body.commissionerId || !body.draftAt) {
    return NextResponse.json(
      { error: "name, commissionerId, and draftAt are required" },
      { status: 400 },
    );
  }

  const pot: PotRules | null = body.pot
    ? {
        tokenMint: body.pot.tokenMint,
        buyInBaseUnits: body.pot.buyInBaseUnits,
        payout: NFL_DEFAULT_PAYOUT,
        refundUnlockAt: body.pot.refundUnlockAt,
      }
    : null;

  const rules = buildNflPprRules({
    seasonYear: body.seasonYear ?? 2026,
    draft: {
      type: "SNAKE",
      mode: body.draftMode ?? "SLOW",
      pickSeconds: body.pickSeconds ?? 14_400,
      scheduledAt: body.draftAt,
    },
    league: { visibility: body.visibility ?? "PRIVATE" },
    pot,
  });

  const pool = db();
  const { client, release } = await pool.connect();

  try {
    // Idempotent, and cheap. Guarantees the registry exists before the first
    // league on a fresh database.
    await seedSport(client, NFL);

    const league = await createLeague(client, NFL, {
      name: body.name,
      commissionerId: body.commissionerId,
      rules,
    });

    // TODO (A8 wiring): pin the canonical document and call setRulesUri once a
    // Pinata key is configured. See docs/SETUP-REQUIRED.md.
    return NextResponse.json(league, { status: 201 });
  } catch (error) {
    if (error instanceof LeagueValidationError) {
      return NextResponse.json(
        { error: error.message, problems: error.problems },
        { status: 400 },
      );
    }
    throw error;
  } finally {
    release();
  }
}
