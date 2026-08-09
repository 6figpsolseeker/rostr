/**
 * Trades, persisted.
 *
 * The rules — who may veto, how many it takes, when the window closes — live in
 * `@rostr/core`. This module holds the state they act on and applies what they
 * decide.
 *
 * ## Assets are frozen at acceptance, not at execution
 *
 * Between accepting and executing there is a 48-hour window. If the players
 * involved stayed droppable during it, a manager could accept a trade and then
 * cut the player they promised, and execution would find a hole where a roster
 * spot used to be. So an accepted trade **locks its players**: they cannot be
 * dropped, claimed away, or entered into a second trade until it resolves.
 *
 * That is what `docs/RULES.md` §6 means by "both NFTs move to the escrow PDA".
 * The chain half is D-milestone work; this is the same guarantee in the database,
 * and it has to hold whether or not the league has a pot.
 *
 * ## Nothing here asks who is asking
 *
 * There is no commissioner override — not a check that fails, an absence. No
 * function takes an "is admin" argument, so there is nothing to accidentally
 * grant later.
 */

import {
  isVetoed,
  tradeBlockedBecause,
  vetoWindowEndsAt,
  vetoWindowHasClosed,
  vetoesRequired,
} from "@rostr/core";
import type { LeagueRules } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";
import { withTransaction } from "./transaction.js";
import { currentWeek } from "./week.js";

export class TradeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LEAGUE_NOT_FOUND"
      | "TRADE_NOT_FOUND"
      | "NOT_YOUR_TRADE"
      | "NOT_YOUR_PLAYER"
      | "WRONG_STATE"
      | "TRADES_DISABLED"
      | "PAST_DEADLINE"
      | "SAME_TEAM"
      | "NOTHING_OFFERED"
      | "PLAYER_IN_ANOTHER_TRADE"
      | "BOT_CANNOT_TRADE"
      | "BOT_CANNOT_VETO"
      | "INVOLVED_CANNOT_VETO"
      | "ALREADY_VETOED"
      | "ROSTER_WOULD_OVERFLOW",
  ) {
    super(message);
    this.name = "TradeError";
  }
}

export type TradeState =
  "PROPOSED" | "ACCEPTED" | "VETOED" | "EXECUTED" | "WITHDRAWN" | "EXPIRED";

