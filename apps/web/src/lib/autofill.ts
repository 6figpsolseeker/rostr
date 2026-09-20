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
      /*
        **Names no cause, deliberately, and it used to name two.**

        `unavailable` has four: a bye, an out designation, no NFL club, and a
        fixture we cannot locate. The sentence said "on a bye or out this week",
        so from #327 onwards it told a manager that a released player was
        resting — specific, plausible and false, which is the failure
        `byeChip` and the scoreboard's separate "no club" chip both exist to
        prevent.

        Enumerating all four here would be worse than either: this sentence
        answers "why was he passed over", and the answer is the same for all of
        them — he was not a real alternative. **Which** reason applies is a fact
        about that player, and his own row already carries it precisely, from
        `weekNote` — "bye", "no club", "TBD" — where a manager deciding whether
        to hold the roster spot will actually look.
      */
      return "not expected to play this week";
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

  // Not "will fill": the list below may say a slot stays empty, because the
  // autofill will not start a player whose game has already kicked off and may
  // have nobody left who has not. Nor "at kickoff" — the fill runs through the
  // week, and the checkbox above no longer claims otherwise either.
  return input.emptySlots === 1
    ? "1 empty slot, and what autofill would do with it:"
    : `${input.emptySlots} empty slots, and what autofill would do with them:`;
}
