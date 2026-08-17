import { describe, expect, it } from "vitest";
import {
  bucketFieldGoal,
  isBlockedKick,
  isDefensiveReturnTouchdown,
  isExtraPointMade,
  isSpecialTeamsReturnTouchdown,
  isSuccessfulTwoPointConversion,
  parseFieldGoalYards,
  parseStatValue,
  TANK01_DST_MAP,
  TANK01_STAT_MAP,
  TANK01_TEAM_BLOCKED_KICK_FIELDS,
  TANK01_TEAM_DEF_ST_TD_FIELD,
  TANK01_UNMAPPED_PLAYER_DEFENSE_FIELDS,
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
    expect(bucketFieldGoal(53)).toBe("fg_50_59");
    expect(bucketFieldGoal(58)).toBe("fg_50_59");
  });

  it("is right at every boundary", () => {
    expect(bucketFieldGoal(0)).toBe("fg_0_39");
    expect(bucketFieldGoal(39)).toBe("fg_0_39");
    expect(bucketFieldGoal(40)).toBe("fg_40_49");
    expect(bucketFieldGoal(49)).toBe("fg_40_49");
    expect(bucketFieldGoal(50)).toBe("fg_50_59");
    // 59/60 is the boundary the ESPN alignment added, and the only one worth a
    // point on its own: a 59-yarder pays 5 and a 60-yarder pays 6. Twelve were
    // kicked in 2025, so it is reachable rather than theoretical.
    expect(bucketFieldGoal(59)).toBe("fg_50_59");
    expect(bucketFieldGoal(60)).toBe("fg_60_plus");
    expect(bucketFieldGoal(66)).toBe("fg_60_plus");
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

/** Verbatim return touchdowns from 2025 weeks 4, 8, 14 and 17. */
const REAL_RETURNS = {
  kickoff: "Rashid Shaheed 100 Yd Kickoff Return (Jason Myers Kick)",
  kickoff2: "Deonte Banks 95 Yd Kickoff Return (Ben Sauls Kick)",
  punt: "Marcus Jones 87 Yd Punt Return (Andy Borregales Kick)",
  puntWithTwoPoint: "Parker Washington 87 Yd Punt Return (Two-Point Pass Conversion Failed)",
  blockedPunt: "Sydney Brown 35 yd. return of blocked punt (J.Elliott kick)",
  blockedFieldGoal: "Jared Verse 76 Yd Return of Blocked Field Goal (Harrison Mevis Kick)",
  interception: "Christian Benford 63 Yd Interception Return (Matt Prater Kick)",
  interception2: "T.J. Edwards 34 Yd Interception Return (Cairo Santos Kick)",
} as const;

describe("isSpecialTeamsReturnTouchdown", () => {
  it("recognises kickoff returns", () => {
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.kickoff)).toBe(true);
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.kickoff2)).toBe(true);
  });

  it("recognises punt returns", () => {
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.punt)).toBe(true);
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.puntWithTwoPoint)).toBe(true);
  });

  it("recognises blocked-kick returns, including the lowercase variant", () => {
    // "35 yd. return of blocked punt (J.Elliott kick)" — different casing,
    // abbreviated name, full stop after "yd". Tank01's text is not uniform.
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.blockedPunt)).toBe(true);
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.blockedFieldGoal)).toBe(true);
  });

  it("does NOT count interception returns", () => {
    // The double-pay trap. These are defensive touchdowns, already scored as
    // def_td. Counting them here would pay one play under two rules.
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.interception)).toBe(false);
    expect(isSpecialTeamsReturnTouchdown(REAL_RETURNS.interception2)).toBe(false);
  });

  it("does not fire on ordinary touchdowns", () => {
    expect(isSpecialTeamsReturnTouchdown(REAL_PAT_FORMS.kickMade)).toBe(false);
    expect(isSpecialTeamsReturnTouchdown(REAL_PAT_FORMS.twoPointRun)).toBe(false);
  });
});

