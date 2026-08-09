/**
 * PGlite adapter for tests.
 *
 * PGlite is real Postgres compiled to WASM, running in-process. No service, no
 * Docker, no connection string — so migrations and constraints are genuinely
 * exercised rather than mocked, and CI needs no service containers.
 *
 * Test-only. Production uses node-postgres against Supabase.
 */

import { PGlite } from "@electric-sql/pglite";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import type { SqlClient } from "./client.js";
import { migrate } from "./migrate.js";

export class PGliteClient implements SqlClient {
  constructor(private readonly db: PGlite) {}

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.db.query<T>(sql, params as unknown[]);
    return result.rows;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** A fresh in-memory database with every migration applied. */
export async function createTestDatabase(): Promise<PGliteClient> {
  const client = new PGliteClient(new PGlite());
  await migrate(client);
  return client;
}

/** A wallet that can sign, derived from a seed so tests are reproducible. */
export interface TestWallet {
  /** Base58, as it is stored and as `joinLeague` expects it. */
  readonly address: string;
  /** Base58 signature over the message, as `verifyJoinSignature` expects it. */
  sign(message: string): string;
}

/**
 * A signing wallet for tests.
 *
 * The curve library and base58 are dependencies of *this* package, so a test
 * living outside it — the program suite, which runs from `programs/` — cannot
 * import them. Putting the two lines here means such a test can still perform a
 * real join rather than reaching past the signature check into the tables.
 *
 * Seeded rather than random: a failing signature test should fail the same way
 * twice.
 */
export function testWallet(seed: number): TestWallet {
  const secret = new Uint8Array(32).fill(seed);
  return {
    address: bs58.encode(ed25519.getPublicKey(secret)),
    sign: (message) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret)),
  };
}

/**
 * A human-owned team, without the join ceremony.
 *
 * Most tests need a league full of teams so they can draft, score or trade —
 * not to exercise consent. Going through `joinLeague` would mean a keypair, a
 * wallet link and a signature per team, which is noise in a test about lineups.
 *
 * **Use this rather than `addBot`.** A bot is capped at one per league and
 * barred from pot leagues entirely, so a fixture built out of bots is a fixture
 * describing a league that cannot exist. This produces the same rows a real join
 * produces — a team with an owner — minus only the signature.
 */
export async function addTestTeam(
  db: SqlClient,
  leagueId: string,
  name: string,
): Promise<{ teamId: string; userId: string; slot: number }> {
  const [user] = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2) RETURNING id`,
    [`${name.toLowerCase().replace(/\W+/g, "-")}-${leagueId.slice(0, 8)}@example.test`, name],
  );

  const [team] = await db.query<{ id: string; slot: number }>(
    `INSERT INTO teams (league_id, owner_id, is_bot, name, slot)
     VALUES ($1, $2, false, $3,
             COALESCE((SELECT max(slot) FROM teams WHERE league_id = $1), 0) + 1)
     RETURNING id, slot`,
    [leagueId, user!.id, name],
  );

  return { teamId: team!.id, userId: user!.id, slot: Number(team!.slot) };
}
