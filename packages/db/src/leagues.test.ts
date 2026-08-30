import { afterEach, describe, expect, it } from "vitest";
import {
  encodeLeagueRules,
  buildNflPprRules,
  hashLeagueRules,
  NFL,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
} from "@rostr/core";
import type { DraftRules, LeagueRules, PotRules } from "@rostr/core";
import {
  createLeague,
  getChainState,
  getLeagueRules,
  LeagueValidationError,
  recordChainAnchor,
  recordSeasonStart,
  setRulesUri,
  verifyStoredRules,
} from "./leagues.js";
import { seedSport, SportNotSeededError } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

const POT: PotRules = {
  tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  buyInBaseUnits: "50000000",
  payout: NFL_DEFAULT_PAYOUT,
  refundUnlockAt: 1_773_000_000,
  feeBps: NFL_DEFAULT_FEE_BPS,
  feeRecipient: "6dNUCTMTgoHhbfgDzKtiPvBpJ2LzMwGqBpKmUDgQtNMK",
  settlementOracle: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
};

function rules(overrides: Partial<LeagueRules> = {}): LeagueRules {
  return {
    ...buildNflPprRules({ seasonYear: 2026, draft: DRAFT, pot: POT }),
    ...overrides,
  } as LeagueRules;
}

async function setup(): Promise<{ client: PGliteClient; commissionerId: string }> {
  db = await createTestDatabase();
  await seedSport(db, NFL);
  const [user] = await db.query<{ id: string }>(
    "INSERT INTO users (email, display_name) VALUES ('commish@example.com', 'Commish') RETURNING id",
  );
  return { client: db, commissionerId: user!.id };
}

describe("seedSport", () => {
  it("projects the sport definition into rows", async () => {
    const { client } = await setup();

    const ids = await seedSport(client, NFL);
    expect(ids.statKeyIds.size).toBe(NFL.statKeys.length);
    expect(ids.positionIds.size).toBe(NFL.positions.length);
    expect(ids.slotTypeIds.size).toBe(NFL.slotTypes.length);
  });

  it("is idempotent", async () => {
    const { client } = await setup();
    await seedSport(client, NFL);
    await seedSport(client, NFL);

    const [row] = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM stat_keys",
    );
    expect(Number(row?.count)).toBe(NFL.statKeys.length);
  });

  it("wires FLEX to exactly RB, WR, and TE", async () => {
    const { client } = await setup();
    const rows = await client.query<{ key: string }>(
      `SELECT p.key FROM slot_type_positions stp
         JOIN slot_types st ON st.id = stp.slot_type_id
         JOIN positions p ON p.id = stp.position_id
        WHERE st.key = 'FLEX'
        ORDER BY p.sort_order`,
    );
    expect(rows.map((r) => r.key)).toEqual(["RB", "WR", "TE"]);
  });

  it("reports a sport that was never seeded", async () => {
    db = await createTestDatabase();
    await expect(
      createLeague(db, NFL, { name: "X", commissionerId: crypto.randomUUID(), rules: rules() }),
    ).rejects.toThrow(SportNotSeededError);
  });
});

