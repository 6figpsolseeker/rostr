/**
 * Where the draft order's randomness comes from.
 *
 * `generateDraftOrder` is a deterministic shuffle: same seed, same teams, same
 * order, on any machine. That is what makes it auditable. It is also what makes
 * the *choice of seed* the entire security question.
 *
 * ## The attack a fixed seed allows
 *
 * The shuffle depends on the seed **and on the set of team IDs**. Anything the
 * commissioner can vary before the draft, they can grind:
 *
 *   1. Add a bot. Compute the order offline. Seventh — not good enough.
 *   2. Remove it, add a differently-identified one. Compute again. Fourth.
 *   3. Repeat until first.
 *
 * Every order they computed was correct, and nothing about the published one
 * looks wrong, because nothing was tampered with. They re-rolled in private and
 * announced the roll they kept. No server-side check can catch this — the
 * computation happens on their laptop.
 *
 * ## The fix
 *
 * The seed must not exist while the field can still change. So it is taken from
 * the first Solana block produced at or after the league's frozen
 * `draft.scheduledAt`:
 *
 *   * **Unpredictable.** While teams are joining, that block has not been
 *     produced. There is nothing to grind against.
 *   * **Verifiable.** Afterwards anyone can look up the slot, confirm it is the
 *     first block at or after the scheduled time, and recompute the order.
 *   * **Not ours.** We do not choose it, cannot influence it, and gain nothing
 *     by being trusted about it.
 */

import { sha256Hex } from "../canonical.js";

/** The block a draft order was drawn from. */
export interface OrderRandomness {
  readonly slot: number;
  readonly blockhash: string;
}

export interface OrderSeedInput extends OrderRandomness {
  readonly leagueId: string;
  /** The league's frozen rules hash. */
  readonly rulesHash: string;
}

/**
 * Derive a draft order seed from a block.
 *
 * The league ID and rules hash are mixed in for domain separation: two leagues
 * drawing from the same block must not receive correlated orders, and a seed
 * that means something in one league must mean nothing in another.
 */
export function deriveOrderSeed(input: OrderSeedInput): string {
  return sha256Hex(
    [
      "rostr:draft-order:v1",
      input.leagueId,
      input.rulesHash,
      String(input.slot),
      input.blockhash,
    ].join(":"),
  );
}

/**
 * Instructions for checking a draft order by hand.
 *
 * **Not rendered anywhere yet**, and this used to say it was. A verification
 * nobody can perform is indistinguishable from no verification — which was
 * written here as the reason to show it, and had become an accurate description
 * of the shipped state instead. It is written, tested and exported, and no
 * screen calls it. Filed separately; the sentence stays because it is the
 * argument for fixing that.
 *
 * The text below is true as of migration `0028`. Before it, the closing claim —
 * that nobody could have known the blockhash while teams were still joining —
 * was false: the seed existed from the scheduled draft time and the field stayed
 * open until the commissioner pressed the button.
 */
export function explainOrderDraw(input: OrderSeedInput): string {
  return [
    `Draft order for league ${input.leagueId}.`,
    ``,
    `Drawn from Solana slot ${input.slot}, the first block produced at or after`,
    `the league's scheduled draft time. Its blockhash is:`,
    ``,
    `  ${input.blockhash}`,
    ``,
    `To check this yourself:`,
    ``,
    `  1. Look up slot ${input.slot} on any Solana explorer or RPC node.`,
    `     Confirm its block time is at or after the scheduled draft time, and`,
    `     that the block before it is earlier. That makes it the only block`,
    `     this league could have used.`,
    `  2. The seed is sha256 of these five fields joined with colons:`,
    `       rostr:draft-order:v1:<leagueId>:<rulesHash>:<slot>:<blockhash>`,
    `     which gives ${deriveOrderSeed(input)}`,
    `  3. Feed that seed to the published shuffle over the team IDs in join`,
    `     order. The result is the order that was used.`,
    ``,
    `Nobody could have known this blockhash while teams were still joining, and`,
    `the order was recorded before anyone could act on it.`,
  ].join("\n");
}
