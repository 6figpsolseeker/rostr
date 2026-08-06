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
 * Everything our scoring table needs is obtainable.
 *
 * An earlier version of this file claimed blocked kicks were unavailable. They
 * are not — see {@link isBlockedKick}. Confirmed across 48 games of 2025.
 */
export const TANK01_UNAVAILABLE_STATS: readonly string[] = [];

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
 * Two-point conversions and blocked kicks: the parenthetical.
 *
 * Confirmed across 48 games of the 2025 season (weeks 1-3). There are exactly
 * **three** `scoreType` values — `TD`, `FG`, `SF` — and nothing else. Extra
 * points, two-point conversions, and blocked kicks are not score types at all:
 * they live in the trailing parenthetical of a touchdown's `score` text, the
 * same slot as the kick.
 *
 * Every observed form:
 *
 *     (Brandon Aubrey Kick)                                    XP made
 *     (Harrison Butker PAT Failed)                             XP missed
 *     (Joshua Karty PAT blocked)                               XP blocked
 *     (Rhamondre Stevenson Run for Two-Point Conversion)       2PT good
 *     (Tua Tagovailoa Pass to Julian Hill for Two-Point ...)   2PT good
 *     (Two-Point Pass Conversion Failed)                       2PT failed
 *
 * An earlier version of this file checked `scoreType` for a "2PT" token. It
 * would never have matched, and a looser text match would have **awarded two
 * points for a failed conversion** — the exact silent scoring bug this parsing
 * has to avoid. Hence the explicit `Failed` exclusion, and a test for it.
 */

const TWO_POINT_PATTERN = /Two-Point\s+\w*\s*Conversion/i;
const FAILED_PATTERN = /\bfailed\b/i;

/**
 * Whether the play includes a **successful** two-point conversion.
 *
 * Note the asymmetry in Tank01's wording: a success names the players
 * ("Rhamondre Stevenson Run for Two-Point Conversion") while a failure often
 * does not ("Two-Point Pass Conversion Failed"). Only the `Failed` token is a
 * reliable discriminator.
 */
export function isSuccessfulTwoPointConversion(scoreText: string): boolean {
  return TWO_POINT_PATTERN.test(scoreText) && !FAILED_PATTERN.test(scoreText);
}

/**
 * Whether the play involved a blocked kick.
 *
 * Two observed forms:
 *
 *     Blake Corum 1 Yd Rush (Joshua Karty PAT blocked)
 *     Blocked Kick Recovered by Jordan Davis (PHI) Jordan Davis 61 Yd Touchown Return
 *
 * Note "Touchown" — Tank01's own text contains typos, which is a standing
 * argument for matching on stable tokens rather than whole phrases.
 */
export function isBlockedKick(scoreText: string): boolean {
  return /\bblocked\b/i.test(scoreText) || /\bblocked\s+kick\b/i.test(scoreText);
}

/** Whether the play's PAT attempt was a successful kick. */
export function isExtraPointMade(scoreText: string): boolean {
  return /\(\s*[^)]*\bKick\s*\)/i.test(scoreText) && !FAILED_PATTERN.test(scoreText);
}

/**
 * Whether a touchdown was a **special teams return** by a player.
 *
 * The distinction that matters, and the trap this exists to avoid:
 *
 *     Rashid Shaheed 100 Yd Kickoff Return          -> ret_td   (special teams)
 *     Marcus Jones 87 Yd Punt Return                -> ret_td
 *     Sydney Brown 35 yd. return of blocked punt    -> ret_td
 *     Jared Verse 76 Yd Return of Blocked Field Goal -> ret_td
 *
 *     Christian Benford 63 Yd Interception Return   -> def_td   (defensive)
 *     ... Fumble Return                             -> def_td
 *
 * Interception and fumble returns are already scored as defensive touchdowns.
 * Counting them here as well would pay a single play twice under two different
 * rules — which is exactly the misconfiguration Sleeper's own documentation
 * warns about.
 *
 * Note `"35 yd. return of blocked punt (J.Elliott kick)"` — lowercase, an
 * abbreviated name, and a full stop after "yd". Tank01's play text comes from
 * more than one source and its formatting is not consistent, so this matches
 * tokens rather than shapes.
 */
const DEFENSIVE_RETURN = /\b(interception|fumble)\s+return\b/i;
const SPECIAL_TEAMS_RETURN = /\b(kickoff|kick|punt)\s+return\b|\breturn\s+of\s+blocked\b/i;

export function isSpecialTeamsReturnTouchdown(scoreText: string): boolean {
  if (DEFENSIVE_RETURN.test(scoreText)) return false;
  return SPECIAL_TEAMS_RETURN.test(scoreText);
}

/** Whether a touchdown was a defensive return — an interception or fumble. */
export function isDefensiveReturnTouchdown(scoreText: string): boolean {
  return DEFENSIVE_RETURN.test(scoreText);
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
