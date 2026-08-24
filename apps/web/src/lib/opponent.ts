/**
 * "vs NO", "@ MIA", "BYE".
 *
 * In `lib` for the reason `field.ts`, `chrome.ts`, `autofill.ts` and
 * `waiver-run.ts` all record: `apps/web` has no jsdom in either vitest project,
 * so a string composed inside a `.tsx` is verified only by being run in
 * production.
 *
 * **`vs` and `@` rather than a home/away badge**, because it is the convention
 * every fantasy site already uses and it carries two facts in three characters.
 * A manager reading `@ KC` knows both who and where without a legend.
 */

export type Availability = "SCHEDULED" | "TIME_TBD" | "BYE" | "UNSCHEDULED";

export function opponentLabel(input: {
  readonly opponentRef: string | null;
  readonly isHome: boolean | null;
  readonly availability: Availability;
}): string | null {
  /*
    Availability decides first, and that ordering is the whole point.

    A bye and a fixture nobody has ingested both arrive here with no opponent,
    and they are opposite instructions: one says start somebody else, the other
    says he will play and we do not know the hour. `gameAvailability` already
    separates them from data this module does not have — bye weeks and the TBD
    flag — so re-deriving anything from the missing opponent would be a second,
    worse answer to a question already answered.
  */
  if (input.availability === "BYE") return "BYE";

  // A fixture we have not stored, or a player whose club we do not know. Not a
  // bye, and saying nothing is better than implying one — a manager who benches
  // somebody because the screen went quiet has been misled by an absence.
  // `availability` is what tells them which of the two this is.
  if (input.opponentRef === null || input.isHome === null) return null;

  return `${input.isHome ? "vs" : "@"} ${input.opponentRef}`;
}
