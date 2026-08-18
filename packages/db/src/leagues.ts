/**
 * League creation.
 *
 * The one moment a league's rules are writable. Everything after this point is
 * enforced immutable by trigger, so this function is where correctness has to be
 * established rather than assumed:
 *
 *   validate → hash → write, all in one transaction
 *
 * If validation fails, nothing is written. If any write fails, nothing is
 * written. There is no state in which a league exists with rules that were never
 * checked.
 */

import type { LeagueRules, SportDef } from "@rostr/core";
import { encodeLeagueRules, hashLeagueRules, validateLeagueRules } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { loadSportIds } from "./sports.js";
import { withTransaction } from "./transaction.js";

export interface CreateLeagueInput {
  readonly name: string;
  readonly commissionerId: string;
  readonly rules: LeagueRules;
  /**
   * Where the canonical rule document is pinned. Optional at creation: a league
   * in FORMING state with no members yet anchors nothing. It must be set before
   * anyone joins — see `setRulesUri`.
   */
  readonly rulesUri?: string;
}

export interface CreatedLeague {
  readonly id: string;
  readonly rulesHash: string;
  /** The exact bytes that were hashed. Pin these, not a pretty-printed copy. */
  readonly canonical: string;
}

export class LeagueValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`League rules are invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "LeagueValidationError";
  }
}

/**
 * Create a league and freeze its rules.
 *
 * @throws {LeagueValidationError} if the rule set is incoherent. Rules cannot be
 * corrected after creation, so this is the last chance to reject them.
 */
export async function createLeague(
  db: SqlClient,
  sport: SportDef,
  input: CreateLeagueInput,
): Promise<CreatedLeague> {
  const problems = validateLeagueRules(input.rules, sport);
  if (problems.length > 0) throw new LeagueValidationError(problems);

  const canonical = encodeLeagueRules(input.rules);
  const rulesHash = hashLeagueRules(input.rules);
  const ids = await loadSportIds(db, sport.key);

  return withTransaction(db, async (tx) => {
    const [league] = await tx.query<{ id: string }>(
      `INSERT INTO leagues (sport_id, season, name, visibility, commissioner_id, rules_hash, rules_uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        ids.sportId,
        input.rules.seasonYear,
        input.name,
        input.rules.league.visibility,
        input.commissionerId,
        rulesHash,
        input.rulesUri ?? null,
      ],
    );
    const leagueId = league!.id;

    // The authoritative copy. `canonical` is stored verbatim so anyone can
    // re-hash it and check the result against the chain.
    await tx.query(
      `INSERT INTO league_rules (league_id, rule_json, canonical, hash)
       VALUES ($1, $2::jsonb, $3, $4)`,
      [leagueId, canonical, canonical, rulesHash],
    );

    // Denormalised copies for querying. Copies, never references to a shared
    // template — a template edit would otherwise reach leagues already created.
    for (const rule of input.rules.scoring) {
      const statKeyId = ids.statKeyIds.get(rule.statKey);
      if (!statKeyId) {
        throw new Error(
          `Scoring rule references stat key "${rule.statKey}", which is not seeded for ${sport.key}`,
        );
      }

      await tx.query(
        `INSERT INTO league_scoring_rules
           (league_id, stat_key_id, kind, milli_points_per_unit, tiers)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          leagueId,
          statKeyId,
          rule.kind,
          rule.kind === "LINEAR" ? rule.milliPointsPerUnit : null,
          rule.kind === "TIERED" ? JSON.stringify(rule.tiers) : null,
        ],
      );
    }

    for (const [ordinal, slot] of input.rules.roster.starters.entries()) {
      const slotTypeId = ids.slotTypeIds.get(slot.slotType);
      if (!slotTypeId) {
        throw new Error(
          `Roster references slot type "${slot.slotType}", which is not seeded for ${sport.key}`,
        );
      }
      await tx.query(
        `INSERT INTO league_roster_slots (league_id, slot_type_id, count, ordinal)
         VALUES ($1, $2, $3, $4)`,
        [leagueId, slotTypeId, slot.count, ordinal],
      );
    }

    return { id: leagueId, rulesHash, canonical };
  });
}

/**
 * Record where the rule document is pinned.
 *
 * Separate from creation because pinning is a network call that can fail, and a
 * league with no members yet anchors nothing. `leagues` is mutable; the rules
 * themselves are not.
 */
export async function setRulesUri(
  db: SqlClient,
  leagueId: string,
  rulesUri: string,
): Promise<void> {
  await db.query("UPDATE leagues SET rules_uri = $1 WHERE id = $2", [rulesUri, leagueId]);
}

export interface ChainAnchor {
  /** The transaction that created the on-chain league account. */
  readonly signature: string;
  /** `mainnet-beta`, `devnet`, `localnet`. */
  readonly cluster: string;
}

/**
 * Record that a league's rules are anchored on-chain.
 *
 * **Call this only after reading the account back and confirming its rules hash
 * matches.** The signature arrives from a browser, and a browser can claim
 * anything; what makes this a fact rather than a report is that the caller
 * checked the chain. `verifyChainAnchor` in the web app is that check.
 *
 * Separate from creation because anchoring is a second transaction, signed by
 * the commissioner's own wallet rather than by us. That is deliberate — it means
 * no key of ours is involved in creating a league — and it means a league can
 * exist here while unanchored, because someone can close a tab. The partial
 * index in migration 0014 is for finding those.
 *
 * Written once. A second call with different values raises, from a trigger
 * rather than from this function, so it holds against psql too.
 */
export async function recordChainAnchor(
  db: SqlClient,
  leagueId: string,
  anchor: ChainAnchor,
): Promise<void> {
  await db.query(
    `UPDATE leagues
        SET chain_anchored_at = now(), chain_signature = $1, chain_cluster = $2
      WHERE id = $3`,
    [anchor.signature, anchor.cluster, leagueId],
  );
}

/**
 * Record that a league's season has been declared started on-chain.
 *
 * **Call this only after reading `League.started` back off the account.** The
 * signature arrives from a browser and a browser can claim anything; what makes
 * this a fact rather than a report is that the caller checked the chain.
 * `verifyOnChainSeasonStart` in `@rostr/escrow` is that check, and
 * `/api/leagues/[id]/start-season` is the only caller.
 *
 * ## What the record is for
 *
 * `refund_stake` opens two ways — the ordinary timelock, and
 * `!started && now >= start_deadline` for a league that never began — and
 * `League.started` is the only thing that separates them. A pot league that
 * drafts without this having landed spends its whole season with the escape
 * hatch open: any member could withdraw their stake and keep playing for the
 * pot. `drawDraftOrder` refuses a pot league until this row exists, which is
 * why it has to be a row rather than an RPC call — see migration `0031`.
 *
 * Written once, by trigger, so it holds against psql too. Re-posting after a
 * lost response is handled by the route returning early on the existing record
 * rather than by a second write.
 */
export async function recordSeasonStart(
  db: SqlClient,
  leagueId: string,
  start: ChainAnchor,
): Promise<void> {
  await db.query(
    `UPDATE leagues
        SET season_started_at = now(), season_start_signature = $1, season_start_cluster = $2
      WHERE id = $3`,
    [start.signature, start.cluster, leagueId],
  );
}

export interface LeagueChainState {
  readonly anchoredAt: Date | null;
  readonly signature: string | null;
  readonly cluster: string | null;
  /**
   * When `start_season` was recorded, or `null` if it never was.
   *
   * Always `null` for a free league: the program refuses `start_season` without
   * a pot, so there is no transaction that could set it.
   */
  readonly seasonStartedAt: Date | null;
  readonly seasonStartSignature: string | null;
  readonly seasonStartCluster: string | null;
}

/**
 * Whether a league's rules are on-chain yet, and whether its season has been
 * declared started.
 *
 * Members should not be asked to consent to a rule set they cannot verify, so
 * the first of those gates joining. The second gates the draw of a pot league —
 * see `recordSeasonStart`.
 */
export async function getChainState(
  db: SqlClient,
  leagueId: string,
): Promise<LeagueChainState | null> {
  const [row] = await db.query<{
    chain_anchored_at: Date | null;
    chain_signature: string | null;
    chain_cluster: string | null;
    season_started_at: Date | null;
    season_start_signature: string | null;
    season_start_cluster: string | null;
  }>(
    `SELECT chain_anchored_at, chain_signature, chain_cluster,
            season_started_at, season_start_signature, season_start_cluster
       FROM leagues WHERE id = $1`,
    [leagueId],
  );

  if (!row) return null;

  return {
    anchoredAt: row.chain_anchored_at,
    signature: row.chain_signature,
    cluster: row.chain_cluster,
    seasonStartedAt: row.season_started_at,
    seasonStartSignature: row.season_start_signature,
    seasonStartCluster: row.season_start_cluster,
  };
}

export interface StoredLeagueRules {
  readonly leagueId: string;
  readonly hash: string;
  readonly canonical: string;
  readonly rules: LeagueRules;
}

/** Read back a league's frozen rules. */
export async function getLeagueRules(
  db: SqlClient,
  leagueId: string,
): Promise<StoredLeagueRules | null> {
  const [row] = await db.query<{ league_id: string; hash: string; canonical: string }>(
    "SELECT league_id, hash, canonical FROM league_rules WHERE league_id = $1",
    [leagueId],
  );
  if (!row) return null;

  return {
    leagueId: row.league_id,
    hash: row.hash,
    canonical: row.canonical,
    rules: JSON.parse(row.canonical) as LeagueRules,
  };
}

/**
 * Re-derive a league's hash from its stored rules and check it still matches.
 *
 * Cheap, and it catches the failure mode that would matter most: stored rules
 * that no longer hash to what members signed.
 */
export async function verifyStoredRules(db: SqlClient, leagueId: string): Promise<boolean> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) return false;
  return hashLeagueRules(stored.rules) === stored.hash;
}
