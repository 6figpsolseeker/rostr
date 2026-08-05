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
