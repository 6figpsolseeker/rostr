/**
 * The randomness the draft order is drawn from.
 *
 * The rule, in one line: **the first Solana block produced at or after the
 * league's frozen scheduled draft time.**
 *
 * That block does not exist while teams are still joining, so there is nothing
 * for a commissioner to grind against; and once it exists, anyone can look up
 * the slot and recompute the order. See `deriveOrderSeed` in `@rostr/core` for
 * why any seed known in advance is worthless.
 *
 * This file only *finds* the block. It does not decide anything.
 *
 * ## Why the "first at or after" phrasing matters
 *
 * The rule has to name exactly one block, otherwise it is not a rule. "A recent
 * block" would let whoever draws keep asking until they liked the answer.
 *
 * Finding it needs a search, but **checking it needs two RPC calls**: confirm
 * the chosen block is at or after the scheduled time, and that the one before it
 * is earlier. Cheap verification is the point — a check nobody can afford to run
 * is not a check.
 */

export interface DrawnBlock {
  readonly slot: number;
  readonly blockhash: string;
  /** Unix seconds. */
  readonly blockTime: number;
}

export class BeaconError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_YET" | "RPC_FAILED" | "NOT_FOUND",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BeaconError";
  }
}

export interface RandomnessBeacon {
  /** The first block produced at or after `time`. */
  firstBlockAtOrAfter(time: Date): Promise<DrawnBlock>;

  /**
   * Whether `slot` really is the first block at or after `time`.
   *
   * What a sceptic runs. Two calls, no search.
   */
  verify(slot: number, time: Date): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

export interface SolanaBeaconOptions {
  /** RPC endpoint. Any node will do; nothing here needs a paid one. */
  readonly endpoint: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** Mainnet averages ~400ms per slot. Used only to seed the search. */
const APPROX_SLOT_MS = 400;

/** How far to widen the lower bound each time the estimate proves too high. */
const SEARCH_MARGIN_SLOTS = 250_000;

/**
 * How many consecutive skipped slots to tolerate before giving up.
 *
 * Real gaps are a handful of slots. A gap this large means the node has pruned
 * the range, not that the chain stalled.
 */
const MAX_SKIP_WALK = 500;

export class SolanaBeacon implements RandomnessBeacon {
  private readonly endpoint: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: SolanaBeaconOptions) {
    this.endpoint = options.endpoint;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await this.doFetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (cause) {
      throw new BeaconError(`Solana RPC ${method} failed`, "RPC_FAILED", { cause });
    }

    if (!response.ok) {
      throw new BeaconError(`Solana RPC ${method} returned ${response.status}`, "RPC_FAILED");
    }

    const payload = (await response.json()) as { result?: T; error?: { message?: string } };
    if (payload.error) {
      throw new BeaconError(
        `Solana RPC ${method}: ${payload.error.message ?? "unknown error"}`,
        "RPC_FAILED",
      );
    }

    return payload.result as T;
  }

  /**
   * A slot's block time, or `null` if that slot was skipped.
   *
   * Skipped slots are normal — a leader that misses its turn produces no block —
   * so the search below has to tolerate gaps rather than treat them as errors.
   */
  private async blockTime(slot: number): Promise<number | null> {
    try {
      return await this.rpc<number | null>("getBlockTime", [slot]);
    } catch (error) {
      if (error instanceof BeaconError && error.code === "RPC_FAILED") return null;
      throw error;
    }
  }