export interface TradeSummary {
  readonly tradeId: string;
  readonly proposerTeamId: string;
  readonly receiverTeamId: string;
  readonly state: TradeState;
  readonly proposedAt: Date;
  readonly vetoDeadline: Date | null;
  readonly resolvedAt: Date | null;
  /** Players leaving each side. */
  readonly proposerGives: readonly string[];
  readonly receiverGives: readonly string[];
  readonly vetoes: number;
  /** How many vetoes would block it, given who is uninvolved right now. */
  readonly vetoesRequired: number;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Teams that may vote on a trade: human-managed, and not party to it. */
async function uninvolvedManagers(
  db: SqlClient,
  leagueId: string,
  proposerTeamId: string,
  receiverTeamId: string,
): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM teams
      WHERE league_id = $1 AND NOT is_bot AND id <> $2 AND id <> $3`,
    [leagueId, proposerTeamId, receiverTeamId],
  );

  return Number(row?.n ?? 0);
}

async function loadTrade(db: SqlClient, tradeId: string): Promise<TradeSummary> {
  const [trade] = await db.query<{
    id: string;
    league_id: string;
    proposer_team_id: string;
    receiver_team_id: string;
    state: TradeState;
    proposed_at: string;
    veto_deadline: string | null;
    resolved_at: string | null;
  }>(
    `SELECT id, league_id, proposer_team_id, receiver_team_id, state,
            proposed_at, veto_deadline, resolved_at
       FROM trades WHERE id = $1`,
    [tradeId],
  );
  if (!trade) throw new TradeError("Trade not found", "TRADE_NOT_FOUND");

  const assets = await db.query<{ from_team_id: string; player_id: string }>(
    "SELECT from_team_id, player_id FROM trade_assets WHERE trade_id = $1",
    [tradeId],
  );

  const [votes] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM trade_vetoes WHERE trade_id = $1",
    [tradeId],
  );

  const stored = await getLeagueRules(db, trade.league_id);
  if (!stored) throw new TradeError("League has no rules", "LEAGUE_NOT_FOUND");

  const electorate = await uninvolvedManagers(
    db,
    trade.league_id,
    trade.proposer_team_id,
    trade.receiver_team_id,
  );

  return {
    tradeId: trade.id,
    proposerTeamId: trade.proposer_team_id,
    receiverTeamId: trade.receiver_team_id,
    state: trade.state,
    proposedAt: new Date(trade.proposed_at),
    vetoDeadline: trade.veto_deadline ? new Date(trade.veto_deadline) : null,
    resolvedAt: trade.resolved_at ? new Date(trade.resolved_at) : null,
    proposerGives: assets
      .filter((a) => a.from_team_id === trade.proposer_team_id)
      .map((a) => a.player_id),
    receiverGives: assets
      .filter((a) => a.from_team_id === trade.receiver_team_id)
      .map((a) => a.player_id),
    vetoes: Number(votes?.n ?? 0),
    vetoesRequired: vetoesRequired(electorate, stored.rules.trades),
  };
}

/** Every trade in a league, newest first. */
export async function listTrades(
  db: SqlClient,
  leagueId: string,
  states?: readonly TradeState[],
): Promise<readonly TradeSummary[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM trades
      WHERE league_id = $1
        AND ($2::text[] IS NULL OR state = ANY($2::text[]::trade_state[]))
      ORDER BY proposed_at DESC`,
    [leagueId, states ?? null],
  );

  const out: TradeSummary[] = [];
  for (const row of rows) out.push(await loadTrade(db, row.id));
  return out;
}

/** Players that an accepted trade has frozen, and must not be moved. */
export async function lockedByTrade(
  db: SqlClient,
  leagueId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db.query<{ player_id: string }>(
    `SELECT a.player_id FROM trade_assets a
       JOIN trades t ON t.id = a.trade_id
      WHERE t.league_id = $1 AND t.state = 'ACCEPTED'`,
    [leagueId],
  );

  return new Set(rows.map((row) => row.player_id));
}

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

export interface ProposeTradeInput {
  readonly leagueId: string;
  readonly proposerTeamId: string;
  readonly receiverTeamId: string;
  readonly proposerGives: readonly string[];
  readonly receiverGives: readonly string[];
  /** The current week, checked against the league's frozen deadline. */
  readonly week: number;
  readonly now: Date;
}

export async function proposeTrade(
  db: SqlClient,
  input: ProposeTradeInput,
): Promise<{ tradeId: string }> {
  const stored = await getLeagueRules(db, input.leagueId);
  if (!stored) throw new TradeError("League has no rules", "LEAGUE_NOT_FOUND");

  const blocked = tradeBlockedBecause({
    rules: stored.rules.trades,
    week: input.week,
    proposerTeamId: input.proposerTeamId,
    receiverTeamId: input.receiverTeamId,
    proposerGives: input.proposerGives,
    receiverGives: input.receiverGives,
  });
  if (blocked) throw new TradeError(explain(blocked, stored.rules), blocked);

  // A bot has nobody to weigh an offer, so it cannot accept one. Letting a
  // manager propose to a bot would either strand the trade forever or require
  // the bot to judge it — and a bot that judges trades is a commissioner with
  // extra steps.
  const bots = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE id = ANY($1) AND is_bot",
    [[input.proposerTeamId, input.receiverTeamId]],
  );
  if (bots.length > 0) {
    throw new TradeError("Bots do not trade", "BOT_CANNOT_TRADE");
  }

  return withTransaction(db, async (tx) => {
    const frozen = await lockedByTrade(tx, input.leagueId);

    for (const [teamId, players] of [
      [input.proposerTeamId, input.proposerGives],
      [input.receiverTeamId, input.receiverGives],
    ] as const) {
      for (const playerId of players) {
        const [owned] = await tx.query<{ id: string }>(
          `SELECT id FROM roster_entries
            WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL`,
          [teamId, playerId],
        );
        if (!owned) {
          throw new TradeError(
            `${playerId} is not on team ${teamId}'s roster`,
            "NOT_YOUR_PLAYER",
          );
        }

        if (frozen.has(playerId)) {
          throw new TradeError(
            `${playerId} is already committed to an accepted trade`,
            "PLAYER_IN_ANOTHER_TRADE",
          );
        }
      }
    }

    const [trade] = await tx.query<{ id: string }>(
      `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state, proposed_at)
       VALUES ($1, $2, $3, 'PROPOSED', $4)
       RETURNING id`,
      [input.leagueId, input.proposerTeamId, input.receiverTeamId, input.now.toISOString()],
    );

    for (const [teamId, players] of [
      [input.proposerTeamId, input.proposerGives],
      [input.receiverTeamId, input.receiverGives],
    ] as const) {
      for (const playerId of players) {
        await tx.query(
          "INSERT INTO trade_assets (trade_id, from_team_id, player_id) VALUES ($1, $2, $3)",
          [trade!.id, teamId, playerId],
        );
      }
    }

    return { tradeId: trade!.id };
  });
}

