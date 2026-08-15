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
  pastTradeDeadline,
  tradeBlockedBecause,
  vetoWindowEndsAt,
  vetoWindowHasClosed,
  vetoesRequired,
} from "@rostr/core";
import type { LeagueRules } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";
import { withTransaction } from "./transaction.js";
import { transactionWeek } from "./week.js";

export class TradeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LEAGUE_NOT_FOUND"
      | "TRADE_NOT_FOUND"
      | "NOT_YOUR_TRADE"
      | "NOT_YOUR_PLAYER"
      | "NOT_IN_LEAGUE"
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
      | "ROSTER_WOULD_OVERFLOW"
      | "ASSET_GONE",
  ) {
    super(message);
    this.name = "TradeError";
  }
}

export type TradeState =
  "PROPOSED" | "ACCEPTED" | "VETOED" | "EXECUTED" | "WITHDRAWN" | "EXPIRED";

export interface TradeSummary {
  readonly tradeId: string;
  /** The league this trade belongs to. A trade never leaves it. */
  readonly leagueId: string;
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

  // **The tally must be scoped exactly like the electorate it is compared to.**
  //
  // `vetoTrade` refuses a voter from outside the trade's league, but that guards
  // the door and not the count. Counting every row for the trade meant a vote
  // written before that guard existed — or by any future path that inserts one —
  // still moved the numerator while `uninvolvedManagers` scoped the denominator
  // to this league. The two disagreeing is what forces a veto the league never
  // cast, and `trade_vetoes.team_id` is `ON DELETE RESTRICT`, so a stale row
  // cannot be cleaned up by removing the team.
  //
  // The same three conditions as the electorate: this league, not a bot, not a
  // party to the trade. Counting is a read, so it must not trust that every
  // writer got it right.
  const [votes] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM trade_vetoes v
       JOIN teams t ON t.id = v.team_id
      WHERE v.trade_id = $1
        AND t.league_id = $2
        AND NOT t.is_bot
        AND t.id <> $3
        AND t.id <> $4`,
    [tradeId, trade.league_id, trade.proposer_team_id, trade.receiver_team_id],
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
    leagueId: trade.league_id,
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

/**
 * Refuse a team acting on a trade that belongs to another league.
 *
 * **Derived, never supplied.** Both halves are read from the database in one
 * query, so there is no league argument for a caller to get wrong — the shape
 * `vetoTrade` has used since migration `0020`, and the reason it was the only
 * one of the five entry points that was never exploitable. A `leagueId`
 * parameter would have closed the same hole while creating an obligation every
 * future caller has to honour, in a module whose rule is that the server does
 * not take identifiers from the caller and trust them.
 *
 * `TRADE_NOT_FOUND` rather than `NOT_IN_LEAGUE`, deliberately: a trade in
 * another league is one this team has no business knowing exists, and a distinct
 * code would confirm the id names something real.
 */
async function requireSameLeague(
  db: SqlClient,
  tradeId: string,
  actingTeamId: string,
): Promise<void> {
  const [row] = await db.query<{ id: string }>(
    `SELECT t.id FROM teams t
       JOIN trades tr ON tr.id = $2
      WHERE t.id = $1 AND t.league_id = tr.league_id`,
    [actingTeamId, tradeId],
  );
  if (!row) throw new TradeError("Trade not found", "TRADE_NOT_FOUND");
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
  readonly now: Date;
}

/**
 * The week a trade decided at `at` would execute in.
 *
 * **`transactionWeek`, never `currentWeek`.** `currentWeek` answers "the week of
 * the most recent kickoff", so from a week's last game until the next week's
 * first it keeps naming a week whose games have all been played — and a trade
 * landing in that stretch executes into the *following* week's rosters. Asking
 * it about a deadline let a trade land roughly three days past a date members
 * signed, which is exactly what `docs/RULES.md` §6 says the deadline prevents.
 *
 * It is also season-scoped, which `currentWeek` is not: with a prior season's
 * games ingested, `currentWeek` answers "week 18" all summer and would refuse
 * every proposal in the preseason.
 *
 * `null` when the schedule cannot answer. `pastTradeDeadline` decides what that
 * means, in one place, for both callers.
 */
async function executionWeek(
  db: SqlClient,
  rules: LeagueRules,
  at: Date,
): Promise<number | null> {
  return transactionWeek(db, rules, at);
}

export async function proposeTrade(
  db: SqlClient,
  input: ProposeTradeInput,
): Promise<{ tradeId: string }> {
  const stored = await getLeagueRules(db, input.leagueId);
  if (!stored) throw new TradeError("League has no rules", "LEAGUE_NOT_FOUND");

  // Derived here, never taken from the caller. This used to be a `week` field on
  // the input, supplied by the route — so the rule depended on a number computed
  // outside the package that enforces it, and the route computed it wrongly.
  // A deadline checked against a week somebody else worked out is not a deadline.
  //
  // The earliest a proposal can land is when its veto window closes, which is
  // the check `RULES.md` §6 requires at proposal time.
  const lands = new Date(
    input.now.getTime() + stored.rules.trades.vetoWindowHours * 3600 * 1000,
  );

  const blocked = tradeBlockedBecause({
    rules: stored.rules.trades,
    week: await executionWeek(db, stored.rules, lands),
    proposerTeamId: input.proposerTeamId,
    receiverTeamId: input.receiverTeamId,
    proposerGives: input.proposerGives,
    receiverGives: input.receiverGives,
  });
  if (blocked) throw new TradeError(explain(blocked, stored.rules), blocked);

  // **Both teams must be in this league, and this is checked before anything
  // else looks at them.**
  //
  // A trade is a closed swap inside one league. Nothing used to say so: the
  // receiver arrived from the request body and was never joined to
  // `input.leagueId`, so a manager holding a team in two leagues could name the
  // other one and move a player between closed player pools — bypassing the
  // receiving league's waiver queue in both directions, since `resolveTrade`
  // releases with a direct `UPDATE` and never puts anyone on the wire.
  //
  // `vetoTrade` was fixed for exactly this and has been correct since migration
  // `0020`; propose and accept were not revisited. This is that same join.
  //
  // **Order matters.** It has to come before the bot check below, which queries
  // teams by id with no league predicate — so a receiver in another league gets
  // `BOT_CANNOT_TRADE` rather than `NOT_IN_LEAGUE`, which answers "does this id
  // name a bot somewhere" for an id the caller was never entitled to resolve.
  // Two separate checks rather than one combined query, so a bot in this league
  // still reports `BOT_CANNOT_TRADE`.
  //
  // The proposer is checked too, though today it always arrives as
  // `context.myTeamId`, which the route derives with a league predicate of its
  // own. That makes it safe by virtue of its one caller, which is the property
  // this whole fix exists to stop relying on.
  const inLeague = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE id = ANY($1) AND league_id = $2",
    [[input.proposerTeamId, input.receiverTeamId], input.leagueId],
  );
  if (inLeague.length !== 2) {
    throw new TradeError("Both teams must be in this league", "NOT_IN_LEAGUE");
  }

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
  await requireSameLeague(db, tradeId, actingTeamId);

  if (trade.state !== "PROPOSED") {
    throw new TradeError(`This trade is ${trade.state.toLowerCase()}`, "WRONG_STATE");
  }
  if (trade.receiverTeamId !== actingTeamId) {
    throw new TradeError("Only the team offered a trade can accept it", "NOT_YOUR_TRADE");
  }

  const stored = await getLeagueRules(db, trade.leagueId);
  if (!stored) throw new TradeError("League has no rules", "LEAGUE_NOT_FOUND");

  const deadline = new Date(
    vetoWindowEndsAt(Math.floor(now.getTime() / 1000), stored.rules.trades) * 1000,
  );

  return withTransaction(db, async (tx) => {
    // Re-validate every asset now, not only at propose time. Accepting is the
    // moment the trade freezes for execution, and the proposal's checks are
    // stale: since then a player could have been dropped, or committed to a
    // different trade that was accepted first. Skipping this is what lets one
    // player be committed to two accepted trades and duplicated onto two rosters
    // when both execute.
    //
    // **Order is the whole of the concurrency argument.** Take every row lock
    // first, and only then read the freeze set. Read the other way round — the
    // obvious way round — and two concurrent accepts of the same player both
    // compute an empty freeze set *before* either takes a lock; the loser then
    // blocks, wakes after the winner commits, re-checks a snapshot that predates
    // it, and passes. Both trades reach ACCEPTED and the player is minted. The
    // lock would be doing real work and guarding a value already read.
    // **`ORDER BY player_id`, and it is not cosmetic.** Pass one takes a row
    // lock per asset in whatever order this returns, so two accepts of two
    // different trades sharing two players could take them in opposite orders
    // and deadlock. An unordered `SELECT` is not a stable order, it is whatever
    // the plan produces. Sorting on the same key in every caller makes the cycle
    // unconstructible — and that is only true once **every** caller sorts.
    // `resolveTrade` did not when this comment was first written, so the cycle it
    // claims to have removed was still constructible between these two functions;
    // it sorts on the same key now.
    const assets = await tx.query<{ from_team_id: string; player_id: string }>(
      "SELECT from_team_id, player_id FROM trade_assets WHERE trade_id = $1 ORDER BY player_id",
      [tradeId],
    );

    // Pass one: ownership, and take the lock on every asset.
    for (const asset of assets) {
      const [owned] = await tx.query<{ id: string }>(
        `SELECT id FROM roster_entries
          WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL
          FOR UPDATE`,
        [asset.from_team_id, asset.player_id],
      );
      if (!owned) {
        throw new TradeError(
          `${asset.player_id} is no longer on team ${asset.from_team_id}'s roster`,
          "NOT_YOUR_PLAYER",
        );
      }
    }

    // Pass two, with every lock now held, so a competing accept has either
    // already committed and is visible here, or is still blocked behind us.
    const frozen = await lockedByTrade(tx, trade.leagueId);
    for (const asset of assets) {
      if (frozen.has(asset.player_id)) {
        throw new TradeError(
          `${asset.player_id} is already committed to an accepted trade`,
          "PLAYER_IN_ANOTHER_TRADE",
        );
      }
    }

    // `RETURNING id` is what makes the predicate observable. `SqlClient.query`
    // hands back rows and discards `rowCount`, so without it a refused write and
    // a successful one are the same empty array — the guard would be real and
    // its result unreadable, and this function would report an acceptance it did
    // not perform.
    const accepted = await tx.query<{ id: string }>(
      `UPDATE trades SET state = 'ACCEPTED', veto_deadline = $2
        WHERE id = $1 AND state = 'PROPOSED'
      RETURNING id`,
      [tradeId, deadline.toISOString()],
    );
    if (accepted.length === 0) {
      throw new TradeError("This trade is no longer open", "WRONG_STATE");
    }

    return loadTrade(tx, tradeId);
  });
}

