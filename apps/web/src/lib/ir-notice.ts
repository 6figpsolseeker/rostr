import "server-only";
import { irClosedReason } from "@rostr/db";

/**
 * What injured reserve will accept right now, and the sentence when it will not.
 *
 * Composed here rather than in the component for the reason `lib/ops.ts` gives:
 * `apps/web` cannot render a component in a test — both vitest projects are
 * node-environment with no jsdom — so anything the screen *decides* lives where
 * a test can reach it, and the component only draws it.
 *
 * ## Two booleans, because the two directions do not get the same answer
 *
 * During a draft, placement is refused and activation is allowed — the owner's
 * ruling of 2026-09-18, recorded in `DECISIONS.md`. A single `open`, which is
 * all `market` and `trading` need, cannot carry that:
 *
 * - bound to placement, it takes the Activate button away and strands a team
 *   over its limit with no legal way back under, which is the exact trap the
 *   ruling exists to prevent — **not reachable today**, since nothing can be on
 *   injured reserve during a draft, and written to the rule rather than to that
 *   accident for the reason `DECISIONS.md` gives;
 * - bound to activation, it renders a "To IR" button whose only outcome is 409.
 *   That one is reachable, and is the whole of what #316 turned out to be.
 *
 * **So this is not the shape `marketClosedReason` uses, deliberately.** That
 * function takes a move too, but its move only changes the *wording* — both
 * moves are refused in every state it closes — so its route can collapse the
 * *boolean* without losing anything.
 *
 * Its *notice* is a different story, and worth knowing before copying the shape:
 * `players/route.ts` passes `"ACQUIRE"` for both fields, so the `RELEASE`
 * sentence is discarded and `PlayerMarket` renders the acquire wording above a
 * hidden **Drop** button. Lossless in the boolean, lossy in the prose. Injured
 * reserve is the first rule here where the move changes the *answer*, so there
 * is no precedent to copy and copying one is how the asymmetry gets deleted.
 *
 * ## Why one sentence is enough for two controls
 *
 * `notice` is the placement sentence, and that is not a coin toss: placement is
 * shut in every state where activation is shut. The two differ only during a
 * draft, and there it is placement that refuses. So the placement sentence is
 * the one that covers both controls whenever either is missing.
 *
 * `ir-notice.test.ts` asserts that ordering rather than trusting it — this
 * function only composes, so the guarantee lives in the test and not here. Change
 * one of the six existing states so activation alone is shut and it goes red,
 * instead of the screen silently showing a sentence about the wrong button.
 *
 * **It does not cover a seventh state**, because nothing in TypeScript can
 * enumerate the `league_state` enum at runtime and the test iterates a written-out
 * list. A new value lands in the fallthrough, which is shut for both moves and so
 * satisfies the ordering by construction.
 */
export interface IrAvailability {
  /** Whether a player may be moved to injured reserve. */
  readonly place: boolean;
  /** Whether a stashed player may be brought back. */
  readonly activate: boolean;
  /** Why injured reserve is shut, or `null` when it is fully open. */
  readonly notice: string | null;
}

export function irAvailability(state: string): IrAvailability {
  const placeReason = irClosedReason(state, "PLACE");

  return {
    place: placeReason === null,
    activate: irClosedReason(state, "ACTIVATE") === null,
    notice: placeReason,
  };
}