function explain(code: string, rules: LeagueRules): string {
  switch (code) {
    case "TRADES_DISABLED":
      return "This league does not allow trades.";
    case "PAST_DEADLINE":
      return `The trade deadline was the end of week ${rules.trades.deadlineWeek}.`;
    case "SAME_TEAM":
      return "A team cannot trade with itself.";
    case "NOTHING_OFFERED":
      return "Both sides have to give somebody up — a one-way transfer is not a trade.";
    default:
      return code;
  }
}

// ---------------------------------------------------------------------------
// Responding
// ---------------------------------------------------------------------------

/**
 * Accept a trade, opening the veto window.
 *
 * This is the moment the players freeze. Nothing moves yet — rosters swap only
 * when the window closes without enough objections.
 */
export async function acceptTrade(
  db: SqlClient,
  tradeId: string,
  actingTeamId: string,
  now: Date,
): Promise<TradeSummary> {
  const trade = await loadTrade(db, tradeId);
  if (trade.state !== "PROPOSED") {
    throw new TradeError(`This trade is ${trade.state.toLowerCase()}`, "WRONG_STATE");
  }
  if (trade.receiverTeamId !== actingTeamId) {
    throw new TradeError("Only the team offered a trade can accept it", "NOT_YOUR_TRADE");
  }

  const [row] = await db.query<{ league_id: string }>(
    "SELECT league_id FROM trades WHERE id = $1",
    [tradeId],
  );
  const stored = await getLeagueRules(db, row!.league_id);
  if (!stored) throw new TradeError("League has no rules", "LEAGUE_NOT_FOUND");

  const deadline = new Date(
    vetoWindowEndsAt(Math.floor(now.getTime() / 1000), stored.rules.trades) * 1000,
  );

  await db.query(
    "UPDATE trades SET state = 'ACCEPTED', veto_deadline = $2 WHERE id = $1 AND state = 'PROPOSED'",
    [tradeId, deadline.toISOString()],
  );

  return loadTrade(db, tradeId);
}

/** Decline an offer. Only the team it was made to. */
export async function declineTrade(
  db: SqlClient,
  tradeId: string,
  actingTeamId: string,
  now: Date,
): Promise<void> {
  const trade = await loadTrade(db, tradeId);
  if (trade.state !== "PROPOSED") {
    throw new TradeError(`This trade is ${trade.state.toLowerCase()}`, "WRONG_STATE");
  }
  if (trade.receiverTeamId !== actingTeamId) {
    throw new TradeError("Only the team offered a trade can decline it", "NOT_YOUR_TRADE");
  }

  await db.query("UPDATE trades SET state = 'WITHDRAWN', resolved_at = $2 WHERE id = $1", [
    tradeId,
    now.toISOString(),
  ]);
}