/**
 * Decline an offer. Only the team it was made to.
 *
 * The league check below is symmetry rather than a hole being closed: the
 * receiver-equality test underneath it means only a party to the trade gets
 * this far, and a party in another league can only exist because `proposeTrade`
 * let one through. Scoped anyway, because leaving one of five entry points
 * deriving the league differently from the other four is how this recurs.
 */
export async function declineTrade(
  db: SqlClient,
  tradeId: string,
  actingTeamId: string,
  now: Date,
): Promise<void> {
  const trade = await loadTrade(db, tradeId);
  await requireSameLeague(db, tradeId, actingTeamId);

  if (trade.state !== "PROPOSED") {
    throw new TradeError(`This trade is ${trade.state.toLowerCase()}`, "WRONG_STATE");
  }
  if (trade.receiverTeamId !== actingTeamId) {
    throw new TradeError("Only the team offered a trade can decline it", "NOT_YOUR_TRADE");
  }

  // The state test above reads a snapshot taken before this statement, so it
  // cannot be the guard — it is the error message. This is the guard.
  //
  // Reachable from one manager and one browser, which is why it matters more
  // than the withdraw race: `TradeBlock` renders Accept and Decline side by side
  // on a PROPOSED trade, so two in-flight requests need no second person.
  const declined = await db.query<{ id: string }>(
    `UPDATE trades SET state = 'WITHDRAWN', resolved_at = $2
      WHERE id = $1 AND state = 'PROPOSED'
    RETURNING id`,
    [tradeId, now.toISOString()],
  );
  if (declined.length === 0) {
    throw new TradeError("This trade is no longer open", "WRONG_STATE");
  }
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
  await requireSameLeague(db, tradeId, actingTeamId);

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

  // This function opens no transaction, so the read above and this write are two
  // autocommit statements with an acceptance able to commit between them. That
  // is not theoretical — it is reproduced in `trades.race.test.ts`.
  //
  // The stomping write did not merely mislabel the row. `lockedByTrade` counts
  // only ACCEPTED trades, so overwriting the state **unfroze both players in the
  // same statement**, and the proposer could then drop the player they had
  // promised. With no rate limit on the route, a proposer wanting out could fire
  // withdrawals until one landed on the accept.
  const withdrawn = await db.query<{ id: string }>(
    `UPDATE trades SET state = 'WITHDRAWN', resolved_at = $2
      WHERE id = $1 AND state = 'PROPOSED'
    RETURNING id`,
    [tradeId, now.toISOString()],
  );
  if (withdrawn.length === 0) {
    throw new TradeError(
      "This trade has been accepted — it is now up to the league.",
      "WRONG_STATE",
    );
  }
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

  // Scope the voter to the trade's own league. Without the league join this
  // found the team by id alone, so a team in a *different* league could cast a
  // counted vote — its vote raised the tally while the electorate (the trade
  // league's uninvolved managers) did not, letting an outsider force a veto.
  const [team] = await db.query<{ is_bot: boolean }>(
    `SELECT t.is_bot FROM teams t
       JOIN trades tr ON tr.id = $2
      WHERE t.id = $1 AND t.league_id = tr.league_id`,
    [actingTeamId, tradeId],
  );
  if (!team) {
    throw new TradeError("Only a team in this league can vote on its trades", "NOT_IN_LEAGUE");
  }
  if (team.is_bot) throw new TradeError("Bots do not vote", "BOT_CANNOT_VETO");

  const [existing] = await db.query<{ team_id: string }>(
    "SELECT team_id FROM trade_vetoes WHERE trade_id = $1 AND team_id = $2",
    [tradeId, actingTeamId],
  );
  if (existing) throw new TradeError("You have already voted", "ALREADY_VETOED");

  await db.query(
    // The league is stored on the vote, not inferred at read time: the composite
    // foreign keys in 0020 use it to make an out-of-league vote unrepresentable
    // rather than merely uncounted.
    `INSERT INTO trade_vetoes (trade_id, team_id, league_id, created_at)
       SELECT $1, $2, t.league_id, $3 FROM trades t WHERE t.id = $1`,
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

export interface DueTradesOutcome {
  readonly resolutions: readonly TradeResolution[];
  /**
   * Trades this run could not settle, and why. **Nothing was written for these.**
   *
   * Surfaced rather than swallowed, and surfaced *here* rather than recorded in
   * the database — the distinction `resolveLeagueWeeksThrough` already draws.
   * A trade that cannot execute must not be given a terminal state by an error
   * handler; see the comment on the catch that fills this.
   */
  readonly failures: readonly { tradeId: string; reason: string }[];
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
): Promise<DueTradesOutcome> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new TradeError("League has no rules", "LEAGUE_NOT_FOUND");

  // No `ORDER BY`, deliberately. Every due trade is now attempted whatever
  // happens to the ones before it, and their inputs are disjoint, so the order
  // cannot change the outcome — the same conclusion `score-week`'s league query
  // reached, and it still has none either.
  const pending = await db.query<{ id: string; veto_deadline: string }>(
    `SELECT id, veto_deadline FROM trades
      WHERE league_id = $1 AND state = 'ACCEPTED' AND veto_deadline IS NOT NULL`,
    [leagueId],
  );
  if (pending.length === 0) return { resolutions: [], failures: [] };

  // The deadline binds on the week a trade *executes*, which is this one — the
  // proposal check can only bound the earliest week it might land in, and a
  // trade left unaccepted for days slides past that. This is where it actually
  // holds, and it is the reason `EXPIRED` exists in the state enum.
  //
  // Same derivation as the proposal check, same rule applied to it. The two used
  // to be independent: this one asked `currentWeek` and the route asked it
  // separately, so one rule had two implementations and both were wrong.
  const pastDeadline = pastTradeDeadline(
    await executionWeek(db, stored.rules, now),
    stored.rules.trades,
  );

  const out: TradeResolution[] = [];
  const failures: { tradeId: string; reason: string }[] = [];

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

    // One trade that cannot execute must not stop the rest from settling — the
    // same rule as every other loop over leagues or weeks in this repo. This
    // used to rethrow anything that was not `ASSET_GONE`, which is the
    // allowlist-inside-a-loop shape `CLAUDE.md` names as itself the defect: the
    // offending trade stayed ACCEPTED forever, every trade queued behind it
    // stayed ACCEPTED too, and uninvolved managers' players stayed frozen for
    // the rest of the season.
    //
    // **But widening the catch must not widen what gets written.** The obvious
    // reading — record and continue, marking the trade EXPIRED — is a worse bug
    // than the one it fixes. `withTransaction` calls `db.connect()` before
    // `BEGIN` and the pool has a connect timeout, so one saturated pool during
    // an hourly run would expire *every due trade in every league*, in one pass,
    // permanently: nothing revisits EXPIRED. The same goes for a 40P01 deadlock,
    // a 57014 statement timeout, or any bug of ours.
    //
    // `RULES.md` defines EXPIRED as the deadline case — "rosters untouched,
    // nobody's fault" — and §9 forbids forcing or reversing trades. Expiring on
    // an infrastructure blip is the system reversing a trade the league
    // approved, wearing a legitimate expiry's costume.
    //
    // So: `ASSET_GONE` is the only error that writes a terminal state, because
    // it is the only one that establishes the trade can *never* execute — the
    // asset is gone and no retry brings it back. Everything else is recorded in
    // the return value and the trade stays ACCEPTED to be retried next hour,
    // which is what `resolveLeagueWeeksThrough` means by record-and-continue.
    try {
      const resolution = await resolveTrade(db, row.id, stored.rules, now, pastDeadline);
      // `null` is a trade another run settled between our select and our write.
      // Not a failure, and not ours to report.
      if (resolution) out.push(resolution);
    } catch (error) {
      const reason =
        error instanceof TradeError
          ? error.code
          : error instanceof Error
            ? error.message
            : String(error);

      if (error instanceof TradeError && error.code === "ASSET_GONE") {
        // Guarded, so an overlapping run that already executed this trade does
        // not get it relabelled EXPIRED over the top of a completed swap — which
        // is how "rosters untouched" came to be reported for moved rosters.
        if (await tradeCannotExecute(db, row.id, now)) {
          out.push({ tradeId: row.id, outcome: "EXPIRED", vetoes: 0, required: 0 });
        }
        continue;
      }

      failures.push({ tradeId: row.id, reason });
    }
  }

  return { resolutions: out, failures };
}