describe("createLeague", () => {
  it("creates a league and freezes its rules", async () => {
    const { client, commissionerId } = await setup();
    const ruleSet = rules();

    const league = await createLeague(client, NFL, {
      name: "The Money League",
      commissionerId,
      rules: ruleSet,
    });

    expect(league.rulesHash).toBe(hashLeagueRules(ruleSet));
    expect(league.rulesHash).toMatch(/^[0-9a-f]{64}$/);

    const stored = await getLeagueRules(client, league.id);
    expect(stored?.hash).toBe(league.rulesHash);
    expect(stored?.rules).toEqual(ruleSet);
  });

  it("stores canonical bytes that re-hash to the stored hash", async () => {
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "L",
      commissionerId,
      rules: rules(),
    });

    // The property everything else rests on: what is stored still hashes to
    // what members signed.
    expect(await verifyStoredRules(client, league.id)).toBe(true);
  });

  it("denormalises scoring rules with the right shape", async () => {
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "L",
      commissionerId,
      rules: rules(),
    });

    const linear = await client.query<{ milli_points_per_unit: number }>(
      `SELECT lsr.milli_points_per_unit FROM league_scoring_rules lsr
         JOIN stat_keys sk ON sk.id = lsr.stat_key_id
        WHERE lsr.league_id = $1 AND sk.key = 'rec'`,
      [league.id],
    );
    expect(linear[0]?.milli_points_per_unit).toBe(1000);

    const tiered = await client.query<{ kind: string; tiers: unknown; milli: number | null }>(
      `SELECT lsr.kind, lsr.tiers, lsr.milli_points_per_unit AS milli
         FROM league_scoring_rules lsr
         JOIN stat_keys sk ON sk.id = lsr.stat_key_id
        WHERE lsr.league_id = $1 AND sk.key = 'def_pts_allowed'`,
      [league.id],
    );
    expect(tiered[0]?.kind).toBe("TIERED");
    expect(tiered[0]?.milli).toBeNull();
    expect(Array.isArray(tiered[0]?.tiers)).toBe(true);
  });

  it("denormalises roster slots in order", async () => {
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "L",
      commissionerId,
      rules: rules(),
    });

    const rows = await client.query<{ key: string; count: number }>(
      `SELECT st.key, lrs.count FROM league_roster_slots lrs
         JOIN slot_types st ON st.id = lrs.slot_type_id
        WHERE lrs.league_id = $1
        ORDER BY lrs.ordinal`,
      [league.id],
    );

    expect(rows.map((r) => r.key)).toEqual(["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"]);
    expect(rows.map((r) => Number(r.count))).toEqual([1, 2, 2, 1, 1, 1, 1]);
  });

  it("makes the rules immutable once written", async () => {
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "L",
      commissionerId,
      rules: rules(),
    });

    await expect(
      client.query("UPDATE league_rules SET canonical = '{}' WHERE league_id = $1", [
        league.id,
      ]),
    ).rejects.toThrow(/immutable/i);

    await expect(
      client.query(
        `UPDATE league_scoring_rules SET milli_points_per_unit = 9999 WHERE league_id = $1`,
        [league.id],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects invalid rules and writes nothing", async () => {
    const { client, commissionerId } = await setup();

    const broken = structuredClone(rules()) as LeagueRules;
    (broken.settlement as { payingFinalizationHours: number }).payingFinalizationHours = 1;

    await expect(
      createLeague(client, NFL, { name: "Nope", commissionerId, rules: broken }),
    ).rejects.toThrow(LeagueValidationError);

    const leagues = await client.query("SELECT id FROM leagues");
    expect(leagues).toEqual([]);
  });

  it("reports every problem at once rather than the first", async () => {
    const { client, commissionerId } = await setup();

    const broken = structuredClone(rules()) as LeagueRules;
    (broken.league as { minHumans: number }).minHumans = 1;
    (broken.trades as { deadlineWeek: number }).deadlineWeek = 99;

    await expect(
      createLeague(client, NFL, { name: "Nope", commissionerId, rules: broken }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof LeagueValidationError && e.problems.length >= 2,
    );
  });

  it("rolls back completely if a write fails midway", async () => {
    const { client, commissionerId } = await setup();

    // A rule set that passes validation but names a stat key absent from the
    // database — validation checks the SportDef, this checks the seeded rows.
    const orphaned = structuredClone(rules()) as LeagueRules;
    await client.query("DELETE FROM stat_keys WHERE key = 'rec'");

    await expect(
      createLeague(client, NFL, { name: "Nope", commissionerId, rules: orphaned }),
    ).rejects.toThrow(/not seeded/);

    expect(await client.query("SELECT id FROM leagues")).toEqual([]);
    expect(await client.query("SELECT league_id FROM league_rules")).toEqual([]);
    expect(await client.query("SELECT id FROM league_scoring_rules")).toEqual([]);
  });

  it("distinguishes two leagues with different rules by hash", async () => {
    const { client, commissionerId } = await setup();

    const a = await createLeague(client, NFL, {
      name: "A",
      commissionerId,
      rules: rules(),
    });

    const differentDraft = structuredClone(rules()) as LeagueRules;
    (differentDraft.draft as { pickSeconds: number }).pickSeconds = 28_800;

    const b = await createLeague(client, NFL, {
      name: "B",
      commissionerId,
      rules: differentDraft,
    });

    expect(a.rulesHash).not.toBe(b.rulesHash);
  });

  it("gives identical rules the identical hash across leagues", async () => {
    const { client, commissionerId } = await setup();

    const a = await createLeague(client, NFL, { name: "A", commissionerId, rules: rules() });
    const b = await createLeague(client, NFL, { name: "B", commissionerId, rules: rules() });

    expect(a.rulesHash).toBe(b.rulesHash);
    expect(a.canonical).toBe(b.canonical);
  });

  it("records the pinned rules URI after creation", async () => {
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "L",
      commissionerId,
      rules: rules(),
    });

    await setRulesUri(client, league.id, { uri: "ipfs://bafyfake", hash: league.rulesHash });

    const [row] = await client.query<{ rules_uri: string }>(
      "SELECT rules_uri FROM leagues WHERE id = $1",
      [league.id],
    );
    expect(row?.rules_uri).toBe("ipfs://bafyfake");
  });

  it("creates a league with no pot", async () => {
    const { client, commissionerId } = await setup();
    const free = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });

    const league = await createLeague(client, NFL, {
      name: "For Pride",
      commissionerId,
      rules: free,
    });

    const stored = await getLeagueRules(client, league.id);
    expect(stored?.rules.pot).toBeNull();
  });
});

