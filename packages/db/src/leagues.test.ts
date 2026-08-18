import { afterEach, describe, expect, it } from "vitest";
import {
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

    await setRulesUri(client, league.id, "ipfs://bafyfake");

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

    await setRulesUri(client, created.id, "ipfs://bafyfake");
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
