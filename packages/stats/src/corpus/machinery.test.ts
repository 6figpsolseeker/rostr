/**
 * The corpus machinery, exercised on its **failure** branches.
 *
 * `corpus.test.ts` runs all of this against thirteen real games, and those games
 * are chosen to reconcile — so every guard in here answers "no problem" thirteen
 * times and nothing proves it can answer anything else. A guard that has never
 * fired is indistinguishable from a guard that cannot fire, and the whole
 * argument for the corpus is that it notices. This file is where "it notices"
 * stops being an assumption.
 *
 * Everything below is hand-built and tiny: no fixture, no network, no
 * credentials, and no dependency on which games happen to be captured. A test
 * that reached for a real game would go red the day somebody swapped a fixture
 * for a better one, which is exactly the coupling the corpus is meant to absorb.
 */

import { describe, expect, it } from "vitest";
import { indexScoringRules, NFL_PPR_SCORING } from "@rostr/core";
import { checkRepublication, normalisePlayText } from "./espn.js";
import { buildLedger, serialiseLedger } from "./ledger.js";
import type { KnownDisagreement, Manifest, ManifestGame, Unjoinable } from "./manifest.js";
import { manifestProblems } from "./manifest.js";
import {
  SLEEPER_UNMAPPED_DST_FIELDS,
  SLEEPER_UNMAPPED_PLAYER_FIELDS,
  sleeperPlayerStats,
  sleeperTeamDefenseStats,
} from "./sleeper.js";

// ---------------------------------------------------------------------------
// manifest.ts
// ---------------------------------------------------------------------------

const CLASSES: readonly string[] = ["CLASS_A", "CLASS_B"];

const game = (over: Partial<ManifestGame> = {}): ManifestGame => ({
  gameRef: "20250101_AAA@BBB",
  season: 2025,
  week: 1,
  boxScore: "aaa.json",
  why: "it carries the only shutout in the corpus",
  classes: ["CLASS_A", "CLASS_B"],
  ...over,
});

const disagreement = (over: Partial<KnownDisagreement> = {}): KnownDisagreement => ({
  gameRef: "20250101_AAA@BBB",
  subject: "player:1",
  kind: "DEFECT",
  reason: "we pay the returner and Sleeper pays the unit",
  issue: 155,
  ourMilliPoints: 6000,
  sleeperMilliPoints: 0,
  ...over,
});

const unjoinable = (over: Partial<Unjoinable> = {}): Unjoinable => ({
  ref: "1",
  name: "A Player",
  reason: "Sleeper serves no row for him at all",
  issue: 157,
  ...over,
});

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  games: [game()],
  knownDisagreements: [],
  unjoinable: [],
  ...over,
});

/**
 * A manifest entry as it can actually arrive off disk.
 *
 * `readManifest` in `fixtures.ts` is `JSON.parse(...) as Manifest` — an
 * assertion, never a validation — so the checked-in file really can carry a
 * `kind` outside the union or no `issue` at all, and `manifestProblems` is the
 * only thing standing between that file and a silently suppressed comparison.
 * These casts reproduce a hand-edited JSON file, not a TypeScript mistake.
 */
const fromDisk = <T>(raw: Record<string, unknown>): T => raw as unknown as T;

