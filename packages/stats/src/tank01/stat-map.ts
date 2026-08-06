/**
 * Tank01 field names to our stat keys.
 *
 * **Every name here was confirmed against a live box score** (`20250904_DAL@PHI`)
 * via `pnpm stats:probe`, not taken from documentation. An earlier version of
 * this file was written from docs and three of its guesses were wrong — see the
 * notes below, which exist so nobody re-introduces them.
 *
 * Two structural things to know before editing:
 *
 * 1. **Tank01 returns every stat as a string.** `"188"`, not `188`. Parse at the
 *    boundary; the scoring engine rejects non-integers by design.
 * 2. **Categories are absent when empty.** A player with no receptions has no
 *    `Receiving` key at all. Absent is not zero — which is correct for scoring,
 *    except where a zero is meaningful (see `def_pts_allowed`).
 */

/** `Category.field` in `playerStats[playerID]` -> our stat key. All verified. */
export const TANK01_STAT_MAP: Readonly<Record<string, string>> = {
  "Passing.passYds": "pass_yd",
  "Passing.passTD": "pass_td",
  "Passing.int": "pass_int",

  "Rushing.rushYds": "rush_yd",
  "Rushing.rushTD": "rush_td",

  "Receiving.recYds": "rec_yd",
  "Receiving.recTD": "rec_td",
  "Receiving.receptions": "rec",

  // Fumbles live under Defense even for offensive players. Counter-intuitive,
  // and verified: there is no `Rushing.fumblesLost` or `Receiving.fumblesLost`,
  // which is what an earlier version of this file wrongly assumed.
  "Defense.fumblesLost": "fum_lost",

  // Individual defensive stats. Note these are for *players*, not the team
  // defense unit — fantasy DST scoring comes from the `DST` block instead.
  "Defense.defTD": "def_td",
  "Defense.sacks": "def_sack",
  "Defense.defensiveInterceptions": "def_int",
  "Defense.fumblesRecovered": "def_fum_rec",

  "Kicking.xpMade": "xp_made",
};

/**
 * The team defense block, `box.DST.home` / `box.DST.away`.
 *
 * A separate object from player stats, and the only place `ptsAllowed` appears —
 * which the tiered defensive rule needs.
 *
 * **`def_pts_allowed` must be emitted even when zero.** The scoring engine treats
 * an absent stat as "did not play", so a defense that pitched a shutout and
 * reported nothing would silently forfeit its 10-point bonus. Every unit that
 * played gets an explicit value.
 */
export const TANK01_DST_MAP: Readonly<Record<string, string>> = {
  ptsAllowed: "def_pts_allowed",
  sacks: "def_sack",
  defensiveInterceptions: "def_int",
  fumblesRecovered: "def_fum_rec",
  defTD: "def_td",
  safeties: "def_safety",
};

/**
 * Not available from Tank01.
 *
 * `def_blk_kick` appears in neither the DST block nor any player category. Until
 * a source is found, blocked kicks score nothing — a small, known
 * under-count rather than a silent wrong answer.
 */
export const TANK01_UNAVAILABLE_STATS: readonly string[] = ["def_blk_kick"];

// ---------------------------------------------------------------------------
// Field goals and two-point conversions
// ---------------------------------------------------------------------------

/**
 * Field goal distances are only in the play-by-play text.
 *
 * This is the one genuinely awkward thing about Tank01 for our rules. The
 * `Kicking` category gives `fgMade`, `fgAttempts`, `fgLong` — **counts, not
 * distances**. Our scoring pays 3/4/5 by distance, so counts are not enough.
 *
 * The distances exist, but only inside `scoringPlays[].score`, as prose:
 *
 *     "Brandon Aubrey 41 Yd Field Goal"
 *     "Jake Elliott 58 Yd Field Goal"
 *
 * So the adapter parses them. String parsing in a scoring path is exactly the
 * kind of thing that breaks quietly, so it is cross-checked: the number of field
 * goals parsed out must equal `Kicking.fgMade`. A mismatch means the format
 * changed, and it is raised rather than absorbed.
 */
const FIELD_GOAL_PATTERN = /(\d+)\s*Yd\s+Field\s+Goal/i;

/** Extract a field goal distance from a scoring play description. */
export function parseFieldGoalYards(scoreText: string): number | null {
  const match = FIELD_GOAL_PATTERN.exec(scoreText);
  if (!match?.[1]) return null;

  const yards = Number.parseInt(match[1], 10);
  return Number.isFinite(yards) ? yards : null;
}

/**
 * Two-point conversions are also only in the play-by-play.
 *
 * No `Passing`/`Rushing`/`Receiving` field carries them — another guess the
 * earlier version of this file got wrong. They appear as a distinct
 * `scoreType`, and the exact token has **not** yet been observed: the probe
 * game contained none. Confirm against a game that has one before trusting
 * two-point scoring.
 */
export const TWO_POINT_SCORE_TYPES: readonly string[] = ["2PT", "2PTC", "TWO POINT"];

export function isTwoPointConversion(scoreType: string): boolean {
  const normalised = scoreType.trim().toUpperCase();
  return TWO_POINT_SCORE_TYPES.some((token) => normalised.includes(token));
}

/** Bucket a made field goal into the three keys the scoring table uses. */
export function bucketFieldGoal(yards: number): "fg_0_39" | "fg_40_49" | "fg_50_plus" {
  if (yards >= 50) return "fg_50_plus";
  if (yards >= 40) return "fg_40_49";
  return "fg_0_39";
}

/**
 * Parse a Tank01 stat string.
 *
 * Values arrive as strings, and some are ratios rather than numbers —
 * `sacked: "0-0"`, `penalties: "4-42"`. Those are not stats we score, but a
 * parser that returned `0` for them would hide a mapping mistake, so anything
 * unparseable comes back null.
 */
export function parseStatValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : Math.round(raw);
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;

  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? Math.round(value) : null;
}
