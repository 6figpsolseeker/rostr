/**
 * Tank01 field names to our stat keys.
 *
 * This table is the whole reason the adapter layer exists. Tank01 nests stats
 * under category objects with its own naming; the engine only ever sees registry
 * keys. When we add a second provider for oracle agreement, it gets its own
 * table and nothing else changes.
 *
 * Field names come from Tank01's box score shape and must be confirmed against
 * a live response — that is what `pnpm stats:check` is for.
 */

/** `category.field` in a Tank01 box score -> our stat key. */
export const TANK01_STAT_MAP: Readonly<Record<string, string>> = {
  "Passing.passYds": "pass_yd",
  "Passing.passTD": "pass_td",
  "Passing.int": "pass_int",

  "Rushing.rushYds": "rush_yd",
  "Rushing.rushTD": "rush_td",

  "Receiving.recYds": "rec_yd",
  "Receiving.recTD": "rec_td",
  "Receiving.receptions": "rec",

  "Defense.defTD": "def_td",
  "Defense.sacks": "def_sack",
  "Defense.defensiveInterceptions": "def_int",
  "Defense.fumblesRecovered": "def_fum_rec",
};

/**
 * Two-point conversions and lost fumbles.
 *
 * Tank01 reports these across several categories — a two-pointer can be
 * passing, rushing, or receiving — so they are summed rather than mapped
 * one-to-one.
 */
export const TANK01_SUMMED_STATS: Readonly<Record<string, readonly string[]>> = {
  two_pt: [
    "Passing.passingTwoPointConversion",
    "Rushing.rushingTwoPointConversion",
    "Receiving.receivingTwoPointConversion",
  ],
  fum_lost: ["Rushing.fumblesLost", "Receiving.fumblesLost", "Passing.fumblesLost"],
};

/**
 * Field goals, bucketed by distance.
 *
 * Tank01 reports made kicks as a list of distances rather than pre-bucketed
 * counts, so the adapter counts them into our three keys. This is exactly why
 * field goals are three LINEAR stats rather than one TIERED rule: the mess stays
 * here, and the scoring engine keeps one uniform shape.
 */
export function bucketFieldGoal(yards: number): "fg_0_39" | "fg_40_49" | "fg_50_plus" {
  if (yards >= 50) return "fg_50_plus";
  if (yards >= 40) return "fg_40_49";
  return "fg_0_39";
}

/**
 * Defensive points allowed.
 *
 * **Must be emitted even when zero.** The scoring engine treats an absent stat
 * as "did not play", so a defense that pitched a shutout and reports nothing
 * would silently forfeit its 10-point bonus. Every unit that played gets an
 * explicit value.
 */
export const DEF_POINTS_ALLOWED_KEY = "def_pts_allowed";