describe("isDefensiveReturnTouchdown", () => {
  it("recognises interception returns", () => {
    expect(isDefensiveReturnTouchdown(REAL_RETURNS.interception)).toBe(true);
  });

  it("is mutually exclusive with special teams returns", () => {
    // Every real return play must land in exactly one bucket.
    for (const text of Object.values(REAL_RETURNS)) {
      const special = isSpecialTeamsReturnTouchdown(text);
      const defensive = isDefensiveReturnTouchdown(text);
      expect(special && defensive, `both matched: ${text}`).toBe(false);
      expect(special || defensive, `neither matched: ${text}`).toBe(true);
    }
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
    expect(mapped).not.toContain("fg_50_59");
    expect(mapped).not.toContain("two_pt");
  });

  it("sources points allowed from the DST block only", () => {
    expect(TANK01_DST_MAP["ptsAllowed"]).toBe("def_pts_allowed");
    expect(Object.values(TANK01_STAT_MAP)).not.toContain("def_pts_allowed");
  });
});

/**
 * Blocked kicks are often **recovered**, not returned.
 *
 * Both strings below are verbatim Tank01 output and neither contains the word
 * "return" in a form the old pattern matched, so both scored as nothing: the
 * unit lost the 6 points `RULES.md` §1 pays for a special teams touchdown, and
 * `DST.defTD` reads "0" in the Kneeland game, so no other path made it up.
 */
const REAL_BLOCKED_KICK_TDS = {
  // 2025 week 9, 20251103_ARI@DAL. Captured as
  // __fixtures__/box-score-blocked-punt-td.json.
  kneeland: "Marshawn Kneeland Blocked Punt Recovery in End Zone (Brandon Aubrey Kick)",
  // docs/TANK01.md, and issue #158. Note Tank01's own typo, "Touchown".
  jordanDavis:
    "Blocked Kick Recovered by Jordan Davis (PHI) Jordan Davis 61 Yd Touchown Return",
} as const;

/**
 * The negative case, and the reason the new pattern is anchored on "blocked".
 *
 * **Every** fumble-return touchdown in the 2025 season is worded "Fumble
 * Recovery" rather than "Fumble Return". Adding a bare `recover` alternative to
 * the special teams pattern — the obvious repair for the two strings above —
 * therefore reclassifies **14 defensive touchdowns** as return touchdowns, which
 * pays each of them a second time on a second roster spot.
 */
const REAL_FUMBLE_RECOVERY_TDS = [
  "Tyler Lockett 0 Yd Fumble Recovery",
  "Zack Baun 12 Yd Fumble Recovery (Jake Elliott Kick)",
] as const;

