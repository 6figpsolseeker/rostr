/**
 * Migration dispatch — which connection does each statement land on?
 *
 * This is the one property about the runner that PGlite cannot show. PGlite is a
 * single connection, so every statement shares a session no matter what the
 * runner does; the question only exists in front of a pool, and there is no real
 * Postgres in this suite.
 *
 * So this drives the **real** `pg-pool` — the code that actually makes the
 * dispatch decision — with a stub `Client`, which `pg` supports through
 * `options.Client`. The stub runs no SQL. It records which connection object
 * received each statement and answers the one query the runner reads back
 * (`pg_try_advisory_lock`). Nothing about connection assignment is stubbed, so a
 * runner that went back to dispatching per statement would fail these.
 *
 * What this still cannot cover, and a real Postgres would: that the DDL and the
 * `schema_migrations` row actually commit or roll back together, that
 * `SET LOCAL statement_timeout = 0` really lets a slow `CREATE INDEX` finish, and
 * that two processes racing for the advisory lock resolve the way one process
 * asking twice does.
 */

import { EventEmitter } from "node:events";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, MigrationError } from "./migrate.js";
import type { Migration } from "./migrate.js";
import { PostgresClient } from "./postgres.js";

interface Statement {
  readonly conn: string;
  readonly sql: string;
}

interface Scenario {
  /** A statement containing any of these fragments fails, as a SQL error would. */
  failOn: readonly string[];
  /** What `pg_try_advisory_lock` answers. */
  lockGranted: boolean;
  /** Called after each statement is recorded, so a test can create pool traffic. */
  onStatement?: (sql: string) => void;
}

let log: Statement[] = [];
let scenario: Scenario = { failOn: [], lockGranted: true };
let connCounter = 0;

/**
 * The narrowest stand-in for `pg.Client` that pg-pool will drive.
 *
 * `_queryable` / `_ending` / `isConnected` are read by pg-pool when it decides
 * whether a released connection goes back to the idle set or is destroyed
 * (`pg-pool/index.js:392`), so they are part of the contract rather than padding.
 */
class StubClient extends EventEmitter {
  readonly connId = `conn#${++connCounter}`;
  _queryable = true;
  _ending = false;
  connection: undefined;

  isConnected(): boolean {
    return true;
  }
  ref(): void {}
  unref(): void {}

  connect(cb: (err: Error | null) => void): void {
    setImmediate(() => {
      cb(null);
    });
  }

  query(
    text: string,
    values?: unknown[] | ((err: Error | null, res?: { rows: unknown[] }) => void),
    cb?: (err: Error | null, res?: { rows: unknown[] }) => void,
  ): Promise<{ rows: unknown[] }> | undefined {
    const callback = typeof values === "function" ? values : cb;
    const sql = String(text).replace(/\s+/g, " ").trim();
    log.push({ conn: this.connId, sql });

    const failed = scenario.failOn.some((fragment) => sql.includes(fragment));
    const rows = sql.includes("pg_try_advisory_lock") ? [{ locked: scenario.lockGranted }] : [];

    scenario.onStatement?.(sql);

    if (callback) {
      setImmediate(() => {
        // A SQL error, as node-postgres surfaces one: the connection itself is
        // still usable, which is why `_queryable` stays true.
        callback(failed ? new Error(`stub failure: ${sql}`) : null, { rows });
      });
      return undefined;
    }
    return failed
      ? Promise.reject(new Error(`stub failure: ${sql}`))
      : Promise.resolve({ rows });
  }

  end(cb?: () => void): Promise<void> {
    this._ending = true;
    if (cb) setImmediate(cb);
    return Promise.resolve();
  }
}

let pool: Pool | undefined;

function stubbedClient(max = 10): { client: PostgresClient; pool: Pool } {
  // `Client` is typed `new () => ClientBase`, and neither the constructor
  // signature pg-pool actually uses nor the full `ClientBase` surface is worth
  // satisfying for a stub that answers three statements.
  const created = new Pool({
    Client: StubClient as unknown as PoolConfig["Client"],
    max,
  });
  pool = created;
  return { client: new PostgresClient(created), pool: created };
}

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  log = [];
  scenario = { failOn: [], lockGranted: true };
  connCounter = 0;
});

function mig(version: number, sql: string): Migration {
  return {
    version,
    name: `m${version}`,
    filename: `${String(version).padStart(4, "0")}_m${version}.sql`,
    sql,
    checksum: String(version).padEnd(64, "0"),
  };
}

/** Which connections received a statement containing `fragment`. */
function connsFor(fragment: string): string[] {
  return [...new Set(log.filter((s) => s.sql.includes(fragment)).map((s) => s.conn))];
}

const sqlLog = (): string[] => log.map((s) => s.sql);

