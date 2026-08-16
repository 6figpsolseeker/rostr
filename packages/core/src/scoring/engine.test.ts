import { describe, expect, it } from "vitest";
import { buildNflPprRules, NFL_PPR_ROSTER, NFL_PPR_SCORING } from "../rules/nfl-ppr.js";
import type { DraftRules, ScoringRule } from "../rules/types.js";
import {
  compareScores,
  formatPoints,
  indexScoringRules,
  scorePlayer,
  scoreTeamWeek,
  scoreTeamWeekWithRules,
  ScoringError,
} from "./engine.js";
import type { LineupEntry } from "./engine.js";
import { SCORING_FIXTURES } from "./fixtures.js";

const RULES = indexScoringRules(NFL_PPR_SCORING);

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

describe("scorePlayer — fixtures", () => {
  for (const fixture of SCORING_FIXTURES) {
    it(`${fixture.name}: ${fixture.workedOut}`, () => {
      expect(scorePlayer(fixture.stats, RULES)).toBe(fixture.expected);
    });
  }
});

describe("scorePlayer — linear rules", () => {
  it("scores 25 passing yards as exactly 1.00 point", () => {
    expect(scorePlayer([{ statKey: "pass_yd", value: 25 }], RULES)).toBe(1000);
  });

  it("scores 10 rushing yards as exactly 1.00 point", () => {
    expect(scorePlayer([{ statKey: "rush_yd", value: 10 }], RULES)).toBe(1000);
  });

  it("accumulates without drift across a full season", () => {
    // The failure this design exists to prevent. Seventeen weeks of a receiver
    // catching 7 for 83 — in floats, the error compounds; in integers it cannot.
    let total = 0;
    for (let week = 0; week < 17; week++) {
      total += scorePlayer(
        [
          { statKey: "rec", value: 7 },
          { statKey: "rec_yd", value: 83 },
        ],
        RULES,
      );
    }
    // (7 x 1000 + 83 x 100) x 17 = 15300 x 17 = 260100
    expect(total).toBe(260_100);
    expect(Number.isSafeInteger(total)).toBe(true);
  });

  it("handles negative rules", () => {
    expect(scorePlayer([{ statKey: "pass_int", value: 3 }], RULES)).toBe(-6000);
  });

  it("ignores stats the league does not score", () => {
    const sparse = indexScoringRules([
      { statKey: "rec", kind: "LINEAR", milliPointsPerUnit: 1000 },
    ]);
    const total = scorePlayer(
      [
        { statKey: "rec", value: 5 },
        { statKey: "rec_yd", value: 100 },
        { statKey: "rec_td", value: 2 },
      ],
      sparse,
    );
    expect(total).toBe(5000);
  });

  it("rejects a non-integer stat value", () => {
    expect(() => scorePlayer([{ statKey: "rec_yd", value: 12.5 }], RULES)).toThrow(
      ScoringError,
    );
  });

  it("rejects a non-integer rate in the rule itself", () => {
    // The other half of the same guard, and the one that was missing: a whole
    // stat value times a fractional rate is still a float in a total that
    // decides a matchup. Rates are milli-points — 0.04 points per yard is 40.
    //
    // Constructed by hand. `buildNflPprRules` hardcodes `NFL_PPR_SCORING` and
    // `NflPprOverrides` has no `scoring` field, so nothing shipping today can
    // hand the engine a rule set like this; `validateLeagueRules` now refuses it
    // as well. This is the engine refusing to be the place it goes unnoticed.
    const fractional = indexScoringRules([
      { statKey: "pass_yd", kind: "LINEAR", milliPointsPerUnit: 0.04 },
    ]);
    expect(() => scorePlayer([{ statKey: "pass_yd", value: 25 }], fractional)).toThrow(
      ScoringError,
    );
  });

  it("does not check a rate for a stat the player did not record", () => {
    // Matching how the stat-value check behaves: rules are consulted per stat
    // present, so a rule nobody triggered is nobody's problem. Otherwise adding
    // this guard would have turned an unused bad rule into a scoring outage.
    const fractional = indexScoringRules([
      { statKey: "pass_yd", kind: "LINEAR", milliPointsPerUnit: 0.04 },
      { statKey: "rec", kind: "LINEAR", milliPointsPerUnit: 1000 },
    ]);
    expect(scorePlayer([{ statKey: "rec", value: 5 }], fractional)).toBe(5000);
  });
});

