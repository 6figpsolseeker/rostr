/**
 * Joining a league.
 *
 * The signature is verified here, server-side, against the rules currently
 * stored for the league — not against whatever the client claims it signed.
 * A client that signs a permissive rule set and posts it alongside a different
 * league must fail, and the only way to guarantee that is to rebuild the message
 * from the database.
 */

import { buildJoinMessage, isValidWalletAddress, verifyJoinSignature } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getChainState, getLeagueRules } from "./leagues.js";
import { withTransaction } from "./transaction.js";

export interface JoinLeagueInput {
  readonly leagueId: string;
  readonly userId: string;
  readonly walletAddress: string;
  /** Base58 signature over `buildJoinMessage(...)`. */
  readonly signature: string;
  readonly teamName: string;
  /**
   * The cluster this join is being made against, e.g. `mainnet-beta`.
   *
   * When set, the league's anchor must be on that cluster. The PDA is identical
   * everywhere, so a devnet anchor and a mainnet one are indistinguishable
   * without it — and a devnet anchor is not an anchor for a real stake.
   */
  readonly requireCluster?: string;
}

export interface JoinedLeague {
  readonly teamId: string;
  readonly membershipId: string;
  readonly slot: number;
}

export class JoinError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LEAGUE_NOT_FOUND"
      | "LEAGUE_CLOSED"
      | "LEAGUE_FULL"
      | "ALREADY_JOINED"
      | "INVALID_WALLET"
      | "WALLET_NOT_LINKED"
      | "INVALID_SIGNATURE"
      | "RULES_MISSING"
      | "LEAGUE_NOT_ANCHORED"
      | "WRONG_CLUSTER"
      | "BOTS_NOT_ALLOWED"
      | "BOT_LIMIT"
      | "EVEN_WITHOUT_BOT"
      | "BOT_NOT_FOUND"
      | "DRAFT_ALREADY_DRAWN",
  ) {
    super(message);
    this.name = "JoinError";
  }
}

interface LeagueRow {
  id: string;
  name: string;
  season: number;
  state: string;
  rules_hash: string;
  rules_uri: string | null;
}

/**
 * The exact text a prospective member must sign to join.
 *
 * Built server-side from stored data so the client cannot influence what gets
 * signed — it receives the message, shows it, and returns a signature.
 */
export async function getJoinMessage(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
): Promise<string> {
  const [league] = await db.query<LeagueRow>(
    "SELECT id, name, season, state, rules_hash, rules_uri FROM leagues WHERE id = $1",
    [leagueId],
  );
  if (!league) throw new JoinError("League not found", "LEAGUE_NOT_FOUND");

  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new JoinError("League has no stored rules", "RULES_MISSING");

  return buildJoinMessage({
    leagueId: league.id,
    leagueName: league.name,
    rulesHash: stored.hash,
    walletAddress,
    seasonYear: stored.rules.seasonYear,
  });
}

/**
 * Join a league by proving consent to its rules.
 *
 * @throws {JoinError} for every rejection, with a code a caller can branch on.
 */