/**
 * A trade that can never execute, recorded rather than retried.
 *
 * Separate from the veto and deadline paths because the reason differs and a
 * reader should be able to tell them apart, even though the state is the same:
 * nothing moved, and nothing will.
 */
async function tradeCannotExecute(db: SqlClient, tradeId: string, now: Date): Promise<boolean> {
  // Guarded, and deliberately silent when it matches nothing. This runs from a
  // `catch` on an autocommit connection with no transaction to roll back, and
  // zero rows here means another run already settled the trade — which is the
  // benign outcome, not an error to raise on top of the one being handled.
  const expired = await db.query<{ id: string }>(
    `UPDATE trades SET state = 'EXPIRED', resolved_at = $2
      WHERE id = $1 AND state = 'ACCEPTED'
    RETURNING id`,
    [tradeId, now.toISOString()],
  );

  return expired.length > 0;
}

async function resolveTrade(
  db: SqlClient,
  tradeId: string,
  rules: LeagueRules,
  now: Date,
  pastDeadline: boolean,
): Promise<TradeResolution | null> {
  const trade = await loadTrade(db, tradeId);
  const electorate = await uninvolvedManagersFor(db, tradeId);
  const required = vetoesRequired(electorate, rules.trades);

  // Neither of these two may throw on a refusal. Both run on `db` in autocommit
  // with no transaction open, so there is nothing to roll back and nothing was
  // written — zero rows means another run settled this trade first, and the
  // caller reports one fewer resolution rather than an error. `null` says "not
  // mine to report", which is different from "it failed".
  if (pastDeadline) {
    const expired = await db.query<{ id: string }>(
      `UPDATE trades SET state = 'EXPIRED', resolved_at = $2
        WHERE id = $1 AND state = 'ACCEPTED'
      RETURNING id`,
      [tradeId, now.toISOString()],
    );
    if (expired.length === 0) return null;

    return { tradeId, outcome: "EXPIRED", vetoes: trade.vetoes, required };
  }

  if (isVetoed(trade.vetoes, electorate, rules.trades)) {
    const vetoed = await db.query<{ id: string }>(
      `UPDATE trades SET state = 'VETOED', resolved_at = $2
        WHERE id = $1 AND state = 'ACCEPTED'
      RETURNING id`,
      [tradeId, now.toISOString()],
    );
    if (vetoed.length === 0) return null;

    return { tradeId, outcome: "VETOED", vetoes: trade.vetoes, required };
  }

  await withTransaction(db, async (tx) => {
    // `ORDER BY player_id`, the same key `acceptTrade` takes its locks in. Two
    // functions that lock the same rows in different orders can deadlock, and
    // this one used to take them in whatever order the plan produced — so the
    // cycle `acceptTrade`'s comment claims to have removed was still
    // constructible between the two of them.
    const assets = await tx.query<{ from_team_id: string; player_id: string }>(
      "SELECT from_team_id, player_id FROM trade_assets WHERE trade_id = $1 ORDER BY player_id",
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
      const released = await tx.query<{ id: string }>(
        `UPDATE roster_entries SET released_at = $3
          WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL
        RETURNING id`,
        [asset.from_team_id, asset.player_id, now.toISOString()],
      );

      // **Nothing is created that was not destroyed.** The insert used to be
      // unconditional, so if the release matched no row — the player having left
      // that roster since the trade was accepted — a second copy of him appeared
      // on the receiver, owned by two teams at once. `0005`'s per-team unique
      // index could not catch it; `roster_entries_one_owner_per_league`
      // (migration `0022`) now does, but as a 23505 rather than as an answer.
      //
      // This is the last line of defence rather than the first, and it is the one
      // that holds regardless of how he left: accepted twice, dropped through a
      // path that did not consult the freeze, or claimed off waivers. Upstream
      // checks each close one route; this closes the outcome — and it is still
      // the only one of them that can say *which* asset is missing.
      if (released.length === 0) {
        throw new TradeError(
          `${asset.player_id} is no longer on team ${asset.from_team_id}'s roster, ` +
            `so this trade cannot be executed`,
          "ASSET_GONE",
        );
      }

      await tx.query(
        `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
         VALUES ($1, $2, 'TRADE', $3)`,
        [to, asset.player_id, now.toISOString()],
      );
    }

    // **This one must throw**, and it is the only one of the six that must.
    //
    // It sits inside the transaction that has already swapped both rosters. If
    // another run settled the trade first, answering "somebody got there
    // ahead of me" would return normally and **commit the swap** with the trade
    // still ACCEPTED — so the next hourly run would select it again and execute
    // it a second time, releasing the player from the team that just received
    // him. Throwing rolls the swap back, which is the whole reason it is in a
    // transaction.
    const executed = await tx.query<{ id: string }>(
      `UPDATE trades SET state = 'EXECUTED', resolved_at = $2
        WHERE id = $1 AND state = 'ACCEPTED'
      RETURNING id`,
      [tradeId, now.toISOString()],
    );
    if (executed.length === 0) {
      throw new TradeError(
        "This trade was settled by another run while it was executing",
        "WRONG_STATE",
      );
    }
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
