import { describe, expect, it } from "vitest";
import { BeaconError, FixedBeacon, SolanaBeacon } from "./randomness.js";

/**
 * A synthetic chain.
 *
 * Slot 0 starts at `GENESIS` and each slot advances 400ms, except that one slot
 * in seven is skipped — a leader that misses its turn produces no block, which
 * is normal and which every lookup here has to tolerate.
 */
const GENESIS = 1_700_000_000;
const TIP = 1_000_000;

const isSkipped = (slot: number): boolean => slot % 7 === 3;
const timeOf = (slot: number): number => GENESIS + Math.floor((slot * 400) / 1000);

/** The answer, computed the slow honest way, for the search to be checked against. */
function firstBlockAtOrAfter(target: number): number {
  for (let slot = 0; slot <= TIP; slot++) {
    if (!isSkipped(slot) && timeOf(slot) >= target) return slot;
  }
  throw new Error("no such block");
}

interface Counter {
  calls: number;
}

function chainFetch(counter: Counter, options: { tip?: number } = {}): typeof globalThis.fetch {
  const tip = options.tip ?? TIP;

  return (async (_url: string, init?: RequestInit) => {
    counter.calls++;
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };

    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    switch (body.method) {
      case "getSlot":
        return reply(tip);

      case "getBlockTime": {
        const slot = body.params[0] as number;
        if (slot > tip || slot < 0 || isSkipped(slot)) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32009, message: "Slot was skipped" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return reply(timeOf(slot));
      }

      case "getBlock": {
        const slot = body.params[0] as number;
        if (isSkipped(slot)) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Slot was skipped" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return reply({ blockhash: `hash-for-slot-${slot}`, blockTime: timeOf(slot) });
      }

      default:
        throw new Error(`unexpected RPC method ${body.method}`);
    }
  }) as unknown as typeof globalThis.fetch;
}

const beaconFor = (counter: Counter, options: { tip?: number } = {}) =>
  new SolanaBeacon({
    endpoint: "https://example.invalid",
    fetchImpl: chainFetch(counter, options),
  });

describe("SolanaBeacon.firstBlockAtOrAfter", () => {
  it("finds the first block at or after the target", async () => {
    const counter = { calls: 0 };
    const target = GENESIS + 200_000;

    const block = await beaconFor(counter).firstBlockAtOrAfter(new Date(target * 1000));

    expect(block.slot).toBe(firstBlockAtOrAfter(target));
    expect(block.blockTime).toBeGreaterThanOrEqual(target);
  });

  it("never returns a later block when an earlier one qualifies", async () => {
    // The rule has to name exactly one block. Returning "a recent block" would
    // let whoever draws keep asking until they liked the answer.
    const counter = { calls: 0 };
    const target = GENESIS + 123_456;

    const block = await beaconFor(counter).firstBlockAtOrAfter(new Date(target * 1000));
    const expected = firstBlockAtOrAfter(target);

    expect(block.slot).toBe(expected);

    // And every earlier block really is earlier.
    for (let slot = expected - 1; slot > expected - 20; slot--) {
      if (!isSkipped(slot)) expect(timeOf(slot)).toBeLessThan(target);
    }
  });

  it("lands on a real block, never a skipped slot", async () => {
    const counter = { calls: 0 };

    for (const offset of [1, 400, 4_001, 40_000, 300_000]) {
      const target = GENESIS + offset;
      const block = await beaconFor(counter).firstBlockAtOrAfter(new Date(target * 1000));

      expect(isSkipped(block.slot), `slot ${block.slot}`).toBe(false);
      expect(block.slot).toBe(firstBlockAtOrAfter(target));
    }
  });

  it("returns the block's hash", async () => {
    const counter = { calls: 0 };
    const target = GENESIS + 50_000;

    const block = await beaconFor(counter).firstBlockAtOrAfter(new Date(target * 1000));

    expect(block.blockhash).toBe(`hash-for-slot-${block.slot}`);
  });

  it("searches in a handful of calls, not by walking", async () => {
    // A linear walk over months of chain history would be millions of round
    // trips. If this number balloons, the search has degenerated.
    const counter = { calls: 0 };
    await beaconFor(counter).firstBlockAtOrAfter(new Date((GENESIS + 200_000) * 1000));

    expect(counter.calls).toBeLessThan(80);
  });

  it("refuses when the chain has not reached the target yet", async () => {
    // Drawing early is drawing from a block someone could still arrange the
    // field against.
    const counter = { calls: 0 };
    const future = new Date((timeOf(TIP) + 3600) * 1000);

    await expect(beaconFor(counter).firstBlockAtOrAfter(future)).rejects.toMatchObject({
      code: "NOT_YET",
    });
  });

  it("finds a block right at the tip", async () => {
    const counter = { calls: 0 };
    const target = timeOf(TIP) - 1;

    const block = await beaconFor(counter).firstBlockAtOrAfter(new Date(target * 1000));

    expect(block.blockTime).toBeGreaterThanOrEqual(target);
    expect(block.slot).toBeLessThanOrEqual(TIP);
  });

  it("finds a block near genesis", async () => {
    const counter = { calls: 0 };
    const target = GENESIS + 1;

    const block = await beaconFor(counter).firstBlockAtOrAfter(new Date(target * 1000));

    expect(block.slot).toBe(firstBlockAtOrAfter(target));
  });
});