describe("scorePlayer — tiered rules", () => {
  const tier = (value: number): number =>
    scorePlayer([{ statKey: "def_pts_allowed", value }], RULES);

  it("scores every boundary of the points-allowed ladder", () => {
    // Both edges of every bucket. Off-by-one here silently changes results,
    // and this ladder moved wholesale on 2026-08-16 to match ESPN — the values
    // below are theirs, decoded from their own published totals.
    expect(tier(0)).toBe(5000);
    expect(tier(1)).toBe(4000);
    expect(tier(6)).toBe(4000);
    expect(tier(7)).toBe(3000);
    expect(tier(13)).toBe(3000);
    expect(tier(14)).toBe(1000);
    expect(tier(17)).toBe(1000);
    expect(tier(18)).toBe(0);
    expect(tier(27)).toBe(0);
    expect(tier(28)).toBe(-1000);
    expect(tier(34)).toBe(-1000);
    expect(tier(35)).toBe(-3000);
    expect(tier(45)).toBe(-3000);
    expect(tier(46)).toBe(-5000);
  });

  it("has no gaps across the whole plausible range", () => {
    for (let points = 0; points <= 80; points++) {
      expect(() => tier(points)).not.toThrow();
    }
  });

  it("keeps scoring above the last bounded tier", () => {
    expect(tier(99)).toBe(-5000);
  });

  it("throws rather than silently scoring zero for an uncovered value", () => {
    // A negative points-allowed means the feed is broken. Scoring 0 would bury
    // that; throwing surfaces it.
    expect(() => tier(-1)).toThrow(ScoringError);
  });

  it("rejects a fractional award from the tier that matched", () => {
    // Hand-built: the shipped ladder is `NFL_PPR_SCORING`'s and there is no
    // override that could reach it. A tier's award goes straight into a team
    // total, so it gets the same treatment as a stat value and a linear rate.
    const fractional = indexScoringRules([
      {
        statKey: "def_pts_allowed",
        kind: "TIERED",
        tiers: [
          { min: 0, max: 0, milliPoints: 10.5 },
          { min: 1, max: null, milliPoints: 0 },
        ],
      },
    ]);

    expect(() => scorePlayer([{ statKey: "def_pts_allowed", value: 0 }], fractional)).toThrow(
      ScoringError,
    );

    // Only the tier that matched is checked — the same rule as above, so a bad
    // tier nobody landed in cannot take a week down.
    expect(scorePlayer([{ statKey: "def_pts_allowed", value: 24 }], fractional)).toBe(0);
  });

  it("does not score a tiered stat that is absent", () => {
    // Absent is not zero: a defense that did not play earns no shutout bonus.
    expect(scorePlayer([{ statKey: "def_sack", value: 2 }], RULES)).toBe(2000);
  });
});