describe("blocked kick touchdowns", () => {
  it("recognises a blocked kick recovered rather than returned", () => {
    expect(isSpecialTeamsReturnTouchdown(REAL_BLOCKED_KICK_TDS.kneeland)).toBe(true);
    expect(isSpecialTeamsReturnTouchdown(REAL_BLOCKED_KICK_TDS.jordanDavis)).toBe(true);
  });

  it("does NOT read a fumble recovery as a special teams return", () => {
    // The 14-touchdown trap. If this ever goes green the other way, one play is
    // being paid under two rules in two different roster spots.
    for (const text of REAL_FUMBLE_RECOVERY_TDS) {
      expect(isSpecialTeamsReturnTouchdown(text), text).toBe(false);
      expect(isDefensiveReturnTouchdown(text), text).toBe(true);
    }
  });

  it("does not fire on a touchdown that merely had its extra point blocked", () => {
    // "(Joshua Karty PAT blocked)" puts the word after the kick rather than
    // before it, and a blocked PAT is not a touchdown by anyone.
    expect(isSpecialTeamsReturnTouchdown(REAL_PAT_FORMS.patBlocked)).toBe(false);
    expect(isSpecialTeamsReturnTouchdown(REAL_PAT_FORMS.patBlocked2)).toBe(false);
  });

  it("leaves every previously recognised return where it was", () => {
    // Widening a pattern is how a fix becomes a regression. Every string the old
    // rule classified is re-asserted here rather than assumed.
    for (const text of Object.values(REAL_RETURNS)) {
      const special = isSpecialTeamsReturnTouchdown(text);
      const defensive = isDefensiveReturnTouchdown(text);
      expect(special && defensive, `both matched: ${text}`).toBe(false);
      expect(special || defensive, `neither matched: ${text}`).toBe(true);
    }
  });

  /**
   * Deliberately still unrecognised — see the comment on the pattern.
   *
   * It is not a blocked kick, the scorer is a running back rather than a
   * defender, and whether ESPN pays it as a return touchdown or as an offensive
   * fumble recovery has not been settled against a second source. Six points on a
   * rosterable player is not something to guess at. Refs #158.
   */
  it("still does not recognise a kickoff recovered in the end zone", () => {
    expect(
      isSpecialTeamsReturnTouchdown(
        "George Holani Recovered Kickoff in End Zone for a Touchdown",
      ),
    ).toBe(false);
  });
});

describe("no per-player defensive stat is mapped", () => {
  /**
   * `NFL_SLOT_TYPES` admits QB, RB, WR, TE, K and DEF. There is no IDP slot, so
   * the only roster spot a `def_*` key can reach is the D/ST — which is scored
   * from `TANK01_DST_MAP`. A per-player row keyed the same way is not an unused
   * row, it is a **duplicate** paid to whoever holds that player.
   */
  it("maps none of the individual Defense fields", () => {
    for (const field of TANK01_UNMAPPED_PLAYER_DEFENSE_FIELDS) {
      expect(TANK01_STAT_MAP[field], `${field} must not be mapped`).toBeUndefined();
    }
  });

  it("keeps the one Defense field that really is the offensive player's", () => {
    // He lost the ball; the points come off his own roster spot. Removing the
    // whole category would have been the mirror-image error.
    expect(TANK01_STAT_MAP["Defense.fumblesLost"]).toBe("fum_lost");
  });

  it("leaves every unit stat key to the DST block alone", () => {
    // Tyler Lockett, a wide receiver, was paid 6 points for "Tyler Lockett 0 Yd
    // Fumble Recovery" because `Defense.defTD` was mapped; three quarterbacks,
    // a receiver and a running back were paid 2 each for recovering their own
    // fumbles because `Defense.fumblesRecovered` was.
    const unitOnly = ["def_td", "def_sack", "def_int", "def_fum_rec", "def_safety"];
    const mapped = Object.values(TANK01_STAT_MAP);

    for (const statKey of unitOnly) {
      expect(mapped, `${statKey} must come from the DST block only`).not.toContain(statKey);
      expect(Object.values(TANK01_DST_MAP)).toContain(statKey);
    }
  });
});

describe("the team-level fields", () => {
  it("names the three blocked kick counters", () => {
    // Summed into one `def_blk_kick`. Verified against 20250907_ARI@NO, where
    // New Orleans — the blocking team — carries blockedFG "1".
    expect([...TANK01_TEAM_BLOCKED_KICK_FIELDS].sort()).toEqual([
      "blockedFG",
      "blockedPunt",
      "blockedXP",
    ]);
  });

  it("keeps the def/ST touchdown total out of the stat maps", () => {
    // A check, never a source: it double-counts a defensive player's return the
    // way this adapter used to, reading 2 for New England's single punt-return
    // touchdown in week 4.
    expect(Object.keys(TANK01_DST_MAP)).not.toContain(TANK01_TEAM_DEF_ST_TD_FIELD);
    expect(Object.keys(TANK01_STAT_MAP)).not.toContain(TANK01_TEAM_DEF_ST_TD_FIELD);
  });
});
