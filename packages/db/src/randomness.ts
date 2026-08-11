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
   *
   * `false` means the check ran and the slot failed it. An implementation that
   * cannot reach its source **throws** rather than answering `false`, because
   * "I could not check" is not "this draw is wrong" and a caller that publishes
   * one as the other accuses an honest commissioner of rigging the draft.
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
  /**
   * Attempts per RPC call, including the first. Defaults to `RPC_ATTEMPTS`.
   *
   * Injectable so a test can pin how many round trips it expects rather than
   * inferring them from a constant it does not control.
   */
  readonly attempts?: number;
  /** Injectable for tests, so retry backoff costs no wall-clock time. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
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

/**
 * Attempts per RPC call, including the first.
 *
 * A search is ~30 sequential `getBlockTime` calls with no pacing, and the
 * deployed shape points them at whatever `SOLANA_RPC_URL` names — often a free
 * public endpoint that rate-limits. Since a failed call now *fails the draw*
 * rather than being quietly read as a skipped slot, one 429 in thirty would
 * send the commissioner back to the button. Three attempts costs at most 600ms
 * of added latency *per call* — so a search where every call retries twice adds
 * about sixteen seconds, not six hundred milliseconds. That only happens
 * against an endpoint that is failing almost everything, where the draw should
 * be refusing anyway, but it is why the ceiling is three and not ten.
 *
 * It is deliberately small and deliberately not a pacing delay: pacing would
 * slow every draw to protect against a burst that three attempts already
 * absorbs, and every call here is an idempotent read of immutable history, so
 * repeating one cannot produce a different answer.
 */
const RPC_ATTEMPTS = 3;

/** First backoff step; doubles per attempt. */
const RETRY_BASE_MS = 200;

/**
 * Whether an HTTP status is worth a second attempt.
 *
 * 429 is the one that matters. A 4xx that is not 429 is the node telling us the
 * request is wrong, and repeating it wastes the commissioner's time.
 */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

interface JsonRpcErrorBody {
  readonly code?: number;
  readonly message?: string;
}

/**
 * The outcome of one JSON-RPC round trip that reached the node and came back
 * well-formed. Transport and HTTP failures never appear here — they throw.
 */
type RpcOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: JsonRpcErrorBody };

/**
 * JSON-RPC error codes meaning "that slot holds no block".
 *
 * -32007 is the live-ledger form ("Slot N was skipped, or missing due to ledger
 * jump to recent snapshot") and -32009 the long-term-storage form.
 *
 * A slot the node has *pruned* is a different answer — agave reports that as
 * -32001 `BlockCleanedUp`, which is deliberately **not** listed here, so a
 * pruned range now fails loudly instead of being walked past. That is the right
 * direction (a pruned range cannot be verified, and pretending otherwise is how
 * an unverifiable draw gets recorded), but it means the archival-node guidance
 * on `NOT_FOUND` is now reached only through a genuine long walk. UNVERIFIED
 * against a live node from this repo.
 *
 * **What is assumed here, plainly, because it has not been checked against a
 * live node from this repo:** that these are the codes a node answers a skipped
 * slot with, and that some nodes may instead answer with a `null` *result* and
 * no error at all. Both are accepted — and, critically, *nothing else is*.
 *
 * That asymmetry is the whole point. Reading a failure as "skipped" moves the
 * draw to the next block; `drawDraftOrder` writes it, migration 0010's trigger
 * freezes it, and `verify()` then calls the league's own recorded draw wrong
 * forever. Reading a skip as a failure makes the draw refuse, which costs a
 * commissioner one more click and corrupts nothing. So an error we do not
 * recognise is a failure.
 */
const SKIPPED_SLOT_CODES: readonly number[] = [-32007, -32009];

/**
 * Codes that mean "ask again", not "no block there".
 *
 * -32004 and -32014 are a backend that has not caught up: public endpoints are
 * load-balanced, so `getSlot` can answer from one node and `getBlockTime` from
 * another a few slots behind. 429 appears here because some providers deliver a
 * rate limit as HTTP 200 with the limit in the error body, where the HTTP-status
 * retry never sees it.
 */
const TRANSIENT_RPC_CODES: readonly number[] = [-32004, -32014, 429];

function isTransientRpcError(error: JsonRpcErrorBody): boolean {
  return typeof error.code === "number" && TRANSIENT_RPC_CODES.includes(error.code);
}

/**
 * Whether a JSON-RPC error body means "no block at that slot".
 *
 * The message check is the loose branch, and it is here on purpose: the exact
 * code is unverified (see above), so a node using a third code in the same
 * family would otherwise make every draw fail.
 *
 * **It is gated on the code being absent or in the -3200x family**, because
 * unguarded it is genuinely fail-open: an internal error whose message merely
 * contains the word — `{code: -32603, message: "request was skipped by the
 * proxy"}` is a real shape — would move the draw a block and freeze it. A
 * failure must never be read as a gap, so the hedge only applies where the code
 * itself already says "something about this slot".
 */
function isSkippedSlot(error: JsonRpcErrorBody): boolean {
  const code = typeof error.code === "number" ? error.code : null;
  if (code !== null && SKIPPED_SLOT_CODES.includes(code)) return true;
  if (code !== null && (code > -32000 || code <= -32010)) return false;

  return /\bskipped\b/i.test(error.message ?? "");
}

