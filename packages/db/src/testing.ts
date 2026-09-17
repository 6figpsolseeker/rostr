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

/**
 * A client that records every statement it is asked to run, **and which
 * connection ran it**, then runs it.
 *
 * ## What this is for, and what it is not
 *
 * PGlite is one connection, so nothing in this repo can produce two overlapping
 * transactions — a lock never blocks, and any test claiming to demonstrate
 * serialisation is theatre. What *can* be established is that the production
 * code path emits the statement at all, on the transaction's own handle, before
 * the reads it has to dominate.
 *
 * ## Why the connection is recorded and not just the SQL
 *
 * There are two spellings of the same production bug and only one of them is
 * visible in a list of statements.
 *
 * The first is textual: hoist the call above `withTransaction` and the lock runs
 * in its own autocommit transaction, released before the next line. A position
 * assertion catches that.
 *
 * The second is not. `withTransaction` only checks out a dedicated connection
 * when the client has `connect`; `PGliteClient` does not define one, so in every
 * test in this repo the transaction handle **is** the outer client. Pass `db`
 * where `tx` was meant — two characters, and `db` is in scope at all three call
 * sites — and the statement still appears in the log, in the right place, while
 * in production it lands on an arbitrary pooled connection and its lock is gone
 * before the next statement runs. `waivers.ts` records that this has already
 * shipped here once: *"Inside the transaction, not before it. Read on `db` and
 * written on `tx`…"*.
 *
 * So this supplies a `connect` that PGlite lacks, handing back a distinctly
 * tagged wrapper over the same database. The transaction then runs on a handle a
 * test can tell apart from the outer one, which is the property
 * `migrate.pool.test.ts` drives a real `pg-pool` to establish. Everything still
 * executes against the one PGlite connection underneath — this buys identity,
 * not isolation, and no test here should claim otherwise.
 *
 * Positions are recorded for `exec` as well as `query` because `BEGIN` and
 * `COMMIT` go through `exec`, and "inside the transaction" is an assertion about
 * where a statement sits between those two.
 */
export function recordStatements(inner: SqlClient): {
  client: SqlClient;
  statements: string[];
  params: (readonly unknown[] | undefined)[];
  /** Which handle ran each statement. `"outer"` is the un-checked-out client. */
  connections: string[];
} {
  const statements: string[] = [];
  const params: (readonly unknown[] | undefined)[] = [];
  const connections: string[] = [];
  let checkouts = 0;

  const wrap = (target: SqlClient, conn: string): SqlClient => ({
    async exec(sql: string): Promise<void> {
      statements.push(sql);
      params.push(undefined);
      connections.push(conn);
      return target.exec(sql);
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<T[]> {
      statements.push(sql);
      params.push(values);
      connections.push(conn);
      return target.query<T>(sql, values);
    },
    /*
      Always supplied, even when the inner client has none. That is the point:
      it makes `withTransaction` take the checked-out branch under PGlite, so
      `tx` is a different object from `db` here exactly as it is in production,
      and a test can tell which one a statement went to.
    */
    connect: async (): Promise<{ client: SqlClient; release: () => void }> => {
      const id = `tx#${++checkouts}`;
      if (!target.connect) return { client: wrap(target, id), release: () => {} };
      const checked = await target.connect();
      return { client: wrap(checked.client, id), release: checked.release };
    },
  });

  return { client: wrap(inner, "outer"), statements, params, connections };
}
