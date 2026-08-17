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
  //
  // **This is the only `Defense.*` field mapped, and the exclusion of the rest
  // is deliberate — see the block below.**
  "Defense.fumblesLost": "fum_lost",

  "Kicking.xpMade": "xp_made",
  // Missed field goals cost a point each under ESPN's table. `fgMissed` is a
  // real field — confirmed in the captured fixture — so it is read rather than
  // derived from `fgAttempts - fgMade`, which would be a second definition of
  // the same number and free to disagree with the first.
  //
  // Distance is deliberately not consulted: a miss is not a scoring play, so it
  // never appears in the text the made distances are parsed from. ESPN charging
  // a flat -1 is what makes the category computable from this feed at all.
  "Kicking.fgMissed": "fg_missed",
};

/**
 * Why no per-player defensive stats are mapped.
 *
 * `Defense.defTD`, `Defense.sacks`, `Defense.defensiveInterceptions` and
 * `Defense.fumblesRecovered` used to be mapped here, to `def_td`, `def_sack`,
 * `def_int` and `def_fum_rec`, under a comment saying they were "for *players*,
 * not the team defense unit". That comment was accurate about the data and wrong
 * about the consequence: **nothing in this product can consume a per-player
 * defensive stat.** `NFL_SLOT_TYPES` admits QB, RB, WR, TE, K and DEF and there
 * is no IDP slot, so the only roster spot those keys reach is the D/ST — which is
 * scored from {@link TANK01_DST_MAP} instead. A per-player row keyed on the same
 * stat key is not an unused row; it is a **duplicate** attributed to whoever
 * happens to hold that player.
 *
 * And Tank01 files things under `Defense` that are not defensive plays at all. A
 * player who fumbles and falls on his own ball carries
 * `Defense.fumblesRecovered: "1"`. Verified verbatim in
 * `__fixtures__/box-score-blocked-punt-td.json` (2025 week 9, `20251103_ARI@DAL`):
 *
 *     Jacoby Brissett  (QB, ARI)  fumbles "1"  fumblesRecovered "1"
 *     George Pickens   (WR, DAL)  fumbles "2"  fumblesRecovered "1"
 *     Javonte Williams (RB, DAL)  fumbles "1"  fumblesRecovered "1"
 *
 * All three were paid `def_fum_rec` — 2 points each — for recovering their own
 * fumbles. Measured across the 2025 season: **185 player-weeks, 384 points.**
 * `Defense.defTD` did the same thing to Tyler Lockett (WR), credited 6 points for
 * "Tyler Lockett 0 Yd Fumble Recovery" in week 5.
 *
 * `Defense.fumblesLost` stays, because that one really is the offensive player's
 * own stat and `fum_lost` really is scored on his roster spot.
 */
export const TANK01_UNMAPPED_PLAYER_DEFENSE_FIELDS: readonly string[] = [
  "Defense.defTD",
  "Defense.sacks",
  "Defense.defensiveInterceptions",
  "Defense.fumblesRecovered",
];

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
  // Added 2026-08-16 with the ESPN alignment. ESPN scores the unit on yards as
  // well as points, and this is the only place the figure appears. Like
  // `ptsAllowed` it must be emitted even at zero, for the same reason.
  ydsAllowed: "def_yds_allowed",
  sacks: "def_sack",
  defensiveInterceptions: "def_int",
  fumblesRecovered: "def_fum_rec",
  defTD: "def_td",
  safeties: "def_safety",
};

/**
 * `teamStats.home` / `teamStats.away` — the fields the `DST` block does not carry.
 *
 * A **second** team-level block, and one this adapter read nothing from until
 * 2026-08-17. Like everything else from this provider its values are strings —
 * `blockedFG: "1"`, not `1` — which is worth stating only because the first
 * version of this comment said the opposite and two tests caught it.
 *
 * It is keyed the way `DST` is: `home` / `away`, each carrying its own
 * `teamAbv`, and in every captured game the two blocks agree side for side. This
 * adapter still matches on `teamAbv` rather than on the side, because crediting a
 * defensive stat to the wrong team is a swing between two rosters and there is no
 * reason to depend on an ordering nothing enforces.
 */

