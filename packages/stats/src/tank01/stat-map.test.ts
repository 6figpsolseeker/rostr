import { describe, expect, it } from "vitest";
import {
  bucketFieldGoal,
  isBlockedKick,
  isExtraPointMade,
  isSuccessfulTwoPointConversion,
  parseFieldGoalYards,
  parseStatValue,
  TANK01_DST_MAP,
  TANK01_STAT_MAP,
} from "./stat-map.js";

/** Verbatim from the live probe of 20250904_DAL@PHI. */
const REAL_SCORING_PLAYS = [
  "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)",
  "Jalen Hurts 4 Yd Rush (Jake Elliott Kick)",
  "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)",
  "Jalen Hurts 8 Yd Rush (Jake Elliott Kick)",
  "Brandon Aubrey 41 Yd Field Goal",
  "Saquon Barkley 10 Yd Rush (Jake Elliott Kick)",
  "Brandon Aubrey 53 Yd Field Goal",
  "Jake Elliott 58 Yd Field Goal",
];

describe("parseFieldGoalYards", () => {
  it("reads distances from real scoring plays", () => {
    const distances = REAL_SCORING_PLAYS.map(parseFieldGoalYards).filter(
      (yards): yards is number => yards !== null,
    );
    expect(distances).toEqual([41, 53, 58]);
  });

  it("does not mistake a rushing touchdown for a field goal", () => {
    // "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)" contains both a yard
    // count and a kicker's name. A loose pattern would score it as a 1-yard FG.
    expect(parseFieldGoalYards("Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)")).toBeNull();
  });

  it("tolerates spacing and case variation", () => {
    expect(parseFieldGoalYards("Jake Elliott 58 yd field goal")).toBe(58);
    expect(parseFieldGoalYards("Jake Elliott 58Yd Field Goal")).toBe(58);
  });

  it("returns null on anything unrecognised", () => {
    expect(parseFieldGoalYards("")).toBeNull();
    expect(parseFieldGoalYards("Safety")).toBeNull();
  });
});

describe("bucketFieldGoal", () => {
  it("buckets the real distances correctly", () => {
    expect(bucketFieldGoal(41)).toBe("fg_40_49");
    expect(bucketFieldGoal(53)).toBe("fg_50_plus");
    expect(bucketFieldGoal(58)).toBe("fg_50_plus");
  });

  it("is right at every boundary", () => {
    expect(bucketFieldGoal(0)).toBe("fg_0_39");
    expect(bucketFieldGoal(39)).toBe("fg_0_39");
    expect(bucketFieldGoal(40)).toBe("fg_40_49");
    expect(bucketFieldGoal(49)).toBe("fg_40_49");
    expect(bucketFieldGoal(50)).toBe("fg_50_plus");
  });
});

describe("parseStatValue", () => {
  it("parses the string values Tank01 actually returns", () => {
    expect(parseStatValue("188")).toBe(188);
    expect(parseStatValue("0")).toBe(0);
    expect(parseStatValue("7")).toBe(7);
  });

  it("rounds decimals, since stat values are whole units", () => {
    expect(parseStatValue("6.3")).toBe(6);
    expect(parseStatValue("5.5")).toBe(6);
  });

  it("returns null for ratio fields rather than pretending they are numbers", () => {
    // sacked: "0-0", penalties: "4-42". Returning 0 would hide a bad mapping.
    expect(parseStatValue("0-0")).toBeNull();
    expect(parseStatValue("21-34")).toBeNull();
    expect(parseStatValue("25:08")).toBeNull();
  });

  it("returns null for junk", () => {
    expect(parseStatValue(undefined)).toBeNull();
    expect(parseStatValue(null)).toBeNull();
    expect(parseStatValue("")).toBeNull();
    expect(parseStatValue({})).toBeNull();
  });

  it("handles negatives", () => {
    expect(parseStatValue("-3")).toBe(-3);
  });
});

/**
 * Verbatim scoring-play text collected from 48 real games (2025 weeks 1-3).
 * Every string below was produced by Tank01, not written by hand.
 */
const REAL_PAT_FORMS = {
  kickMade: "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)",
  kickMadeApostrophe: "Nico Collins 29 Yd pass from C.J. Stroud (Ka'imi Fairbairn Kick)",
  patFailed: "Patrick Mahomes 11 Yd Rush (Harrison Butker PAT Failed)",
  patBlocked: "Blake Corum 1 Yd Rush (Joshua Karty PAT blocked)",
  patBlocked2: "Cam Skattebo 13 Yd Rush (Jamie Gillan PAT blocked)",
  twoPointRun: "Drake Maye 6 Yd Rush (Rhamondre Stevenson Run for Two-Point Conversion)",
  twoPointPass:
    "De'Von Achane 11 Yd pass from Tua Tagovailoa (Tua Tagovailoa Pass to Julian Hill for Two-Point Conversion)",
  twoPointFailed:
    "Travis Kelce 37 Yd pass from Patrick Mahomes (Two-Point Pass Conversion Failed)",
  blockedReturnTd:
    "Blocked Kick Recovered by Jordan Davis (PHI) Jordan Davis 61 Yd Touchown Return",
  safety: "Defensive Holding in Endzone for Safety",
} as const;

