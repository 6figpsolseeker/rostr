/**
 * ESPN, asserted as a **republication** rather than offered as corroboration.
 *
 * ## ESPN is not a third source, and a column labelled "ESPN" would say it is
 *
 * Tank01 is an ESPN re-serialisation. Established 2026-08-17 and recorded in
 * `docs/TANK01.md`: the scoring-play text is byte-identical including trailing
 * whitespace and ESPN's own `"Touchown"` typo, the numeric stats match 42 of
 * 42, and `playerID` *is* the ESPN athlete id. Two readings of one feed are one
 * source. Putting them side by side under two headings is the most expensive
 * kind of green: it looks like `RULES.md` §7's two-provider agreement gate is
 * satisfied when nothing independent has been consulted.
 *
 * So this file does the opposite of corroborating. **It asserts the
 * republication itself** — that for every scoring play Tank01 serves, ESPN
 * serves the same sentence under the same abbreviation. That turns the vendor
 * assumption every other comparison in this repo rests on into something a test
 * can fail. If Tank01 ever starts writing its own play text, or files a play
 * under a `scoreType` ESPN does not use, this is what says so — and until it
 * does, nobody should read a Tank01/ESPN agreement as evidence about the world.
 *
 * Sleeper is the second source. See {@link ./sleeper.ts}.
 */

/** A scoring play as Tank01 serves it. */
export interface TankPlay {
  readonly score?: string | undefined;
  readonly scoreType?: string | undefined;
}

/** A scoring play as ESPN serves it, trimmed to the two fields compared. */
export interface EspnPlay {
  readonly text: string;
  /** ESPN's `scoringType.abbreviation`. Absent on at least one real play. */
  readonly abbreviation: string | null;
}

/**
 * The only normalisation applied before comparing two play texts.
 *
 * Trailing and repeated whitespace, and nothing else — no case folding, no
 * punctuation stripping, no token matching. ESPN pads some plays
 * (`"Jake Elliott 39 Yd Field Goal "`) and Tank01 does not always carry the
 * padding through, which is a fact about serialisation rather than about the
 * sentence. Anything looser would make the assertion vacuous: the claim being
 * made is that Tank01 does not write its own prose, and a comparison that
 * tolerates a reworded clause cannot detect the day it starts.
 */
export function normalisePlayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface RepublicationMismatch {
  readonly kind: "TEXT_NOT_IN_ESPN" | "TYPE_DISAGREES";
  readonly tankText: string;
  readonly tankScoreType: string | null;
  readonly espnAbbreviation?: string | null;
}

export interface RepublicationResult {
  readonly mismatches: readonly RepublicationMismatch[];
  /**
   * ESPN plays no Tank01 play claimed, verbatim and normalised.
   *
   * Not a failure on its own, but every one has to be declared in the manifest,
   * so a play Tank01 silently stopped serving cannot pass as an ESPN artifact.
   *
   * **Empty in every captured game**, and `espnExtraPlays` is therefore declared
   * by nobody. Kept because the asymmetry below is the point: this is the side
   * that is allowed to be explained, and the day it stops being empty somebody
   * has to look at why rather than watch a play quietly vanish.
   */
  readonly unmatchedEspn: readonly string[];
}

/**
 * Check every Tank01 scoring play against ESPN's list.
 *
 * **Matched by content, not by index**, and each ESPN play may be claimed only
 * once: a genuine duplicate in Tank01 needs a duplicate in ESPN to match it,
 * rather than both matching the same row. Four captured games do carry repeated
 * texts — Josh Allen three times in one of them — and in every case the repeat
 * is present on *both* sides, which is a real play happening twice rather than a
 * serialisation artifact.
 *
 * This used to say ESPN duplicates a play in at least one captured game, so the
 * arrays are not the same length. **They are the same length in all thirteen**,
 * and `unmatchedEspn` is empty everywhere. Content matching is still the right
 * design — it is what makes the claim-once rule expressible at all — but no
 * fixture currently exercises a length difference, so that branch is reasoned
 * rather than tested.
 *
 * The direction matters and is deliberately asymmetric. A Tank01 play with no
 * ESPN counterpart is a failure: it means Tank01 is serving something ESPN does
 * not, which is precisely the assumption this file exists to police. An ESPN
 * play with no Tank01 counterpart is reported for declaration instead, because
 * ESPN's list is the one known to contain repeats.
 *
 * **An absent `scoreType` compares equal to an absent abbreviation**, and to
 * nothing else. Tank01 leaves the field off some plays and ESPN leaves
 * `scoringType` null on some, and where both are silent there is no
 * disagreement to report. Where one names a type and the other does not, there
 * is.
 */
export function checkRepublication(
  tankPlays: readonly TankPlay[],
  espnPlays: readonly EspnPlay[],
): RepublicationResult {
  const mismatches: RepublicationMismatch[] = [];
  const claimed = new Set<number>();

  for (const play of tankPlays) {
    const text = normalisePlayText(play.score ?? "");
    const scoreType = play.scoreType?.trim() ? play.scoreType.trim() : null;

    const index = espnPlays.findIndex(
      (candidate, at) => !claimed.has(at) && normalisePlayText(candidate.text) === text,
    );

    if (index === -1) {
      mismatches.push({ kind: "TEXT_NOT_IN_ESPN", tankText: text, tankScoreType: scoreType });
      continue;
    }

    claimed.add(index);

    const espn = espnPlays[index];
    const abbreviation = espn?.abbreviation?.trim() ? espn.abbreviation.trim() : null;

    if (abbreviation !== scoreType) {
      mismatches.push({
        kind: "TYPE_DISAGREES",
        tankText: text,
        tankScoreType: scoreType,
        espnAbbreviation: abbreviation,
      });
    }
  }

  const unmatchedEspn = espnPlays
    .map((play, at) => (claimed.has(at) ? null : normalisePlayText(play.text)))
    .filter((text): text is string => text !== null);

  return { mismatches, unmatchedEspn };
}
