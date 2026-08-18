/**
 * Everything a commissioner needs to write their league's settlement account.
 *
 * ## Why this is a server function rather than a form
 *
 * The `Scores` account carries a payee roster and the four terms the on-chain
 * derivation runs under, and the draw refuses it if any of them disagrees with
 * the rules members signed. So there is exactly one correct value for each
 * field, and it is derivable — nobody should be typing any of it.
 *
 * The commissioner's part is a signature and the rent. This produces what they
 * sign, from the frozen document and the roster that actually formed, so the
 * account it writes is the account the draw will accept.
 *
 * ## What the browser cannot work out for itself
 *
 * Team ids and the wallet behind each of them. That pairing is a Postgres fact —
 * it lives in `league_memberships` — and it is the whole reason the `Scores`
 * account exists, since nothing on-chain otherwise connects a team to a wallet.
 *
 * The order is the join order, and it is arbitrary but must be **stable**: the
 * positions become team indices for every game posted afterwards. Any consistent
 * order works, because the seeding is decided by record and then by tiebreakers
 * ending in `LOWEST_TEAM_ID`, which compares ids rather than positions.
 */

import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";

export class SettlementPlanError extends Error {
  constructor(
    message: string,
    readonly code:
      | "RULES_MISSING"
      | "NOT_A_POT_LEAGUE"
      | "NO_TEAMS"
      /** A team with no linked wallet — nothing to pay it. */
      | "TEAM_WITHOUT_WALLET",
  ) {
    super(message);
    this.name = "SettlementPlanError";
  }
}

export interface SettlementPlanEntry {
  readonly teamId: string;
  readonly teamName: string;
  /** Base58. Where this team's prize would be paid. */
  readonly wallet: string;
}

export interface SettlementPlan {
  readonly roster: readonly SettlementPlanEntry[];
  /** Base58, from the signed rules. */
  readonly oracle: string;
  /** Discriminants, in the signed order. */
  readonly tiebreakers: readonly string[];
  readonly playoffWeeks: readonly number[];
  readonly regularSeasonWeeks: number;
  readonly playoffTeams: number;
  readonly firstRoundByes: number;
  readonly thirdPlace: boolean;
}

/**
 * The account contents, derived rather than chosen.
 *
 * Refuses rather than guessing at every point something is missing: a league
 * with no pot has nothing to settle, and a team with no wallet is a prize with
 * nowhere to go. Both are unrecoverable once written, because the account is
 * write-once and the rules are frozen — so the only useful moment to refuse is
 * before it exists.
 */
export async function settlementPlan(db: SqlClient, leagueId: string): Promise<SettlementPlan> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) {
    throw new SettlementPlanError("League has no rules", "RULES_MISSING");
  }
  const pot = stored.rules.pot;
  if (!pot) {
    throw new SettlementPlanError(
      "A league that plays for nothing has no pot to settle",
      "NOT_A_POT_LEAGUE",
    );
  }

  // Bots are excluded, and a pot league may not have any — `maxBots` is zero
  // when there is a pot, because a bot has no wallet and could not be paid. The
  // filter is written to be true rather than to rely on that.
  const rows = await db.query<{ id: string; name: string; address: string | null }>(
    `SELECT t.id, t.name, w.address
       FROM teams t
       LEFT JOIN league_memberships m ON m.team_id = t.id
       LEFT JOIN wallets w ON w.id = m.wallet_id
      WHERE t.league_id = $1 AND t.is_bot = false
      ORDER BY t.slot`,
    [leagueId],
  );

  if (rows.length === 0) {
    throw new SettlementPlanError("League has no teams", "NO_TEAMS");
  }

  const roster = rows.map((row) => {
    if (!row.address) {
      throw new SettlementPlanError(
        `${row.name} has no linked wallet, so there is nowhere to pay it. ` +
          `Every team in a pot league joined by signing from a wallet, so this ` +
          `should be unreachable — a settlement account written now would name a ` +
          `payee that does not exist, permanently.`,
        "TEAM_WITHOUT_WALLET",
      );
    }
    return { teamId: row.id, teamName: row.name, wallet: row.address };
  });

  return {
    roster,
    oracle: pot.settlementOracle,
    tiebreakers: [...stored.rules.schedule.tiebreakers],
    playoffWeeks: [...stored.rules.schedule.playoffWeeks],
    regularSeasonWeeks: stored.rules.schedule.regularSeasonWeeks,
    playoffTeams: stored.rules.schedule.playoffTeams,
    // The frozen count applies only when the playoff field is the size it was
    // frozen for; a league that never filled takes whatever its own size needs.
    // `expectedScoreTerms` in `@rostr/escrow` makes the same choice from the same
    // inputs, and the draw compares the two — so a disagreement here would refuse
    // an account this function itself produced.
    firstRoundByes: byesFor(
      Math.min(stored.rules.schedule.playoffTeams, roster.length),
      stored.rules.schedule.playoffTeams,
      stored.rules.schedule.byeSeeds,
    ),
    // Always played, paid or not — `playsThirdPlace` in `playoffs.ts`.
    thirdPlace: true,
  };
}

function byesFor(field: number, playoffTeams: number, byeSeeds: number): number {
  if (field === playoffTeams) return byeSeeds;
  let power = 1;
  while (power < field) power *= 2;
  return power - field;
}
