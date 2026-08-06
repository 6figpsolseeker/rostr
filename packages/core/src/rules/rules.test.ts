import { describe, expect, it } from "vitest";
import { NFL } from "../sports/nfl.js";
import { validateSport } from "../sports/types.js";
import { encodeLeagueRules, hashLeagueRules, verifyLeagueRulesHash } from "./hash.js";
import { buildNflPprRules, NFL_DEFAULT_PAYOUT, NFL_PPR_SCORING } from "./nfl-ppr.js";
import type { LeagueRules, PotRules } from "./types.js";
import { validateLeagueRules } from "./validate.js";

/**
 * A fully-specified rule set with every free variable pinned. Its hash is a
 * golden fixture: if it changes, the canonical encoding changed, and every
 * league created before that change can no longer be verified.
 */
const FIXTURE_POT: PotRules = {
  tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  buyInBaseUnits: "50000000",
  payout: NFL_DEFAULT_PAYOUT,
  refundUnlockAt: 1_773_000_000,
};

const FIXTURE: LeagueRules = buildNflPprRules({
  seasonYear: 2026,
  draft: { type: "SNAKE", mode: "SLOW", pickSeconds: 14_400, scheduledAt: 1_756_400_000 },
  pot: FIXTURE_POT,
});

describe("NFL sport registry", () => {
  it("is internally consistent", () => {
    expect(validateSport(NFL)).toEqual([]);
  });

  it("marks only points allowed as tiered", () => {
    const tiered = NFL.statKeys.filter((s) => s.kind === "TIERED").map((s) => s.key);
    expect(tiered).toEqual(["def_pts_allowed"]);
  });

  it("lets FLEX take RB, WR, or TE", () => {
    const flex = NFL.slotTypes.find((s) => s.key === "FLEX");
    expect(flex?.eligiblePositions).toEqual(["RB", "WR", "TE"]);
  });
});

describe("NFL PPR defaults", () => {
  it("matches the documented scoring table", () => {
    const byKey = new Map(NFL_PPR_SCORING.map((r) => [r.statKey, r]));
    const linear = (key: string): number => {
      const rule = byKey.get(key);
      if (rule?.kind !== "LINEAR") throw new Error(`${key} is not linear`);
      return rule.milliPointsPerUnit;
    };

    expect(linear("pass_td")).toBe(4000);
    expect(linear("rush_td")).toBe(6000);
    expect(linear("rec_td")).toBe(6000);
    expect(linear("pass_yd")).toBe(40); // 1 point per 25 yards
    expect(linear("rush_yd")).toBe(100); // 1 point per 10 yards
    expect(linear("rec_yd")).toBe(100);
    expect(linear("rec")).toBe(1000); // full PPR
    expect(linear("pass_int")).toBe(-2000);
    expect(linear("fum_lost")).toBe(-2000);
  });

  it("accumulates yardage without float drift", () => {
    // A single product often survives IEEE 754 intact — 0.04 * 25 really is 1.
    // Accumulation is where it fails, and a season is nothing but accumulation.
    let float = 0;
    for (let i = 0; i < 10; i++) float += 0.1;
    expect(float).not.toBe(1); // 0.9999999999999999

    let milli = 0;
    for (let i = 0; i < 10; i++) milli += 100;
    expect(milli).toBe(1000); // exactly 1.000 points

    // The classic, for the avoidance of doubt.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(100 + 200).toBe(300);
  });

  it("covers every points-allowed bucket contiguously and unbounded at the top", () => {
    const rule = NFL_PPR_SCORING.find((r) => r.statKey === "def_pts_allowed");
    if (rule?.kind !== "TIERED") throw new Error("expected a tiered rule");

    expect(rule.tiers[0]).toEqual({ min: 0, max: 0, milliPoints: 10_000 });
    expect(rule.tiers.at(-1)).toEqual({ min: 35, max: null, milliPoints: -4000 });

    for (const [i, tier] of rule.tiers.entries()) {
      const prev = rule.tiers[i - 1];
      if (prev) expect(tier.min).toBe((prev.max ?? -1) + 1);
    }
  });

  it("pays the champion the largest share, summing to 100%", () => {
    const total = NFL_DEFAULT_PAYOUT.reduce((s, p) => s + p.basisPoints, 0);
    expect(total).toBe(10_000);

    const champion = NFL_DEFAULT_PAYOUT.find((p) => p.prize === "CHAMPION");
    const largest = Math.max(...NFL_DEFAULT_PAYOUT.map((p) => p.basisPoints));
    expect(champion?.basisPoints).toBe(largest);
  });

  it("does not share references with the defaults it was built from", () => {
    // A league must be unreachable from a later edit to the default table.
    const rules = buildNflPprRules({
      seasonYear: 2026,
      draft: { type: "SNAKE", mode: "FAST", pickSeconds: 90, scheduledAt: 1 },
    });
    expect(rules.scoring).not.toBe(NFL_PPR_SCORING);
    expect(rules.scoring[0]).not.toBe(NFL_PPR_SCORING[0]);
  });
});

