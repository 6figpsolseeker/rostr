import { describe, expect, it } from "vitest";
import { joinPlan, type JoinPlanInput } from "./join-plan.js";

const plan = (overrides: Partial<JoinPlanInput> = {}) =>
  joinPlan({ membership: null, hasPot: true, depositsOpen: true, ...overrides });

describe("joinPlan, a free league", () => {
  it("sends the seat alone and never asks the server about a stake", () => {
    expect(plan({ hasPot: false })).toEqual({
      sendJoin: true,
      sendStake: false,
      recordStake: false,
      nothingToSend: false,
    });
  });

  it("is unaffected by the deposit gate, which is about pots", () => {
    expect(plan({ hasPot: false, depositsOpen: false })).toEqual(
      plan({ hasPot: false, depositsOpen: true }),
    );
  });
});

describe("joinPlan, a pot league with staking open", () => {
  it("batches the seat and the stake into one approval", () => {
    expect(plan()).toMatchObject({ sendJoin: true, sendStake: true, recordStake: true });
  });

  it("sends the stake alone to a member who took their seat and stopped", () => {
    // The interrupted member, and the one who joined on-chain before batching
    // existed. `join_league` uses `init`, so re-sending it fails the whole
    // transaction and takes the stake down with it.
    const p = plan({ membership: { deposited: 0n, refunded: false } });
    expect(p).toMatchObject({ sendJoin: false, sendStake: true, recordStake: true });
  });

  it("sends nothing when the money is already in the vault", () => {
    const p = plan({ membership: { deposited: 50_000_000n, refunded: false } });
    expect(p).toMatchObject({ sendJoin: false, sendStake: false, nothingToSend: true });
  });

  it("still records a stake the chain holds and the database missed", () => {
    // The POST that failed after the transaction landed. `verifyOnChainDeposit`
    // will confirm this one, so asking is worth it.
    expect(plan({ membership: { deposited: 50_000_000n, refunded: false } }).recordStake).toBe(
      true,
    );
  });
});

describe("joinPlan, a pot league with staking shut", () => {
  /**
   * The whole of issue #168. The gate shuts the stake and the seat still has to
   * be takeable: the field locks at the frozen draft time on INSERT *and*
   * DELETE (migration `0028`) and there is no dissolve, so refusing the join
   * would be unrecoverable.
   */
  it("takes the seat and leaves the buy-in in the member's wallet", () => {
    expect(plan({ depositsOpen: false })).toMatchObject({
      sendJoin: true,
      sendStake: false,
    });
  });

  it("does not POST a deposit it did not send", () => {
    // The half that makes the fix survive contact with the server. Posting
    // `/deposit` here answers `NOT_DEPOSITED`, 409s, and the retry re-posts it —
    // so a correct join reads as a permanent failure.
    expect(plan({ depositsOpen: false }).recordStake).toBe(false);
  });

  it("is not 'nothing to send' — the seat is still owed", () => {
    expect(plan({ depositsOpen: false }).nothingToSend).toBe(false);
  });

  it("sends nothing at all once the seat exists", () => {
    const p = plan({ membership: { deposited: 0n, refunded: false }, depositsOpen: false });
    expect(p).toMatchObject({ sendJoin: false, sendStake: false, nothingToSend: true });
  });
});

/**
 * `deposited > 0` is not "currently staked", and the two answer different
 * questions — see `verify.ts` and `membership.test.ts` for the four states.
 */
describe("joinPlan, a membership that was refunded", () => {
  const refunded = { deposited: 50_000_000n, refunded: true };

  it("never re-sends a stake the program would refuse", () => {
    expect(plan({ membership: refunded }).sendStake).toBe(false);
  });

  it("never posts a deposit the verifier answers ALREADY_REFUNDED", () => {
    // Reachable today, and the failure is a loop rather than an error: the POST
    // 409s, the panel offers a retry, and the retry posts the same thing.
    expect(plan({ membership: refunded }).recordStake).toBe(false);
  });

  it("has nothing left to send", () => {
    expect(plan({ membership: refunded })).toMatchObject({
      sendJoin: false,
      sendStake: false,
      nothingToSend: true,
    });
  });
});

/**
 * The invariant the whole file exists for, swept rather than argued: the server
 * is never asked to confirm a stake this transaction did not send and the chain
 * does not already hold.
 */
describe("the record never outruns the send", () => {
  const memberships: (JoinPlanInput["membership"] | null)[] = [
    null,
    { deposited: 0n, refunded: false },
    { deposited: 50_000_000n, refunded: false },
    { deposited: 50_000_000n, refunded: true },
  ];

  it("only records a stake that is sent now or staked already", () => {
    for (const membership of memberships) {
      for (const hasPot of [true, false]) {
        for (const depositsOpen of [true, false]) {
          const p = joinPlan({ membership, hasPot, depositsOpen });
          const liveStake =
            membership !== null && membership.deposited > 0n && !membership.refunded;
          expect(p.recordStake).toBe(p.sendStake || liveStake);
        }
      }
    }
  });
});
