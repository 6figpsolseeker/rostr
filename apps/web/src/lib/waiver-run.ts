/**
 * How a settled waiver run reads.
 *
 * In `lib` for the reason `field.ts`, `chrome.ts` and `autofill.ts` record:
 * `apps/web` has no jsdom in either vitest project, so a sentence composed
 * inside a `.tsx` is verified only by being run in production. This one is the
 * product explaining a contest it decided while nobody was watching, which is
 * the worst place to be wrong.
 */

/**
 * Why a claim lost, in words.
 *
 * The four reasons are **not interchangeable**, which is the whole argument for
 * `0039` recording them:
 *
 *   - `PLAYER_TAKEN` is the system working exactly as the rules describe.
 *     Nobody did anything wrong and there is nothing to do differently.
 *   - `ROSTER_FULL` is a mistake the manager could have avoided, and will make
 *     again next Wednesday unless told.
 *   - `DROP_NOT_ON_ROSTER` is a claim that went stale — the player they offered
 *     to drop left by some other route before the run.
 *   - `ALREADY_ROSTERED` means somebody had him before the run even started.
 *
 * An unrecognised value falls back to a plain statement rather than throwing or
 * rendering the raw token. `failure_reason` is deliberately free text so a new
 * failure mode needs no migration, which means this function must expect one it
 * has never seen — and a screen showing `SOME_NEW_CODE` to a manager is worse
 * than one saying only that the claim did not succeed.
 */
export function whyClaimFailed(reason: string | null): string {
  switch (reason) {
    case "PLAYER_TAKEN":
      return "a team with better priority claimed him first";
    case "ROSTER_FULL":
      // **Not "named nobody to drop".** That was false in the case #237 created
      // and stays false in one the fix leaves behind: a stashed player who
      // recovers puts a team over the counted limit, so a claim naming a
      // perfectly valid drop is still refused. The panel prints the drop two
      // lines above this sentence, so the old wording denied, on one line, the
      // fact rendered on the line before it.
      return "your roster was still full, even after any drop the claim named";
    case "DROP_ON_IR":
      // The mistake this fix makes likely. Once claims start being awarded,
      // "drop the injured one" is the natural way to make room — and it is the
      // one drop that makes none, because he was not occupying a counted slot.
      return "the player you dropped was on injured reserve, so dropping him freed no roster space";
    case "DROP_NOT_ON_ROSTER":
      return "the player you offered to drop was no longer on your roster";
    case "ALREADY_ROSTERED":
      return "somebody already held him when the run began";
    case null:
      // Every loser since `0039` carries one. A null is a claim settled before
      // that migration, and inventing a reason for it would be worse than
      // admitting the record does not have one.
      return "this claim did not succeed, and the run did not record why";
    default:
      return "this claim did not succeed";
  }
}

/**
 * "3 claims · 1 awarded".
 *
 * Both numbers, always. "1 awarded" alone hides how contested the run was, and
 * how contested it was is the thing that makes losing legible.
 */
export function runSummary(input: {
  readonly total: number;
  readonly awarded: number;
}): string {
  const claims = input.total === 1 ? "1 claim" : `${input.total} claims`;
  return `${claims} · ${input.awarded} awarded`;
}