/**
 * Withdraw an offer you made.
 *
 * Only before it is accepted. Once the window opens the trade belongs to the
 * league, not to the proposer — otherwise a manager could pull a trade the
 * moment it looked like surviving a veto.
 */
export async function withdrawTrade(
  db: SqlClient,
  tradeId: string,
  actingTeamId: string,
  now: Date,
): Promise<void> {
  const trade = await loadTrade(db, tradeId);
  if (trade.state !== "PROPOSED") {
    throw new TradeError(
      trade.state === "ACCEPTED"
        ? "This trade has been accepted — it is now up to the league."
        : `This trade is ${trade.state.toLowerCase()}`,
      "WRONG_STATE",
    );
  }
  if (trade.proposerTeamId !== actingTeamId) {
    throw new TradeError("Only the proposing team can withdraw", "NOT_YOUR_TRADE");
  }

  await db.query("UPDATE trades SET state = 'WITHDRAWN', resolved_at = $2 WHERE id = $1", [
    tradeId,
    now.toISOString(),
  ]);
}

// ---------------------------------------------------------------------------
// Vetoing
// ---------------------------------------------------------------------------

/**
 * Vote against a trade.
 *
 * Only uninvolved human teams, one vote each. There is no way to un-vote and no
 * override; a trade the league does not block goes through.
 */
export async function vetoTrade(
  db: SqlClient,
  tradeId: string,
  actingTeamId: string,
  now: Date,
): Promise<TradeSummary> {
  const trade = await loadTrade(db, tradeId);
  if (trade.state !== "ACCEPTED") {
    throw new TradeError(
      "Only an accepted trade inside its veto window can be blocked",
      "WRONG_STATE",
    );
  }
  if ([trade.proposerTeamId, trade.receiverTeamId].includes(actingTeamId)) {
    throw new TradeError("A team in the trade cannot vote on it", "INVOLVED_CANNOT_VETO");
  }

  const [team] = await db.query<{ is_bot: boolean }>("SELECT is_bot FROM teams WHERE id = $1", [
    actingTeamId,
  ]);
  if (team?.is_bot) throw new TradeError("Bots do not vote", "BOT_CANNOT_VETO");

  const [existing] = await db.query<{ team_id: string }>(
    "SELECT team_id FROM trade_vetoes WHERE trade_id = $1 AND team_id = $2",
    [tradeId, actingTeamId],
  );
  if (existing) throw new TradeError("You have already voted", "ALREADY_VETOED");

  await db.query(
    "INSERT INTO trade_vetoes (trade_id, team_id, created_at) VALUES ($1, $2, $3)",
    [tradeId, actingTeamId, now.toISOString()],
  );

  return loadTrade(db, tradeId);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface TradeResolution {
  readonly tradeId: string;
  readonly outcome: "EXECUTED" | "VETOED" | "EXPIRED";
  readonly vetoes: number;
  readonly required: number;
}

/**
 * Settle every accepted trade whose window has closed.
 *
 * A trade with enough votes against is blocked; anything else executes. Both are
 * one transaction per trade, so a swap either happens whole or not at all — half
 * a trade would leave two rosters that no rule produced.
 */
export async function resolveDueTrades(
  db: SqlClient,
  leagueId: string,
  now: Date,
): Promise<readonly TradeResolution[]> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new TradeError("League has no rules", "LEAGUE_NOT_FOUND");

  const pending = await db.query<{ id: string; veto_deadline: string }>(
    `SELECT id, veto_deadline FROM trades
      WHERE league_id = $1 AND state = 'ACCEPTED' AND veto_deadline IS NOT NULL`,
    [leagueId],
  );
  if (pending.length === 0) return [];

  // The deadline binds on the week a trade *executes*, which is this one — the
  // proposal check can only bound the earliest week it might land in, and a
  // trade left unaccepted for days slides past that. This is where it actually
  // holds, and it is the reason `EXPIRED` exists in the state enum.
  const week = await currentWeek(db, stored.rules.sportKey, now);
  const pastDeadline = week !== null && week > stored.rules.trades.deadlineWeek;

  const out: TradeResolution[] = [];

  for (const row of pending) {
    // The window is stored, but the *rule* about when it closes lives in core —
    // deriving it from the acceptance time keeps one definition rather than
    // trusting a column somebody could have written wrongly.
    const acceptedAt =
      Math.floor(new Date(row.veto_deadline).getTime() / 1000) -
      stored.rules.trades.vetoWindowHours * 3600;

    if (
      !vetoWindowHasClosed(acceptedAt, Math.floor(now.getTime() / 1000), stored.rules.trades)
    ) {
      continue;
    }

    out.push(await resolveTrade(db, row.id, stored.rules, now, pastDeadline));
  }

  return out;
}