const describeRpcError = (error: JsonRpcErrorBody): string =>
  `${error.message ?? "unknown error"} (code ${error.code ?? "none"})`;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SolanaBeacon implements RandomnessBeacon {
  private readonly endpoint: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SolanaBeaconOptions) {
    this.endpoint = options.endpoint;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // Guarded rather than clamped: Math.max(1, NaN) is NaN, and `attempt >= NaN`
    // is never true, which would retry forever with doubling backoff.
    const attempts = options.attempts ?? RPC_ATTEMPTS;
    this.attempts = Number.isFinite(attempts)
      ? Math.max(1, Math.floor(attempts))
      : RPC_ATTEMPTS;
    this.sleep = options.sleepImpl ?? realSleep;
  }

  /**
   * One JSON-RPC call, retried while the failure looks transient.
   *
   * **A JSON-RPC error body is returned, not thrown.** For `getBlockTime` it is
   * the node's real answer about the slot ("nothing there") and only the caller
   * knows whether that answer is expected — which is exactly the distinction
   * this whole file turns on. Everything that is *not* an answer about the slot
   * — an unreachable node, an HTTP status, a body that is not JSON — throws,
   * because none of it says anything about whether the chain skipped a slot.
   */
  private async call<T>(method: string, params: unknown[]): Promise<RpcOutcome<T>> {
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.attemptCall<T>(method, params);

      // A transient failure arrives in two shapes and both have to be retried.
      // An HTTP 429 comes back as a `BeaconError`; the *same* rate limit from a
      // provider that answers 200 with `{"error":{"code":429}}` comes back as an
      // error body, which is not a `BeaconError` and so used to skip the loop
      // entirely — the retry never fired for the case it was added for.
      const retryable =
        outcome instanceof BeaconError || (!outcome.ok && isTransientRpcError(outcome.error));
      if (!retryable) return outcome;

      if (attempt >= this.attempts) {
        if (outcome instanceof BeaconError) throw outcome;
        return outcome;
      }
      await this.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }

  /** One round trip. Returns the outcome, or the `BeaconError` to retry on. */
  private async attemptCall<T>(
    method: string,
    params: unknown[],
  ): Promise<RpcOutcome<T> | BeaconError> {
    let response: Response;
    try {
      response = await this.doFetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (cause) {
      return new BeaconError(`Solana RPC ${method} failed`, "RPC_FAILED", { cause });
    }

    if (!response.ok) {
      const failure = new BeaconError(
        `Solana RPC ${method} returned ${response.status}`,
        "RPC_FAILED",
      );
      if (!isRetryableStatus(response.status)) throw failure;
      return failure;
    }

    let payload: { result?: T; error?: JsonRpcErrorBody };
    try {
      payload = (await response.json()) as { result?: T; error?: JsonRpcErrorBody };
    } catch (cause) {
      // A proxy or captive portal answering 200 with HTML. Not an answer about
      // the slot, so it must not be mistaken for one.
      return new BeaconError(`Solana RPC ${method} returned a non-JSON body`, "RPC_FAILED", {
        cause,
      });
    }

    if (payload.error) return { ok: false, error: payload.error };

    // Neither a result nor an error is not an answer about the slot, and it must
    // not decay into one. `result` absent and `result: null` are different
    // facts — the second says "no block there", the first says the node did not
    // answer — and `payload.result` collapses both to `undefined`, so the check
    // has to be on the key rather than the value. Without it a proxy returning
    // a bare `{"jsonrpc":"2.0","id":1}` reads as a skipped slot, which is the
    // whole defect this file was rewritten to remove.
    if (!("result" in payload)) {
      return new BeaconError(
        `Solana RPC ${method} answered with neither a result nor an error`,
        "RPC_FAILED",
      );
    }

    return { ok: true, result: payload.result as T };
  }

  /** A call whose JSON-RPC error body is never an expected answer. */
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const outcome = await this.call<T>(method, params);
    if (!outcome.ok) {
      throw new BeaconError(
        `Solana RPC ${method}: ${describeRpcError(outcome.error)}`,
        "RPC_FAILED",
      );
    }
    return outcome.result;
  }

  /**
   * A slot's block time, or `null` when the node says that slot holds no block.
   *
   * `null` means exactly one thing — **the chain skipped this slot** — because
   * that is the only thing the callers below can do anything sensible with: they
   * read it as "keep walking" and move on to the next slot. Skipped slots are
   * normal; a leader that misses its turn produces no block.
   *
   * Everything else throws. A node that is unreachable, rate-limiting, or
   * answering with an error we do not recognise has told us nothing about the
   * slot, and walking past it on that basis moves the draw to a different block
   * — permanently, since the order is written once and frozen by a trigger.
   * See `SKIPPED_SLOT_CODES` for what counts as "the slot was skipped" and what
   * is assumed in deciding that.
   */
  private async blockTime(slot: number): Promise<number | null> {
    const outcome = await this.call<number | null>("getBlockTime", [slot]);
    if (outcome.ok) return outcome.result ?? null;
    if (isSkippedSlot(outcome.error)) return null;

    throw new BeaconError(
      `Solana RPC getBlockTime(${slot}): ${describeRpcError(outcome.error)}`,
      "RPC_FAILED",
    );
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

  /**
   * Two calls, no search — and it throws rather than guessing.
   *
   * `null` here is a real finding: the recorded slot holds no block, so it
   * cannot be the block the order was drawn from. A node that failed to answer
   * is not a finding, and `blockTime` throws on that rather than handing back a
   * `null` this would read as proof of a rigged draw.
   */
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
   *
   * The walk covers gaps and nothing else. A lookup that genuinely failed throws
   * out of `blockTime` and out of here, rather than being counted as one more
   * skipped slot and stepped over.
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