describe("scoreTeamWeek", () => {
  const lineup: LineupEntry[] = [
    { slotType: "QB", playerId: "qb", stats: [{ statKey: "pass_td", value: 2 }] },
    { slotType: "RB", playerId: "rb1", stats: [{ statKey: "rush_yd", value: 100 }] },
    { slotType: "FLEX", playerId: "wr2", stats: [{ statKey: "rec", value: 4 }] },
    { slotType: "BN", playerId: "bench", stats: [{ statKey: "rec_td", value: 3 }] },
    { slotType: "IR", playerId: "injured", stats: [{ statKey: "rush_td", value: 1 }] },
  ];

  it("totals only the starting slots", () => {
    const result = scoreTeamWeek(lineup, RULES, NFL_PPR_ROSTER);
    // 8000 (2 pass TD) + 10000 (100 rush yd) + 4000 (4 rec) = 22000
    expect(result.milliPoints).toBe(22_000);
  });

  it("scores bench and IR but does not count them", () => {
    const result = scoreTeamWeek(lineup, RULES, NFL_PPR_ROSTER);

    const bench = result.players.find((p) => p.playerId === "bench");
    expect(bench?.milliPoints).toBe(18_000);
    expect(bench?.counted).toBe(false);

    const injured = result.players.find((p) => p.playerId === "injured");
    expect(injured?.counted).toBe(false);
  });

  it("counts FLEX, which is a starting slot", () => {
    const flex = scoreTeamWeek(lineup, RULES, NFL_PPR_ROSTER).players.find(
      (p) => p.slotType === "FLEX",
    );
    expect(flex?.counted).toBe(true);
  });

  it("returns every player, started or not", () => {
    expect(scoreTeamWeek(lineup, RULES, NFL_PPR_ROSTER).players).toHaveLength(5);
  });

  it("totals zero for an empty lineup", () => {
    expect(scoreTeamWeek([], RULES, NFL_PPR_ROSTER).milliPoints).toBe(0);
  });

  it("allows a negative team total", () => {
    const disaster: LineupEntry[] = [
      {
        slotType: "QB",
        playerId: "qb",
        stats: [
          { statKey: "pass_int", value: 4 },
          { statKey: "fum_lost", value: 1 },
        ],
      },
    ];
    expect(scoreTeamWeek(disaster, RULES, NFL_PPR_ROSTER).milliPoints).toBe(-10_000);
  });

  it("derives its slot filter from the league's own roster rules", () => {
    // A league whose only starting slot is QB must not count the RB.
    const qbOnly = { ...NFL_PPR_ROSTER, starters: [{ slotType: "QB", count: 1 }] };
    expect(scoreTeamWeek(lineup, RULES, qbOnly).milliPoints).toBe(8000);
  });
});

describe("scoreTeamWeekWithRules", () => {
  it("scores straight from a league rule set", () => {
    const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });
    const result = scoreTeamWeekWithRules(
      [{ slotType: "QB", playerId: "qb", stats: [{ statKey: "pass_yd", value: 250 }] }],
      rules,
    );
    expect(result.milliPoints).toBe(10_000);
  });
});

describe("formatPoints", () => {
  it("renders milli-points to two places", () => {
    expect(formatPoints(31_400)).toBe("31.40");
    expect(formatPoints(1000)).toBe("1.00");
    expect(formatPoints(0)).toBe("0.00");
    expect(formatPoints(-9280)).toBe("-9.28");
  });

  it("renders sub-point values exactly", () => {
    // 1 passing yard = 0.04 points. The value that would be worst hit by floats.
    expect(formatPoints(40)).toBe("0.04");
    expect(formatPoints(4)).toBe("0.00");
  });
});

describe("compareScores", () => {
  it("is exact — matchups decided by a hundredth resolve correctly", () => {
    expect(compareScores(100_010, 100_000)).toBe(1);
    expect(compareScores(100_000, 100_010)).toBe(-1);
  });

  it("reports an exact tie", () => {
    expect(compareScores(120_500, 120_500)).toBe(0);
  });
});

describe("scoring engine independence", () => {
  it("knows nothing about football", () => {
    // Invented sport, invented stats. If the engine needed football knowledge,
    // this could not work.
    const rules: ScoringRule[] = [
      { statKey: "wickets", kind: "LINEAR", milliPointsPerUnit: 25_000 },
      {
        statKey: "runs_conceded",
        kind: "TIERED",
        tiers: [
          { min: 0, max: 20, milliPoints: 5000 },
          { min: 21, max: null, milliPoints: -1000 },
        ],
      },
    ];

    const total = scorePlayer(
      [
        { statKey: "wickets", value: 3 },
        { statKey: "runs_conceded", value: 45 },
      ],
      indexScoringRules(rules),
    );

    expect(total).toBe(75_000 - 1000);
  });
});