describe("manifestProblems", () => {
  it("reports nothing when every game, disagreement and exclusion is well formed", () => {
    expect(
      manifestProblems(
        manifest({ knownDisagreements: [disagreement()], unjoinable: [unjoinable()] }),
        CLASSES,
      ),
    ).toEqual([]);
  });

  it("catches the same game listed twice", () => {
    // Two rows for one gameRef means one ledger, one Sleeper fixture and one
    // ESPN fixture read under two sets of expectations, and the second row's
    // `why` and `classes` are then decorative.
    expect(manifestProblems(manifest({ games: [game(), game()] }), CLASSES)).toContain(
      "20250101_AAA@BBB appears twice",
    );
  });

  it("catches a game with a blank why", () => {
    // Whitespace rather than the empty string, because that is what a half-typed
    // entry looks like and a bare truthiness check would pass it.
    expect(manifestProblems(manifest({ games: [game({ why: "   " })] }), CLASSES)).toContain(
      '20250101_AAA@BBB has no "why"',
    );
  });

  it("catches a game that claims no coverage class", () => {
    const problems = manifestProblems(
      // The second game keeps both registered classes claimed, so the only
      // complaint left is the empty one.
      manifest({ games: [game({ classes: [] }), game({ gameRef: "20250102_CCC@DDD" })] }),
      CLASSES,
    );

    expect(problems).toEqual([
      expect.stringContaining("20250101_AAA@BBB claims no coverage class"),
    ]);
  });

  it("catches a game claiming a class that classes.ts does not register", () => {
    const problems = manifestProblems(
      manifest({ games: [game({ classes: ["CLASS_A", "CLASS_B", "CLASS_TYPO"] })] }),
      CLASSES,
    );

    expect(problems).toEqual(["20250101_AAA@BBB claims unknown class CLASS_TYPO"]);
  });

  it("catches a registered class that no game claims", () => {
    // The guard the corpus exists for. A coverage class nobody covers is a
    // capability the suite advertises and does not have, and it looks green.
    const problems = manifestProblems(manifest({ games: [game({ classes: ["CLASS_A"] })] }), [
      ...CLASSES,
      "CLASS_UNCOVERED",
    ]);

    expect(problems).toEqual([
      expect.stringContaining(
        "class CLASS_B is registered in classes.ts and no game claims it",
      ),
      expect.stringContaining("class CLASS_UNCOVERED is registered in classes.ts"),
    ]);
  });

  it("catches a disagreement naming a game that is not in the corpus", () => {
    // A renamed or dropped game leaves its exceptions behind, and an exception
    // attached to nothing is one nobody will ever watch expire.
    const problems = manifestProblems(
      manifest({ knownDisagreements: [disagreement({ gameRef: "20250102_CCC@DDD" })] }),
      CLASSES,
    );

    expect(problems).toEqual(["disagreement 20250102_CCC@DDD player:1 names no corpus game"]);
  });

  it("catches a disagreement with a blank reason", () => {
    const problems = manifestProblems(
      manifest({ knownDisagreements: [disagreement({ reason: " \n " })] }),
      CLASSES,
    );

    expect(problems).toEqual(["disagreement 20250101_AAA@BBB player:1 has no reason"]);
  });

  it.each([
    ["missing", fromDisk<KnownDisagreement>({ ...disagreement(), issue: undefined })],
    ["zero", disagreement({ issue: 0 })],
    ["negative", disagreement({ issue: -3 })],
    ["fractional", disagreement({ issue: 12.5 })],
  ])("catches a disagreement whose issue number is %s", (_label, entry) => {
    const problems = manifestProblems(manifest({ knownDisagreements: [entry] }), CLASSES);

    expect(problems).toEqual(["disagreement 20250101_AAA@BBB player:1 has no issue number"]);
  });

  it("catches a disagreement whose kind is outside the union", () => {
    // DEFECT and DELIBERATE are not decoration: one is expected to shrink and
    // then vanish, the other to sit there indefinitely. A third value makes a
    // neglected entry indistinguishable from a decided one.
    const problems = manifestProblems(
      manifest({
        knownDisagreements: [fromDisk<KnownDisagreement>({ ...disagreement(), kind: "KNOWN" })],
      }),
      CLASSES,
    );

    expect(problems).toEqual([
      "disagreement 20250101_AAA@BBB player:1 does not say whether it is a defect or a decision",
    ]);
  });

  it("catches an unjoinable player with a blank reason", () => {
    const problems = manifestProblems(
      manifest({ unjoinable: [unjoinable({ reason: "" })] }),
      CLASSES,
    );

    expect(problems).toEqual(["unjoinable 1 has no reason"]);
  });

  it.each([
    ["missing", fromDisk<Unjoinable>({ ...unjoinable(), issue: undefined })],
    ["zero", unjoinable({ issue: 0 })],
    ["fractional", unjoinable({ issue: 1.5 })],
  ])("catches an unjoinable player whose issue number is %s", (_label, entry) => {
    const problems = manifestProblems(manifest({ unjoinable: [entry] }), CLASSES);

    expect(problems).toEqual(["unjoinable 1 has no issue number"]);
  });

  it("catches an ESPN type disagreement with a blank reason", () => {
    // The same rule the Sleeper exceptions follow, and it did not apply here
    // until review noticed. A type disagreement is declared in order to
    // *suppress* a comparison, so a blank justification is indistinguishable
    // from one nobody thought about — and this is the one exception list whose
    // entries cannot be traced to an issue, which makes the prose all there is.
    const problems = manifestProblems(
      manifest({
        games: [game({ espnTypeDisagreements: [{ text: "A Player 1 Yd Run", reason: "  " }] })],
      }),
      CLASSES,
    );

    expect(problems).toEqual([
      '20250101_AAA@BBB espn type disagreement "A Player 1 Yd Run" has no reason',
    ]);
  });

  it("accepts an ESPN type disagreement with no issue number, and refuses a bad one", () => {
    // Optional on purpose: an ESPN type disagreement is two serialisations of
    // one event disagreeing about what to call it, which may be a filing
    // convention with no defect behind it. Forcing a number would mean inventing
    // one, and a wrong issue link is worse than none. Present-but-nonsense is
    // still refused.
    const withNone = game({
      espnTypeDisagreements: [{ text: "A Player 1 Yd Run", reason: "ESPN leaves it null" }],
    });
    expect(manifestProblems(manifest({ games: [withNone] }), CLASSES)).toEqual([]);

    const withBad = game({
      espnTypeDisagreements: [
        { text: "A Player 1 Yd Run", reason: "ESPN leaves it null", issue: 0 },
      ],
    });
    expect(manifestProblems(manifest({ games: [withBad] }), CLASSES)).toEqual([
      '20250101_AAA@BBB espn type disagreement "A Player 1 Yd Run" has an issue number that is not one',
    ]);
  });

  it("catches one subject declared twice", () => {
    // Two rows explaining the same comparison: the staleness check matches
    // whichever it reaches first, so the other can rot indefinitely while still
    // looking like a live exception.
    const problems = manifestProblems(
      manifest({ knownDisagreements: [disagreement(), disagreement()] }),
      CLASSES,
    );

    expect(problems).toContain("disagreement 20250101_AAA@BBB player:1 is declared twice");
  });

  it("catches one unjoinable player declared twice", () => {
    expect(
      manifestProblems(manifest({ unjoinable: [unjoinable(), unjoinable()] }), CLASSES),
    ).toContain("unjoinable 1 is declared twice");
  });

  it.each([
    ["ourMilliPoints", disagreement({ ourMilliPoints: 6000.5 })],
    ["sleeperMilliPoints", disagreement({ sleeperMilliPoints: 0.1 })],
  ])("catches a non-integer %s", (label, entry) => {
    // Milli-points are integers everywhere in this repo, and a pinned float is
    // worse than a wrong integer: it can never equal a real total, so the entry
    // reports as a moved gap on every run and the noise trains somebody to stop
    // reading it.
    const problems = manifestProblems(manifest({ knownDisagreements: [entry] }), CLASSES);

    expect(problems).toEqual([
      `disagreement 20250101_AAA@BBB player:1 has a non-integer ${label}`,
    ]);
  });

  it("reports every problem rather than the first", () => {
    // The house style, and the reason this returns rather than throws: somebody
    // repairing a manifest should see the whole list in one pass instead of
    // discovering the next fault only after fixing each one.
    const problems = manifestProblems(
      manifest({
        games: [game({ why: "", classes: ["CLASS_A", "CLASS_NOPE"] }), game()],
        knownDisagreements: [disagreement({ reason: "", issue: 0 })],
        unjoinable: [unjoinable({ reason: "", issue: 0 })],
      }),
      CLASSES,
    );

    expect(problems).toEqual([
      '20250101_AAA@BBB has no "why"',
      "20250101_AAA@BBB claims unknown class CLASS_NOPE",
      "20250101_AAA@BBB appears twice",
      "disagreement 20250101_AAA@BBB player:1 has no reason",
      "disagreement 20250101_AAA@BBB player:1 has no issue number",
      "unjoinable 1 has no reason",
      "unjoinable 1 has no issue number",
    ]);
  });
});