  /**
   * Binary search for the first block at or after `time`.
   *
   * The invariant, held throughout: everything at or below `low` is earlier than
   * the target, and `high` is a real block at or after it. The loop narrows until
   * no block sits between them, at which point `high` is the answer.
   *
   * About twenty RPC calls for a search spanning months of chain history. The
   * naive walk would be millions.
   */
  async firstBlockAtOrAfter(time: Date): Promise<DrawnBlock> {
    const target = Math.floor(time.getTime() / 1000);

    const tipSlot = await this.rpc<number>("getSlot", [{ commitment: "finalized" }]);
    const tip = await this.blockAtOrBefore(tipSlot);

    if (tip.time < target) {
      // The block has not been produced yet. Drawing early is the one thing that
      // would reintroduce predictability, so this refuses rather than
      // approximating with whatever exists now.
      throw new BeaconError(
        `The chain has not reached ${time.toISOString()} yet ` +
          `(finalized tip is at ${new Date(tip.time * 1000).toISOString()})`,
        "NOT_YET",
      );
    }

    // Estimate a lower bound from the average slot time, then widen downward
    // until it genuinely sits before the target. Slot times drift, so the
    // estimate is a starting point and never trusted as a bound.
    const behind = Math.ceil(((tip.time - target) * 1000) / APPROX_SLOT_MS);
    let low = Math.max(0, tip.slot - behind - SEARCH_MARGIN_SLOTS);

    for (let widened = 0; low > 0 && widened < 32; widened++) {
      const candidate = await this.blockAtOrBefore(low);
      if (candidate.time < target) break;
      low = Math.max(0, low - SEARCH_MARGIN_SLOTS);
    }

    let high = tip.slot;

    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      const block = await this.blockAtOrBefore(mid);

      if (block.slot <= low) {
        // Every slot between `low` and `mid` was skipped, so nothing new was
        // learned about the boundary except that it is above `mid`.
        low = mid;
      } else if (block.time >= target) {
        high = block.slot;
      } else {
        low = block.slot;
      }
    }

    return {
      slot: high,
      blockhash: await this.blockhashOf(high),
      blockTime: (await this.blockAtOrBefore(high)).time,
    };
  }

  async verify(slot: number, time: Date): Promise<boolean> {
    const target = Math.floor(time.getTime() / 1000);

    const chosen = await this.blockTime(slot);
    if (chosen === null || chosen < target) return false;

    if (slot === 0) return true;

    // And nothing earlier qualifies, which is what makes it *the* block rather
    // than merely *a* block. Two calls total — cheap enough that a sceptic will
    // actually run it.
    const previous = await this.blockAtOrBefore(slot - 1);
    return previous.time < target;
  }

  /**
   * The nearest real block at or before `slot`.
   *
   * Skipped slots are normal — a leader that misses its turn produces no block —
   * so every lookup has to tolerate gaps rather than treat them as failures.
   */
  private async blockAtOrBefore(slot: number): Promise<{ slot: number; time: number }> {
    for (let current = slot; current >= 0 && current > slot - MAX_SKIP_WALK; current--) {
      const time = await this.blockTime(current);
      if (time !== null) return { slot: current, time };
    }

    throw new BeaconError(
      `No block within ${MAX_SKIP_WALK} slots at or before ${slot}. ` +
        `The RPC node may have pruned this range — verification of an old draw ` +
        `needs an archival node.`,
      "NOT_FOUND",
    );
  }

  private async blockhashOf(slot: number): Promise<string> {
    const block = await this.rpc<{ blockhash?: string }>("getBlock", [
      slot,
      {
        encoding: "json",
        transactionDetails: "none",
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]);

    if (!block?.blockhash) {
      throw new BeaconError(`Slot ${slot} returned no blockhash`, "NOT_FOUND");
    }

    return block.blockhash;
  }
}

// ---------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------

/**
 * A beacon over a fixed set of blocks.
 *
 * For tests and local development only. It makes the seed predictable, which is
 * the entire thing the real beacon exists to prevent — so it is never wired into
 * anything that runs against mainnet.
 */
export class FixedBeacon implements RandomnessBeacon {
  constructor(private readonly blocks: readonly DrawnBlock[]) {}

  private first(time: Date): DrawnBlock | undefined {
    const target = Math.floor(time.getTime() / 1000);
    return [...this.blocks]
      .sort((a, b) => a.slot - b.slot)
      .find((block) => block.blockTime >= target);
  }

  firstBlockAtOrAfter(time: Date): Promise<DrawnBlock> {
    const block = this.first(time);
    if (!block) {
      return Promise.reject(
        new BeaconError(`No block at or after ${time.toISOString()}`, "NOT_YET"),
      );
    }
    return Promise.resolve(block);
  }

  verify(slot: number, time: Date): Promise<boolean> {
    return Promise.resolve(this.first(time)?.slot === slot);
  }
}
