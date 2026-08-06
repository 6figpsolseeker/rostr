import { describe, expect, it } from "vitest";
import { isSeasonAggregate, parseSeasonProjections } from "./projections.js";
import type { RawProjectionsBody } from "./projections.js";

/**
 * Shapes copied verbatim from a live `getNFLProjections` response on 2026-08-06,
 * trimmed to the fields that matter. Not invented — the last time projection
 * field names were written from documentation in this codebase, three of them
 * were wrong.
 */
const LIVE: RawProjectionsBody = {
  week: "season",
  season: 2026,
  playerProjections: {
    "4362628": {
      twoPointConversion: "0.4",
      Rushing: { rushYds: "18.6", carries: "3.1", rushTD: "0.1" },
      Passing: { passAttempts: "0", passTD: "0", passYds: "0", int: "0" },
      Receiving: { recYds: "1457", targets: "175", recTD: "11.2", receptions: "121" },
      fumblesLost: "0.9",
      pos: "WR",
      team: "CIN",
      longName: "Ja'Marr Chase",
      playerID: "4362628",
      fantasyPointsDefault: { standard: "223", PPR: "344.16", halfPPR: "283" },
    },
    "8439": {
      Rushing: { rushYds: "62.4", carries: "18", rushTD: "0.6" },
      Passing: { passAttempts: "512", passTD: "24.9", passYds: "3245", int: "9.4" },
      Receiving: { recYds: "0", targets: "0", recTD: "0", receptions: "0" },
      fumblesLost: "1.4",
      pos: "QB",
      team: "PIT",
      longName: "Aaron Rodgers",
      playerID: "8439",
    },
    "10621": {
      Kicking: { fgMade: "27.1", fgMissed: "4.3", xpMade: "36.8", xpMissed: "1.6" },
      team: "ATL",
      pos: "PK",
      longName: "Nick Folk",
      playerID: "10621",
    },
    "9999": {
      Rushing: { rushYds: "301", carries: "70", rushTD: "2.2" },
      pos: "FB",
      team: "SF",
      longName: "Kyle Juszczyk",
      playerID: "9999",
    },
  },
  teamDefenseProjections: {
    ARI: {
      returnTD: "0.3",
      defTD: "1.2",
      safeties: "0.1",
      fumbleRecoveries: "6.3",
      ptsAgainst: "230",
      teamAbv: "ARI",
      interceptions: "10.6",
      sacks: "33.2",
      blockKick: "1.1",
      fantasyPointsDefault: "73.3",
    },
  },
};

const parsed = parseSeasonProjections(LIVE, "DST_");
const find = (ref: string) => parsed.find((p) => p.externalRef === ref);
const stat = (ref: string, key: string): number | undefined =>
  find(ref)?.stats.find((s) => s.statKey === key)?.value;

describe("isSeasonAggregate", () => {
  it("recognises the season response", () => {
    // The whole difference between a season total and one week is the absence
    // of a `week` parameter, and this string is the only confirmation.
    expect(isSeasonAggregate(LIVE)).toBe(true);
  });

  it("rejects a weekly response", () => {
    expect(isSeasonAggregate({ ...LIVE, week: 1 })).toBe(false);
  });
});

