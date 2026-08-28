import { NextResponse } from "next/server";
import { pastTradeDeadline } from "@rostr/core";
import type { LeagueRules } from "@rostr/core";
import {
  acceptTrade,
  declineTrade,
  listTrades,
  lockedByTrade,
  proposeTrade,
  tradeClosedReason,
  TradeError,
  transactionWeek,
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
  NOT_IN_LEAGUE: 403,
  BOT_CANNOT_TRADE: 403,
  BOT_CANNOT_VETO: 403,
  WRONG_STATE: 409,
  // The vote arrived while the cron was resolving the trade. 409 like
  // WRONG_STATE beside it, and a separate code because the screen says something
  // different: "you were a moment late", not "you are looking at something old".
  TRADE_ALREADY_SETTLED: 409,
  WINDOW_CLOSED: 409,
  PLAYER_IN_ANOTHER_TRADE: 409,
  ALREADY_VETOED: 409,
  ROSTER_WOULD_OVERFLOW: 409,
  // The league is not playing. A conflict with its state, like the 409s above,
  // and it shares its name with the waiver code for the same rule.
  LEAGUE_NOT_IN_SEASON: 409,
  TRADES_DISABLED: 400,
  PAST_DEADLINE: 400,
  SAME_TEAM: 400,
  NOTHING_OFFERED: 400,
};

/**
 * Whether a proposal made now would already be past the league's deadline.
 *
 * **For the screen only. The rule is enforced in `proposeTrade`**, which derives
 * the execution week itself rather than being handed one — a deadline checked
 * against a number worked out somewhere else is not a deadline, and this route
 * used to be that somewhere else. Both now go through `transactionWeek` and
 * `pastTradeDeadline`, so the banner cannot disagree with the refusal.
 *
 * The reason this is a boolean rather than a week is that there is no week to
 * report in the cases that matter: once the season's games are exhausted the
 * schedule cannot name an execution week at all, and the old `?? 0` fallback
 * reported that as week zero — which the screen rendered as "trading is open",
 * in January, permanently.
 */
async function tradingClosed(now: Date, rules: LeagueRules): Promise<boolean> {
  const lands = new Date(now.getTime() + rules.trades.vetoWindowHours * 3600 * 1000);
  return pastTradeDeadline(await transactionWeek(db(), rules, lands), rules.trades);
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
      tradingClosed: await tradingClosed(now, context.rules),
      /*
        Whether the league is playing at all, and the sentence if not.

        Separate from `tradingClosed`, which is the *deadline* — a different
        question with a different answer, and collapsing them would tell a
        manager in August that the trade deadline has passed.

        Composed here from the same function that refuses the write, so the
        screen and the server cannot disagree about what is on offer. It is also
        the only way the sentence gets a test.
      */
      trading: {
        open: tradeClosedReason(context.state) === null,
        notice: tradeClosedReason(context.state),
      },
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
 * The **acting** team always comes from the session, never the body — a route
 * that took a team ID would let anyone accept anyone's trade.
 *
 * **The objects it acts on do come from the body**, and that is the half this
 * comment used to leave out. `receiverTeamId` and `tradeId` are both read off
 * the wire, and authorising the actor says nothing about them: for a while a
 * manager could name a team in a different league as the receiver, because
 * nothing downstream joined it to the league in the URL. Both are now bound in
 * `@rostr/db` rather than here — derived from the database on each call, so a
 * second route could not get it wrong — and migration `0026` makes a trade whose
 * teams are not in its league unrepresentable.
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
