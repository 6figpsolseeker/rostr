/**
 * How the autofill preview reads.
 *
 * In `lib` rather than in `LineupEditor` for the reason `field.ts` and
 * `chrome.ts` record: `apps/web` has no jsdom in either vitest project, so a
 * sentence composed inside a `.tsx` is verified only by being run in
 * production. The wording here has a wrong answer worth catching — this is the
 * screen explaining a decision nobody was present for.
 */

export type RunnerUpReason = "LOWER_RANKED" | "UNAVAILABLE" | "NO_DATA";

export type AutofillMode = "WEEKLY_PROJECTION" | "SEASON_AVERAGE";

/**
 * "Projected lower", "On a bye or out", "No games played yet".
 *
 * Three sentences because they are three different instructions. Lower-ranked
 * says the autofill worked and you may disagree with it. Unavailable says the
 * alternative was never really one. No data says the autofill is guessing, and
 * your own opinion outranks its ordering — which is the case where a manager
 * most needs to be told rather than reassured.
 *
 * The mode is named in the first, because "projected lower" and "averaged
 * lower" are different claims and the league froze which one it makes.
 */
export function whyNot(reason: RunnerUpReason, mode: AutofillMode): string {
  switch (reason) {
    case "UNAVAILABLE":
      return "on a bye or out this week";
    case "NO_DATA":
      return mode === "WEEKLY_PROJECTION"
        ? "has no projection this week"
        : "has not played yet this season";
    case "LOWER_RANKED":
      return mode === "WEEKLY_PROJECTION" ? "projected lower" : "averaging lower";
  }
}

/**
 * The headline above the preview list.
 *
 * **Says nothing when the autofill is off**, which is the whole point of the
 * distinction: an empty slot with autofill off is a slot that scores zero, and
 * describing what the autofill "would" do there would be describing something
 * that is not going to happen.
 */
export function previewHeading(input: {
  readonly enabled: boolean;
  readonly emptySlots: number;
}): string | null {
  if (input.emptySlots === 0) return null;

  if (!input.enabled) {
    // The honest version of the same fact. A manager who turned autofill off and
    // then left a slot empty has made two separate decisions, and only the
    // second one is likely to be an accident.
    return input.emptySlots === 1
      ? "1 slot is empty and will score nothing — autofill is off."
      : `${input.emptySlots} slots are empty and will score nothing — autofill is off.`;
  }

  return input.emptySlots === 1
    ? "Autofill will fill 1 empty slot at kickoff:"
    : `Autofill will fill ${input.emptySlots} empty slots at kickoff:`;
}