describe("isSuccessfulTwoPointConversion", () => {
  it("recognises a successful rushing conversion", () => {
    expect(isSuccessfulTwoPointConversion(REAL_PAT_FORMS.twoPointRun)).toBe(true);
  });

  it("recognises a successful passing conversion", () => {
    expect(isSuccessfulTwoPointConversion(REAL_PAT_FORMS.twoPointPass)).toBe(true);
  });

  it("does NOT award points for a failed conversion", () => {
    // The bug this exists to prevent. A match on "Two-Point" alone would score
    // two points for a conversion that did not happen.
    expect(isSuccessfulTwoPointConversion(REAL_PAT_FORMS.twoPointFailed)).toBe(false);
  });

  it("ignores ordinary kicks", () => {
    expect(isSuccessfulTwoPointConversion(REAL_PAT_FORMS.kickMade)).toBe(false);
    expect(isSuccessfulTwoPointConversion(REAL_PAT_FORMS.patFailed)).toBe(false);
  });
});

describe("isBlockedKick", () => {
  it("recognises a blocked extra point", () => {
    expect(isBlockedKick(REAL_PAT_FORMS.patBlocked)).toBe(true);
    expect(isBlockedKick(REAL_PAT_FORMS.patBlocked2)).toBe(true);
  });

  it("recognises a blocked kick returned for a touchdown", () => {
    // Note Tank01's own typo, "Touchown". Matching stable tokens rather than
    // whole phrases is why this still works.
    expect(isBlockedKick(REAL_PAT_FORMS.blockedReturnTd)).toBe(true);
  });

  it("does not fire on ordinary plays", () => {
    expect(isBlockedKick(REAL_PAT_FORMS.kickMade)).toBe(false);
    expect(isBlockedKick(REAL_PAT_FORMS.twoPointRun)).toBe(false);
  });
});

describe("isExtraPointMade", () => {
  it("recognises a made kick", () => {
    expect(isExtraPointMade(REAL_PAT_FORMS.kickMade)).toBe(true);
    expect(isExtraPointMade(REAL_PAT_FORMS.kickMadeApostrophe)).toBe(true);
  });

  it("rejects a failed or blocked attempt", () => {
    expect(isExtraPointMade(REAL_PAT_FORMS.patFailed)).toBe(false);
    expect(isExtraPointMade(REAL_PAT_FORMS.patBlocked)).toBe(false);
  });

  it("rejects a two-point conversion", () => {
    expect(isExtraPointMade(REAL_PAT_FORMS.twoPointRun)).toBe(false);
  });
});

describe("field goals against real plays", () => {
  it("finds distances only in genuine field goals", () => {
    // Every string here is real. The rushing touchdowns contain both a yard
    // count and a kicker's name, which is what breaks a loose pattern.
    expect(parseFieldGoalYards(REAL_PAT_FORMS.kickMade)).toBeNull();
    expect(parseFieldGoalYards(REAL_PAT_FORMS.twoPointRun)).toBeNull();
    expect(parseFieldGoalYards(REAL_PAT_FORMS.blockedReturnTd)).toBeNull();
    expect(parseFieldGoalYards("Brandon Aubrey 41 Yd Field Goal")).toBe(41);
  });
});

describe("mapping integrity", () => {
  const REGISTRY_KEYS = new Set([
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
    "fg_0_39",
    "fg_40_49",
    "fg_50_plus",
    "xp_made",
    "def_sack",
    "def_int",
    "def_fum_rec",
    "def_safety",
    "def_td",
    "def_blk_kick",
    "def_pts_allowed",
  ]);

  it("maps only to registry stat keys", () => {
    // A provider field name leaking through as a stat key would put Tank01's
    // vocabulary inside the scoring engine.
    for (const statKey of Object.values(TANK01_STAT_MAP)) {
      expect(REGISTRY_KEYS, `unknown stat key: ${statKey}`).toContain(statKey);
    }
    for (const statKey of Object.values(TANK01_DST_MAP)) {
      expect(REGISTRY_KEYS, `unknown stat key: ${statKey}`).toContain(statKey);
    }
  });

  it("keeps fumbles under Defense, where Tank01 actually puts them", () => {
    // Verified against a live box score. There is no Rushing.fumblesLost.
    expect(TANK01_STAT_MAP["Defense.fumblesLost"]).toBe("fum_lost");
    expect(TANK01_STAT_MAP["Rushing.fumblesLost"]).toBeUndefined();
    expect(TANK01_STAT_MAP["Receiving.fumblesLost"]).toBeUndefined();
  });

  it("does not map field goals or two-pointers as plain fields", () => {
    // Both come from scoringPlays. A Kicking.fgMade mapping would score every
    // field goal as if it were under 40 yards.
    const mapped = Object.values(TANK01_STAT_MAP);
    expect(mapped).not.toContain("fg_0_39");
    expect(mapped).not.toContain("fg_40_49");
    expect(mapped).not.toContain("fg_50_plus");
    expect(mapped).not.toContain("two_pt");
  });

  it("sources points allowed from the DST block only", () => {
    expect(TANK01_DST_MAP["ptsAllowed"]).toBe("def_pts_allowed");
    expect(Object.values(TANK01_STAT_MAP)).not.toContain("def_pts_allowed");
  });
});