/**
 * The three blocked-kick counters, summed into `def_blk_kick`.
 *
 * **Credited to the team that made the block**, which is the fact that had to be
 * established before these could be used at all — the mirror of the trap
 * {@link isBlockedKick}'s caller fell into twice. Proven against
 * `20250907_ARI@NO` (2025 week 1), captured as
 * `__fixtures__/box-score-blocked-fg.json`: Arizona's kicker had a field goal
 * blocked, and it is **New Orleans** whose `teamStats` reads `blockedFG: 1` while
 * Arizona's reads `0`.
 *
 * That game is also why these are read at all: no scoring play in it mentions a
 * block, so the text path — the only source before this — scored New Orleans 0.
 * **27 of the season's 44 blocked kicks never led to a score**, which is 54
 * points invisible to a translator that only reads scoring text.
 */
export const TANK01_TEAM_BLOCKED_KICK_FIELDS: readonly string[] = [
  "blockedFG",
  "blockedPunt",
  "blockedXP",
];

/**
 * Tank01's own count of a team's defensive **and** special-teams touchdowns.
 *
 * Read as a cross-check and never as a source, because it **double-counts the
 * same play** the way this adapter used to. `20250928_CAR@NE` (2025 week 4) has
 * exactly one defensive or special-teams touchdown in it — Marcus Jones's 87-yard
 * punt return — and New England's `defensiveOrSpecialTeamsTds` reads **2**, being
 * `DST.defTD` (1, because Jones is a cornerback and ESPN counts his return as a
 * defensive touchdown too) plus the special-teams score (1).
 *
 * Which makes `defensiveOrSpecialTeamsTds - DST.defTD` a usable check on our own
 * detection of special-teams touchdowns: it is Tank01's independent count of the
 * same thing. It is what would have caught `Marshawn Kneeland Blocked Punt
 * Recovery in End Zone` sitting unrecognised for a season.
 */
export const TANK01_TEAM_DEF_ST_TD_FIELD = "defensiveOrSpecialTeamsTds";

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
 * `TD`, `FG` and `SF` are the three that carry meaning here, and they were the
 * only three seen across 48 games of 2025 weeks 1-3. **That is not the whole
 * vocabulary**, and this comment used to say it was: a sweep of the full season
 * also found `2PTC` and a `null`. Nothing below enumerates the set — every use
 * is an equality test against one of the three — so an unfamiliar value is inert
 * rather than a crash, and that is deliberate.
 *
 * Extra points, two-point conversions, and blocked kicks are not score types at
 * all: they live in the trailing parenthetical of a touchdown's `score` text, the
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
 *     Marshawn Kneeland Blocked Punt Recovery in End Zone -> ret_td
 *     Blocked Kick Recovered by Jordan Davis (PHI) …      -> ret_td
 *
 *     Christian Benford 63 Yd Interception Return   -> def_td   (defensive)
 *     Tyler Lockett 0 Yd Fumble Recovery            -> def_td
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
 *
 * ## "Recovery" is not a synonym for "return", and that is the trap here
 *
 * A blocked kick is often *recovered* rather than *returned* — verbatim, from
 * 2025 week 9 `20251103_ARI@DAL`:
 *
 *     Marshawn Kneeland Blocked Punt Recovery in End Zone (Brandon Aubrey Kick)
 *
 * There is no "return" anywhere in it, so the old pattern scored it as nothing at
 * all: Dallas's unit lost the 6 points `RULES.md` §1 pays for a special-teams
 * touchdown, and `DST.defTD` reads `"0"` for that game, so no other path made it
 * up. Issue #158's `"Blocked Kick Recovered by Jordan Davis (PHI) … 61 Yd
 * Touchown Return"` is the same shape.
 *
 * **The obvious repair is wrong.** Adding a bare `recover` alternative to
 * {@link SPECIAL_TEAMS_RETURN} looks equivalent and is not: every fumble-return
 * touchdown in the 2025 season is worded `"Fumble Recovery"`, not `"Fumble
 * Return"`, so a loose `recover` turns **14 defensive touchdowns** into `ret_td`
 * *and* `def_td` — one play paid twice, in two different roster spots. So the
 * recovery forms below are anchored on **`blocked`**, which a fumble recovery
 * never carries, and `DEFENSIVE_RETURN` is widened to exclude a recovery as well
 * as a return so the guard holds even if this pattern is loosened later. There is
 * a test for that exact negative.
 *
 * ## Still not recognised, deliberately
 *
 * `"George Holani Recovered Kickoff in End Zone for a Touchdown"` (issue #158) is
 * left out. It is not a blocked kick, the scorer is a running back rather than a
 * defender, and whether ESPN pays that as a return touchdown or as an offensive
 * fumble recovery has not been established from a second source. Adding it would
 * put six points on a rosterable player on a guess.
 */
const DEFENSIVE_RETURN = /\b(interception|fumble)\s+(return|recovery)\b/i;
const SPECIAL_TEAMS_RETURN = /\b(kickoff|kick|punt)\s+return\b|\breturn\s+of\s+blocked\b/i;
/**
 * A blocked kick recovered rather than returned. Anchored on "blocked".
 *
 * Note what is **not** in the alternation: extra point and PAT. A blocked extra
 * point picked up and taken the other way is a two-point defensive conversion
 * return, not a touchdown, and `"(Joshua Karty PAT blocked)"` puts the word the
 * other way round in any case.
 */
const BLOCKED_KICK_RECOVERY = /\bblocked\s+(kick|punt|field\s+goal|fg)\b/i;

export function isSpecialTeamsReturnTouchdown(scoreText: string): boolean {
  if (DEFENSIVE_RETURN.test(scoreText)) return false;
  return SPECIAL_TEAMS_RETURN.test(scoreText) || BLOCKED_KICK_RECOVERY.test(scoreText);
}

/**
 * A play's text with every parenthetical removed.
 *
 * Tank01 splits a scoring play into two parts, and **which part a name appears
 * in is what identifies the player's role**:
 *
 *     Rashid Shaheed 58 Yd Punt Return (Sam Darnold Pass to Cooper Kupp for …)
 *     └─ main clause: who scored ────┘ └─ parenthetical: the PAT or conversion ┘
 *
 * So this is the complement of the window {@link isSuccessfulTwoPointConversion}
 * is matched in: conversions are read from inside the parenthetical, the score
 * itself from outside it.
 *
 * **This replaces `playerIDs[0]`.** The returner is *usually* first in that
 * array, and the comment that said so held for 26 of the 27 return touchdowns
 * in the 2025 season — but on the play above Tank01 orders it
 * `[Darnold, Shaheed, Kupp]`, putting the conversion passer first. Sam Darnold,
 * a quarterback, was credited a 6-point punt-return touchdown, and Rashid
 * Shaheed was denied his: a 12-point swing on one play, both halves wrong, with
 * no warning anywhere. Ordering is an implementation detail of the feed; the
 * clause a name sits in is what the sentence actually means.
 *
 * `(PHI)` in "Blocked Kick Recovered by Jordan Davis (PHI) …" is stripped too,
 * which is harmless — that name also appears in the main clause.
 */
export function mainClause(scoreText: string): string {
  return scoreText.replace(/\([^)]*\)/g, " ");
}

