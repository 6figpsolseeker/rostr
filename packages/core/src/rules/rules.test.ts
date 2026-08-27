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
import type { LeagueRules, PotRules, Weekday } from "./types.js";
import {
  draftDateProblem,
  earliestRefundUnlock,
  latestRefundUnlock,
  MIN_DRAFT_LEAD_SECONDS,
  MAX_TEAMS_PER_LEAGUE,
  validateLeagueRules,
} from "./validate.js";

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
  settlementOracle: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
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

  it("marks both defensive ladders as tiered, and nothing else", () => {
    // Two since the ESPN alignment. Pinned as a list rather than a count: the
    // translator has to emit a tiered stat even at zero, because absent means
    // "did not play" to the engine — so a new one appearing here and nowhere
    // else is a silent forfeit of whatever bonus it carries.
    const tiered = NFL.statKeys.filter((s) => s.kind === "TIERED").map((s) => s.key);
    expect(tiered).toEqual(["def_pts_allowed", "def_yds_allowed"]);
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

  it.each(["def_pts_allowed", "def_yds_allowed"])(
    "covers every %s bucket contiguously and unbounded at the top",
    (statKey) => {
      const rule = NFL_PPR_SCORING.find((r) => r.statKey === statKey);
      if (rule?.kind !== "TIERED") throw new Error("expected a tiered rule");

      // A gap throws at score time rather than scoring zero — deliberate,
      // because a hole in the ladder means the feed or the table is wrong, and
      // burying it is how a defence silently scores nothing.
      expect(rule.tiers[0]?.min).toBe(0);
      expect(rule.tiers.at(-1)?.max).toBeNull();

      for (const [i, tier] of rule.tiers.entries()) {
        const prev = rule.tiers[i - 1];
        if (prev) expect(tier.min).toBe((prev.max ?? -1) + 1);
      }
    },
  );

  it("matches ESPN's points-allowed ladder exactly", () => {
    // Decoded from ESPN's own published player totals rather than from any
    // documentation — see the note in `nfl-ppr.ts`. The top of this ladder used
    // to pay 10 and now pays 5, which is the single largest scoring change in
    // the alignment.
    const rule = NFL_PPR_SCORING.find((r) => r.statKey === "def_pts_allowed");
    if (rule?.kind !== "TIERED") throw new Error("expected a tiered rule");

    expect(rule.tiers.map((t) => [t.min, t.max, t.milliPoints / 1000])).toEqual([
      [0, 0, 5],
      [1, 6, 4],
      [7, 13, 3],
      [14, 17, 1],
      [18, 27, 0],
      [28, 34, -1],
      [35, 45, -3],
      [46, null, -5],
    ]);
  });

  it("matches ESPN's yards-allowed ladder exactly", () => {
    const rule = NFL_PPR_SCORING.find((r) => r.statKey === "def_yds_allowed");
    if (rule?.kind !== "TIERED") throw new Error("expected a tiered rule");

    expect(rule.tiers.map((t) => [t.min, t.max, t.milliPoints / 1000])).toEqual([
      [0, 99, 5],
      [100, 199, 3],
      [200, 299, 2],
      [300, 349, 0],
      [350, 399, -1],
      [400, 449, -3],
      [450, 499, -5],
      [500, 549, -6],
      [550, null, -7],
    ]);
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

/**
 * A deeply mutable view of a rules document.
 *
 * `LeagueRules` is deeply `readonly`, so every test below that stages an invalid
 * document had to cast its way past that — eight of them invented a structural
 * subset (`d.schedule as { playoffWeeks: number[] }`) purely to get a writable
 * property. Those casts re-declared the shape they were writing to, so a rename
 * would have left them writing a field that no longer exists while
 * `validateLeagueRules` returned no problems and the failure surfaced as a
 * baffling assertion message — in the file CI pins the rules hash with.
 *
 * Stripping the modifier once, here, deletes all eight. It is not a widening:
 * property types are preserved exactly, so a typo'd key, a wrong element type
 * and an invalid enum member are all still errors. `structuredClone` below is
 * the proof this is sound — a value it can clone is plain data, with no
 * functions or class instances for the mapped type to mangle.
 */
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

/**
 * A value the type system forbids, staged on purpose.
 *
 * A rules document arrives from the database and the wire as JSON, so the
 * compiler's guarantee stops at that boundary and `validateLeagueRules` is what
 * stands behind it. These casts are the subject of the tests that use them, not
 * a workaround for them — which is exactly why they are named rather than
 * written inline as `as unknown as`. In the file that pins what members sign,
 * every deliberate lie should be greppable, and an anonymous cast is not.
 */
const poison = <T>(value: unknown): T => value as T;

describe("validateLeagueRules", () => {
  const mutate = (fn: (draft: Mutable<LeagueRules>) => void): LeagueRules => {
    const draft = structuredClone(FIXTURE) as Mutable<LeagueRules>;
    fn(draft);
    return draft;
  };

  it("accepts the default rule set", () => {
    expect(validateLeagueRules(FIXTURE, NFL)).toEqual([]);
  });

  /**
   * The ceiling, which did not exist until 2026-08-17.
   *
   * `docs/RULES.md` §3 caps a league at twelve and nothing enforced it, so a
   * twenty-team pot league was creatable and anchorable. The cost lands at
   * settlement rather than at scheduling: the on-chain derivation kernels size
   * fixed arrays to their own `MAX_TEAMS` and refuse above it, so such a league
   * plays a whole season and then cannot be settled at all — its members falling
   * to the timelock refund with no earlier signal. Frozen rules mean the only
   * moment this is fixable is before creation.
   */
  it("rejects a league above the twelve-team cap", () => {
    const bad = mutate((d) => {
      (d.league as { maxTeams: number }).maxTeams = MAX_TEAMS_PER_LEAGUE + 1;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining(`maxTeams cannot exceed ${MAX_TEAMS_PER_LEAGUE}`),
    );
  });

  it("accepts a league at exactly the cap", () => {
    // The negative control, and the default: `NFL_PPR` ships `maxTeams: 12`, so
    // an off-by-one here would refuse every league the product actually creates.
    const ok = mutate((d) => {
      (d.league as { maxTeams: number }).maxTeams = MAX_TEAMS_PER_LEAGUE;
    });
    expect(validateLeagueRules(ok, NFL)).toEqual([]);
  });

  /**
   * The oracle is required, unlike the fee recipient one field up.
   *
   * A fee-free league is a real league, so an empty recipient is legal. There is
   * no equivalent here: a pot nobody may post scores for can never be settled,
   * and its members wait out the timelock for money they should have won. The
   * only recoverable moment is before creation.
   */
  it("rejects a pot with no settlement oracle", () => {
    const bad = mutate((d) => {
      (d.pot as { settlementOracle: string }).settlementOracle = "";
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("settlement oracle"),
    );
  });

  it("rejects a settlement oracle that is not an address", () => {
    // Same check the mint gets, and for a sharper reason: a truncated paste here
    // freezes into a document nobody can amend, and the key it names cannot
    // sign, so the league is unsettleable from the moment it is created.
    const bad = mutate((d) => {
      (d.pot as { settlementOracle: string }).settlementOracle = "not-an-address";
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("settlement oracle"),
    );
  });

  it("rejects an unknown stat key", () => {
    const bad = mutate((d) => {
      d.scoring[0]!.statKey = "touchdowns_probably";
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("unknown stat key"),
    );
  });

  it("rejects a gap between tiers", () => {
    const bad = mutate((d) => {
      const rule = d.scoring.find((r) => r.statKey === "def_pts_allowed");
      if (rule?.kind === "TIERED") rule.tiers[0]!.max = 2;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("gap or overlap"),
    );
  });

  it("rejects a tiered rule that does not end unbounded", () => {
    const bad = mutate((d) => {
      const rule = d.scoring.find((r) => r.statKey === "def_pts_allowed");
      if (rule?.kind === "TIERED") {
        rule.tiers.at(-1)!.max = 99;
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

  it.each([
    ["empty", ""],
    ["truncated", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt"],
    ["not base58", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O"],
    ["a sentence", "USDC please"],
    ["too long", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vEPjFW"],
  ])("rejects a token mint that is %s", (_label, mint) => {
    // Only emptiness was checked before, which let a mistyped or truncated
    // address be canonically encoded, hashed, signed and frozen — and a frozen
    // rules document cannot be corrected. This cannot say the mint is the one
    // anybody wanted; it can refuse the shapes that are silent and permanent.
    const bad = mutate((d) => {
      (d.pot as { tokenMint: string }).tokenMint = mint;
    });
    expect(validateLeagueRules(bad, NFL)).toContainEqual(
      expect.stringContaining("valid token mint address"),
    );
  });

  it("accepts a well-formed mint", () => {
    // The control: the check must not reject the address every fixture uses.
    expect(validateLeagueRules(FIXTURE, NFL)).not.toContainEqual(
      expect.stringContaining("token mint"),
    );
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
      d.pot!.payout[0]!.basisPoints = 5000;
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
      d.schedule.playoffWeeks = [15, 16, 900];
      d.pot!.refundUnlockAt = d.draft.scheduledAt + 3000 * 86_400;
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
      d.schedule.regularSeasonWeeks = 17;
      d.schedule.playoffWeeks = [18, 19, 20];
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
      d.schedule.tiebreakers = ["WIN_PCT", "POINTS_FOR"];
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
      d.schedule.playoffWeeks = [15, 16];
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

describe("draftDateProblem", () => {
  // The draft time is when the field locks, so a league created to draft in the
  // past would refuse its own first join — the commissioner's included — and its
  // rules are immutable, so it could never be corrected, only recreated under a
  // new id. That became reachable by accepting the create form's default from
  // 22 August 2026 onward, when its hardcoded date passed.
  const NOW = new Date("2026-08-14T12:00:00Z");
  const at = (offsetSeconds: number): number =>
    Math.floor(NOW.getTime() / 1000) + offsetSeconds;

  it("accepts a draft comfortably in the future", () => {
    expect(draftDateProblem(at(7 * 24 * 3600), NOW)).toBeNull();
  });

  it("refuses a draft in the past, and one at this very instant", () => {
    expect(draftDateProblem(at(-1), NOW)).toMatch(/already passed/);
    expect(draftDateProblem(at(0), NOW)).toMatch(/already passed/);
  });

  it("refuses a draft too soon for anyone to join", () => {
    // The field closes at the draft time, so a league scheduled minutes out is
    // born locked around whoever happened to be in it.
    expect(draftDateProblem(at(MIN_DRAFT_LEAD_SECONDS - 1), NOW)).toMatch(/at least an hour/);
    expect(draftDateProblem(at(MIN_DRAFT_LEAD_SECONDS), NOW)).toBeNull();
  });

  it("refuses an unset or nonsensical time", () => {
    expect(draftDateProblem(0, NOW)).toMatch(/must be set/);
    expect(draftDateProblem(Number.NaN, NOW)).toMatch(/must be set/);
  });

  it("is deliberately not part of validateLeagueRules", () => {
    // That function has to stay a pure function of the frozen document, so a
    // league can be re-validated years later to check it was legal when it was
    // made. A clock in there would fail every league in the repository the day
    // after it drafted — and this fixture's own draft is in 2025.
    expect(validateLeagueRules(FIXTURE, NFL)).toEqual([]);
    expect(draftDateProblem(FIXTURE.draft.scheduledAt, NOW)).toMatch(/already passed/);
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
    // Moved 2026-08-16: schemaVersion 5 -> 6, aligning the scoring table with
    //   ESPN's PPR defaults. Both a *schema* change (two new stat keys and a new
    //   tiered rule) and a *defaults* change, and the largest single move this
    //   constant has made. What changed:
    //     - `fg_50_plus` split into `fg_50_59` (5) and `fg_60_plus` (6)
    //     - `fg_missed` added at -1. Misses used to be unpenalised, on the
    //       argument that they punish a kicker for his coach's decision to try a
    //       55-yarder. ESPN charges for them, and matching ESPN won.
    //     - `def_yds_allowed` added, a second tiered ladder. We scored the
    //       defensive unit on points alone, so a unit that bent without breaking
    //       scored the same as one that did not.
    //     - the points-allowed ladder replaced wholesale. It paid 10 for a
    //       shutout against ESPN's 5, and stopped at -4 where ESPN reaches -5.
    //       The old table appears to have been transcribed from a stale page.
    //   Every value is ESPN's own, decoded from their published player totals
    //   rather than from documentation, and checked by recomputing all 11,507
    //   player-weeks of the 2025 season against the totals ESPN itself
    //   published. See `docs/TANK01.md`.
    // No leagues existed on any of these occasions.
    //
    // Moved 2026-08-17: schemaVersion 6 -> 7, adding `def_2pt_ret` — a defensive
    //   two-point conversion return, which ESPN pays the unit 2 for and we had
    //   no stat key for at all, so it scored nothing. Three occurrences across
    //   2024 and 2025: Dallas in 2025 week 4, Miami in 2025 week 13,
    //   Philadelphia in 2024 week 4. Tank01 carries the count as
    //   `teamStats.defensiveTwoPointConversionReturns`.
    //
    //   **"No leagues existed" is not the claim this time, and repeating it
    //   would have been false.** Four test leagues were created in the deployed
    //   database before 2026-08-16 and are recorded as retired to `DISSOLVED`;
    //   `apps/web/src/app/api/cron/score-week/route.test.ts` also creates and
    //   dissolves leagues there whenever `DATABASE_URL` is set. What makes this
    //   safe is a different fact, and a stronger one: **an addition cannot reach
    //   a league that already exists.** A frozen league holds its own copy of
    //   the scoring table in `league_rules.rule_json`, `scorePlayer` skips a
    //   stat with no matching rule by design, and so a key those leagues have
    //   never heard of scores them nothing — which is exactly right. The move
    //   that does damage is a *rename* or a removal, which is what #162 and
    //   `sports/stat-keys.test.ts` exist to catch, and this is neither.
    //
    //   Two consequences that are not about the hash. `seedSport` must be re-run
    //   against any deployed database before the next box-score ingest, or
    //   `ingestOneGame` throws on a stat key `stat_keys` does not hold — that is
    //   deliberate and it is loud. And the four dissolved leagues do not gain
    //   the rule, because frozen rules cannot be migrated; nothing can be done
    //   about that and nothing should be.
    //
    // Moved 2026-08-18: schemaVersion 7 -> 8, adding `pot.settlementOracle` —
    //   the key permitted to post a league's finalised scores on-chain.
    //
    //   **This one is a promise rather than a number.** `docs/RULES.md` §7 says
    //   the contract derives the champion and that stats reach the chain through
    //   an oracle. It named the oracle nowhere, so members were signing a
    //   document with exactly one trusted party in it and no way to see who.
    //   Now they sign the key, it is rendered above the join control with
    //   everything else, and `scoresTermMismatches` refuses a settlement account
    //   naming a different one — which is what closes the attack in
    //   `docs/SETTLEMENT.md` §6, where a commissioner names their own key and
    //   posts the scores that make themselves champion.
    //
    //   **Unlike 6 -> 7 this is not a safe addition to an existing league**, and
    //   the distinction is worth keeping straight. That one added a scoring key,
    //   and a frozen league that never heard of it simply scores it zero. This
    //   adds a field settlement *requires*: a league frozen without it has no
    //   signed oracle, so nothing may ever post its scores and its only exit is
    //   the timelock refund. The four dissolved test leagues are in that state
    //   and it does not matter, because they are dissolved. It would matter for
    //   a live one, which is why this moves now — while every anchored league is
    //   disposable and `league_onchain_stakes` is empty — and could not move
    //   later.
    expect(hashLeagueRules(FIXTURE)).toBe(
      "34902406ca6e98967da17dc53bf63da250d47819d507d792098da037aa8195ac",
    );
  });
});

describe("the waiver weekday is checked against the union — #132", () => {
  /*
    The hour beside it was validated and the day was not. `nextWeekly` resolves a
    weekday to an index, so an unrecognised one produces a schedule that cannot
    be computed — and every value here is frozen at creation and hashed, so a
    league created with a typo can never be corrected.

    It is also what made #131 dangerous: `leaguesDueForWaivers` computes this for
    every league with a pending claim, so one league with an unusable weekday
    could take the whole run down.

    The timezone next to it *was* checked for being a real IANA zone. This closes
    the gap the pair left.
  */

  it("refuses a weekday that is not one of the seven", () => {
    const rules = FIXTURE;
    const broken = {
      ...rules,
      waivers: {
        ...rules.waivers,
        processing: { ...rules.waivers.processing, day: poison<Weekday>("WENSDAY") },
      },
    };

    const problems = validateLeagueRules(broken, NFL);
    expect(problems.some((p) => p.includes("WENSDAY"))).toBe(true);
  });

  it("names the acceptable values, so the fix is obvious", () => {
    // A rule frozen at creation is worth an error somebody can act on the first
    // time rather than after a second refused attempt.
    const rules = FIXTURE;
    const broken = {
      ...rules,
      waivers: {
        ...rules.waivers,
        weeklyLock: { ...rules.waivers.weeklyLock, day: poison<Weekday>("funday") },
      },
    };

    /*
      Matched against the problem for **this** field, not against the whole
      array. Searching every problem for "WEDNESDAY" passed for the wrong
      reason under a mutation that dropped Wednesday from the accepted set: the
      substring matched the message *rejecting* Wednesday. A test named "names
      the acceptable values" was satisfied by a value being named unacceptable.
    */
    const problem = validateLeagueRules(broken, NFL).find((p) =>
      p.startsWith("weeklyLock.day"),
    );

    expect(problem).toContain("funday");
    for (const day of [
      "SUNDAY",
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
    ]) {
      expect(problem).toContain(day);
    }
  });

  it("is case-sensitive, because the stored value is", () => {
    // The document is hashed verbatim, so "monday" and "MONDAY" are different
    // bytes and only one of them is what every reader compares against.
    const rules = FIXTURE;
    const broken = {
      ...rules,
      waivers: {
        ...rules.waivers,
        processing: { ...rules.waivers.processing, day: poison<Weekday>("wednesday") },
      },
    };

    expect(validateLeagueRules(broken, NFL).length).toBeGreaterThan(0);
  });

  it("accepts every one of the seven, so the list cannot lose a day", () => {
    /*
      Both directions. Three tests refuse a bad value and none accepted a good
      one, so dropping a day from `WEEKDAYS` was green — and the consequence is
      the opposite of the bug being fixed: a validator that refuses a correct,
      ordinary rule set. Sunday and Saturday are the ones nobody would notice.
    */
    const days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

    for (const day of days) {
      const rules = {
        ...FIXTURE,
        waivers: {
          ...FIXTURE.waivers,
          weeklyLock: { day, hour: 0 },
          processing: { day, hour: 3 },
        },
      } as LeagueRules;

      expect(validateLeagueRules(rules, NFL)).toEqual([]);
    }
  });

  it("refuses a processing run earlier in the day than its own lock", () => {
    /*
      **The silent one, two lines from the loud one.**

      The pair was checked for identity only. `everyoneIsOnWaivers` asks whether
      now is before the processing run that follows the most recent lock, and
      `nextProcessingAt` is strictly after — so a processing hour earlier in the
      same weekday pushes that answer a whole cycle forward, and every unrostered
      player sits on waivers for 167 hours of every week.

      Free agency open for one hour, all season, in a document that is frozen and
      hashed and cannot be amended. Nothing throws; every function returns a
      plausible answer. The weekday check got written because its failure is
      loud, and this one is the reason that is not the right filter.
    */
    const broken = {
      ...FIXTURE,
      waivers: {
        ...FIXTURE.waivers,
        weeklyLock: { day: "WEDNESDAY", hour: 4 },
        processing: { day: "WEDNESDAY", hour: 3 },
      },
    } as LeagueRules;

    expect(
      validateLeagueRules(broken, NFL).some((p) => p.includes("after the weekly lock")),
    ).toBe(true);
  });

  it("allows the two moments on different days in any order", () => {
    // Tuesday's lock and Wednesday's run is the default, and the ordering rule
    // must not reach across days — a lock late on Tuesday with a run early on
    // Wednesday is the ordinary arrangement.
    const rules = {
      ...FIXTURE,
      waivers: {
        ...FIXTURE.waivers,
        weeklyLock: { day: "TUESDAY", hour: 23 },
        processing: { day: "WEDNESDAY", hour: 3 },
      },
    } as LeagueRules;

    expect(validateLeagueRules(rules, NFL)).toEqual([]);
  });

  it("refuses a waiver period that is fractional or absurd", () => {
    /*
      It was bounded below only. A fractional value passed here and threw from
      `canonicalize` instead, which breaks this module's contract that a creator
      sees everything wrong at once; and with no ceiling, 3650 meant no player
      ever cleared waivers for the life of the league.
    */
    for (const days of [1.5, 3650]) {
      const broken = {
        ...FIXTURE,
        waivers: { ...FIXTURE.waivers, waiverPeriodDays: days },
      } as LeagueRules;

      expect(validateLeagueRules(broken, NFL).some((p) => p.includes("waiverPeriodDays"))).toBe(
        true,
      );
    }
  });

  it("refuses a tiebreaker that is not one of the five", () => {
    /*
      The same gap as the weekday, one field over, failing far more quietly.

      `scoresFor` has no default arm, so an unrecognised link returns undefined
      and `orderGroup` reads that as "not applicable here" — the typo is dropped
      from a chain that is signed, hashed and unamendable. Nothing throws. It
      just seeds the playoffs differently, and seed 1 carries the best-record
      prize. Issue #132 asked for this sweep in the same pass.
    */
    const broken = {
      ...FIXTURE,
      schedule: {
        ...FIXTURE.schedule,
        tiebreakers: ["WIN_PCT", "POINTS_FRO", "LOWEST_TEAM_ID"],
      },
    } as LeagueRules;

    expect(validateLeagueRules(broken, NFL).some((p) => p.includes("POINTS_FRO"))).toBe(true);
  });

  it("accepts the default rule set unchanged", () => {
    const rules = FIXTURE;
    expect(validateLeagueRules(rules, NFL)).toEqual([]);
  });
});