describe("validateLeagueRules", () => {
  const mutate = (fn: (draft: LeagueRules) => void): LeagueRules => {
    const draft = structuredClone(FIXTURE) as LeagueRules;
    fn(draft);
    return draft;
  };

  it("accepts the default rule set", () => {
    expect(validateLeagueRules(FIXTURE, NFL)).toEqual([]);
  });

  it("rejects an unknown stat key", () => {
    const bad = mutate((d) => {
      (d.scoring as { statKey: string }[])[0]!.statKey = "touchdowns_probably";
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("unknown stat key"),
    );
  });

  it("rejects a gap between tiers", () => {
    const bad = mutate((d) => {
      const rule = d.scoring.find((r) => r.statKey === "def_pts_allowed");
      if (rule?.kind === "TIERED") (rule.tiers as { max: number | null }[])[0]!.max = 2;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("gap or overlap"),
    );
  });

  it("rejects a tiered rule that does not end unbounded", () => {
    const bad = mutate((d) => {
      const rule = d.scoring.find((r) => r.statKey === "def_pts_allowed");
      if (rule?.kind === "TIERED") {
        (rule.tiers as { max: number | null }[]).at(-1)!.max = 99;
      }
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("unbounded tier"),
    );
  });

  it("rejects a pick clock below 90 seconds", () => {
    const bad = mutate((d) => {
      (d.draft as { mode: string; pickSeconds: number }).mode = "FAST";
      (d.draft as { pickSeconds: number }).pickSeconds = 30;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(expect.stringContaining("90 seconds"));
  });

  it("rejects payout shares that do not sum to 100%", () => {
    const bad = mutate((d) => {
      (d.pot!.payout as { basisPoints: number }[])[0]!.basisPoints = 5000;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("must be exactly 10000"),
    );
  });

  it("rejects a payout where the champion is not the largest share", () => {
    const bad = mutate((d) => {
      const payout = d.pot!.payout as { prize: string; basisPoints: number }[];
      payout.find((p) => p.prize === "CHAMPION")!.basisPoints = 1000;
      payout.find((p) => p.prize === "RUNNER_UP")!.basisPoints = 6500;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("CHAMPION must hold the largest"),
    );
  });

  it("rejects a paying finalisation window shorter than the stat-correction window", () => {
    const bad = mutate((d) => {
      (d.settlement as { payingFinalizationHours: number }).payingFinalizationHours = 48;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("at least 168"),
    );
  });

  it("rejects a non-deterministic final tiebreaker", () => {
    const bad = mutate((d) => {
      (d.schedule as { tiebreakers: string[] }).tiebreakers = ["WIN_PCT", "POINTS_FOR"];
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("must be LOWEST_TEAM_ID"),
    );
  });

  it("rejects a trade deadline after the regular season", () => {
    const bad = mutate((d) => {
      (d.trades as { deadlineWeek: number }).deadlineWeek = 15;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("falls after the regular season"),
    );
  });

  it("rejects a bracket whose rounds do not match its playoff weeks", () => {
    const bad = mutate((d) => {
      (d.schedule as { playoffWeeks: number[] }).playoffWeeks = [15, 16];
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(expect.stringContaining("rounds"));
  });

  it("requires two oracle sources when a pot exists", () => {
    const bad = mutate((d) => {
      (d.settlement as { requiredOracleSources: number }).requiredOracleSources = 1;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("two independent oracle sources"),
    );
  });

  it("requires at least two humans", () => {
    const bad = mutate((d) => {
      (d.league as { minHumans: number }).minHumans = 1;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("at least 2 humans"),
    );
  });
});

describe("hashLeagueRules", () => {
  it("is independent of key insertion order", () => {
    // Same data, rebuilt with its top-level keys inserted in reverse order.
    const reordered = Object.fromEntries(Object.entries(FIXTURE).reverse()) as LeagueRules;

    expect(Object.keys(reordered)).not.toEqual(Object.keys(FIXTURE));
    expect(reordered).toEqual(FIXTURE);
    expect(hashLeagueRules(reordered)).toBe(hashLeagueRules(FIXTURE));
  });

  it("is independent of nested key insertion order", () => {
    const nested = structuredClone(FIXTURE) as Record<string, unknown>;
    nested["pot"] = Object.fromEntries(Object.entries(FIXTURE.pot!).reverse());

    expect(hashLeagueRules(nested as LeagueRules)).toBe(hashLeagueRules(FIXTURE));
  });

  it("changes when any rule changes", () => {
    const base = hashLeagueRules(FIXTURE);
    const nudged = structuredClone(FIXTURE) as LeagueRules;
    (nudged.trades as { vetoWindowHours: number }).vetoWindowHours = 47;
    expect(hashLeagueRules(nudged)).not.toBe(base);
  });

  it("verifies against an expected hash", () => {
    expect(verifyLeagueRulesHash(FIXTURE, hashLeagueRules(FIXTURE))).toBe(true);
    expect(verifyLeagueRulesHash(FIXTURE, "0".repeat(64))).toBe(false);
  });

  it("accepts an uppercase expected hash", () => {
    expect(verifyLeagueRulesHash(FIXTURE, hashLeagueRules(FIXTURE).toUpperCase())).toBe(true);
  });

  it("encodes to bytes that re-hash to the same value", () => {
    const encoded = encodeLeagueRules(FIXTURE);
    expect(JSON.parse(encoded)).toEqual(FIXTURE);
    expect(encoded).not.toContain("\n");
  });

  it("GOLDEN: the pinned fixture hash has not moved", () => {
    // If this fails, either the canonical encoding changed or the default rule
    // set did. Work out which before touching this value.
    //
    //   - Encoding changed  -> every league ever created is now unverifiable.
    //                          Fix the encoding, never the constant.
    //   - Defaults changed  -> only new leagues are affected; existing ones hold
    //                          frozen copies. Updating the constant is correct,
    //                          and the commit must say what moved and why.
    //
    // Last moved: 2026-08-05, roster changed to one FLEX instead of two
    // (QB/RB/RB/WR/WR/TE/FLEX/K/DEF). No leagues existed.
    expect(hashLeagueRules(FIXTURE)).toBe(
      "df3a5e0445c67dff9fc1b3f54fcdfaed0853c2adbe844830edd48b6e4a486d43",
    );
  });
});