/**
 * Whether this player is the one the main clause says scored.
 *
 * A substring match, like `twoPointCredit`'s, and safe for the same reason: it
 * is only ever asked about players the play already names in `playerIDs`, so a
 * coincidental hit needs two participants in one play whose names contain one
 * another. It is **not** safe to widen this to the whole roster without a
 * stricter comparison.
 */
export function scoredInMainClause(scoreText: string, longName: string): boolean {
  return mainClause(scoreText).includes(longName);
}

/**
 * Whether a touchdown was a defensive return — an interception or a fumble,
 * **returned or recovered**.
 *
 * The `recovery` half was added on 2026-08-17 with the blocked-kick recovery
 * forms above. It changes nothing on its own — a fumble recovery matched neither
 * pattern before — but it is what keeps the two mutually exclusive now that one
 * of them recognises the word "recover" at all, and every 2025 fumble-return
 * touchdown is worded `"Fumble Recovery"` rather than `"Fumble Return"`.
 */
export function isDefensiveReturnTouchdown(scoreText: string): boolean {
  return DEFENSIVE_RETURN.test(scoreText);
}

/**
 * Bucket a made field goal into the four keys the scoring table uses.
 *
 * `fg_50_plus` became `fg_50_59` and `fg_60_plus` on 2026-08-16, because ESPN
 * pays 6 for a 60-yarder and 5 for a 55-yarder. Twelve 60+ field goals were
 * kicked in the 2025 season, so the bucket is real rather than theoretical, and
 * a kicker who hits one is worth a point more than this used to say.
 */
export function bucketFieldGoal(
  yards: number,
): "fg_0_39" | "fg_40_49" | "fg_50_59" | "fg_60_plus" {
  if (yards >= 60) return "fg_60_plus";
  if (yards >= 50) return "fg_50_59";
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
