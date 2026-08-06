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
import { getLeagueRules } from "./leagues.js";
import { withTransaction } from "./transaction.js";

export interface JoinLeagueInput {
  readonly leagueId: string;
  readonly userId: string;
  readonly walletAddress: string;
  /** Base58 signature over `buildJoinMessage(...)`. */
  readonly signature: string;
  readonly teamName: string;
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
      | "RULES_MISSING",
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
 * Add a bot to fill an unclaimed slot.
 *
 * Bots have no owner and sign nothing — there is no consent to record, because
 * there is nobody to consent.
 */
export async function addBot(
  db: SqlClient,
  leagueId: string,
  name: string,
): Promise<{ teamId: string; slot: number }> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new JoinError("League has no stored rules", "RULES_MISSING");

  return withTransaction(db, async (tx) => {
    const [count] = await tx.query<{ taken: number }>(
      "SELECT count(*)::int AS taken FROM teams WHERE league_id = $1",
      [leagueId],
    );
    const taken = Number(count?.taken ?? 0);
    if (taken >= stored.rules.league.maxTeams) {
      throw new JoinError("League is full", "LEAGUE_FULL");
    }

    const [team] = await tx.query<{ id: string; slot: number }>(
      `INSERT INTO teams (league_id, is_bot, name, slot)
       VALUES ($1, true, $2, $3)
       RETURNING id, slot`,
      [leagueId, name, taken + 1],
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
