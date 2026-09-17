/**
 * The order capacity keys are taken in.
 *
 * Nothing here touches a database, and that is the point: the ordering is the
 * only part of `lockRosterCapacity` a test in this repo can establish at all.
 * PGlite is one connection, so a second transaction never runs, a lock never
 * blocks, and no test here can show that the lock excludes anything. The three
 * call sites assert instead that the statement is *issued*, inside the
 * transaction and before the reads it has to dominate; see
 * `trades.test.ts`, `waivers.test.ts` and `injured-reserve.test.ts`.
 *
 * What is left over — that `pg_advisory_xact_lock` is exclusive and
 * transaction-scoped, and that a fresh READ COMMITTED statement snapshot taken
 * after waking sees the winner's committed insert — is a Postgres guarantee plus
 * the argument written at `lockRosterCapacity`. It has to be got right by
 * reading. `membership.ts` is in exactly the same position for the seat count,
 * and says so.
 */

import { describe, expect, it } from "vitest";
import { capacityLockOrder } from "./roster-capacity.js";

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
    // Not reachable from the three callers, all of which name at least one team.
    // Asserted so the loop in `lockRosterCapacity` is total rather than relying
    // on its callers to stay that way.
    expect(capacityLockOrder([])).toEqual([]);
  });
});
