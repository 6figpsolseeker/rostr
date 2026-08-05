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

  // Kicking
  { key: "fg_0_39", displayName: "Field Goals 0-39 Yards", kind: "LINEAR" },
  { key: "fg_40_49", displayName: "Field Goals 40-49 Yards", kind: "LINEAR" },
  { key: "fg_50_plus", displayName: "Field Goals 50+ Yards", kind: "LINEAR" },
  { key: "xp_made", displayName: "Extra Points Made", kind: "LINEAR" },

  // Defense / special teams
  { key: "def_sack", displayName: "Sacks", kind: "LINEAR" },
  { key: "def_int", displayName: "Defensive Interceptions", kind: "LINEAR" },
  { key: "def_fum_rec", displayName: "Fumble Recoveries", kind: "LINEAR" },
  { key: "def_safety", displayName: "Safeties", kind: "LINEAR" },
  { key: "def_td", displayName: "Defensive/Special Teams Touchdowns", kind: "LINEAR" },
  { key: "def_blk_kick", displayName: "Blocked Kicks", kind: "LINEAR" },
  { key: "def_pts_allowed", displayName: "Points Allowed", kind: "TIERED" },
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