// ---------------------------------------------------------------------------
// espn.ts
// ---------------------------------------------------------------------------

describe("normalisePlayText", () => {
  it("collapses runs of whitespace and trims, and changes nothing else", () => {
    // ESPN pads some plays and Tank01 does not always carry the padding through,
    // which is a fact about serialisation rather than about the sentence.
    // Anything looser — case folding, token matching — would stop the comparison
    // detecting the day Tank01 starts writing its own prose, which is the only
    // thing it is for. ESPN's own "Touchown" typo survives untouched.
    expect(normalisePlayText("  A Kicker 39 Yd\n Field  Goal ")).toBe(
      "A Kicker 39 Yd Field Goal",
    );
    expect(normalisePlayText("A Back 3 Yd Touchown Run")).toBe("A Back 3 Yd Touchown Run");
  });
});

describe("checkRepublication", () => {
  it("reports nothing when every play matches by text and by type", () => {
    const result = checkRepublication(
      [
        { score: "A Kicker 39 Yd Field Goal", scoreType: "FG" },
        { score: "A Back 3 Yd Run", scoreType: "TD" },
      ],
      [
        { text: "A Kicker 39 Yd Field Goal", abbreviation: "FG" },
        { text: "A Back 3 Yd Run", abbreviation: "TD" },
      ],
    );

    expect(result).toEqual({ mismatches: [], unmatchedEspn: [] });
  });

  it("matches across whitespace-only differences", () => {
    const result = checkRepublication(
      [{ score: "A Kicker 39 Yd Field Goal", scoreType: "FG" }],
      [{ text: "  A Kicker 39 Yd  Field Goal ", abbreviation: "FG" }],
    );

    expect(result).toEqual({ mismatches: [], unmatchedEspn: [] });
  });

  it("fails a Tank01 play ESPN does not serve", () => {
    // The failing direction, and deliberately the asymmetric one: a sentence
    // Tank01 has and ESPN does not is Tank01 writing its own text, which is the
    // assumption this whole comparison exists to police.
    const result = checkRepublication(
      [{ score: "A Back 3 Yd Rush Touchdown", scoreType: "TD" }],
      [{ text: "A Back 3 Yd Touchown Run", abbreviation: "TD" }],
    );

    expect(result.mismatches).toEqual([
      { kind: "TEXT_NOT_IN_ESPN", tankText: "A Back 3 Yd Rush Touchdown", tankScoreType: "TD" },
    ]);
    // The ESPN row nobody claimed is still reported, so one reworded sentence
    // surfaces from both sides rather than only as a missing play.
    expect(result.unmatchedEspn).toEqual(["A Back 3 Yd Touchown Run"]);
  });

  it("reports an ESPN play no Tank01 play claims, without failing on it", () => {
    // Explainable rather than wrong, which is why it lands in `unmatchedEspn`
    // for declaration in the manifest instead of in `mismatches`.
    const result = checkRepublication(
      [{ score: "A Back 3 Yd Run", scoreType: "TD" }],
      [
        { text: "A Back 3 Yd Run", abbreviation: "TD" },
        { text: "A Receiver 12 Yd Pass From A Passer", abbreviation: "TD" },
      ],
    );

    expect(result.mismatches).toEqual([]);
    expect(result.unmatchedEspn).toEqual(["A Receiver 12 Yd Pass From A Passer"]);
  });

  it("reports a scoreType disagreement on a play whose text matched", () => {
    // The known real case: a kickoff recovered in the end zone, which ESPN
    // leaves untyped and Tank01 files as `TD`.
    const result = checkRepublication(
      [{ score: "Kickoff Recovered In End Zone", scoreType: "TD" }],
      [{ text: "Kickoff Recovered In End Zone", abbreviation: null }],
    );

    expect(result.mismatches).toEqual([
      {
        kind: "TYPE_DISAGREES",
        tankText: "Kickoff Recovered In End Zone",
        tankScoreType: "TD",
        espnAbbreviation: null,
      },
    ]);
  });

  it("treats an absent scoreType and an absent abbreviation as agreeing", () => {
    // Both sides silent is no disagreement to report. A blank string counts as
    // absent on either side, so a provider that starts sending `""` where it
    // used to omit the field does not produce a page of spurious mismatches.
    const result = checkRepublication(
      [{ score: "Untyped Play One" }, { score: "Untyped Play Two", scoreType: "  " }],
      [
        { text: "Untyped Play One", abbreviation: null },
        { text: "Untyped Play Two", abbreviation: " " },
      ],
    );

    expect(result.mismatches).toEqual([]);
  });

  it("reports a disagreement when only one side names a type", () => {
    const result = checkRepublication(
      [{ score: "One Sided Play" }],
      [{ text: "One Sided Play", abbreviation: "TD" }],
    );

    expect(result.mismatches).toEqual([
      {
        kind: "TYPE_DISAGREES",
        tankText: "One Sided Play",
        tankScoreType: null,
        espnAbbreviation: "TD",
      },
    ]);
  });

  it("lets each ESPN play be claimed only once", () => {
    /*
      No captured game exercises this, and `espn.ts` says so itself: Tank01 and
      ESPN serve the same number of plays in all thirteen, and the repeated texts
      repeat on both sides. It is the branch that decides what content matching
      *means* — without the claim-once rule two identical Tank01 plays would both
      find the single ESPN row, and a play Tank01 had started emitting twice
      would read as a perfect republication.
    */
    const result = checkRepublication(
      [
        { score: "A Passer 1 Yd Run", scoreType: "TD" },
        { score: "A Passer 1 Yd Run", scoreType: "TD" },
      ],
      [{ text: "A Passer 1 Yd Run", abbreviation: "TD" }],
    );

    expect(result.mismatches).toEqual([
      { kind: "TEXT_NOT_IN_ESPN", tankText: "A Passer 1 Yd Run", tankScoreType: "TD" },
    ]);
    expect(result.unmatchedEspn).toEqual([]);
  });

  it("matches a genuine repeat when both sides carry it twice", () => {
    // The other half of the same rule. Four captured games do carry repeated
    // texts, and a real play that happened twice must not be reported as a
    // mismatch merely because the sentences are identical.
    const result = checkRepublication(
      [
        { score: "A Passer 1 Yd Run", scoreType: "TD" },
        { score: "A Passer 1 Yd Run", scoreType: "TD" },
      ],
      [
        { text: "A Passer 1 Yd Run", abbreviation: "TD" },
        { text: "A Passer 1 Yd Run", abbreviation: "TD" },
      ],
    );

    expect(result).toEqual({ mismatches: [], unmatchedEspn: [] });
  });
});