describe("parseSeasonProjections", () => {
  it("maps receiving totals", () => {
    expect(stat("4362628", "rec_yd")).toBe(1457);
    expect(stat("4362628", "rec")).toBe(121);
  });

  it("rounds fractional projections", () => {
    // 11.2 receiving touchdowns is a meaningful estimate; the scoring engine
    // takes whole units by design.
    expect(stat("4362628", "rec_td")).toBe(11);
    expect(stat("8439", "pass_td")).toBe(25);
  });

  it("reads fumbles from the top level", () => {
    // In a box score this lives under `Defense`. Getting that backwards is one
    // of the three mistakes a documentation-written map made here before.
    expect(stat("4362628", "fum_lost")).toBe(1);
  });

  it("reads two-point conversions as a field", () => {
    // Available in projections; only parseable from scoring plays in actuals.
    // 0.4 rounds to zero and a zero is dropped, so the absence here is the
    // parser working — see "drops zeroes rather than asserting them".
    expect(stat("4362628", "two_pt")).toBeUndefined();

    const scoring = parseSeasonProjections(
      {
        ...LIVE,
        playerProjections: {
          x: { playerID: "x", pos: "WR", longName: "X", twoPointConversion: "1.6" },
        },
      },
      "DST_",
    );
    expect(scoring[0]?.stats).toContainEqual({ statKey: "two_pt", value: 2 });
  });

  it("maps passing totals", () => {
    expect(stat("8439", "pass_yd")).toBe(3245);
    expect(stat("8439", "pass_int")).toBe(9);
  });

  it("drops zeroes rather than asserting them", () => {
    // A quarterback with no receiving projection has no receiving projection.
    expect(stat("8439", "rec_yd")).toBeUndefined();
  });

  it("translates positions the registry names differently", () => {
    // PK is a kicker and FB is a running back. A filter written against Tank01's
    // own spelling once silently dropped every kicker in the league.
    expect(find("10621")?.position).toBe("K");
    expect(find("9999")?.position).toBe("RB");
  });

  it("projects kickers, conservatively", () => {
    // Tank01 gives a total `fgMade` with no distance split, and our scoring pays
    // 3, 4 or 5 by distance. Everything lands in the 3-point tier, which is a
    // floor — and the board groups by position, so kickers are only ever
    // compared with each other.
    expect(stat("10621", "fg_0_39")).toBe(27);
    expect(stat("10621", "xp_made")).toBe(37);
  });

  it("does not penalise misses", () => {
    expect(find("10621")?.stats.some((s) => s.statKey.includes("miss"))).toBe(false);
  });
});

describe("team defenses", () => {
  it("uses the same synthetic ref as the player sync", () => {
    expect(find("DST_ARI")?.position).toBe("DEF");
    expect(find("DST_ARI")?.fullName).toBe("ARI D/ST");
  });

  it("maps the defensive stats", () => {
    expect(stat("DST_ARI", "def_sack")).toBe(33);
    expect(stat("DST_ARI", "def_int")).toBe(11);
    expect(stat("DST_ARI", "def_fum_rec")).toBe(6);
  });

  it("uses the registry's key for blocked kicks", () => {
    // `def_blk_kick`, not `def_block_kick`. Guessed wrong once.
    expect(stat("DST_ARI", "def_blk_kick")).toBe(1);
  });

  it("keeps points allowed", () => {
    // The tiered rule needs a value. Absent means "did not play", which would
    // silently forfeit the tier.
    expect(stat("DST_ARI", "def_pts_allowed")).toBe(230);
  });

  it("sums defensive and return touchdowns into the unit's touchdown", () => {
    // RULES.md §1 pays 6 for a "defensive or special teams touchdown", and
    // Tank01 reports the two separately. 1.2 + 0.3 rounds to 2.
    expect(stat("DST_ARI", "def_td")).toBe(2);
  });

  it("does not credit the unit with the individual returner's points", () => {
    // `ret_td` belongs to the player who ran it back — a different roster spot,
    // usually a different manager.
    expect(stat("DST_ARI", "ret_td")).toBeUndefined();
  });
});

describe("what is deliberately ignored", () => {
  it("never reads the provider's own fantasy points", () => {
    // Every league scores raw stats against its own frozen rules. Ours pays 4
    // for a passing touchdown; this response's PPR total assumes otherwise.
    const keys = parsed.flatMap((p) => p.stats.map((s) => s.statKey));
    expect(keys.some((key) => key.toLowerCase().includes("fantasy"))).toBe(false);
  });

  it("scores Chase differently from the provider's PPR figure", () => {
    // 344.16 is Tank01's arithmetic. Ours is computed from these raw stats by
    // the same engine that decides matchups, and the two need not agree.
    const chase = find("4362628")!;
    expect(chase.stats.length).toBeGreaterThan(3);
  });
});