async function resolveTrade(
  db: SqlClient,
  tradeId: string,
  rules: LeagueRules,
  now: Date,
  pastDeadline: boolean,
): Promise<TradeResolution> {
  const trade = await loadTrade(db, tradeId);
  const electorate = await uninvolvedManagersFor(db, tradeId);
  const required = vetoesRequired(electorate, rules.trades);

  if (pastDeadline) {
    await db.query("UPDATE trades SET state = 'EXPIRED', resolved_at = $2 WHERE id = $1", [
      tradeId,
      now.toISOString(),
    ]);
    return { tradeId, outcome: "EXPIRED", vetoes: trade.vetoes, required };
  }

  if (isVetoed(trade.vetoes, electorate, rules.trades)) {
    await db.query("UPDATE trades SET state = 'VETOED', resolved_at = $2 WHERE id = $1", [
      tradeId,
      now.toISOString(),
    ]);
    return { tradeId, outcome: "VETOED", vetoes: trade.vetoes, required };
  }

  await withTransaction(db, async (tx) => {
    const assets = await tx.query<{ from_team_id: string; player_id: string }>(
      "SELECT from_team_id, player_id FROM trade_assets WHERE trade_id = $1",
      [tradeId],
    );

    for (const asset of assets) {
      const to =
        asset.from_team_id === trade.proposerTeamId
          ? trade.receiverTeamId
          : trade.proposerTeamId;

      // Release then re-add, rather than repointing the row. `roster_entries` is
      // append-only with `released_at` precisely so any past week's roster can be
      // reconstructed — a trade that edited history would make a settled week
      // unverifiable.
      await tx.query(
        `UPDATE roster_entries SET released_at = $3
          WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL`,
        [asset.from_team_id, asset.player_id, now.toISOString()],
      );

      await tx.query(
        `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
         VALUES ($1, $2, 'TRADE', $3)`,
        [to, asset.player_id, now.toISOString()],
      );
    }

    await tx.query("UPDATE trades SET state = 'EXECUTED', resolved_at = $2 WHERE id = $1", [
      tradeId,
      now.toISOString(),
    ]);
  });

  return { tradeId, outcome: "EXECUTED", vetoes: trade.vetoes, required };
}

async function uninvolvedManagersFor(db: SqlClient, tradeId: string): Promise<number> {
  const [trade] = await db.query<{
    league_id: string;
    proposer_team_id: string;
    receiver_team_id: string;
  }>("SELECT league_id, proposer_team_id, receiver_team_id FROM trades WHERE id = $1", [
    tradeId,
  ]);
  if (!trade) return 0;

  return uninvolvedManagers(
    db,
    trade.league_id,
    trade.proposer_team_id,
    trade.receiver_team_id,
  );
}

/** Leagues with an accepted trade whose window has closed. */
export async function leaguesWithDueTrades(
  db: SqlClient,
  now: Date,
): Promise<readonly string[]> {
  const rows = await db.query<{ league_id: string }>(
    `SELECT DISTINCT league_id FROM trades
      WHERE state = 'ACCEPTED' AND veto_deadline IS NOT NULL AND veto_deadline <= $1`,
    [now.toISOString()],
  );

  return rows.map((row) => row.league_id);
}