describe("the on-chain anchor", () => {
  const anchor = { signature: "5xSig".padEnd(88, "a"), cluster: "localnet" };

  async function league(client: PGliteClient, commissionerId: string) {
    return createLeague(client, NFL, { name: "L", commissionerId, rules: rules() });
  }

  it("starts unanchored, because anchoring is a separate signature", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);

    const state = await getChainState(client, created.id);
    expect(state?.anchoredAt).toBeNull();
    expect(state?.signature).toBeNull();
  });

  it("records the transaction that anchored it", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);

    await recordChainAnchor(client, created.id, anchor);

    const state = await getChainState(client, created.id);
    expect(state?.anchoredAt).toBeInstanceOf(Date);
    expect(state?.signature).toBe(anchor.signature);
    // Without the cluster, a devnet anchor and a mainnet one are
    // indistinguishable — the PDA is identical on every chain.
    expect(state?.cluster).toBe("localnet");
  });

  it("cannot be rewritten to point at a different transaction", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);
    await recordChainAnchor(client, created.id, anchor);

    // The real anchor exists on-chain and cannot be undone. Letting the record
    // move is how a genuine anchor gets papered over with a fake one later.
    await expect(
      recordChainAnchor(client, created.id, { signature: "other", cluster: "mainnet-beta" }),
    ).rejects.toThrow(/anchored/);

    const state = await getChainState(client, created.id);
    expect(state?.signature).toBe(anchor.signature);
  });

  it("refuses a timestamp with no transaction behind it", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);

    // A claim of anchoring with nothing to check is the shape of thing the
    // column exists to remove.
    await expect(
      client.query("UPDATE leagues SET chain_anchored_at = now() WHERE id = $1", [created.id]),
    ).rejects.toThrow();
  });

  it("returns nothing for a league that does not exist", async () => {
    const { client } = await setup();
    expect(await getChainState(client, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

/**
 * And the same again for the season start, which is a different fact with the
 * same properties.
 *
 * `League.started` is set once by the program and never unset. It decides which
 * of two refund schedules a pot league's members are on — the ordinary timelock,
 * or the failed-league opening 48 hours after the draft time — so a record that
 * could be cleared or re-pointed is a record that could be made to disagree with
 * the chain about whether a season ever began. `drawDraftOrder` reads it.
 */
describe("the season start on-chain", () => {
  const anchor = { signature: "5xSig".padEnd(88, "a"), cluster: "localnet" };
  const start = { signature: "6".repeat(88), cluster: "localnet" };

  async function league(client: PGliteClient, commissionerId: string) {
    return createLeague(client, NFL, { name: "L", commissionerId, rules: rules() });
  }

  it("starts unrecorded, because starting a season is a separate signature", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);

    const state = await getChainState(client, created.id);
    expect(state?.seasonStartedAt).toBeNull();
    expect(state?.seasonStartSignature).toBeNull();
    expect(state?.seasonStartCluster).toBeNull();
  });

  it("records the transaction that started the season", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);

    await recordSeasonStart(client, created.id, start);

    const state = await getChainState(client, created.id);
    expect(state?.seasonStartedAt).toBeInstanceOf(Date);
    expect(state?.seasonStartSignature).toBe(start.signature);
    expect(state?.seasonStartCluster).toBe("localnet");
  });

  it("cannot be rewritten to point at a different transaction", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);
    await recordSeasonStart(client, created.id, start);

    await expect(
      recordSeasonStart(client, created.id, { signature: "other", cluster: "mainnet-beta" }),
    ).rejects.toThrow(/season started/);

    const state = await getChainState(client, created.id);
    expect(state?.seasonStartSignature).toBe(start.signature);
  });

  it("cannot be cleared, which is the direction that matters most", async () => {
    // Clearing it reopens the failed-league refund on a running season — the
    // exact state that lets a member withdraw their stake and keep playing for
    // the pot. The chain would still say started; only our record would lie.
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);
    await recordSeasonStart(client, created.id, start);

    await expect(
      client.query(
        `UPDATE leagues
            SET season_started_at = NULL, season_start_signature = NULL,
                season_start_cluster = NULL
          WHERE id = $1`,
        [created.id],
      ),
    ).rejects.toThrow(/season started/);
  });

  it("refuses a timestamp with no transaction behind it", async () => {
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);

    await expect(
      client.query("UPDATE leagues SET season_started_at = now() WHERE id = $1", [created.id]),
    ).rejects.toThrow();
  });

  it("leaves the anchor alone", async () => {
    // Two triggers on one table, and each has to ignore the other's columns —
    // otherwise recording a season start on an anchored league would raise from
    // the anchor's trigger and nothing could ever draft.
    const { client, commissionerId } = await setup();
    const created = await league(client, commissionerId);
    await recordChainAnchor(client, created.id, anchor);

    await expect(recordSeasonStart(client, created.id, start)).resolves.toBeUndefined();

    const state = await getChainState(client, created.id);
    expect(state?.signature).toBe(anchor.signature);
    expect(state?.seasonStartSignature).toBe(start.signature);
  });
});

