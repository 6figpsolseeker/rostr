import { NextResponse } from "next/server";
import {
  buildNflPprRules,
  NFL,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
  validateLeagueRules,
} from "@rostr/core";
import type { PotRules } from "@rostr/core";
import { createDraftRecord, createLeague, LeagueValidationError, seedSport } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

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
  visibility?: "PRIVATE" | "PUBLIC";
  seasonYear?: number;
  draftMode?: "FAST" | "SLOW";
  pickSeconds?: number;
  draftAt?: number;
  tradeDeadlineWeek?: number;
  pot?: {
    tokenMint: string;
    buyInBaseUnits: string;
    refundUnlockAt: number;
  } | null;
}

export async function POST(request: Request): Promise<NextResponse> {
  // From the session. This route used to accept a `commissionerId` the client
  // supplied, which meant anyone could create a league attributed to anyone —
  // and the commissioner is the only account that can start a draft.
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to create a league" }, { status: 401 });
  }

  const body = (await request.json()) as CreateBody;

  if (!body.name || !body.draftAt) {
    return NextResponse.json({ error: "name and draftAt are required" }, { status: 400 });
  }

  // A draft in the past can never draw an order: the deciding block would
  // already exist, which is the whole thing the timing prevents.
  if (body.draftAt * 1000 <= Date.now()) {
    return NextResponse.json(
      { error: "The draft must be scheduled in the future" },
      { status: 400 },
    );
  }

  // The fee and its recipient come from server configuration, never from the
  // request. A client-supplied fee would let anyone create a league that pays
  // nothing, and a client-supplied recipient would let them redirect ours.
  //
  // Without FEE_RECIPIENT set there is nowhere to pay, so leagues are created
  // fee-free. That is fine locally and wrong in production, where it would mean
  // silently giving away the fee on every league ever created — the rules are
  // frozen, so it could never be corrected afterwards. Same reasoning as the
  // sign-in link: fail loudly rather than pretend.
  const feeRecipient = process.env.FEE_RECIPIENT ?? "";
  if (body.pot && !feeRecipient && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Pot leagues are unavailable: FEE_RECIPIENT is not configured" },
      { status: 503 },
    );
  }

  const pot: PotRules | null = body.pot
    ? {
        tokenMint: body.pot.tokenMint,
        buyInBaseUnits: body.pot.buyInBaseUnits,
        payout: NFL_DEFAULT_PAYOUT,
        refundUnlockAt: body.pot.refundUnlockAt,
        feeBps: feeRecipient ? NFL_DEFAULT_FEE_BPS : 0,
        feeRecipient,
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
    ...(body.tradeDeadlineWeek === undefined
      ? {}
      : { trades: { deadlineWeek: body.tradeDeadlineWeek } }),
    pot,
  });

  // Belt and braces: validateLeagueRules already bounds the deadline to the
  // regular season and to week 1, and createLeague refuses rules that do not
  // validate. Checking here only turns a 500-shaped failure into a 400 with a
  // message, since this is the one rule field a client supplies directly.
  const problems = validateLeagueRules(rules);
  if (problems.length > 0) {
    return NextResponse.json({ error: "Those rules are not valid", problems }, { status: 400 });
  }

  const pool = db();
  const { client, release } = await pool.connect();

  try {
    // Idempotent, and cheap. Guarantees the registry exists before the first
    // league on a fresh database.
    await seedSport(client, NFL);

    const league = await createLeague(client, NFL, {
      name: body.name,
      commissionerId: user.id,
      rules,
    });

    // Scheduled here rather than as a separate step. A league whose draft has
    // to be created later is a league that silently has no draft until somebody
    // remembers — and `scheduledAt` is already frozen in the rules, so there is
    // nothing left to decide.
    //
    // No order is drawn: teams are still joining, and a seed that exists while
    // the field can change is a seed a commissioner can grind against.
    await createDraftRecord(client, {
      leagueId: league.id,
      rounds:
        rules.roster.starters.reduce((total, slot) => total + slot.count, 0) +
        rules.roster.benchSlots,
      pickSeconds: rules.draft.pickSeconds,
      scheduledAt: new Date(rules.draft.scheduledAt * 1000),
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
