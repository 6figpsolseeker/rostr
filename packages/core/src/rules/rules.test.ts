import { describe, expect, it } from "vitest";
import { CanonicalEncodingError } from "../canonical.js";
import { indexScoringRules, scorePlayer, ScoringError } from "../scoring/engine.js";
import { NFL } from "../sports/nfl.js";
import { validateSport } from "../sports/types.js";
import { encodeLeagueRules, hashLeagueRules, verifyLeagueRulesHash } from "./hash.js";
import {
  buildNflPprRules,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
  NFL_PPR_SCORING,
  NFL_WINNER_TAKE_ALL_PAYOUT,
} from "./nfl-ppr.js";
import type { LeagueRules, PotRules } from "./types.js";
import { earliestRefundUnlock, latestRefundUnlock, validateLeagueRules } from "./validate.js";

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
  feeBps: NFL_DEFAULT_FEE_BPS,
  feeRecipient: "6dNUCTMTgoHhbfgDzKtiPvBpJ2LzMwGqBpKmUDgQtNMK",
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

  // ---------------------------------------------------------------------------
  // Scoring numbers: integers, and a ladder that covers what a feed can emit.
  //
  // **No shipped path can produce any of the rule sets below.** `NflPprOverrides`
  // has no `scoring` field and `buildNflPprRules` hardcodes `NFL_PPR_SCORING`, so
  // every one of them is built here by hand, out of a clone of the fixture. These
  // checks are defence for a custom-scoring feature that does not exist yet, and
  // for anything that assembles a `LeagueRules` directly rather than through the
  // builder — which is every test in this repo, and `@rostr/db`'s `createLeague`,
  // whose `rules` argument is just a value.
  // ---------------------------------------------------------------------------

  /** Replace the points-allowed ladder, by hand. Nothing in the app does this. */
  const withTiers = (tiers: { min: number; max: number | null; milliPoints: number }[]) =>
    mutate((d) => {
      const rule = d.scoring.find((r) => r.statKey === "def_pts_allowed");
      if (rule?.kind === "TIERED") (rule as { tiers: unknown }).tiers = tiers;
    });

  it("rejects a fractional milli-points-per-unit", () => {
    // 0.04 points per passing yard is 40 milli-points, not 0.04. Written the
    // wrong way it is a float in the frozen rules, which is what milli-points
    // exist to prevent — and `canonicalize` refuses to encode it, so before this
    // check league creation failed at the encoder with validation having just
    // said the rules were fine.
    const bad = mutate((d) => {
      const rule = d.scoring.find((r) => r.statKey === "pass_yd");
      if (rule?.kind === "LINEAR")
        (rule as { milliPointsPerUnit: number }).milliPointsPerUnit = 0.04;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("not a whole number"),
    );
    expect(() => encodeLeagueRules(bad)).toThrow(CanonicalEncodingError);
  });

  it("rejects a fractional tier award", () => {
    const bad = withTiers([
      { min: 0, max: 0, milliPoints: 10.5 },
      { min: 1, max: null, milliPoints: 0 },
    ]);
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("non-integer milliPoints"),
    );
  });

  it("rejects a fractional tier bound as itself, not as a gap", () => {
    // The structural walk does arithmetic on the bounds, so left to run it
    // would also report "expected min 7.5, got 7" — advice to start a tier at
    // 7.5, which is itself illegal. The name of this test is the assertion:
    // the creator is told the one true thing, not that plus a confident lie.
    const bad = withTiers([
      { min: 0, max: 6.5, milliPoints: 7000 },
      { min: 7, max: null, milliPoints: 0 },
    ]);
    const problems = validateLeagueRules(bad, NFL);

    expect(problems).toContainEqual(expect.stringContaining("non-integer max"));
    expect(problems).not.toContainEqual(expect.stringContaining("gap or overlap"));
  });

  it("blames the ladder's real floor, not whichever tier is written first", () => {
    // An out-of-order ladder is rejected either way, by the ordering check. But
    // reporting "a value of 0 falls below every tier" about a ladder whose
    // second tier covers 0 would be a true verdict reached by a false claim.
    const bad = withTiers([
      { min: 7, max: null, milliPoints: 0 },
      { min: 0, max: 6, milliPoints: 7000 },
    ]);
    const problems = validateLeagueRules(bad, NFL);

    expect(problems).not.toContainEqual(
      expect.stringContaining("a value of 0 falls below every tier"),
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  it("rejects a ladder whose floor sits above zero", () => {
    // The one with teeth. A ladder starting at 1 is contiguous with itself and
    // hashes cleanly, because the contiguity loop seeds `expectedMin` from
    // `tiers[0].min` — so nothing anywhere constrained the floor. A shutout is
    // then a value no tier covers, and a shutout is real: the Tank01 adapter
    // emits `def_pts_allowed: 0` deliberately, as a fact rather than an absence.
    const bad = withTiers([
      { min: 1, max: 6, milliPoints: 7000 },
      { min: 7, max: null, milliPoints: 0 },
    ]);

    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("a value of 0 falls below every tier"),
    );

    // And this is what such a league would have done on the first shutout of the
    // season, having been frozen and therefore being uncorrectable: not a wrong
    // score, a throw — which takes down every other matchup in that league-week
    // too, since `resolveWeek` scores all teams before it resolves any.
    expect(() =>
      scorePlayer([{ statKey: "def_pts_allowed", value: 0 }], indexScoringRules(bad.scoring)),
    ).toThrow(ScoringError);
  });

  it("accepts a ladder whose floor is negative", () => {
    // The rule is "covers zero", not "starts at zero". A tiered stat may
    // legitimately run negative — nothing in `@rostr/core` knows what a stat can
    // emit, and `StatKeyDef` carries no domain — so a floor below zero is not
    // ours to refuse. It is also not ours to vouch for: this ladder still throws
    // at -21, and no check in this file can see that.
    const ok = withTiers([
      { min: -20, max: 0, milliPoints: 10_000 },
      { min: 1, max: null, milliPoints: 0 },
    ]);
    expect(validateLeagueRules(ok, NFL)).toEqual([]);
  });

  /**
   * The four numeric fields a request can actually set.
   *
   * Unlike the scoring cases above, these **are** reachable — `seasonYear`,
   * `draftAt`, `tradeDeadlineWeek` and the pot's `refundUnlockAt` all come
   * straight from `POST /api/leagues`. Before this they reached the encoder
   * unchecked: a fractional one became an unhandled 500 rather than a problem
   * the creator could read, and a *wrongly typed* one was not caught at all.
   */
  describe("numeric fields from the request", () => {
    it("rejects a fractional value with a named problem", () => {
      const bad = mutate((d) => {
        (d as { seasonYear: number }).seasonYear = 2026.5;
      });
      expect(validateLeagueRules(bad, NFL)).toContainEqual(
        expect.stringContaining("seasonYear must be a whole number"),
      );
    });

    it("rejects a value of the wrong type, which the encoder does not", () => {
      // The one that mattered. `canonicalize` checks that a *number* is a safe
      // integer; it does not check that a number is a number. A `seasonYear` of
      // "2026" — or of [1, 2] — validated clean and hashed clean, freezing a
      // league permanently around a value of the wrong type, with no way back.
      for (const wrong of ["2026", [1, 2], null] as const) {
        const bad = mutate((d) => {
          (d as { seasonYear: unknown }).seasonYear = wrong;
        });

        expect(validateLeagueRules(bad, NFL)).toContainEqual(
          expect.stringContaining("seasonYear must be a whole number"),
        );
      }
    });

    it("covers the draft, trade and pot fields too", () => {
      for (const [path, mutation] of [
        [
          "draft.scheduledAt",
          (d: LeagueRules) => ((d.draft as { scheduledAt: number }).scheduledAt = 1.5),
        ],
        [
          "trades.deadlineWeek",
          (d: LeagueRules) => ((d.trades as { deadlineWeek: number }).deadlineWeek = 11.5),
        ],
        [
          "pot.refundUnlockAt",
          (d: LeagueRules) => ((d.pot as { refundUnlockAt: number }).refundUnlockAt = 1.5),
        ],
      ] as const) {
        expect(validateLeagueRules(mutate(mutation), NFL)).toContainEqual(
          expect.stringContaining(`${path} must be a whole number`),
        );
      }
    });

    it("says nothing about a free league's absent pot", () => {
      const free = mutate((d) => {
        (d as { pot: unknown }).pot = null;
      });
      expect(validateLeagueRules(free, NFL)).toEqual([]);
    });
  });

  it("rejects a pick clock below 90 seconds", () => {
    const bad = mutate((d) => {
      (d.draft as { mode: string; pickSeconds: number }).mode = "FAST";
      (d.draft as { pickSeconds: number }).pickSeconds = 30;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(expect.stringContaining("90 seconds"));
  });

  it("rejects a buy-in below the minimum", () => {
    const bad = mutate((d) => {
      (d.pot as { buyInBaseUnits: string }).buyInBaseUnits = "4999999";
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("below the 5000000 base-unit minimum"),
    );
  });

  it("rejects a buy-in above the cap", () => {
    const bad = mutate((d) => {
      (d.pot as { buyInBaseUnits: string }).buyInBaseUnits = "50000001";
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("above the 50000000 base-unit cap"),
    );
  });

  // The bounds are a range, not a price list. Any amount between them is legal,
  // down to a single base unit — cents included, no granularity rule.
  it.each([
    "5000000", // $5.00, the floor
    "5000001", // one base unit above it
    "7250000", // $7.25
    "12500000", // $12.50
    "33330000", // $33.33
    "49990000", // $49.99
    "50000000", // $50.00, the ceiling
  ])("accepts a buy-in of %s base units", (units) => {
    const ok = mutate((d) => {
      (d.pot as { buyInBaseUnits: string }).buyInBaseUnits = units;
    });
    expect(validateLeagueRules(ok, NFL)).toEqual([]);
  });

  it("rejects a fee above the ceiling", () => {
    const bad = mutate((d) => {
      (d.pot as { feeBps: number }).feeBps = 501;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("above the 500 ceiling"),
    );
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

  it("rejects a payout where the champion merely ties for largest", () => {
    // The escrow requires the champion to be *strictly* largest. This used to
    // pass here and fail on-chain with ChampionNotLargest — after the rules were
    // frozen, so the league could never be anchored and never be corrected.
    const tied = mutate((d) => {
      const payout = d.pot!.payout as { prize: string; basisPoints: number }[];
      payout.find((p) => p.prize === "CHAMPION")!.basisPoints = 5000;
      payout.find((p) => p.prize === "RUNNER_UP")!.basisPoints = 5000;
      payout.find((p) => p.prize === "REGULAR_SEASON")!.basisPoints = 0;
    });

    expect(validateLeagueRules(tied, NFL)).toContainEqual(
      expect.stringContaining("CHAMPION must hold the largest"),
    );
  });

  it("accepts winner-take-all, where the champion is the only share", () => {
    const wta = mutate((d) => {
      (d.pot as { payout: unknown }).payout = NFL_WINNER_TAKE_ALL_PAYOUT;
    });

    expect(validateLeagueRules(wta, NFL)).toEqual([]);
  });
  it("rejects a paying finalisation window shorter than the stat-correction window", () => {
    const bad = mutate((d) => {
      (d.settlement as { payingFinalizationHours: number }).payingFinalizationHours = 48;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("at least 168"),
    );
  });

  it("rejects a refund unlock before the pot could have settled", () => {
    // The escape hatch opening mid-season is not a smaller version of it
    // opening late — it lets a losing manager take their stake back and keep
    // playing for a pot they no longer stand behind, because refunding does not
    // remove them from the league.
    const bad = mutate((d) => {
      (d.pot as { refundUnlockAt: number }).refundUnlockAt = d.draft.scheduledAt + 30 * 86_400;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(expect.stringContaining("too early"));
  });

  it("says how many days short the refund unlock is", () => {
    // A creator cannot fix a date they would have to compute themselves, and the
    // rules are frozen the moment they are written — so the message carries the
    // shortfall and the earliest legal value rather than only refusing.
    const bad = mutate((d) => {
      (d.pot as { refundUnlockAt: number }).refundUnlockAt = 1;
    });
    const problems = validateLeagueRules(bad, NFL);
    expect(problems).toContainEqual(expect.stringMatching(/\d+ days too early/));
    expect(problems).toContainEqual(expect.stringContaining("earliest permitted value"));
  });

  it("accepts a refund unlock later than the floor, within the window", () => {
    // A floor, not a prescription — a commissioner may want room past the
    // earliest legal date. 216 days from the draft is ~30 past the floor and
    // well inside the 90-day window.
    const late = mutate((d) => {
      (d.pot as { refundUnlockAt: number }).refundUnlockAt = d.draft.scheduledAt + 216 * 86_400;
    });
    expect(validateLeagueRules(late, NFL)).toEqual([]);
  });

  it("rejects a refund unlock far beyond the window", () => {
    // This exact case used to be asserted as *legal*, by a test of mine, under
    // the comment "Ten years out is legal, if strange." It is the attack. The
    // timelock refund is the only way tokens leave the vault, so a date a decade
    // out is not a long lock but a permanent freeze — and it anchors cleanly,
    // because the chain and the signed document agree about it.
    const frozen = mutate((d) => {
      (d.pot as { refundUnlockAt: number }).refundUnlockAt =
        d.draft.scheduledAt + 3650 * 86_400;
    });
    expect(validateLeagueRules(frozen, NFL)).toContainEqual(
      expect.stringContaining("too late"),
    );
  });

  it("says how many days too late, and the latest permitted value", () => {
    // Same reasoning as the floor's message: a creator cannot act on a bound
    // they would have to compute themselves, and the rules freeze on write.
    const frozen = mutate((d) => {
      (d.pot as { refundUnlockAt: number }).refundUnlockAt = 4_102_444_800; // 2100-01-01
    });
    const problems = validateLeagueRules(frozen, NFL);
    expect(problems).toContainEqual(expect.stringMatching(/\d+ days too late/));
    expect(problems).toContainEqual(expect.stringContaining("latest permitted value"));
  });

  it("treats both bounds as inclusive, and never reports both at once", () => {
    // The floor is `>=` and the ceiling `<=`, so the boundary values are legal
    // and there is no one-second no-man's-land between them. Reporting both
    // would be self-contradictory advice to a creator.
    const at = (pick: (floor: number, ceiling: number) => number) =>
      mutate((d) => {
        const input = {
          draftScheduledAt: d.draft.scheduledAt,
          regularSeasonWeeks: d.schedule.regularSeasonWeeks,
          playoffWeeks: d.schedule.playoffWeeks,
          payingFinalizationHours: d.settlement.payingFinalizationHours,
        };
        (d.pot as { refundUnlockAt: number }).refundUnlockAt = pick(
          earliestRefundUnlock(input),
          latestRefundUnlock(input),
        );
      });

    expect(
      validateLeagueRules(
        at((floor) => floor),
        NFL,
      ),
    ).toEqual([]);
    expect(
      validateLeagueRules(
        at((_, ceiling) => ceiling),
        NFL,
      ),
    ).toEqual([]);
    expect(
      validateLeagueRules(
        at((floor) => floor - 1),
        NFL,
      ),
    ).toContainEqual(expect.stringContaining("too early"));

    const over = validateLeagueRules(
      at((_, ceiling) => ceiling + 1),
      NFL,
    );
    expect(over).toContainEqual(expect.stringContaining("too late"));
    expect(over.filter((p) => /too early/.test(p))).toEqual([]);
  });

  it("cannot have its ceiling inflated by the schedule", () => {
    // Why the ceiling is capped against the draft rather than derived only from
    // the floor. Nothing bounds week numbers above, so a floor-relative ceiling
    // would stretch to 2043 for this rule set and the bound would mean nothing.
    // The cap holds it at draft + 365 days regardless, and the honest answer is
    // that the schedule is the problem rather than the date.
    const inflated = mutate((d) => {
      (d.schedule as { playoffWeeks: number[] }).playoffWeeks = [15, 16, 900];
      (d.pot as { refundUnlockAt: number }).refundUnlockAt =
        d.draft.scheduledAt + 3000 * 86_400;
    });
    expect(validateLeagueRules(inflated, NFL)).toContainEqual(
      expect.stringContaining("no legal value exists"),
    );
  });

  it("moves the floor with the league's own schedule", () => {
    // Derived, not a constant. A league whose playoffs run to week 20 must hold
    // its refund shut three weeks longer than one ending at 17 — and the
    // fixture's date, legal by six days at week 17, stops being legal.
    const longer = mutate((d) => {
      (d.schedule as { regularSeasonWeeks: number }).regularSeasonWeeks = 17;
      (d.schedule as { playoffWeeks: number[] }).playoffWeeks = [18, 19, 20];
    });
    expect(validateLeagueRules(longer, NFL)).toContainEqual(
      expect.stringContaining("too early"),
    );
  });

  it("does not constrain a free league, which has no pot to protect", () => {
    const free = mutate((d) => {
      (d as { pot: unknown }).pot = null;
    });
    expect(validateLeagueRules(free, NFL)).toEqual([]);
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
    // Moved 2026-08-05: roster changed to one FLEX instead of two
    // (QB/RB/RB/WR/WR/TE/FLEX/K/DEF).
    // Moved 2026-08-05: added ret_td at 6 points, matching ESPN and Sleeper.
    // Moved 2026-08-06: waiver rules matched to ESPN — 1-day period rather than
    //   2, plus the weekly cycle, short-tenure rule, and a timezone.
    // Moved 2026-08-07: schemaVersion 1 -> 2, adding pot.feeBps and
    //   pot.feeRecipient. This one is a *schema* change rather than a defaults
    //   change: it alters the shape every rule set encodes to, so it would make
    //   an existing league unverifiable. Safe only because none exists. Once one
    //   does, a schema bump means supporting both versions rather than moving
    //   this constant.
    // Moved 2026-08-08: schemaVersion 2 -> 3, replacing league.botsAllowed
    //   (boolean) with league.maxBots (number). Also a *schema* change. The
    //   boolean was in the frozen rules and enforced nowhere — a guarantee
    //   members signed that did nothing. `maxBots` is one field instead of two
    //   that could disagree, and it is zero in any league with a pot, because a
    //   bot has no wallet and a bot champion would leave 60% with no recipient.
    // Moved 2026-08-08: schemaVersion 3 -> 4, removing `abandonment` and adding
    //   `roster.autofill`. Also a *schema* change. Abandonment counted weeks
    //   with an invalid lineup and could never fire — the autofill runs before
    //   scoring, so a lineup is never invalid at that moment — and taking
    //   somebody's stake for inattention was the wrong rule to fix rather than
    //   delete. It also removes an entire instruction from the escrow.
    // Moved 2026-08-10: schemaVersion 4 -> 5, changing the default payout from
    //   60/15/10/10/5 to 70/20/10 and adding NFL_WINNER_TAKE_ALL_PAYOUT as an
    //   option. A *defaults* change in shape, but it fixes a correctness bug:
    //   consolation and third place are only decidable above a certain league
    //   size (8 and 4 members respectively, at six playoff places), while the
    //   payout is frozen before anyone joins. Paying a prize the field may not
    //   be able to award meant `championship().complete` could never become
    //   true, so the pot never settled and frozen rules made it uncorrectable.
    //   The consolation bracket is still played; it just carries no share.
    // No leagues existed on any of these occasions.
    expect(hashLeagueRules(FIXTURE)).toBe(
      "8fa9b46a9dfd0d0939d0736b3e6db32a73e8a6b5aff547351a8ed2291f60bcf2",
    );
  });
});