describe("the frozen rules are frozen against ordinary SQL", () => {
  /**
   * Migration 0019. These are the holes that needed no elevated privilege — any
   * bug in a route that writes to these tables reaches them, unlike TRUNCATE
   * which needs table ownership.
   *
   * Written as raw SQL on purpose. The point is what happens when the
   * application layer is *not* the thing standing in the way.
   */
  async function frozenLeague(client: PGliteClient, commissionerId: string) {
    return createLeague(client, NFL, { name: "L", commissionerId, rules: rules() });
  }

  it("refuses to rewrite the hash that is anchored on-chain", async () => {
    const { client, commissionerId } = await setup();
    const created = await frozenLeague(client, commissionerId);

    await expect(
      client.query("UPDATE leagues SET rules_hash = $1 WHERE id = $2", [
        "d".repeat(64),
        created.id,
      ]),
    ).rejects.toThrow(/frozen/);
  });

  it("still allows the other league columns to move", async () => {
    // The trigger guards one column, not the row — rules_uri and the chain
    // anchor both have to keep working.
    const { client, commissionerId } = await setup();
    const created = await frozenLeague(client, commissionerId);

    await setRulesUri(client, created.id, { uri: "ipfs://bafyfake", hash: created.rulesHash });
    await recordChainAnchor(client, created.id, { signature: "sig", cluster: "localnet" });

    expect((await getChainState(client, created.id))?.cluster).toBe("localnet");
  });

  it("refuses a scoring rule added after the freeze", async () => {
    // league_rules stays correct and still hashes — but the table the app
    // queries would say something the signed rules do not.
    const { client, commissionerId } = await setup();
    const created = await frozenLeague(client, commissionerId);

    const [row] = await client.query<{ stat_key_id: string }>(
      "SELECT stat_key_id FROM league_scoring_rules WHERE league_id = $1 LIMIT 1",
      [created.id],
    );

    await expect(
      client.query(
        `INSERT INTO league_scoring_rules (league_id, stat_key_id, kind, milli_points_per_unit)
         VALUES ($1, $2, 'LINEAR', 999000)`,
        [created.id, row!.stat_key_id],
      ),
    ).rejects.toThrow(/frozen/);
  });

  it("refuses a roster slot added after the freeze", async () => {
    const { client, commissionerId } = await setup();
    const created = await frozenLeague(client, commissionerId);

    const [row] = await client.query<{ slot_type_id: string }>(
      "SELECT slot_type_id FROM league_roster_slots WHERE league_id = $1 LIMIT 1",
      [created.id],
    );

    await expect(
      client.query(
        `INSERT INTO league_roster_slots (league_id, slot_type_id, count)
         VALUES ($1, $2, 10)`,
        [created.id, row!.slot_type_id],
      ),
    ).rejects.toThrow(/frozen/);
  });

  it("creating a league still works, which is the whole difficulty", async () => {
    // createLeague writes league_rules BEFORE the denormalised copies, in one
    // transaction — so "do rules exist" cannot be the test. If this regresses,
    // no league can be created at all.
    const { client, commissionerId } = await setup();
    const created = await frozenLeague(client, commissionerId);

    const [scoring] = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM league_scoring_rules WHERE league_id = $1",
      [created.id],
    );
    expect(Number(scoring?.count)).toBeGreaterThan(0);
  });

  it("refuses to truncate the tables that hold consent and draft order", async () => {
    const { client, commissionerId } = await setup();
    await frozenLeague(client, commissionerId);

    for (const table of ["leagues", "league_memberships", "teams", "drafts"]) {
      await expect(client.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/frozen/);
    }
  });
});

