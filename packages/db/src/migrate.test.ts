import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrate, MigrationError } from "./migrate.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function fresh(): Promise<PGliteClient> {
  db = await createTestDatabase();
  return db;
}

describe("loadMigrations", () => {
  it("finds the migration set and orders it by version", () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);

    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("checksums every file", () => {
    for (const m of loadMigrations()) {
      expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("migrate", () => {
  it("applies every migration to an empty database", async () => {
    const client = await fresh();
    const rows = await client.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM schema_migrations",
    );
    expect(Number(rows[0]?.count)).toBe(loadMigrations().length);
  });

  it("is idempotent", async () => {
    const client = await fresh();
    const second = await migrate(client);

    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(loadMigrations().length);
  });

  it("refuses to run if an applied migration has been edited", async () => {
    const client = await fresh();

    const tampered = loadMigrations().map((m, i) =>
      i === 0 ? { ...m, checksum: "0".repeat(64) } : m,
    );

    await expect(migrate(client, tampered)).rejects.toThrow(MigrationError);
    await expect(migrate(client, tampered)).rejects.toThrow(/forward-only/);
  });

  it("refuses a migration older than the latest applied version", async () => {
    // Forward-only: two branches can number migrations independently, and if the
    // higher one deploys first, applying the lower one afterwards would build the
    // schema in an order it was never tested in.
    const client = await fresh();
    const mig = (version: number, name: string) => ({
      version,
      name,
      filename: `${String(version).padStart(4, "0")}_${name}.sql`,
      sql: `CREATE TABLE t_${name} (id int);`,
      checksum: String(version).padEnd(64, "0"),
    });

    await migrate(client, [mig(9999, "later")]);

    await expect(migrate(client, [mig(9998, "earlier")])).rejects.toThrow(MigrationError);
    await expect(migrate(client, [mig(9998, "earlier")])).rejects.toThrow(
      /forward-only|older/i,
    );
  });

  it("rolls back a failing migration rather than half-applying it", async () => {
    const client = await fresh();

    const broken = [
      {
        version: 9999,
        name: "broken",
        filename: "9999_broken.sql",
        sql: "CREATE TABLE ok_so_far (id int); CREATE TABLE nope (id nonexistent_type);",
        checksum: "f".repeat(64),
      },
    ];

    await expect(migrate(client, broken)).rejects.toThrow(MigrationError);

    const rows = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('ok_so_far') IS NOT NULL AS exists",
    );
    expect(rows[0]?.exists).toBe(false);
  });
});

describe("schema", () => {
  const expectedTables = [
    "sports",
    "stat_keys",
    "positions",
    "slot_types",
    "slot_type_positions",
    "users",
    "wallets",
    "auth_events",
    "players",
    "player_eligible_positions",
    "player_seasons",
    "stat_lines",
    "games",
    "leagues",
    "league_rules",
    "league_scoring_rules",
    "league_roster_slots",
    "teams",
    "league_memberships",
    "roster_entries",
    "lineups",
    "matchups",
    "trades",
    "trade_assets",
    "trade_vetoes",
    "waiver_claims",
    "waiver_wire",
  ];

  it("creates every expected table", async () => {
    const client = await fresh();
    const rows = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const present = new Set(rows.map((r) => r.table_name));

    for (const table of expectedTables) {
      expect(present, `missing table: ${table}`).toContain(table);
    }
  });

  it("names no column after a football concept", async () => {
    // The multi-sport guarantee, enforced rather than promised. If this fails,
    // the abstraction has leaked into structure.
    const client = await fresh();
    const rows = await client.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
    );

    const banned = /(passing|rushing|receiving|touchdown|quarterback|fumble|yard|kicker|punt)/i;
    const offenders = rows
      .filter((r) => banned.test(r.column_name))
      .map((r) => `${r.table_name}.${r.column_name}`);

    expect(offenders).toEqual([]);
  });
});

describe("league_rules immutability", () => {
  async function seedLeague(client: PGliteClient, hash: string): Promise<string> {
    const [sport] = await client.query<{ id: string }>(
      "INSERT INTO sports (key, display_name, season_weeks) VALUES ('nfl', 'NFL', 18) RETURNING id",
    );
    const [user] = await client.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('a@b.com', 'A') RETURNING id",
    );
    const [league] = await client.query<{ id: string }>(
      `INSERT INTO leagues (sport_id, season, name, visibility, commissioner_id, rules_hash)
       VALUES ($1, 2026, 'Test', 'PRIVATE', $2, $3) RETURNING id`,
      [sport!.id, user!.id, hash],
    );
    return league!.id;
  }

  const HASH = "5afc934db3b3e1b1f5ec7a9e503f61e531aa925a6f966c41ec227118201da36a";

  it("accepts the initial insert", async () => {
    const client = await fresh();
    const leagueId = await seedLeague(client, HASH);

    await client.query(
      "INSERT INTO league_rules (league_id, rule_json, canonical, hash) VALUES ($1, $2, $3, $4)",
      [leagueId, JSON.stringify({ a: 1 }), '{"a":1}', HASH],
    );

    const rows = await client.query("SELECT * FROM league_rules WHERE league_id = $1", [
      leagueId,
    ]);
    expect(rows.length).toBe(1);
  });

  it("rejects UPDATE at the database level", async () => {
    const client = await fresh();
    const leagueId = await seedLeague(client, HASH);
    await client.query(
      "INSERT INTO league_rules (league_id, rule_json, canonical, hash) VALUES ($1, $2, $3, $4)",
      [leagueId, JSON.stringify({ a: 1 }), '{"a":1}', HASH],
    );

    // Application-layer immutability is a promise. This is the guarantee.
    await expect(
      client.query("UPDATE league_rules SET canonical = '{}' WHERE league_id = $1", [leagueId]),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects DELETE at the database level", async () => {
    const client = await fresh();
    const leagueId = await seedLeague(client, HASH);
    await client.query(
      "INSERT INTO league_rules (league_id, rule_json, canonical, hash) VALUES ($1, $2, $3, $4)",
      [leagueId, JSON.stringify({ a: 1 }), '{"a":1}', HASH],
    );

    await expect(
      client.query("DELETE FROM league_rules WHERE league_id = $1", [leagueId]),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects TRUNCATE at the database level", async () => {
    // Row-level BEFORE UPDATE/DELETE triggers do not fire on TRUNCATE, so without
    // a statement-level guard the app's own role could wipe the immutable rules
    // while the on-chain hash still pointed at them.
    const client = await fresh();
    const leagueId = await seedLeague(client, HASH);
    await client.query(
      "INSERT INTO league_rules (league_id, rule_json, canonical, hash) VALUES ($1, $2, $3, $4)",
      [leagueId, JSON.stringify({ a: 1 }), '{"a":1}', HASH],
    );

    await expect(client.query("TRUNCATE league_rules")).rejects.toThrow(/immutable/i);
  });

  it("rejects a rule set whose hash disagrees with its league", async () => {
    const client = await fresh();
    const leagueId = await seedLeague(client, HASH);

    await expect(
      client.query(
        "INSERT INTO league_rules (league_id, rule_json, canonical, hash) VALUES ($1, $2, $3, $4)",
        [leagueId, JSON.stringify({ a: 1 }), '{"a":1}', "b".repeat(64)],
      ),
    ).rejects.toThrow(/hash mismatch/i);
  });

  it("rejects a malformed hash", async () => {
    const client = await fresh();
    const [sport] = await client.query<{ id: string }>(
      "INSERT INTO sports (key, display_name, season_weeks) VALUES ('nfl', 'NFL', 18) RETURNING id",
    );
    const [user] = await client.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('a@b.com', 'A') RETURNING id",
    );

    await expect(
      client.query(
        `INSERT INTO leagues (sport_id, season, name, visibility, commissioner_id, rules_hash)
         VALUES ($1, 2026, 'Test', 'PRIVATE', $2, 'NOT-A-HASH')`,
        [sport!.id, user!.id],
      ),
    ).rejects.toThrow();
  });
});

describe("constraints", () => {
  it("requires a bot to have no owner and a human team to have one", async () => {
    const client = await fresh();
    const [sport] = await client.query<{ id: string }>(
      "INSERT INTO sports (key, display_name, season_weeks) VALUES ('nfl', 'NFL', 18) RETURNING id",
    );
    const [user] = await client.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('a@b.com', 'A') RETURNING id",
    );
    const [league] = await client.query<{ id: string }>(
      `INSERT INTO leagues (sport_id, season, name, visibility, commissioner_id, rules_hash)
       VALUES ($1, 2026, 'T', 'PRIVATE', $2, $3) RETURNING id`,
      [sport!.id, user!.id, "a".repeat(64)],
    );

    // A bot with an owner is incoherent.
    await expect(
      client.query(
        "INSERT INTO teams (league_id, owner_id, is_bot, name, slot) VALUES ($1, $2, true, 'Bot', 1)",
        [league!.id, user!.id],
      ),
    ).rejects.toThrow();

    // So is a human team without one.
    await expect(
      client.query(
        "INSERT INTO teams (league_id, is_bot, name, slot) VALUES ($1, false, 'X', 2)",
        [league!.id],
      ),
    ).rejects.toThrow();

    // Both valid forms are accepted.
    await client.query(
      "INSERT INTO teams (league_id, owner_id, is_bot, name, slot) VALUES ($1, $2, false, 'Human', 1)",
      [league!.id, user!.id],
    );
    await client.query(
      "INSERT INTO teams (league_id, is_bot, name, slot) VALUES ($1, true, 'Bot', 2)",
      [league!.id],
    );

    const teams = await client.query("SELECT * FROM teams WHERE league_id = $1", [league!.id]);
    expect(teams.length).toBe(2);
  });

  it("enforces case-insensitive email uniqueness", async () => {
    const client = await fresh();
    await client.query("INSERT INTO users (email, display_name) VALUES ('A@B.com', 'A')");
    await expect(
      client.query("INSERT INTO users (email, display_name) VALUES ('a@b.COM', 'B')"),
    ).rejects.toThrow();
  });

  it("allows only one primary wallet per user", async () => {
    const client = await fresh();
    const [user] = await client.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('a@b.com', 'A') RETURNING id",
    );

    await client.query(
      "INSERT INTO wallets (user_id, address, is_primary) VALUES ($1, 'addr1', true)",
      [user!.id],
    );
    await expect(
      client.query(
        "INSERT INTO wallets (user_id, address, is_primary) VALUES ($1, 'addr2', true)",
        [user!.id],
      ),
    ).rejects.toThrow();

    // Non-primary wallets are unlimited.
    await client.query(
      "INSERT INTO wallets (user_id, address, is_primary) VALUES ($1, 'addr3', false)",
      [user!.id],
    );
  });

  it("rejects a scoring rule that is both linear and tiered", async () => {
    const client = await fresh();
    const [sport] = await client.query<{ id: string }>(
      "INSERT INTO sports (key, display_name, season_weeks) VALUES ('nfl', 'NFL', 18) RETURNING id",
    );
    const [statKey] = await client.query<{ id: string }>(
      "INSERT INTO stat_keys (sport_id, key, display_name, kind) VALUES ($1, 'rec', 'Receptions', 'LINEAR') RETURNING id",
      [sport!.id],
    );
    const [user] = await client.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('a@b.com', 'A') RETURNING id",
    );
    const [league] = await client.query<{ id: string }>(
      `INSERT INTO leagues (sport_id, season, name, visibility, commissioner_id, rules_hash)
       VALUES ($1, 2026, 'T', 'PRIVATE', $2, $3) RETURNING id`,
      [sport!.id, user!.id, "a".repeat(64)],
    );

    await expect(
      client.query(
        `INSERT INTO league_scoring_rules (league_id, stat_key_id, kind, milli_points_per_unit, tiers)
         VALUES ($1, $2, 'LINEAR', 1000, '[]'::jsonb)`,
        [league!.id, statKey!.id],
      ),
    ).rejects.toThrow();

    // The well-formed linear version is accepted.
    await client.query(
      `INSERT INTO league_scoring_rules (league_id, stat_key_id, kind, milli_points_per_unit)
       VALUES ($1, $2, 'LINEAR', 1000)`,
      [league!.id, statKey!.id],
    );
  });
});