describe("migrate on a pool", () => {
  it("runs the whole migration set on one connection", async () => {
    // Necessary but not sufficient, and worth saying so: on an otherwise idle
    // pool pg-pool hands back the connection just released, so this held before
    // the fix too — by luck, not by construction. The next test removes the luck.
    const { client } = stubbedClient();

    await migrate(client, [
      mig(9001, "CREATE TABLE a (id int)"),
      mig(9002, "CREATE TABLE b (id int)"),
    ]);

    expect(log.length).toBeGreaterThan(0);
    expect([...new Set(log.map((s) => s.conn))]).toHaveLength(1);
  });

  it("lets no other query into the middle of a migration's transaction", async () => {
    // The property, stated the way it actually bites. Dispatching per statement
    // does not merely risk splitting the transaction across connections — it
    // leaves a connection sitting in the idle pool with an **open transaction on
    // it**, so the next unrelated query served by that connection runs inside
    // the migration's transaction and is rolled back with it.
    //
    // `max: 1` makes the ordering deterministic rather than a race: a competing
    // query issued while the migration is mid-transaction either slots between
    // the runner's statements (per-statement dispatch) or waits for the run to
    // release its connection (a held checkout). No timing tolerance either way.
    const { client, pool: created } = stubbedClient(1);
    const competing: Promise<unknown>[] = [];

    scenario = {
      ...scenario,
      onStatement: (sql) => {
        if (sql === "BEGIN") competing.push(created.query("SELECT competing"));
      },
    };

    await migrate(client, [mig(9001, "CREATE TABLE a (id int)")]);
    await Promise.all(competing);

    const order = sqlLog();
    const commit = order.indexOf("COMMIT");
    const intruder = order.indexOf("SELECT competing");

    expect(commit).toBeGreaterThanOrEqual(0);
    expect(intruder).toBeGreaterThan(commit);
  });

  it("rolls a failing migration back on the connection that opened it", async () => {
    // The regression this fix exists for. Before it, every statement went
    // through `pool.query`, which destroys a connection whose query errored — so
    // the ROLLBACK was issued on a brand-new connection with no transaction on
    // it, and only pg-pool's destruction of the erroring connection aborted the
    // real one.
    const { client } = stubbedClient();
    scenario = { ...scenario, failOn: ["CREATE TABLE nope"] };

    await expect(
      migrate(client, [mig(9001, "CREATE TABLE ok (id int); CREATE TABLE nope (id bad)")]),
    ).rejects.toThrow(MigrationError);

    expect(connsFor("ROLLBACK")).toHaveLength(1);
    expect(connsFor("ROLLBACK")).toEqual(connsFor("BEGIN"));
    expect(connsFor("ROLLBACK")).toEqual(connsFor("CREATE TABLE nope"));
    expect(sqlLog()).not.toContain("COMMIT");
  });

  it("lifts statement_timeout inside the transaction, not around it", async () => {
    // Inside, so COMMIT/ROLLBACK reverts it and the connection cannot carry the
    // exemption back into the pool where a request would inherit it.
    const { client } = stubbedClient();
    await migrate(client, [mig(9001, "CREATE INDEX slow ON t (c)")]);

    const order = sqlLog();
    const begin = order.indexOf("BEGIN");
    const set = order.indexOf("SET LOCAL statement_timeout = 0");
    const ddl = order.indexOf("CREATE INDEX slow ON t (c)");
    const commit = order.indexOf("COMMIT");

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(begin);
    expect(ddl).toBeGreaterThan(set);
    expect(commit).toBeGreaterThan(ddl);
  });

  it("takes the lock before it reads schema_migrations, and gives it back", async () => {
    const { client } = stubbedClient();
    await migrate(client, [mig(9001, "CREATE TABLE a (id int)")]);

    const order = sqlLog();
    const lock = order.findIndex((s) => s.includes("pg_try_advisory_lock"));
    const read = order.findIndex((s) => s.includes("SELECT version, name, checksum"));
    const unlock = order.findIndex((s) => s.includes("pg_advisory_unlock"));

    expect(lock).toBe(0);
    expect(read).toBeGreaterThan(lock);
    expect(unlock).toBe(order.length - 1);
    expect(connsFor("pg_advisory_unlock")).toEqual(connsFor("pg_try_advisory_lock"));
  });

  it("gives the lock back even when a migration fails", async () => {
    // Otherwise the connection carries a session lock back into the pool and
    // every later run that lands on a different one refuses forever.
    const { client } = stubbedClient();
    scenario = { ...scenario, failOn: ["CREATE TABLE nope"] };

    await expect(migrate(client, [mig(9001, "CREATE TABLE nope (id bad)")])).rejects.toThrow(
      MigrationError,
    );

    expect(sqlLog().at(-1)).toContain("pg_advisory_unlock");
  });

  it("refuses when another run already holds the lock", async () => {
    const { client } = stubbedClient();
    scenario = { ...scenario, lockGranted: false };

    // Matched on the diagnostic rather than the prose: the message must carry
    // the `pg_locks` query, because a refusal an operator cannot act on is the
    // same dead end as no message at all — a stranded lock and a live run look
    // identical from here.
    await expect(migrate(client, [mig(9001, "CREATE TABLE a (id int)")])).rejects.toThrow(
      /classid = 1919906676/,
    );

    // Refused before anything was read or written, not partway through — and no
    // unlock, because unlocking a lock this session never held would report a
    // warning about someone else's lock.
    expect(sqlLog()).toEqual(["SELECT pg_try_advisory_lock($1, $2) AS locked"]);
  });
});
