import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, hashLeagueRules, NFL, NFL_DEFAULT_PAYOUT } from "@rostr/core";
import type { DraftRules, LeagueRules, PotRules } from "@rostr/core";
import {
  createLeague,
  getLeagueRules,
  LeagueValidationError,
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
