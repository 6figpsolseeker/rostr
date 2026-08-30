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
import {
  encodeLeagueRules,
  hashLeagueRules,
  sha256Hex,
  validateLeagueRules,
} from "@rostr/core";
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

/** A pinned rule document: where it lives, and what it hashes to. */
export interface PinnedRules {
  /** The content address the bytes were published at. */
  readonly uri: string;
  /**
   * The hash of the bytes that were pinned — not the hash the league is
   * expected to have. The point of passing it is that the two can differ.
   */
  readonly hash: string;
}

/**
 * Record where a league's rule document is pinned.
 *
 * Separate from creation because pinning is a network call that can fail, and a
 * league with no members yet publishes nothing. `leagues` is mutable; the rules
 * themselves are not.
 *
 * **Takes the pinned document's hash and swaps on it.** This used to be a bare
 * `UPDATE … SET rules_uri = $1 WHERE id = $2`, which writes whatever it is
 * handed to whichever league it is handed, and the caller is the only thing
 * standing between those two being the same document. Issue #69 §4.
 *
 * That caller is an async pin: encode, upload, await, then write. Nothing in
 * that shape keeps a league id and a CID together — a retry closing over a stale
 * variable, two creations in flight, or an argument order slip all end with a
 * league pointing at somebody else's rules. And it would look right: the URI
 * resolves, the document is a valid rule set, and `rules_hash` is untouched, so
 * `verifyStoredRules`, `0004`'s trigger and the on-chain anchor all still pass.
 * The mismatch is only visible to a member who fetches the document and hashes
 * it, which is precisely the check this column exists to spare them.
 *
 * So the swap is on `rules_hash`: the row is written only if the league's own
 * hash is the hash of the bytes that were pinned. Wrong league, wrong document,
 * either way there is no row to update and no write.
 *
 * `rules_uri = $1` in the predicate makes a genuine retry a no-op success rather
 * than a refusal — re-pinning is content-addressed, so the same rules give back
 * the same URI. `0044`'s `leagues_rules_uri_set_once` is the backstop under
 * both clauses; in the ordinary path it never fires.
 *
 * @returns `true` if the league now points at `pinned.uri`. `false` means it was
 * refused — no such league, its rules hash to something else, or it is already
 * pinned somewhere different — and the caller must not treat the rules as
 * published.
 */
export async function setRulesUri(
  db: SqlClient,
  leagueId: string,
  pinned: PinnedRules,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE leagues SET rules_uri = $1
      WHERE id = $2
        AND rules_hash = $3
        AND (rules_uri IS NULL OR rules_uri = $1)
      RETURNING id`,
    [pinned.uri, leagueId, pinned.hash],
  );
  return rows.length > 0;
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
 * Hash a league's stored rule bytes and check they still match what members signed.
 *
 * **The stored bytes, not the parsed object, and that is the whole of it.** This
 * used to be `hashLeagueRules(stored.rules)` — re-parsing `canonical` and
 * re-canonicalising it before hashing, which normalises away precisely the
 * corruption the check exists to catch. Whitespace, key order, an alternate
 * string escape, an alternate number spelling and a duplicated key all survive
 * `JSON.parse` into an equal object, so all five re-derived the original hash
 * and reported success over bytes that were not the bytes. Issue #69 §1.
 *
 * The sibling package has always stated the rule and followed it — see
 * `pinLeagueRules`: *"Hash the retrieved bytes directly. Re-parsing and
 * re-encoding would hide exactly the corruption this check exists to catch."*
 * This function did the opposite while `CLAUDE.md` claimed it did the same.
 *
 * **Reachable at ordinary privilege**, which is sharper than the issue allowed.
 * `0004`'s `check_rules_hash_matches` compares `NEW.hash` against
 * `leagues.rules_hash` and never looks at the bytes — so a plain INSERT can
 * store anything at all under a correct hash, and both that trigger and this
 * check pass.
 *
 * **Reads the columns rather than going through `getLeagueRules`, so that bytes
 * which are not JSON at all answer `false` instead of throwing.** That helper
 * ends in `JSON.parse(row.canonical)`, and the corruption this function exists
 * to catch is exactly the corruption that makes the parse fail — so routing
 * through it turned the worst case into a `SyntaxError` out of a function whose
 * declared type is `boolean`. Nothing here needs the parsed object anyway: the
 * question is whether the bytes hash to the hash, and a parse can only lose that
 * information.
 *
 * The bytes are safe to hash directly: `createLeague` binds the same string it
 * hashed into a `text` column, and `canonicalize` escapes NUL and lone
 * surrogates on the way out, so nothing that reaches the column is invalid UTF-8
 * for `TextEncoder` to substitute. Verified round-trip: `text` applies no
 * Unicode normalisation in any collation, so NFC and NFD stay distinct and come
 * back byte-identical.
 */
export async function verifyStoredRules(db: SqlClient, leagueId: string): Promise<boolean> {
  const [row] = await db.query<{ canonical: string; hash: string }>(
    "SELECT canonical, hash FROM league_rules WHERE league_id = $1",
    [leagueId],
  );
  if (!row) return false;
  return sha256Hex(row.canonical) === row.hash;
}
