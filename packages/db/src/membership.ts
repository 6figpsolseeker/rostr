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
import { isUniqueViolation } from "./pg-errors.js";
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
      | "DRAFT_ALREADY_DRAWN"
      | "FIELD_LOCKED",
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

  // Refused here too, so nobody is asked to sign a message that `joinLeague`
  // would then refuse. The signature is over the rules hash and costs a wallet
  // approval; handing one out for a seat that cannot be taken is worse than
  // saying no.
  await requireOpenField(db, leagueId);

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
 * Refuse to change the field once the draft order's seed exists.
 *
 * The seed is the first Solana block at or after `drafts.scheduled_at`, mixed
 * with the league id and the rules hash — all public and frozen — so it is
 * computable by anyone the instant that time passes. A field that can still
 * change after that is the whole attack migration `0010` was written to close,
 * reached by waiting rather than by redrawing.
 *
 * **The database is what enforces this** (`0028`, on INSERT and DELETE). This is
 * the translation, so the ordinary path answers `FIELD_LOCKED` rather than
 * letting a raw trigger exception surface as a 500. Do not remove it on the
 * grounds that the trigger already refuses: the trigger is the guarantee, this is
 * the error message.
 */
async function requireOpenField(db: SqlClient, leagueId: string): Promise<void> {
  const [draft] = await db.query<{ order_drawn_at: string | null; scheduled_at: string }>(
    "SELECT order_drawn_at, scheduled_at FROM drafts WHERE league_id = $1",
    [leagueId],
  );

  // No draft scheduled yet, so there is no seed to be known and nothing to lock.
  if (!draft) return;

  if (draft.order_drawn_at) {
    throw new JoinError("The draft order has been drawn", "DRAFT_ALREADY_DRAWN");
  }

  if (new Date(draft.scheduled_at) <= new Date()) {
    throw new JoinError(
      "This league's draft time has passed, so its field is locked",
      "FIELD_LOCKED",
    );
  }
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

  await requireOpenField(db, league.id);

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

    // Two people clicking Join on the last seat both read the same `taken` and
    // both compute the same slot, so `UNIQUE (league_id, slot)` arbitrates and
    // the loser is refused. That is why the count above cannot admit an extra
    // member even without a lock — the collision is on the value derived from
    // the stale read, not on the read itself.
    //
    // Translated rather than left to escape: losing that race means the league
    // filled up, which is `LEAGUE_FULL` and a 409, not a 500. The wrap is around
    // this one statement so no other uniqueness in the transaction can be
    // relabelled as a full league.
    let team: { id: string; slot: number } | undefined;
    try {
      [team] = await tx.query<{ id: string; slot: number }>(
        `INSERT INTO teams (league_id, owner_id, is_bot, name, slot)
         VALUES ($1, $2, false, $3, $4)
         RETURNING id, slot`,
        [league.id, input.userId, input.teamName, taken + 1],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new JoinError("League is full", "LEAGUE_FULL");
      }
      throw error;
    }

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
 *     has no wallet, so a bot champion would leave the largest share with no
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
    await requireOpenField(tx, leagueId);

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
 * to be possible to give it back. Refused once the field locks, which is the
 * league's scheduled draft time — the order is derived from the set of teams and
 * the seed exists from that instant, so a removal afterwards re-rolls it.
 *
 * **Removing is not the harmless direction.** A single join after the seed is
 * known is one blind, irreversible draw; remove-then-add is an unbounded re-roll,
 * because `addBot` inserts a fresh row and the order is a function of the field.
 * That is the attack `0010`'s header describes, and until `0028` the trigger
 * guarded INSERT only — so this check was the only thing standing in its way, in
 * a function with no production caller.
 */
export async function removeBot(db: SqlClient, leagueId: string): Promise<{ removed: string }> {
  return withTransaction(db, async (tx) => {
    // Kept ahead of the field check so a league whose order is already drawn
    // still answers `DRAFT_ALREADY_DRAWN`, which is the more specific fact.
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

    await requireOpenField(tx, leagueId);

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

export interface OnChainStake {
  readonly leagueId: string;
  readonly walletAddress: string;
  readonly depositedBaseUnits: string | null;
  readonly depositedSignature: string | null;
  readonly depositedCluster: string | null;
  readonly refundedAt: string | null;
  readonly refundSignature: string | null;
  readonly refundCluster: string | null;
}

/**
 * The wallet this user joined this league with, or `null` if they are not a
 * member of it.
 *
 * **Exists so no route has to take a wallet address from a request.** Validating
 * a supplied address against the user's linked wallets would also work, but this
 * is stronger and simpler: there is exactly one wallet a member consented with,
 * `league_memberships` already records it next to the signature over the rules
 * hash, and a caller with no way to name a wallet has no way to name someone
 * else's.
 *
 * It also **inherits a proof rather than restating one**: `joinLeague` already
 * verified a signature over the rules hash and refused a wallet not linked to
 * this user, so reading that row back carries all of it.
 *
 * `null` when the user has not joined in Postgres, which is the ordering
 * guarantee the on-chain routes depend on: **no on-chain record without a
 * consent record behind it.**
 *
 * All three on-chain routes — join, deposit, refund — took `walletAddress` from
 * the request body with no ownership check. In the refund case, composed with an
 * inverted verifier, that became "any signed-in account can mark any staked
 * member as refunded".
 */
export async function memberWallet(
  db: SqlClient,
  leagueId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db.query<{ address: string }>(
    `SELECT w.address
       FROM league_memberships m
       JOIN wallets w ON w.id = m.wallet_id
      WHERE m.league_id = $1 AND m.user_id = $2`,
    [leagueId, userId],
  );

  return row?.address ?? null;
}

/**
 * Record that a member has staked into a league on-chain.
 *
 * The member signs `deposit` from their own wallet — no key of ours is
 * involved — and the server reads the `Membership` PDA back (deposited > 0)
 * before recording. The signature is an audit breadcrumb, not the proof. The
 * amount is taken from the program's `Membership.deposited`, which equals
 * `league.buy_in` by construction.
 *
 * Upserts on (league_id, wallet_address): a re-post after a lost response is
 * idempotent.
 */
export async function recordOnChainDeposit(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
  depositedBaseUnits: string,
  signature: string,
  cluster: string,
): Promise<void> {
  await db.query(
    `INSERT INTO league_onchain_stakes
       (league_id, wallet_address, deposited_base_units, deposited_signature, deposited_cluster, deposited_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (league_id, wallet_address)
     DO UPDATE SET
       deposited_base_units = EXCLUDED.deposited_base_units,
       deposited_signature = EXCLUDED.deposited_signature,
       deposited_cluster = EXCLUDED.deposited_cluster,
       deposited_at = now()`,
    [leagueId, walletAddress, depositedBaseUnits, signature, cluster],
  );
}

export async function getOnChainDeposit(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
): Promise<OnChainStake | null> {
  return getOnChainStake(db, leagueId, walletAddress);
}

/**
 * Record that a member has withdrawn their stake on-chain.
 *
 * The refund instruction is unconditional after the timelock, signed by the
 * member alone. The server reads the `Membership` PDA back (refunded == true)
 * before recording. Upserts on (league_id, wallet_address).
 */
export async function recordOnChainRefund(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
  signature: string,
  cluster: string,
): Promise<void> {
  await db.query(
    `INSERT INTO league_onchain_stakes
       (league_id, wallet_address, refunded_at, refund_signature, refund_cluster)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (league_id, wallet_address)
     DO UPDATE SET
       refunded_at = now(),
       refund_signature = EXCLUDED.refund_signature,
       refund_cluster = EXCLUDED.refund_cluster`,
    [leagueId, walletAddress, signature, cluster],
  );
}

export async function getOnChainRefund(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
): Promise<OnChainStake | null> {
  return getOnChainStake(db, leagueId, walletAddress);
}

async function getOnChainStake(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
): Promise<OnChainStake | null> {
  const [row] = await db.query<{
    league_id: string;
    wallet_address: string;
    deposited_base_units: string | null;
    deposited_signature: string | null;
    deposited_cluster: string | null;
    refunded_at: string | null;
    refund_signature: string | null;
    refund_cluster: string | null;
  }>(
    `SELECT league_id, wallet_address, deposited_base_units, deposited_signature,
            deposited_cluster, refunded_at, refund_signature, refund_cluster
       FROM league_onchain_stakes
      WHERE league_id = $1 AND wallet_address = $2`,
    [leagueId, walletAddress],
  );

  if (!row) return null;

  return {
    leagueId: row.league_id,
    walletAddress: row.wallet_address,
    depositedBaseUnits: row.deposited_base_units,
    depositedSignature: row.deposited_signature,
    depositedCluster: row.deposited_cluster,
    refundedAt: row.refunded_at,
    refundSignature: row.refund_signature,
    refundCluster: row.refund_cluster,
  };
}

export interface OnChainJoin {
  readonly leagueId: string;
  readonly walletAddress: string;
  readonly userId: string;
  readonly signature: string;
  readonly cluster: string;
  readonly joinedAt: string;
}

/**
 * Record that a member has joined a league on-chain.
 *
 * The member signs `join_league` from their own wallet — no key of ours is
 * involved — and then tells us it happened. A report is not evidence: this is
 * the write that follows `verifyOnChainJoin` finding a `Membership` account at
 * the PDA for this league and wallet. The signature is an audit breadcrumb
 * (which transaction created the account), not the proof.
 *
 * **This upserts; it is not write-once.** The anchor record is write-once by
 * trigger because there is exactly one anchoring transaction ever. Here a
 * re-post after a lost response is the ordinary case and has to succeed, so the
 * row is keyed on (league, wallet) and rewritten. What makes that safe is not
 * immutability but authorisation: `user_id` is recorded, and the caller may
 * only ever write the wallet their own consent row names, so nobody can
 * overwrite anybody else's record.
 */
export async function recordOnChainJoin(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
  userId: string,
  signature: string,
  cluster: string,
): Promise<void> {
  await db.query(
    `INSERT INTO league_onchain_joins (league_id, wallet_address, user_id, signature, cluster)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (league_id, wallet_address)
     DO UPDATE SET signature = EXCLUDED.signature, cluster = EXCLUDED.cluster, joined_at = now()`,
    [leagueId, walletAddress, userId, signature, cluster],
  );
}

/**
 * The DB-side record of a member's on-chain join, or `null` if they have not
 * yet joined on-chain (e.g. they joined in Postgres but have not signed
 * `join_league` yet).
 */
export async function getOnChainJoin(
  db: SqlClient,
  leagueId: string,
  walletAddress: string,
): Promise<OnChainJoin | null> {
  const [row] = await db.query<{
    league_id: string;
    wallet_address: string;
    user_id: string;
    signature: string;
    cluster: string;
    joined_at: string;
  }>(
    `SELECT league_id, wallet_address, user_id, signature, cluster, joined_at
       FROM league_onchain_joins
      WHERE league_id = $1 AND wallet_address = $2`,
    [leagueId, walletAddress],
  );

  if (!row) return null;

  return {
    leagueId: row.league_id,
    walletAddress: row.wallet_address,
    userId: row.user_id,
    signature: row.signature,
    cluster: row.cluster,
    joinedAt: row.joined_at,
  };
}