// ---------------------------------------------------------------------------
// sleeper.ts
// ---------------------------------------------------------------------------

/** Stat lines as a plain object, so a test can name a key rather than an index. */
const byKey = (lines: readonly { statKey: string; value: number }[]): Record<string, number> =>
  Object.fromEntries(lines.map(({ statKey, value }) => [statKey, value]));

describe("sleeperPlayerStats", () => {
  it("maps the one-to-one fields and drops the ones at zero", () => {
    // Absent is zero for an ordinary counter on both sides, so an explicit zero
    // is dropped rather than emitted. The two tiered D/ST rules are the
    // exception, and they live on the unit side below.
    expect(byKey(sleeperPlayerStats({ pass_yd: 300, pass_td: 2, rush_yd: 0 }))).toEqual({
      pass_yd: 300,
      pass_td: 2,
    });
  });

  it("sums the three two-point fields into one two_pt", () => {
    // Sleeper splits a conversion by how it was scored where we carry one key.
    // Reading any single field would make every conversion of the other two
    // kinds look like a disagreement about what happened on the field.
    expect(byKey(sleeperPlayerStats({ pass_2pt: 1, rush_2pt: 1, rec_2pt: 2 }))).toEqual({
      two_pt: 4,
    });
  });

  it("sums the three sub-40 field goal buckets into fg_0_39", () => {
    // Our table pays the same for all three, so the split carries nothing we can
    // use — but dropping any one of them under-counts a kicker.
    expect(
      byKey(sleeperPlayerStats({ fgm_0_19: 1, fgm_20_29: 2, fgm_30_39: 1, fgm_40_49: 1 })),
    ).toEqual({ fg_0_39: 4, fg_40_49: 1 });
  });

  it("reads the return touchdown from st_td", () => {
    /*
      `st_td` is Sleeper's *Special Teams Player* category rather than their
      *Special Teams Defense* one, and that distinction is what stops a return
      touchdown being paid twice: the same play pays the returner `st_td` and his
      unit `def_st_td`, on two different roster spots, exactly as `RULES.md` §1
      keeps `ret_td` apart from `def_td`.
    */
    expect(byKey(sleeperPlayerStats({ st_td: 1 }))).toEqual({ ret_td: 1 });
  });

  it("reads a missed field goal from fgmiss", () => {
    expect(byKey(sleeperPlayerStats({ fgmiss: 2 }))).toEqual({ fg_missed: 2 });
  });

  it.each(SLEEPER_UNMAPPED_PLAYER_FIELDS)("ignores %s", (field) => {
    /*
      The regression guard that matters most in this file. Every name in the list
      is a plausible-looking field that would double-count if somebody helpfully
      mapped it next to the ones that are read: `misc_td` carries the same return
      touchdown as `st_td` — Kneeland and Hunter Long both have it in the
      corpus — `fgm` is the sum of every made-field-goal bucket, and `fgm_50p` is
      a superset of two mapped buckets. Feeding each one a value and asserting
      the output does not move is what makes "deliberately not read" testable
      rather than a comment.
    */
    const baseline = byKey(sleeperPlayerStats({ rec: 4, rec_yd: 52 }));

    expect(byKey(sleeperPlayerStats({ rec: 4, rec_yd: 52, [field]: 3 }))).toEqual(baseline);
  });
});