describe("verifyStoredRules hashes the stored bytes — #69 §1", () => {
  /*
    It used to hash `JSON.parse(canonical)` re-canonicalised, which normalises
    away exactly the corruption it exists to catch. Each case below round-trips
    through `JSON.parse` to an equal object, so the old check re-derived the
    original hash and reported success over bytes that were not the bytes.

    The sibling package always stated the rule and followed it — "Hash the
    retrieved bytes directly. Re-parsing and re-encoding would hide exactly the
    corruption this check exists to catch." This did the opposite, while
    `CLAUDE.md` claimed it did the same.

    **The corruption is inserted, not updated, and that is the reachable path.**
    `league_rules_immutable` refuses UPDATE and DELETE on this table, so a
    stored row cannot be rewritten. What is unguarded is the INSERT:
    `check_rules_hash_matches` compares the incoming hash against
    `leagues.rules_hash` and never looks at the bytes at all. So a row whose
    bytes are anything whatsoever is accepted under a correct hash — at ordinary
    application privilege, which is the threat `0019`'s header names.
  */

  const honest = encodeLeagueRules(rules());

  /**
   * A league whose stored bytes are not the bytes that were hashed.
   *
   * Built by hand rather than through `createLeague`, because that writes both
   * columns from one derivation and `league_rules_immutable` then refuses every
   * rewrite — so an honest league cannot be corrupted after the fact, and the
   * insert is the shape a second writer would actually produce.
   *
   * `canonical` goes into both columns, as `createLeague` does with the bytes
   * it hashed. A helper that wrote honest JSON to one and corrupt text to the
   * other would manufacture the divergence the duplicate-key case is there to
   * demonstrate.
   */
  const leagueWithBytes = async (
    client: PGliteClient,
    commissionerId: string,
    canonical: string,
  ): Promise<string> => {
    const ruleSet = rules();
    const hash = hashLeagueRules(ruleSet);

    const [sport] = await client.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
      NFL.key,
    ]);
    const [league] = await client.query<{ id: string }>(
      `INSERT INTO leagues (sport_id, season, name, visibility, commissioner_id, rules_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        sport!.id,
        ruleSet.seasonYear,
        "Handmade",
        ruleSet.league.visibility,
        commissionerId,
        hash,
      ],
    );

    // Accepted: the hash matches the league, and nothing checks the bytes.
    await client.query(
      `INSERT INTO league_rules (league_id, rule_json, canonical, hash)
       VALUES ($1, $2::jsonb, $3, $4)`,
      // Two parameters for one value, deliberately. Bound once and used twice,
      // Postgres infers a single type for the placeholder — jsonb, from the cast —
      // and the text column then stores jsonb's normalised rendering instead of the
      // bytes under test. That silently repairs the corruption before the check runs.
      [league!.id, canonical, canonical, hash],
    );

    return league!.id;
  };

  it("passes when the stored bytes are the bytes that were hashed", async () => {
    const { client, commissionerId } = await setup();
    const id = await leagueWithBytes(client, commissionerId, honest);

    expect(await verifyStoredRules(client, id)).toBe(true);
  });

  /*
    Every rewrite survives a parse, so every one used to pass. Pretty-printing
    and reordered keys are what a hand edit produces; the alternate escape and
    number spelling are what a different encoder produces.

    One case per test rather than a loop: a loop stops at the first failure, so
    a regression in the fourth rewrite would stay hidden behind the first three
    — and it would hold four migrated databases open at once, since `setup`
    reassigns the one handle `afterEach` closes.
  */
  it.each([
    ["pretty-printed", JSON.stringify(JSON.parse(honest), null, 2)],
    [
      "key order reversed",
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(honest)).reverse())),
    ],
    ["alternate escape", honest.replace('"seasonYear"', '"\\u0073easonYear"')],
    ["alternate number spelling", honest.replace(/"seasonYear":\d+/, '"seasonYear":2.026e3')],
  ])("catches bytes that parse to the same object: %s", async (_name, canonical) => {
    // A rewrite that did not change the bytes would prove nothing — and this
    // caught a dropped backslash in the escape case during review.
    expect(canonical).not.toBe(honest);
    expect(JSON.parse(canonical)).toEqual(JSON.parse(honest));

    const { client, commissionerId } = await setup();
    const id = await leagueWithBytes(client, commissionerId, canonical);

    expect(await verifyStoredRules(client, id)).toBe(false);
  });

  it("catches a duplicated key, where the two stored columns disagree", async () => {
    /*
      The worst of them, because the corruption does not stay in one column.
      `rule_json` is jsonb and normalises a duplicate key away; `canonical` is
      text and keeps both. So one insert of one string leaves the column that is
      queried and the column that is hashed holding different documents — and
      the old check, which read the parsed object, saw only the tidy one.
    */
    const doubled = honest.replace(/^{/, '{"seasonYear":2026,');
    expect(doubled).not.toBe(honest);

    const { client, commissionerId } = await setup();
    const id = await leagueWithBytes(client, commissionerId, doubled);

    // The divergence is Postgres's doing, not the fixture's: both columns were
    // bound from the same parameter.
    const [row] = await client.query<{ from_json: string; from_text: string }>(
      "SELECT rule_json::text AS from_json, canonical AS from_text FROM league_rules WHERE league_id = $1",
      [id],
    );
    const seasonYears = (s: string) => s.split('"seasonYear"').length - 1;
    expect(seasonYears(row!.from_text)).toBe(2);
    expect(seasonYears(row!.from_json)).toBe(1);

    expect(await verifyStoredRules(client, id)).toBe(false);
  });

  /*
    The worst corruption class, and the one that used to crash rather than
    answer. `verifyStoredRules` went through `getLeagueRules`, which ends in
    `JSON.parse(row.canonical)` — so bytes that are not JSON at all threw a
    `SyntaxError` out of a function declared to return a boolean. A caller
    asking "are these rules intact?" got an exception instead of "no".

    These need the two columns bound separately, unlike every case above:
    `rule_json` is jsonb and simply cannot hold text that does not parse, so
    this is the one shape where a writer must fill the columns from different
    values. That is not a contrivance — it is what makes the case reachable at
    all, and `0004` checks neither column against the hash.
  */
  it.each([
    ["empty", ""],
    ["not JSON at all", "corrupted"],
    ["truncated mid-document", honest.slice(0, honest.length - 1)],
    ["trailing junk after a valid document", honest + "xx"],
  ])("answers false for bytes that do not parse: %s", async (_name, canonical) => {
    expect(() => JSON.parse(canonical)).toThrow();

    const { client, commissionerId } = await setup();
    const ruleSet = rules();
    const hash = hashLeagueRules(ruleSet);
    const [sport] = await client.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
      NFL.key,
    ]);
    const [league] = await client.query<{ id: string }>(
      `INSERT INTO leagues (sport_id, season, name, visibility, commissioner_id, rules_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        sport!.id,
        ruleSet.seasonYear,
        "Unparseable",
        ruleSet.league.visibility,
        commissionerId,
        hash,
      ],
    );
    await client.query(
      `INSERT INTO league_rules (league_id, rule_json, canonical, hash)
       VALUES ($1, $2::jsonb, $3, $4)`,
      [league!.id, honest, canonical, hash],
    );

    // False, not a thrown SyntaxError.
    await expect(verifyStoredRules(client, league!.id)).resolves.toBe(false);
  });

  it("answers false for a league that has no stored rules", async () => {
    // Reads the columns directly now, so the missing-row case is its own branch
    // rather than something `getLeagueRules` handled on the way past.
    const { client } = await setup();

    await expect(
      verifyStoredRules(client, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBe(false);
  });
});

