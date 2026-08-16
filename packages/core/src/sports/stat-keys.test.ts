import { describe, expect, it } from "vitest";
import { NFL } from "./nfl.js";

/**
 * **Stat keys are append-only.** Renaming or removing one silently zeroes that
 * stat for every league frozen before the change.
 *
 * ## The failure this exists to prevent
 *
 * A league's scoring table is copied into `league_rules.rule_json` at creation
 * and never rewritten — that is the whole point of the frozen rules. The stats
 * pipeline, meanwhile, always runs the current code. So the two are joined by
 * nothing but the stat key string, and `scorePlayer` skips a stat with no
 * matching rule, by design and correctly:
 *
 *   > Stats with no matching rule score nothing — a league is free to ignore a
 *   > stat the sport defines.
 *
 * Rename `fg_50_plus` to `fg_50_59`, and every league created before the rename
 * has a rule for a key the adapter no longer emits, and receives a key it has no
 * rule for. Its kickers score **zero** for fifty-yard field goals. No error, no
 * warning, no failing test — the hash still verifies and the league still loads.
 *
 * This is not hypothetical. It happened on 2026-08-16, and the four leagues in
 * the deployed database at the time are still wrong in exactly this way. They
 * were test leagues, which is the only reason it cost nothing.
 *
 * ## Why a pinned list rather than a lint rule
 *
 * The information needed is *historical* — which keys have ever existed — and
 * the code only knows the present. So the history is written down, the same
 * shape as the golden rules hash and for the same reason: a value that must not
 * drift needs somewhere to be compared against.
 *
 * Adding a key needs no change here. That is the point: additions are always
 * safe, and this test should never be in the way of one.
 */

/**
 * Every NFL stat key that has ever been part of the registry.
 *
 * **Add to this when you add a key. Never delete from it.** A key that is
 * genuinely gone belongs in `RETIRED` below, with a reason.
 */
const EVER_DEFINED = [
  "pass_yd",
  "pass_td",
  "pass_int",
  "rush_yd",
  "rush_td",
  "rec",
  "rec_yd",
  "rec_td",
  "fum_lost",
  "two_pt",
  "ret_td",
  "fg_0_39",
  "fg_40_49",
  "fg_50_plus",
  "fg_50_59",
  "fg_60_plus",
  "fg_missed",
  "xp_made",
  "def_sack",
  "def_int",
  "def_fum_rec",
  "def_safety",
  "def_td",
  "def_blk_kick",
  "def_pts_allowed",
  "def_yds_allowed",
] as const;

/**
 * Keys deliberately removed, and why it was safe at the time.
 *
 * Putting one here is a decision with a cost, not a tidy-up. Before adding an
 * entry, establish that **no league in any deployed database holds a scoring
 * rule referencing it** — `SELECT` against `league_rules.rule_json`, not a
 * belief about whether leagues exist. After 22 August 2026 the honest answer is
 * usually that removal is not available, and the key should be left defined and
 * unscored instead.
 */
const RETIRED: Readonly<Record<string, string>> = {
  fg_50_plus:
    "Split into fg_50_59 and fg_60_plus on 2026-08-16 to match ESPN, which pays 6 " +
    "for a 60-yarder. Four test leagues in the deployed database still reference " +
    "this key and score 50+ field goals as zero as a result; they were recreated " +
    "rather than migrated, because a frozen rule set cannot be migrated.",
};

describe("stat keys are append-only", () => {
  const current = new Set(NFL.statKeys.map((k) => k.key));

  it("still defines every key that has ever existed, except those formally retired", () => {
    const gone = EVER_DEFINED.filter((key) => !current.has(key) && !(key in RETIRED));

    expect(
      gone,
      `${gone.join(", ")} disappeared from the registry. A league frozen while that key ` +
        `existed holds a scoring rule for it, and scorePlayer skips a stat with no rule — ` +
        `so those leagues now score it as zero, silently and permanently. Either put the ` +
        `key back, or add it to RETIRED with evidence that no deployed league references it.`,
    ).toEqual([]);
  });

  it("records every registry key in the history", () => {
    // The other direction: adding a key without recording it here would let the
    // next person remove it without this test noticing.
    const unrecorded = [...current].filter(
      (key) => !(EVER_DEFINED as readonly string[]).includes(key),
    );

    expect(
      unrecorded,
      `${unrecorded.join(", ")} is in the registry but not in EVER_DEFINED. Add it — the ` +
        `list is what makes a later removal detectable.`,
    ).toEqual([]);
  });

  it("gives a reason for every retired key, and does not retire a live one", () => {
    for (const [key, reason] of Object.entries(RETIRED)) {
      expect(
        (EVER_DEFINED as readonly string[]).includes(key),
        `${key} is retired but was never in EVER_DEFINED`,
      ).toBe(true);

      // A key both retired and still defined means somebody restored it and
      // left the tombstone behind, which would hide the next real removal.
      expect(current.has(key), `${key} is listed as retired but is still defined`).toBe(false);

      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(
        40,
      );
    }
  });

  it("has no duplicates in the history", () => {
    expect(new Set(EVER_DEFINED).size).toBe(EVER_DEFINED.length);
  });
});
