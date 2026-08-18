/**
 * NFL registered as data.
 *
 * This file is the only place in the codebase that names a football concept.
 * Everything downstream reads these rows.
 */

import type { SportDef } from "./types.js";

/**
 * Stat keys.
 *
 * Field goals are split into three distance buckets rather than modelled as a
 * TIERED rule over a single "field goal distance" stat. A tier would require the
 * engine to see individual kick events; buckets let the provider adapter absorb
 * that shape and hand the engine three ordinary counters. Complexity belongs in
 * the adapter.
 *
 * Defensive points allowed is the one genuinely tiered stat — a step function
 * over the opponent's final score.
 */
export const NFL_STAT_KEYS = [
  // Passing
  { key: "pass_yd", displayName: "Passing Yards", kind: "LINEAR" },
  { key: "pass_td", displayName: "Passing Touchdowns", kind: "LINEAR" },
  { key: "pass_int", displayName: "Interceptions Thrown", kind: "LINEAR" },

  // Rushing
  { key: "rush_yd", displayName: "Rushing Yards", kind: "LINEAR" },
  { key: "rush_td", displayName: "Rushing Touchdowns", kind: "LINEAR" },

  // Receiving
  { key: "rec", displayName: "Receptions", kind: "LINEAR" },
  { key: "rec_yd", displayName: "Receiving Yards", kind: "LINEAR" },
  { key: "rec_td", displayName: "Receiving Touchdowns", kind: "LINEAR" },

  // Misc offense
  { key: "fum_lost", displayName: "Fumbles Lost", kind: "LINEAR" },
  { key: "two_pt", displayName: "Two-Point Conversions", kind: "LINEAR" },

  // Special teams returns by a *player* — a kickoff, punt, or blocked-kick
  // return taken to the house. Distinct from `def_td`, which is the defensive
  // unit's touchdown: an interception or fumble return is not this.
  { key: "ret_td", displayName: "Return Touchdowns", kind: "LINEAR" },

  // Kicking. `fg_50_plus` was split into 50-59 and 60+ on 2026-08-16 to match
  // ESPN, which pays 6 for a 60-yarder — twelve of them were kicked in 2025, so
  // it is a real bucket rather than a theoretical one.
  { key: "fg_0_39", displayName: "Field Goals 0-39 Yards", kind: "LINEAR" },
  { key: "fg_40_49", displayName: "Field Goals 40-49 Yards", kind: "LINEAR" },
  { key: "fg_50_59", displayName: "Field Goals 50-59 Yards", kind: "LINEAR" },
  { key: "fg_60_plus", displayName: "Field Goals 60+ Yards", kind: "LINEAR" },
  { key: "fg_missed", displayName: "Field Goals Missed", kind: "LINEAR" },
  { key: "xp_made", displayName: "Extra Points Made", kind: "LINEAR" },

  // Defense / special teams
  { key: "def_sack", displayName: "Sacks", kind: "LINEAR" },
  { key: "def_int", displayName: "Defensive Interceptions", kind: "LINEAR" },
  { key: "def_fum_rec", displayName: "Fumble Recoveries", kind: "LINEAR" },
  { key: "def_safety", displayName: "Safeties", kind: "LINEAR" },
  { key: "def_td", displayName: "Defensive/Special Teams Touchdowns", kind: "LINEAR" },
  { key: "def_blk_kick", displayName: "Blocked Kicks", kind: "LINEAR" },
  { key: "def_pts_allowed", displayName: "Points Allowed", kind: "TIERED" },
  // Yards allowed, added 2026-08-16. ESPN scores the defensive unit on both
  // points and yards; we had only points, which meant a unit that bent without
  // breaking scored identically to one that did not.
  { key: "def_yds_allowed", displayName: "Yards Allowed", kind: "TIERED" },
  // A failed two-point conversion taken back the other way, added 2026-08-17.
  // ESPN pays the unit 2 and we had no key at all, so it scored nothing: three
  // occurrences across 2024 and 2025. Appended rather than slotted in beside the
  // other defensive counters — stat keys are append-only, and while a *position*
  // in this list is not what a frozen league holds on to, keeping additions at
  // the end is what makes the history readable next to `stat-keys.test.ts`.
  { key: "def_2pt_ret", displayName: "Defensive Two-Point Returns", kind: "LINEAR" },
] as const satisfies SportDef["statKeys"];

export const NFL_POSITIONS = [
  { key: "QB", displayName: "Quarterback", sortOrder: 1 },
  { key: "RB", displayName: "Running Back", sortOrder: 2 },
  { key: "WR", displayName: "Wide Receiver", sortOrder: 3 },
  { key: "TE", displayName: "Tight End", sortOrder: 4 },
  { key: "K", displayName: "Kicker", sortOrder: 5 },
  { key: "DEF", displayName: "Defense/Special Teams", sortOrder: 6 },
] as const satisfies SportDef["positions"];

export const NFL_SLOT_TYPES = [
  { key: "QB", displayName: "QB", eligiblePositions: ["QB"] },
  { key: "RB", displayName: "RB", eligiblePositions: ["RB"] },
  { key: "WR", displayName: "WR", eligiblePositions: ["WR"] },
  { key: "TE", displayName: "TE", eligiblePositions: ["TE"] },
  { key: "FLEX", displayName: "FLEX", eligiblePositions: ["RB", "WR", "TE"] },
  { key: "K", displayName: "K", eligiblePositions: ["K"] },
  { key: "DEF", displayName: "DEF", eligiblePositions: ["DEF"] },
  {
    key: "BN",
    displayName: "Bench",
    eligiblePositions: ["QB", "RB", "WR", "TE", "K", "DEF"],
  },
  {
    key: "IR",
    displayName: "Injured Reserve",
    eligiblePositions: ["QB", "RB", "WR", "TE", "K", "DEF"],
  },
] as const satisfies SportDef["slotTypes"];

export const NFL: SportDef = {
  key: "nfl",
  displayName: "NFL Football",
  seasonWeeks: 18,
  statKeys: NFL_STAT_KEYS,
  positions: NFL_POSITIONS,
  slotTypes: NFL_SLOT_TYPES,
};