export async function joinLeague(db: SqlClient, input: JoinLeagueInput): Promise<JoinedLeague> {
  if (!isValidWalletAddress(input.walletAddress)) {
    throw new JoinError("Wallet address is not a valid Solana public key", "INVALID_WALLET");
  }

  const [league] = await db.query<LeagueRow>(
    "SELECT id, name, season, state, rules_hash, rules_uri FROM leagues WHERE id = $1",
    [input.leagueId],
  );
  if (!league) throw new JoinError("League not found", "LEAGUE_NOT_FOUND");

  if (league.state !== "FORMING") {
    throw new JoinError(
      `League is ${league.state} and no longer accepting members`,
      "LEAGUE_CLOSED",
    );
  }

  const stored = await getLeagueRules(db, league.id);
  if (!stored) {
    throw new JoinError("League has no stored rules", "RULES_MISSING");
  }

  // Nobody consents to rules they cannot verify.
  //
  // Joining signs the rules hash, and the whole point of that signature is that
  // the rules are provably fixed. Until the league is anchored, the only thing
  // holding them still is a row in our own database — which is exactly the
  // arrangement this project exists to replace. A member who signed before the
  // anchor would have consented to a promise, not a fact.
  //
  // Bots are not gated: `addBot` signs nothing, stakes nothing, and consents to
  // nothing, so there is no consent to protect. The guarantee is about people.
  const chain = await getChainState(db, league.id);
  if (!chain?.anchoredAt) {
    throw new JoinError(
      "This league's rules are not on-chain yet, so they cannot be verified. " +
        "The commissioner needs to anchor them before anyone joins.",
      "LEAGUE_NOT_ANCHORED",
    );
  }

  // A league anchored on devnet is not anchored for a mainnet stake. The PDA is
  // identical on every cluster, so "the account exists" is not an answer on its
  // own — the caller has to say which chain it means.
  if (input.requireCluster && chain.cluster !== input.requireCluster) {
    throw new JoinError(
      `This league is anchored on ${chain.cluster}, not ${input.requireCluster}`,
      "WRONG_CLUSTER",
    );
  }

  // The wallet must already belong to this user. Otherwise anyone could join
  // using a public key they do not control — the signature would still fail, but
  // failing early keeps the error honest.
  const [wallet] = await db.query<{ id: string }>(
    "SELECT id FROM wallets WHERE user_id = $1 AND address = $2",
    [input.userId, input.walletAddress],
  );
  if (!wallet) {
    throw new JoinError("Wallet is not linked to this user", "WALLET_NOT_LINKED");
  }

  const [existing] = await db.query<{ id: string }>(
    "SELECT id FROM league_memberships WHERE league_id = $1 AND user_id = $2",
    [league.id, input.userId],
  );
  if (existing) throw new JoinError("Already a member of this league", "ALREADY_JOINED");

  // Rebuilt from the database, never from client input.
  const message = {
    leagueId: league.id,
    leagueName: league.name,
    rulesHash: stored.hash,
    walletAddress: input.walletAddress,
    seasonYear: stored.rules.seasonYear,
  };

  if (!verifyJoinSignature(message, input.signature)) {
    throw new JoinError("Signature does not match these league rules", "INVALID_SIGNATURE");
  }

  const maxTeams = stored.rules.league.maxTeams;

  return withTransaction(db, async (tx) => {
    const [count] = await tx.query<{ taken: number }>(
      "SELECT count(*)::int AS taken FROM teams WHERE league_id = $1",
      [league.id],
    );
    const taken = Number(count?.taken ?? 0);
    if (taken >= maxTeams) throw new JoinError("League is full", "LEAGUE_FULL");

    const [team] = await tx.query<{ id: string; slot: number }>(
      `INSERT INTO teams (league_id, owner_id, is_bot, name, slot)
       VALUES ($1, $2, false, $3, $4)
       RETURNING id, slot`,
      [league.id, input.userId, input.teamName, taken + 1],
    );

    const [membership] = await tx.query<{ id: string }>(
      `INSERT INTO league_memberships (league_id, user_id, team_id, wallet_id, rules_hash, signature)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [league.id, input.userId, team!.id, wallet.id, stored.hash, input.signature],
    );

    return {
      teamId: team!.id,
      membershipId: membership!.id,
      slot: Number(team!.slot),
    };
  });
}

/**
 * Add a bot to square an odd number of managers.
 *
 * Bots have no owner and sign nothing — there is no consent to record, because
 * there is nobody to consent. That is also why they cannot trade, claim waivers
 * or vote on a veto: a bot with a vote is a commissioner with extra steps.
 *
 * Three refusals, all from the league's own frozen rules:
 *
 *   * **Not in a pot league.** `maxBots` is zero whenever there is money. A bot
 *     has no wallet, so a bot champion would leave 60% of the pot with no
 *     recipient — on-chain, where there is nobody to appeal to.
 *   * **One at most.** A bot exists to fix an odd count. More is a different
 *     game.
 *   * **Only when the count is odd.** Adding a bot to an even league gives
 *     somebody a bye instead of preventing one, which is the opposite of the
 *     point.
 */
export async function addBot(
  db: SqlClient,
  leagueId: string,
  name: string,
): Promise<{ teamId: string; slot: number }> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new JoinError("League has no stored rules", "RULES_MISSING");

  const { maxBots, maxTeams } = stored.rules.league;

  return withTransaction(db, async (tx) => {
    const [counts] = await tx.query<{ taken: number; bots: number; humans: number }>(
      `SELECT count(*)::int AS taken,
              count(*) FILTER (WHERE is_bot)::int AS bots,
              count(*) FILTER (WHERE NOT is_bot)::int AS humans
         FROM teams WHERE league_id = $1`,
      [leagueId],
    );

    const taken = Number(counts?.taken ?? 0);
    const bots = Number(counts?.bots ?? 0);
    const humans = Number(counts?.humans ?? 0);

    if (maxBots === 0) {
      throw new JoinError(
        stored.rules.pot
          ? "This league plays for a pot, and a bot cannot be paid — so it cannot hold one."
          : "This league does not allow bots.",
        "BOTS_NOT_ALLOWED",
      );
    }

    if (bots >= maxBots) {
      throw new JoinError(
        `This league already has its ${maxBots === 1 ? "bot" : `${maxBots} bots`}.`,
        "BOT_LIMIT",
      );
    }

    if (humans % 2 === 0) {
      throw new JoinError(
        `There are ${humans} managers, which is already even. A bot would give ` +
          `somebody a bye rather than prevent one.`,
        "EVEN_WITHOUT_BOT",
      );
    }

    if (taken >= maxTeams) throw new JoinError("League is full", "LEAGUE_FULL");

    const [team] = await tx.query<{ id: string; slot: number }>(
      `INSERT INTO teams (league_id, is_bot, name, slot)
       VALUES ($1, true, $2, COALESCE((SELECT max(slot) FROM teams WHERE league_id = $1), 0) + 1)
       RETURNING id, slot`,
      [leagueId, name],
    );

    return { teamId: team!.id, slot: Number(team!.slot) };
  });
}

/**
 * Which team a user manages in a league, or `null` if they are not a member.
 *
 * The only way a request gets to act as a team. Nothing may take a team ID from
 * a client — that would let anyone draft for anyone.
 */
export async function teamForUser(
  db: SqlClient,
  leagueId: string,
  userId: string,
): Promise<{ teamId: string; name: string } | null> {
  const [row] = await db.query<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM teams t
      WHERE t.league_id = $1 AND t.owner_id = $2`,
    [leagueId, userId],
  );

  return row ? { teamId: row.id, name: row.name } : null;
}

/**
 * Remove the bot.
 *
 * The seat is a placeholder for a person, so when a sixth friend turns up it has
 * to be possible to give it back. Refused once the draft order is drawn — the
 * order is derived from the set of teams, and a trigger locks the field at that
 * moment precisely so nobody can change it afterwards.
 */
export async function removeBot(db: SqlClient, leagueId: string): Promise<{ removed: string }> {
  return withTransaction(db, async (tx) => {
    const [draft] = await tx.query<{ order_drawn_at: string | null }>(
      "SELECT order_drawn_at FROM drafts WHERE league_id = $1",
      [leagueId],
    );
    if (draft?.order_drawn_at) {
      throw new JoinError(
        "The draft order is already drawn, so the field is locked.",
        "DRAFT_ALREADY_DRAWN",
      );
    }

    const [bot] = await tx.query<{ id: string }>(
      "SELECT id FROM teams WHERE league_id = $1 AND is_bot ORDER BY slot LIMIT 1",
      [leagueId],
    );
    if (!bot) throw new JoinError("This league has no bot", "BOT_NOT_FOUND");

    // Nothing references a bot before the draft — no roster, no lineup, no
    // matchup. `ON DELETE RESTRICT` on those tables is what makes that a fact
    // rather than an assumption: if anything did reference it, this fails loudly
    // instead of orphaning a season's worth of rows.
    await tx.query("DELETE FROM teams WHERE id = $1", [bot.id]);

    return { removed: bot.id };
  });
}

export interface MembershipProof {
  readonly userId: string;
  readonly walletAddress: string;
  readonly rulesHash: string;
  readonly signature: string;
  readonly joinedAt: string;
}

/**
 * Every recorded consent for a league, with the signature that proves it.
 *
 * The audit trail: what each member agreed to, provable by anyone who can
 * rebuild the message and check the signature.
 */
export async function getMembershipProofs(
  db: SqlClient,
  leagueId: string,
): Promise<MembershipProof[]> {
  const rows = await db.query<{
    user_id: string;
    address: string;
    rules_hash: string;
    signature: string;
    joined_at: string;
  }>(
    `SELECT m.user_id, w.address, m.rules_hash, m.signature, m.joined_at
       FROM league_memberships m
       JOIN wallets w ON w.id = m.wallet_id
      WHERE m.league_id = $1
      ORDER BY m.joined_at`,
    [leagueId],
  );

  return rows.map((r) => ({
    userId: r.user_id,
    walletAddress: r.address,
    rulesHash: r.rules_hash,
    signature: r.signature,
    joinedAt: r.joined_at,
  }));
}
