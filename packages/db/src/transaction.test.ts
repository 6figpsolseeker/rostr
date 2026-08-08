import { describe, it, expect } from "vitest";
import { withTransaction } from "./transaction.js";
import type { SqlClient } from "./client.js";

/**
 * These tests model node-postgres pool semantics without a live server.
 *
 * `pg.Pool.query` acquires an arbitrary idle connection per call and releases it
 * immediately, so a `BEGIN` and the statements after it can land on different
 * connections — which silently voids both transaction atomicity and any
 * `SELECT ... FOR UPDATE` a caller relies on. PGlite (single connection) hides
 * this in the existing suite, so it is asserted here directly.
 *
 * The load-bearing invariant: every statement in one `withTransaction` must run
 * on the same connection.
 */

type Op = { conn: string; sql: string };

/** A single checked-out connection. Every statement records its own id. */
class FakeConnection implements SqlClient {
  released = 0;
  constructor(
    private readonly id: string,
    private readonly log: Op[],
  ) {}

  async exec(sql: string): Promise<void> {
    this.log.push({ conn: this.id, sql });
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    this.log.push({ conn: this.id, sql });
    return [] as T[];
  }

  release(): void {
    this.released += 1;
  }
}

/**
 * A pool: each top-level statement runs on a fresh ephemeral connection (the
 * hazard), but `connect()` hands out one pinned connection whose statements all
 * share an id.
 */
class FakePool implements SqlClient {
  private ephemeral = 0;
  private pinned: FakeConnection | null = null;
  constructor(private readonly log: Op[]) {}

  async exec(sql: string): Promise<void> {
    this.ephemeral += 1;
    this.log.push({ conn: `ephemeral-${this.ephemeral}`, sql });
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    this.ephemeral += 1;
    this.log.push({ conn: `ephemeral-${this.ephemeral}`, sql });
    return [] as T[];
  }

  async connect(): Promise<{ client: SqlClient; release: () => void }> {
    const connection = new FakeConnection("pinned", this.log);
    this.pinned = connection;
    return { client: connection, release: () => connection.release() };
  }

  get released(): number {
    return this.pinned?.released ?? 0;
  }
}

/** A single-connection client with no checkout — models PGlite. */
class SingleConnection implements SqlClient {
  constructor(private readonly log: Op[]) {}

  async exec(sql: string): Promise<void> {
    this.log.push({ conn: "single", sql });
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    this.log.push({ conn: "single", sql });
    return [] as T[];
  }
}

function connections(log: Op[]): Set<string> {
  return new Set(log.map((op) => op.conn));
}

describe("withTransaction", () => {
  it("runs BEGIN, the work, and COMMIT on one checked-out connection", async () => {
    const log: Op[] = [];
    const pool = new FakePool(log);

    await withTransaction(pool, async (tx) => {
      await tx.exec("insert one");
      await tx.query("insert two");
    });

    expect(log.map((op) => op.sql)).toEqual(["BEGIN", "insert one", "insert two", "COMMIT"]);
    // The whole point: not scattered across pooled connections.
    expect(connections(log)).toEqual(new Set(["pinned"]));
    expect(pool.released).toBe(1);
  });

  it("rolls back on the same connection and still releases it", async () => {
    const log: Op[] = [];
    const pool = new FakePool(log);

    await expect(
      withTransaction(pool, async (tx) => {
        await tx.exec("insert one");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(log.map((op) => op.sql)).toEqual(["BEGIN", "insert one", "ROLLBACK"]);
    expect(connections(log)).toEqual(new Set(["pinned"]));
    expect(pool.released).toBe(1);
  });

  it("falls back to the client itself when it cannot check a connection out", async () => {
    const log: Op[] = [];
    const single = new SingleConnection(log);

    await withTransaction(single, async (tx) => {
      await tx.exec("work");
    });

    expect(log.map((op) => op.sql)).toEqual(["BEGIN", "work", "COMMIT"]);
    expect(connections(log)).toEqual(new Set(["single"]));
  });

  it("rolls back a single-connection client on error", async () => {
    const log: Op[] = [];
    const single = new SingleConnection(log);

    await expect(
      withTransaction(single, async (tx) => {
        await tx.exec("work");
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect(log.map((op) => op.sql)).toEqual(["BEGIN", "work", "ROLLBACK"]);
  });
});