describe("the rules URI is written once — #69 §3, §4", () => {
  /*
    `rules_hash` is the guarantee and `0004` already protects it. `rules_uri` is
    the address a member actually fetches in order to *read* the rules, and it
    was a plain nullable column any UPDATE could move anywhere.

    Repointing it leaves `rules_hash` untouched, so `verifyStoredRules`, the
    trigger in `0004` and the on-chain anchor all still agree and nothing in the
    system notices. A member who hashes what they fetched is safe; the defect is
    that it makes the careless path and the careful path disagree in silence.
  */

  const pinned = async (client: PGliteClient, commissionerId: string) => {
    const league = await createLeague(client, NFL, {
      name: "Pinned",
      commissionerId,
      rules: rules(),
    });
    const uri = "ipfs://bafyhonest";
    expect(await setRulesUri(client, league.id, { uri, hash: league.rulesHash })).toBe(true);
    return { league, uri };
  };

  const storedUri = async (client: PGliteClient, leagueId: string) => {
    const [row] = await client.query<{ rules_uri: string | null }>(
      "SELECT rules_uri FROM leagues WHERE id = $1",
      [leagueId],
    );
    return row!.rules_uri;
  };

  it("records the pin when the hash is the league's own", async () => {
    const { client, commissionerId } = await setup();
    const { league, uri } = await pinned(client, commissionerId);

    expect(await storedUri(client, league.id)).toBe(uri);
  });

  it("refuses a document that hashes to something else", async () => {
    /*
      The mixup this swap exists for: pin document A, attach it to a league whose
      rules are B. It would look right — the URI resolves, the document is a
      valid rule set, `rules_hash` is untouched — and only a member who fetched
      and hashed it would ever find out.
    */
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "Mine",
      commissionerId,
      rules: rules(),
    });
    const somebodyElses = hashLeagueRules(rules({ seasonYear: 2027 }));
    expect(somebodyElses).not.toBe(league.rulesHash);

    expect(
      await setRulesUri(client, league.id, { uri: "ipfs://bafyother", hash: somebodyElses }),
    ).toBe(false);
    expect(await storedUri(client, league.id)).toBeNull();
  });

  it("refuses a league that does not exist", async () => {
    const { client } = await setup();

    expect(
      await setRulesUri(client, "00000000-0000-0000-0000-000000000000", {
        uri: "ipfs://bafyghost",
        hash: "0".repeat(64),
      }),
    ).toBe(false);
  });

  it("treats a genuine retry as a no-op success", async () => {
    // Re-pinning is content-addressed, so the same rules give back the same URI.
    // A retry after a lost response must not read as a refusal.
    const { client, commissionerId } = await setup();
    const { league, uri } = await pinned(client, commissionerId);

    expect(await setRulesUri(client, league.id, { uri, hash: league.rulesHash })).toBe(true);
    expect(await storedUri(client, league.id)).toBe(uri);
  });

  it("refuses to repoint a league that is already pinned", async () => {
    const { client, commissionerId } = await setup();
    const { league, uri } = await pinned(client, commissionerId);

    expect(
      await setRulesUri(client, league.id, {
        uri: "ipfs://bafyswapped",
        hash: league.rulesHash,
      }),
    ).toBe(false);
    expect(await storedUri(client, league.id)).toBe(uri);
  });

  it("refuses a repoint at the database, past the function entirely", async () => {
    // 0044. The predicate in setRulesUri never lets this reach the trigger, so
    // the trigger is only reachable by a writer that went around the function —
    // which is the writer it exists for.
    const { client, commissionerId } = await setup();
    const { league, uri } = await pinned(client, commissionerId);

    await expect(
      client.query("UPDATE leagues SET rules_uri = $2 WHERE id = $1", [
        league.id,
        "ipfs://bafyswapped",
      ]),
    ).rejects.toThrow(/cannot be repointed/);
    expect(await storedUri(client, league.id)).toBe(uri);
  });

  it("refuses to clear it back to null, which is the same rewrite in two steps", async () => {
    const { client, commissionerId } = await setup();
    const { league, uri } = await pinned(client, commissionerId);

    await expect(
      client.query("UPDATE leagues SET rules_uri = NULL WHERE id = $1", [league.id]),
    ).rejects.toThrow(/cannot be repointed/);
    expect(await storedUri(client, league.id)).toBe(uri);
  });

  /*
    The headline scenario, and it was the one case the block did not cover —
    which is exactly why the docstring claimed something untrue about it.
    Every other test here operates on a single league.
  */
  it("refuses another league's pin when that league's rules differ", async () => {
    const { client, commissionerId } = await setup();
    const mine = await createLeague(client, NFL, {
      name: "Mine",
      commissionerId,
      rules: rules(),
    });
    const theirs = await createLeague(client, NFL, {
      name: "Theirs",
      commissionerId,
      rules: rules({ seasonYear: 2027 }),
    });
    expect(theirs.rulesHash).not.toBe(mine.rulesHash);

    // Their document, my league. Nothing matches, nothing is written.
    expect(
      await setRulesUri(client, mine.id, {
        uri: "ipfs://bafytheirs",
        hash: theirs.rulesHash,
      }),
    ).toBe(false);
    expect(await storedUri(client, mine.id)).toBeNull();
  });

  it("writes when two leagues share a rule set, because the URI is the same one", async () => {
    /*
      The swap guards the document, not the league, and those come apart:
      `hashLeagueRules` is a pure function of the rule set, so two leagues from
      one template hash identically and each accepts the other's pin.

      That is safe for a reason the predicate does not supply. Identical hashes
      mean identical canonical bytes, and a CID is a function of the bytes — so
      the URI being attached is byte-for-byte the one this league should have
      had. Asserting it rather than describing it, because the whole set-once
      rule in 0044 rests on this property.
    */
    const { client, commissionerId } = await setup();
    const one = await createLeague(client, NFL, {
      name: "One",
      commissionerId,
      rules: rules(),
    });
    const two = await createLeague(client, NFL, {
      name: "Two",
      commissionerId,
      rules: rules(),
    });

    expect(one.id).not.toBe(two.id);
    expect(two.rulesHash).toBe(one.rulesHash);
    // The reason it is safe: same rules, same bytes, therefore same address.
    expect(two.canonical).toBe(one.canonical);

    const uri = "ipfs://bafyshared";
    expect(await setRulesUri(client, one.id, { uri, hash: two.rulesHash })).toBe(true);
    expect(await storedUri(client, one.id)).toBe(uri);
  });
  it("accepts an uppercase hash, like every other hash check in the repo", async () => {
    // `0004` constrains the column to lowercase hex and `hashLeagueRules` emits
    // it, so this can only arrive from a caller that upcased on the way through —
    // and refusing a correct document over letter case would be silent and
    // baffling. `verifyLeagueRulesHash` and `verifyPinnedRules` both normalise.
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "Shouty",
      commissionerId,
      rules: rules(),
    });

    expect(
      await setRulesUri(client, league.id, {
        uri: "ipfs://bafyhonest",
        hash: league.rulesHash.toUpperCase(),
      }),
    ).toBe(true);
    expect(await storedUri(client, league.id)).toBe("ipfs://bafyhonest");
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["a bare CID with no scheme", "QmdSc49tdSSLFADyr79TiVBZ2Tvah8sg54kmyTuqVViAN6"],
    ["a scheme with nothing after it", "ipfs://"],
  ])("throws rather than writing a URI that is not one: %s", async (_name, uri) => {
    /*
      The one unrecoverable argument. A wrong hash costs a retry; a malformed
      URI is accepted and then frozen by 0044, so the column is bricked for the
      life of the league. It throws rather than answering false because a
      caller handing over a non-URI has a bug, not a refused state.
    */
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "Malformed",
      commissionerId,
      rules: rules(),
    });

    await expect(
      setRulesUri(client, league.id, { uri, hash: league.rulesHash }),
    ).rejects.toThrow(/Not a pinning URI/);
    expect(await storedUri(client, league.id)).toBeNull();
  });

  it("accepts the schemes the pinning services actually return", async () => {
    // Pinata gives `ipfs://<cid>`; the in-memory service gives `memory://<hex>`.
    // A check pinned to `ipfs://` alone would refuse every test double.
    for (const uri of ["ipfs://bafyreal", "memory://0123abcd"]) {
      const { client, commissionerId } = await setup();
      const league = await createLeague(client, NFL, {
        name: "Schemes",
        commissionerId,
        rules: rules(),
      });

      expect(await setRulesUri(client, league.id, { uri, hash: league.rulesHash }), uri).toBe(
        true,
      );
    }
  });
  it("leaves an unpinned league writable, and the other columns alone", async () => {
    // The trigger guards one column in one direction. A league that has not been
    // pinned is the ordinary state, and the chain anchor has to keep working.
    const { client, commissionerId } = await setup();
    const league = await createLeague(client, NFL, {
      name: "Unpinned",
      commissionerId,
      rules: rules(),
    });

    await client.query("UPDATE leagues SET name = $2 WHERE id = $1", [league.id, "Renamed"]);
    await recordChainAnchor(client, league.id, { signature: "sig", cluster: "localnet" });

    expect((await getChainState(client, league.id))?.cluster).toBe("localnet");
    expect(await storedUri(client, league.id)).toBeNull();
  });
});
