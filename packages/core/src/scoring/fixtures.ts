/**
 * Scoring fixtures.
 *
 * Realistic stat lines with hand-computed expected totals. Every `expected`
 * value below is worked out longhand in its comment so a reviewer can check the
 * arithmetic without running anything.
 *
 * **These are constructed, not real box scores.** They are shaped like genuine
 * NFL performances and they exercise every rule in the default PPR table, but
 * they were not taken from a live feed. Validating against real 2025 box scores
 * — the last step of commit B5 — needs the Tank01 key; see
 * `docs/SETUP-REQUIRED.md`.
 */

import type { StatLine } from "./engine.js";

export interface ScoringFixture {
  readonly name: string;
  readonly stats: readonly StatLine[];
  /** Hand-computed, in milli-points. */
  readonly expected: number;
  readonly workedOut: string;
}

export const SCORING_FIXTURES: readonly ScoringFixture[] = [
  {
    name: "quarterback, strong game",
    stats: [
      { statKey: "pass_yd", value: 325 },
      { statKey: "pass_td", value: 3 },
      { statKey: "pass_int", value: 1 },
      { statKey: "rush_yd", value: 24 },
      { statKey: "rush_td", value: 1 },
    ],
    // 325 x 40 = 13000
    //   3 x 4000 = 12000
    //   1 x -2000 = -2000
    //  24 x 100 = 2400
    //   1 x 6000 = 6000
    expected: 13_000 + 12_000 - 2000 + 2400 + 6000,
    workedOut: "13000 + 12000 - 2000 + 2400 + 6000 = 31400 (31.40 pts)",
  },
  {
    name: "running back, PPR workhorse",
    stats: [
      { statKey: "rush_yd", value: 87 },
      { statKey: "rush_td", value: 1 },
      { statKey: "rec", value: 6 },
      { statKey: "rec_yd", value: 52 },
      { statKey: "fum_lost", value: 1 },
    ],
    // 87 x 100 = 8700
    //  1 x 6000 = 6000
    //  6 x 1000 = 6000
    // 52 x 100 = 5200
    //  1 x -2000 = -2000
    expected: 8700 + 6000 + 6000 + 5200 - 2000,
    workedOut: "8700 + 6000 + 6000 + 5200 - 2000 = 23900 (23.90 pts)",
  },
  {
    name: "wide receiver, full PPR",
    stats: [
      { statKey: "rec", value: 11 },
      { statKey: "rec_yd", value: 143 },
      { statKey: "rec_td", value: 2 },
      { statKey: "two_pt", value: 1 },
    ],
    //  11 x 1000 = 11000
    // 143 x 100 = 14300
    //   2 x 6000 = 12000
    //   1 x 2000 = 2000
    expected: 11_000 + 14_300 + 12_000 + 2000,
    workedOut: "11000 + 14300 + 12000 + 2000 = 39300 (39.30 pts)",
  },
  {
    name: "tight end, quiet day",
    stats: [
      { statKey: "rec", value: 2 },
      { statKey: "rec_yd", value: 17 },
    ],
    //  2 x 1000 = 2000
    // 17 x 100 = 1700
    expected: 2000 + 1700,
    workedOut: "2000 + 1700 = 3700 (3.70 pts)",
  },
  {
    name: "kicker, mixed distances",
    stats: [
      { statKey: "fg_0_39", value: 2 },
      { statKey: "fg_40_49", value: 1 },
      { statKey: "fg_50_plus", value: 1 },
      { statKey: "xp_made", value: 3 },
    ],
    // 2 x 3000 = 6000
    // 1 x 4000 = 4000
    // 1 x 5000 = 5000
    // 3 x 1000 = 3000
    expected: 6000 + 4000 + 5000 + 3000,
    workedOut: "6000 + 4000 + 5000 + 3000 = 18000 (18.00 pts)",
  },
  {
    name: "defense, shutout",
    stats: [
      { statKey: "def_pts_allowed", value: 0 },
      { statKey: "def_sack", value: 4 },
      { statKey: "def_int", value: 2 },
      { statKey: "def_fum_rec", value: 1 },
      { statKey: "def_td", value: 1 },
    ],
    // tier 0        = 10000
    // 4 x 1000      = 4000
    // 2 x 2000      = 4000
    // 1 x 2000      = 2000
    // 1 x 6000      = 6000
    expected: 10_000 + 4000 + 4000 + 2000 + 6000,
    workedOut: "10000 + 4000 + 4000 + 2000 + 6000 = 26000 (26.00 pts)",
  },
  {
    name: "defense, blown out",
    stats: [
      { statKey: "def_pts_allowed", value: 41 },
      { statKey: "def_sack", value: 1 },
    ],
    // tier 35+   = -4000
    // 1 x 1000   = 1000
    expected: -4000 + 1000,
    workedOut: "-4000 + 1000 = -3000 (-3.00 pts)",
  },
  {
    name: "defense, exactly on a tier boundary",
    stats: [{ statKey: "def_pts_allowed", value: 21 }],
    // The 21–27 tier scores nothing. A boundary that lands on the zero tier is
    // the easiest one to get wrong by an off-by-one.
    expected: 0,
    workedOut: "tier 21-27 = 0",
  },
  {
    name: "player who did not appear",
    stats: [],
    expected: 0,
    workedOut: "no stats = 0",
  },
  {
    name: "quarterback, disaster",
    stats: [
      { statKey: "pass_yd", value: 68 },
      { statKey: "pass_int", value: 4 },
      { statKey: "fum_lost", value: 2 },
    ],
    // 68 x 40 = 2720
    //  4 x -2000 = -8000
    //  2 x -2000 = -4000
    expected: 2720 - 8000 - 4000,
    workedOut: "2720 - 8000 - 4000 = -9280 (-9.28 pts) — negative totals are legal",
  },
];