describe("sleeperTeamDefenseStats", () => {
  it("maps the one-to-one unit fields", () => {
    expect(
      byKey(sleeperTeamDefenseStats({ sack: 3, int: 1, safe: 1, blk_kick: 1, def_2pt: 1 })),
    ).toEqual({
      def_sack: 3,
      def_int: 1,
      def_safety: 1,
      def_blk_kick: 1,
      def_2pt_ret: 1,
      def_pts_allowed: 0,
      def_yds_allowed: 0,
    });
  });

  it("sums fum_rec and def_st_fum_rec into def_fum_rec", () => {
    // Sleeper files a recovery made on a kick or punt in the second field and
    // pays the unit for both. Reading only `fum_rec` would report a disagreement
    // on every muffed punt against a Tank01 side that has them. No corpus game
    // carries `def_st_fum_rec`, so this is the only place that half runs.
    expect(
      byKey(sleeperTeamDefenseStats({ fum_rec: 2, def_st_fum_rec: 1 }))["def_fum_rec"],
    ).toBe(3);
  });

  it("sums def_td and def_st_td into def_td", () => {
    // `RULES.md` §1 pays the unit 6 for a defensive *or special teams* touchdown
    // and we carry one key for both; Sleeper carries two. The sum is also what
    // catches a translator paying an ESPN-defensive return twice — it shows up
    // as a 6-point excess on our side rather than as agreement.
    expect(byKey(sleeperTeamDefenseStats({ def_td: 1, def_st_td: 1 }))["def_td"]).toBe(2);
  });

  it("emits def_pts_allowed and def_yds_allowed for a shutout that reports neither", () => {
    /*
      The one place absent is *not* zero. Both are tiered rules and the scoring
      engine reads a missing tiered stat as "did not play", so a unit that
      pitched a shutout — and therefore has no `pts_allow` key at all — would
      forfeit the top tier rather than earn it. `box-score.ts` makes the same
      correction on the Tank01 side for the same reason.
    */
    const stats = byKey(sleeperTeamDefenseStats({ sack: 2 }));

    expect(stats["def_pts_allowed"]).toBe(0);
    expect(stats["def_yds_allowed"]).toBe(0);
  });

  it("emits both tiered keys even for a unit with nothing else at all", () => {
    expect(byKey(sleeperTeamDefenseStats({}))).toEqual({
      def_pts_allowed: 0,
      def_yds_allowed: 0,
    });
  });

  it("carries pts_allow and yds_allow through when they are present", () => {
    expect(byKey(sleeperTeamDefenseStats({ pts_allow: 24, yds_allow: 388 }))).toEqual({
      def_pts_allowed: 24,
      def_yds_allowed: 388,
    });
  });

  it.each(SLEEPER_UNMAPPED_DST_FIELDS)("ignores %s", (field) => {
    /*
      The unit side needs this as much as the player side does, and did not have
      it until recently: `misc_td` duplicates `def_st_td` for four units in the
      corpus, and `fg_blkd`/`punt_blkd` sit on the team whose kick was blocked
      rather than the team that blocked it, so mapping either would pay the wrong
      unit. The `pts_allow_*` buckets are a second encoding of `pts_allow`, which
      is read whole.
    */
    const baseline = byKey(sleeperTeamDefenseStats({ sack: 2, pts_allow: 13 }));

    expect(byKey(sleeperTeamDefenseStats({ sack: 2, pts_allow: 13, [field]: 1 }))).toEqual(
      baseline,
    );
  });
});

