import { NextResponse } from "next/server";
import { NFL } from "@rostr/core";
import {
  acceptTrade,
  currentWeek,
  declineTrade,
  listTrades,
  lockedByTrade,
  proposeTrade,
  TradeError,
  vetoTrade,
  withdrawTrade,
} from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  TRADE_NOT_FOUND: 404,
  NOT_YOUR_TRADE: 403,
  NOT_YOUR_PLAYER: 403,
  INVOLVED_CANNOT_VETO: 403,
  BOT_CANNOT_TRADE: 403,
  BOT_CANNOT_VETO: 403,
  WRONG_STATE: 409,
  PLAYER_IN_ANOTHER_TRADE: 409,
  ALREADY_VETOED: 409,
  ROSTER_WOULD_OVERFLOW: 409,
  TRADES_DISABLED: 400,
  PAST_DEADLINE: 400,
  SAME_TEAM: 400,
  NOTHING_OFFERED: 400,
};

/**
 * The week a trade proposed now would soonest execute in.
 *
 * **Server-derived, never taken from the request.** A deadline checked against a
 * client-supplied week is not a deadline: anyone could trade in January by
 * posting `week: 1`. And it is the *execution* week rather than today's, because
 * a trade accepted on the deadline still has a veto window to sit through, and a
 * trade that landed after the deadline is exactly what the deadline prevents.
 *
 * Zero before the season's first kickoff, which no deadline is ever below.
 */
async function executionWeek(now: Date, vetoWindowHours: number): Promise<number> {
  const lands = new Date(now.getTime() + vetoWindowHours * 3600 * 1000);
  return (await currentWeek(db(), NFL.key, lands)) ?? 0;
}

/**
 * Every trade in the league, plus the rosters needed to build an offer.
 *
 * Rosters are public within a league — they are on every other team's page
 * already — so this returns all of them rather than making the client ask team
 * by team while assembling a proposal.
 */
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

    const client = db();
    const now = new Date();

    const [trades, locked, teams, roster] = await Promise.all([
      listTrades(client, id),
      lockedByTrade(client, id),
      client.query<{ id: string; name: string; is_bot: boolean }>(
        "SELECT id, name, is_bot FROM teams WHERE league_id = $1 ORDER BY slot",
        [id],
      ),
      client.query<{ team_id: string; player_id: string; full_name: string; key: string }>(
        `SELECT r.team_id, r.player_id, p.full_name, pos.key
           FROM roster_entries r
           JOIN teams t ON t.id = r.team_id
           JOIN players p ON p.id = r.player_id
           JOIN positions pos ON pos.id = p.primary_position_id
          WHERE t.league_id = $1 AND r.released_at IS NULL
          ORDER BY pos.sort_order, p.full_name`,
        [id],
      ),
    ]);

    return NextResponse.json({
      myTeamId: context.myTeamId,
      enabled: context.rules.trades.enabled,
      deadlineWeek: context.rules.trades.deadlineWeek,
      vetoWindowHours: context.rules.trades.vetoWindowHours,
      week: await executionWeek(now, context.rules.trades.vetoWindowHours),
      teams: teams.map((team) => ({
        teamId: team.id,
        name: team.name,
        isBot: team.is_bot,
        players: roster
          .filter((row) => row.team_id === team.id)
          .map((row) => ({
            playerId: row.player_id,
            name: row.full_name,
            position: row.key,
            // Committed to an accepted trade: not offerable until it resolves.
            locked: locked.has(row.player_id),
          })),
      })),
      trades: trades.map((trade) => ({
        tradeId: trade.tradeId,
        proposerTeamId: trade.proposerTeamId,
        receiverTeamId: trade.receiverTeamId,
        state: trade.state,
        proposedAt: trade.proposedAt.toISOString(),
        vetoDeadline: trade.vetoDeadline?.toISOString() ?? null,
        proposerGives: trade.proposerGives,
        receiverGives: trade.receiverGives,
        vetoes: trade.vetoes,
        vetoesRequired: trade.vetoesRequired,
      })),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * Propose, accept, decline, withdraw, or veto.
 *
 * The acting team always comes from the session, never the body — a route that
 * took a team ID would let anyone accept anyone's trade.
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
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json()) as {
      action?: "PROPOSE" | "ACCEPT" | "DECLINE" | "WITHDRAW" | "VETO";
      tradeId?: string;
      receiverTeamId?: string;
      proposerGives?: string[];
      receiverGives?: string[];
    };

    const client = db();
    const now = new Date();

    if (body.action === "PROPOSE") {
      if (!body.receiverTeamId || !body.proposerGives || !body.receiverGives) {
        return NextResponse.json(
          { error: "receiverTeamId, proposerGives and receiverGives are required" },
          { status: 400 },
        );
      }

      const { tradeId } = await proposeTrade(client, {
        leagueId: id,
        proposerTeamId: context.myTeamId,
        receiverTeamId: body.receiverTeamId,
        proposerGives: body.proposerGives,
        receiverGives: body.receiverGives,
        week: await executionWeek(now, context.rules.trades.vetoWindowHours),
        now,
      });

      return NextResponse.json({ tradeId }, { status: 201 });
    }

    if (!body.tradeId) {
      return NextResponse.json({ error: "tradeId is required" }, { status: 400 });
    }

    switch (body.action) {
      case "ACCEPT": {
        const trade = await acceptTrade(client, body.tradeId, context.myTeamId, now);
        return NextResponse.json({
          state: trade.state,
          vetoDeadline: trade.vetoDeadline?.toISOString() ?? null,
          vetoesRequired: trade.vetoesRequired,
        });
      }
      case "DECLINE":
        await declineTrade(client, body.tradeId, context.myTeamId, now);
        return NextResponse.json({ declined: true });
      case "WITHDRAW":
        await withdrawTrade(client, body.tradeId, context.myTeamId, now);
        return NextResponse.json({ withdrawn: true });
      case "VETO": {
        const trade = await vetoTrade(client, body.tradeId, context.myTeamId, now);
        return NextResponse.json({
          vetoes: trade.vetoes,
          vetoesRequired: trade.vetoesRequired,
        });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof TradeError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}
