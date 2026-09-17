/**
 * The order capacity keys are taken in.
 *
 * Nothing here touches a database, and that is the point: the deduplication is
 * the only part of `lockRosterCapacity` a test can reach without one. PGlite is
 * one connection, so a second transaction never runs, a lock never blocks, and
 * no test here can show that the lock excludes anything.
 *
 * The four call sites — `acceptTrade`, `resolveTrade`, `addFreeAgent` and
 * `activateFromIr` — assert instead that the statement is *issued*, on the
 * transaction's own connection, before the reads it has to dominate; see
 * `trades.test.ts`, `waivers.test.ts` and `injured-reserve.test.ts`.
 *
 * **The acquisition order is not decided here.** `lockRosterCapacity` re-orders
 * on `hashtext(teamId)`, because that map is 32 bits and not injective, so
 * sorting the ids would order the keys only while no two collide. What this
 * function guarantees is that two callers naming the same teams hand that step
 * the same input.
 *
 * What is left over — that `pg_advisory_xact_lock` is exclusive and
 * transaction-scoped, and that a fresh READ COMMITTED statement snapshot taken
 * after waking sees the winner's committed insert — is a Postgres guarantee plus
 * the argument written at `lockRosterCapacity`. It has to be got right by
 * reading. `membership.ts` is in exactly the same position for the seat count,
 * and says so.
 */

import { afterEach, describe, expect, it } from "vitest";
import { capacityLockOrder, lockRosterCapacity } from "./roster-capacity.js";
import { createTestDatabase, recordStatements } from "./testing.js";
import type { PGliteClient } from "./testing.js";

describe("capacityLockOrder", () => {
  it("is the same order whichever side of a trade asks", () => {
    /*
      The deadlock this prevents needs no second function to collide with: two
      acceptances between the same pair of teams, proposed in opposite
      directions, would take the two keys in whichever order each proposer
      happened to sit. `acceptTrade` passes `(receiver, proposer)`, so the two
      calls genuinely do arrive with the arguments reversed.
    */
    const one = capacityLockOrder(["team-b", "team-a"]);
    const other = capacityLockOrder(["team-a", "team-b"]);

    expect(one).toEqual(other);
    expect(one).toEqual(["team-a", "team-b"]);
  });

  it("takes one key once, however many times a team is named", () => {
    // `pg_advisory_xact_lock` is re-entrant within a transaction, so a repeat
    // would not hang — it would spend a round trip and read as though the
    // second call meant something.
    expect(capacityLockOrder(["team-a", "team-a"])).toEqual(["team-a"]);
  });

  it("orders by the id, not by anything about the arguments", () => {
    // Sorting UUIDs as strings is a total order and that is all that is asked of
    // it. Any stable total order would do; what must not happen is an order that
    // depends on the caller.
    const ids = [
      "f0000000-0000-4000-8000-000000000000",
      "10000000-0000-4000-8000-000000000000",
      "90000000-0000-4000-8000-000000000000",
    ];

    expect(capacityLockOrder(ids)).toEqual([...ids].sort());
    expect(capacityLockOrder([...ids].reverse())).toEqual(capacityLockOrder(ids));
  });

  it("answers for no teams at all", () => {
    // Not reachable from the four callers, all of which name at least one team.
    // Asserted so the loop in `lockRosterCapacity` is total rather than relying
    // on its callers to stay that way.
    expect(capacityLockOrder([])).toEqual([]);
  });
});

describe("lockRosterCapacity ordering", () => {
  /*
    **The one mutant a two-team assertion cannot catch.**

    `acceptTrade` and `resolveTrade` lock exactly two teams, and with two
    elements "came out ascending" is satisfied by an unordered implementation
    about half the time — team ids are database-generated UUIDs, so which way it
    falls is chance. A test that fails one run in two is worse than none: it gets
    re-run and dismissed. Measured, not assumed — stripping both the `ORDER BY`
    and the JS sort left the two-team assertion green on two of three runs.

    So this does not rely on chance. It searches for a pair whose *id* order and
    whose *key* order genuinely disagree, then asserts the locks come out in key
    order — which for that pair is the reverse of the id order, so an
    implementation that sorts the ids fails every time.

    That pair is exactly the hazard the ordering exists for: `hashtext` is 32
    bits and not injective, so sorting ids only orders keys while no two ids
    invert. Real UUIDs invert constantly; a collision is merely the extreme case.
  */

  let db: PGliteClient;

  afterEach(async () => {
    await db?.close();
  });

  /** Two ids whose alphabetical order is the opposite of their key order. */
  async function invertingPair(client: PGliteClient): Promise<[string, string]> {
    const candidates = Array.from({ length: 40 }, (_, index) => `team-${index}`);
    const rows = await client.query<{ id: string; key: number }>(
      "SELECT id, hashtext(id) AS key FROM unnest($1::text[]) AS t(id)",
      [candidates],
    );

    for (const low of rows) {
      for (const high of rows) {
        if (low.id < high.id && low.key > high.key) return [low.id, high.id];
      }
    }

    // Not reachable in practice — hashtext scatters, so roughly half of the 780
    // pairs invert. Thrown rather than skipped: a silent skip here would retire
    // the only deterministic check on the ordering without anyone noticing.
    throw new Error("no inverting pair among the candidates; the test has lost its subject");
  }

  it("takes the keys in key order, not in id order", async () => {
    db = await createTestDatabase();
    const [first, second] = await invertingPair(db);
    const rec = recordStatements(db);

    await lockRosterCapacity(rec.client, second, first);

    const keys = rec.statements
      .map((sql, index) => ({ sql, params: rec.params[index] }))
      .filter((entry) => entry.sql === "SELECT pg_advisory_xact_lock(hashtext($1), $2)")
      .map((entry) => entry.params?.[1] as number);

    expect(keys).toHaveLength(2);
    expect(keys[0]!).toBeLessThan(keys[1]!);

    // And the id order really is the other way round, so this pair is doing the
    // work it was picked for rather than passing by coincidence.
    const byId = await db.query<{ key: number }>(
      "SELECT hashtext(id) AS key FROM unnest($1::text[]) AS t(id)",
      [[first, second]],
    );
    expect(byId.map((row) => row.key)).not.toEqual(keys);
  });
});