// ---------------------------------------------------------------------------
// ledger.ts
// ---------------------------------------------------------------------------

const RULES = indexScoringRules(NFL_PPR_SCORING);

/**
 * The smallest box score that exercises the three things a ledger decides.
 *
 * One player has no category block at all, so the empty-row rule shows up here
 * rather than as a three-thousand-line diff across the real ledgers.
 *
 * **The ids are 999 and 1000 on purpose, and a first draft that used "1" and
 * "2" proved nothing.** A Tank01 `playerID` is an integer-shaped string, and
 * JavaScript walks integer-shaped object keys in ascending *numeric* order
 * whatever order they were written in — so with single-digit ids the map
 * iteration and `byRef`'s *lexicographic* sort agree by accident and deleting
 * the sort changes nothing. Across a decade boundary they disagree: 999 is
 * translated first and sorts last.
 */
const BOX = {
  gameID: "20250101_AAA@BBB",
  playerStats: {
    "999": {
      playerID: "999",
      longName: "Zeta Receiver",
      Receiving: { receptions: "3", recYds: "40" },
    },
    "1000": {
      playerID: "1000",
      longName: "Alpha Passer",
      Passing: { passYds: "300", passTD: "2" },
    },
    "1001": { playerID: "1001", longName: "Long Snapper" },
  },
};

