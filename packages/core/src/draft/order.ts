/**
 * Draft order.
 *
 * Two properties matter more than anything else here:
 *
 * **Deterministic.** The order is derived from a seed, so anyone holding the
 * seed can recompute it and confirm nobody reshuffled to their advantage. In a
 * league with money in escrow, "the app picked randomly, trust us" is exactly
 * the kind of claim this project exists to remove.
 *
 * **Snake.** Round 1 runs forward, round 2 backward, alternating. Everyone gets
 * one premium pick and one scrap pick.
 */

import { sha256Hex } from "../canonical.js";

/**
 * A deterministic index in `[0, max)`, derived from a seed and a counter.
 *
 * 48 bits of the digest is far more entropy than the range needs; modulo bias
 * across twelve teams is immeasurable.
 */
function seededIndex(seed: string, counter: number, max: number): number {
  const digest = sha256Hex(`${seed}:${counter}`);
  return Number(BigInt(`0x${digest.slice(0, 12)}`) % BigInt(max));
}

/**
 * Shuffle team IDs into a draft order.
 *
 * Fisher-Yates, with every swap driven by the seed. Same seed and same input
 * always produce the same order, on any machine — so the order is *auditable*
 * rather than merely asserted to be random.
 *
 * ## Choosing a seed — this is a security decision
 *
 * The output depends on the seed **and on the set of team IDs**. Anything the
 * commissioner can vary before the draft, they can grind.
 *
 * A seed known at league creation (the rules hash, say) is not sufficient on its
 * own: a commissioner could add a bot, compute the resulting order, remove it,
 * add a differently-identified one, and repeat until the order favours them.
 * Nothing about that is detectable after the fact.
 *
 * The seed must therefore be **unpredictable until after the field is locked**.
 * A Solana slot hash at or after the frozen `draft.scheduledAt` satisfies both
 * halves: nobody can know it in advance, and anyone can verify it afterwards.
 *
 * Until that is wired up (it needs the chain integration), callers should treat
 * the order as fair only for leagues without a pot.
 */
export function generateDraftOrder(
  teamIds: readonly string[],
  seed: string,
): readonly string[] {
  const order = [...teamIds];

  for (let i = order.length - 1; i > 0; i--) {
    const j = seededIndex(seed, i, i + 1);
    const a = order[i]!;
    const b = order[j]!;
    order[i] = b;
    order[j] = a;
  }

  return order;
}

export interface PickPosition {
  /** 1-based. */
  readonly round: number;
  /** 1-based position within the round. */
  readonly pickInRound: number;
  /** Index into the round-1 draft order. */
  readonly orderIndex: number;
}

/**
 * Where a pick falls in a snake draft.
 *
 * @param pickNumber 1-based, counting straight through every round.
 */
export function pickPosition(pickNumber: number, teamCount: number): PickPosition {
  if (pickNumber < 1) throw new RangeError(`pickNumber must be >= 1, got ${pickNumber}`);
  if (teamCount < 1) throw new RangeError(`teamCount must be >= 1, got ${teamCount}`);

  const zeroBased = pickNumber - 1;
  const round = Math.floor(zeroBased / teamCount) + 1;
  const withinRound = zeroBased % teamCount;

  // Even rounds run backwards. That is the whole snake.
  const orderIndex = round % 2 === 1 ? withinRound : teamCount - 1 - withinRound;

  return { round, pickInRound: withinRound + 1, orderIndex };
}

/** The team on the clock for a given pick. */
export function teamOnClock(pickNumber: number, order: readonly string[]): string {
  const { orderIndex } = pickPosition(pickNumber, order.length);
  return order[orderIndex]!;
}

/** Every pick in the draft, in order, as team IDs. */
export function fullDraftSequence(order: readonly string[], rounds: number): readonly string[] {
  const sequence: string[] = [];
  for (let pick = 1; pick <= order.length * rounds; pick++) {
    sequence.push(teamOnClock(pick, order));
  }
  return sequence;
}

/** Total picks in a draft. */
export function totalPicks(teamCount: number, rounds: number): number {
  return teamCount * rounds;
}