describe("SolanaBeacon.verify", () => {
  it("accepts the block the search returns", async () => {
    const counter = { calls: 0 };
    const target = new Date((GENESIS + 200_000) * 1000);
    const beacon = beaconFor(counter);

    const block = await beacon.firstBlockAtOrAfter(target);

    expect(await beacon.verify(block.slot, target)).toBe(true);
  });

  it("rejects a block from before the target", async () => {
    const counter = { calls: 0 };
    const target = new Date((GENESIS + 200_000) * 1000);
    const beacon = beaconFor(counter);

    const chosen = await beacon.firstBlockAtOrAfter(target);

    expect(await beacon.verify(chosen.slot - 10, target)).toBe(false);
  });

  it("rejects a later block, even though it is after the target", async () => {
    // This is the one that catches cheating: picking a block you like from
    // further down the chain. It is after the target, so a naive check passes.
    const counter = { calls: 0 };
    const target = new Date((GENESIS + 200_000) * 1000);
    const beacon = beaconFor(counter);

    const chosen = await beacon.firstBlockAtOrAfter(target);
    let later = chosen.slot + 1;
    while (isSkipped(later)) later++;

    expect(await beacon.verify(later, target)).toBe(false);
  });

  it("costs only a couple of calls", async () => {
    // A check nobody can afford to run is not a check.
    const target = new Date((GENESIS + 200_000) * 1000);
    const slot = firstBlockAtOrAfter(GENESIS + 200_000);

    const counter = { calls: 0 };
    await beaconFor(counter).verify(slot, target);

    expect(counter.calls).toBeLessThan(6);
  });
});

describe("SolanaBeacon transport", () => {
  it("surfaces an RPC error rather than guessing", async () => {
    const failing = (async () =>
      new Response("upstream exploded", { status: 502 })) as unknown as typeof globalThis.fetch;

    const beacon = new SolanaBeacon({
      endpoint: "https://example.invalid",
      fetchImpl: failing,
    });

    await expect(beacon.firstBlockAtOrAfter(new Date())).rejects.toBeInstanceOf(BeaconError);
  });
});

describe("FixedBeacon", () => {
  // Test-only. It makes the seed predictable, which is the entire thing the real
  // beacon exists to prevent.
  const blocks = [
    { slot: 10, blockhash: "a", blockTime: 1000 },
    { slot: 20, blockhash: "b", blockTime: 2000 },
    { slot: 30, blockhash: "c", blockTime: 3000 },
  ];
  const beacon = new FixedBeacon(blocks);

  it("returns the first block at or after the time", async () => {
    expect((await beacon.firstBlockAtOrAfter(new Date(1_500_000))).slot).toBe(20);
  });

  it("is exact on a boundary", async () => {
    expect((await beacon.firstBlockAtOrAfter(new Date(2_000_000))).slot).toBe(20);
  });

  it("rejects a time past the last block", async () => {
    await expect(beacon.firstBlockAtOrAfter(new Date(9_000_000))).rejects.toMatchObject({
      code: "NOT_YET",
    });
  });

  it("verifies the same block it would have chosen", async () => {
    expect(await beacon.verify(20, new Date(1_500_000))).toBe(true);
    expect(await beacon.verify(30, new Date(1_500_000))).toBe(false);
  });
});