describe("buildLedger", () => {
  it("omits rows with no stats while still counting them in playersTranslated", () => {
    /*
      A real box score is around ninety players and most of them are long
      snappers; writing ninety empty rows a game would bury the twenty that
      matter and make every diff unreadable. Dropping them *without* counting
      them would let a player silently vanish from the translation with no signal
      anywhere, which is the job `playersTranslated` does.
    */
    const ledger = buildLedger(BOX, RULES);

    expect(ledger.playersTranslated).toBe(3);
    expect(ledger.players.map((entry) => entry.ref)).toEqual(["1000", "999"]);
  });

  it("sorts rows by ref rather than by the order the translator emitted them", () => {
    // Map iteration is insertion order, which here is the order the provider's
    // JSON was walked. An unrelated reordering upstream would otherwise rewrite
    // every ledger in the corpus and bury a real change in the noise. See the
    // note on `BOX` for why these two ids disagree about what "first" means.
    const ledger = buildLedger(BOX, RULES);

    expect(ledger.players.map((entry) => entry.name)).toEqual([
      "Alpha Passer",
      "Zeta Receiver",
    ]);
  });

  it("sorts the stat keys within a row", () => {
    // The same argument one level down: `passYds` is declared before `passTD` in
    // the fixture above, so an unsorted row would emit `pass_yd` first.
    const [passer] = buildLedger(BOX, RULES).players;

    expect(Object.keys(passer?.stats ?? {})).toEqual(["pass_td", "pass_yd"]);
  });

  it("scores each row with our own table", () => {
    const [passer, receiver] = buildLedger(BOX, RULES).players;

    // 300 passing yards at 40 milli-points each, plus two touchdowns at 4 points.
    expect(passer?.milliPoints).toBe(20_000);
    // Full PPR: three receptions at a point each, forty yards at 100 milli.
    expect(receiver?.milliPoints).toBe(7_000);
  });

  it("carries the game reference and reports no fatal for a readable response", () => {
    const ledger = buildLedger(BOX, RULES);

    expect(ledger.gameRef).toBe("20250101_AAA@BBB");
    expect(ledger.fatal).toEqual([]);
  });
});

describe("serialiseLedger", () => {
  it("emits two-space JSON with a trailing newline, which is what prettier writes", () => {
    // These files stay inside `format:check` rather than needing a
    // `.prettierignore` entry, so a hand edit that reformats one is caught by
    // the formatter as well as by the corpus comparison.
    const ledger = buildLedger(BOX, RULES);
    const text = serialiseLedger(ledger);

    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")[1]).toBe('  "gameRef": "20250101_AAA@BBB",');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(ledger)));
  });
});
