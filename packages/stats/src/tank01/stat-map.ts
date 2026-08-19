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
  // **This is the opponent's fumbles *lost*, not this unit's recoveries**, and it
  // is kept anyway because Tank01 offers nothing that is the latter. Established
  // 2026-08-17 by separating the two readings across 22 team-games:
  // `20251005_TEN@ARI` discriminates them and the field follows fumbles-lost.
  //
  // The two agree on almost every game, because almost every fumble a team loses
  // is recovered by the defence. They part company when a *defender* fumbles
  // during a return and the intercepted team recovers: ESPN pays the recovering
  // unit 2, and this field does not see it. Measured across 2024 and 2025:
  // `20250925_SEA@ARI`, `20251130_MIN@SEA` and `20251208_PHI@LAC` — three
  // team-weeks, 2 points each, Sleeper right in all three.
  //
  // **No substitute exists and none was invented.** `teamStats` carries no
  // recovery counter at all (see `docs/TANK01.md`), and the per-player
  // `Defense.fumblesRecovered` is contaminated by design — a player who falls on
  // his own fumble carries it, 185 player-weeks of 2025 did, and a teammate
  // recovering a teammate's fumble is indistinguishable from a defender
  // recovering an opponent's. Summing it per team and subtracting an estimate of
  // the own-fumble half would be a derivation dressed as a reading, and a
  // three-team-week undercount is a better answer than a number nobody can check.
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
 * `teamStats` fields read as a **source**, not as a cross-check.
 *
 * The only one so far, and the reason it is here rather than in
 * {@link TANK01_DST_MAP} is simply that the `DST` block does not carry it: the
 * `DST` keys are `teamAbv teamID defTD defensiveInterceptions sacks ydsAllowed
 * fumblesRecovered ptsAllowed safeties` and nothing else.
 *
 * **A defensive two-point conversion return** is what happens when a defence
 * takes a failed conversion attempt back the other way. ESPN pays the D/ST **2**
 * for it and we had no stat key at all until 2026-08-17, so it scored nothing.
 * Three occurrences across 2024 and 2025 — Dallas in 2025 week 4
 * (`"Markquese Bell Defensive PAT Conversion"`), Miami in 2025 week 13, and
 * Philadelphia in 2024 week 4.
 *
 * Read from the number rather than parsed out of the text, deliberately. The
 * wording varies (`"Defensive PAT Conversion"` is not the only form), the event
 * is rare enough that a pattern would go years without being exercised, and
 * unlike a field goal's distance there is nothing here that only the prose
 * knows.
 */
export const TANK01_TEAM_STATS_MAP: Readonly<Record<string, string>> = {
  defensiveTwoPointConversionReturns: "def_2pt_ret",
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
 * `TD`, `FG` and `SF` are the three that carry meaning here, and they were the
 * only three seen across 48 games of 2025 weeks 1-3. **That is not the whole
 * vocabulary**, and this comment used to say it was: a sweep of the full season
 * also found `2PTC` and a `null`, and a sweep of 2024 found **`BP`** — see
 * {@link isTouchdownScoringPlay}, which is why nothing decides a touchdown by
 * asking whether this field equals `"TD"` any more.
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

// ---------------------------------------------------------------------------
// Which scoring plays are touchdowns
// ---------------------------------------------------------------------------

/**
 * The `scoreType` values this adapter has actually seen.
 *
 * Not consulted to decide anything — {@link isTouchdownScoringPlay} deliberately
 * does not read it — but a value outside it is worth saying out loud, because
 * this list has now been wrong twice and both times the symptom was silence. See
 * {@link isKnownScoreType}.
 *
 * `TD` `FG` `SF` across 96 games of 2025 weeks 1-3; `2PTC` and an absent value
 * from the full 2025 sweep; `BP` from 2024, verbatim below.
 */
export const KNOWN_SCORE_TYPES: ReadonlySet<string> = new Set(["TD", "FG", "SF", "2PTC", "BP"]);

/**
 * `scoreType` values that are definitely **not** a touchdown.
 *
 * The list this file is prepared to be exhaustive about, because each member was
 * observed carrying its own non-touchdown event: a field goal, a safety, a
 * conversion attempt. Everything else is *eligible*, and the text decides.
 */
const NON_TOUCHDOWN_SCORE_TYPES: ReadonlySet<string> = new Set(["FG", "SF", "2PTC"]);

/**
 * Whether a scoring play may be a touchdown.
 *
 * **A deny-list, and that inversion is the whole point.** This used to be
 * `play.scoreType === "TD"` in the two places that pay six points, and Tank01
 * has a fifth value. Verbatim, from `20241208_BUF@LAR`:
 *
 *     BP | LAR | Hunter Long 22 Yd Return of Blocked Punt (Joshua Karty Kick)
 *
 * That is a touchdown. Under the equality test the returner got no `ret_td` and
 * the Rams' unit no `def_td` — **12 points on one play, in silence**, because
 * `DST.defTD` reads `"0"` and `defensiveOrSpecialTeamsTds` reads `"0"` too, so
 * no other path and no cross-check made it up.
 *
 * An allow-list of `TD` and `BP` would fix that one play and leave the next
 * unknown value exactly as expensive. So the question asked is the negative one:
 * a play is eligible unless its type names something that is known not to be a
 * touchdown. An unfamiliar value, and an absent one, are eligible.
 *
 * **This is only safe because the type is never the deciding evidence.** Both
 * callers require {@link isSpecialTeamsReturnTouchdown} on the play text as
 * well, and that pattern names the event — a kickoff, punt or blocked-kick
 * return. What this function removes is a veto, not a requirement. The
 * deliberate exclusion of the extra point from {@link BLOCKED_KICK_RECOVERY} and
 * from {@link SPECIAL_TEAMS_RETURN} is what stops the one thing that would
 * otherwise leak in: a blocked *extra point* taken back the other way is a
 * defensive two-point conversion return worth 2, not a touchdown worth 6.
 */
export function isTouchdownScoringPlay(scoreType: string | null | undefined): boolean {
  return !NON_TOUCHDOWN_SCORE_TYPES.has((scoreType ?? "").trim().toUpperCase());
}

/**
 * Whether this `scoreType` is one we have seen before.
 *
 * The tripwire, and the reason it exists rather than being inferred later:
 * `"BP"` was invisible for as long as it was, and cost 12 points every time it
 * appeared, precisely because nothing anywhere said "this is a value we do not
 * know". A season sweep is what found it, and a season sweep is not something
 * that happens on a schedule.
 *
 * An absent or empty value counts as known — the full-2025 sweep found one, so
 * warning about it would be noise on the very first game rather than a signal.
 */
export function isKnownScoreType(scoreType: string | null | undefined): boolean {
  const value = (scoreType ?? "").trim().toUpperCase();
  return value === "" || KNOWN_SCORE_TYPES.has(value);
}

/**
 * Whether Tank01 leaves this play out of {@link TANK01_TEAM_DEF_ST_TD_FIELD}.
 *
 * Read by the cross-check in `box-score.ts` and by nothing that scores. A `BP`
 * play is a special-teams touchdown we now pay for, and it appears in **neither**
 * of the provider's own two counters, so a comparison that includes it reports a
 * discrepancy on a game we have just started scoring correctly — which is the
 * defect #181 fixed for blocked kicks filed as defensive, arriving from the
 * other direction.
 *
 * **This rests on one observation and says so.** `20241208_BUF@LAR` is the only
 * `BP` play in 2024 or 2025: the Rams have one blocked-punt return touchdown,
 * `defensiveOrSpecialTeamsTds` reads `"0"` and `DST.defTD` reads `"0"`.
 * (`teamStats.blockedPunt` reads `"1"`, so the block itself is counted; it is
 * the touchdown that is not.) Whether that is how `BP` is always filed or how
 * one game happened to be filed cannot be told apart from a single play — but a
 * warning that fires on a correctly scored game trains people to dismiss the
 * next real one, and the exclusion is reported in the warning text when the
 * check still disagrees, so a genuinely uncounted play cannot read as one nobody
 * noticed.
 */
export function isUncountedSpecialTeamsScoreType(
  scoreType: string | null | undefined,
): boolean {
  return (scoreType ?? "").trim().toUpperCase() === "BP";
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
 * The recovery forms below are anchored on **`blocked`**, which a fumble recovery
 * never carries, and `DEFENSIVE_RETURN` matches a recovery as well as a return so
 * the guard holds even if this pattern is loosened later. There is a test for
 * that exact negative.
 *
 * **Corrected 2026-08-17.** This comment used to say that adding a bare `recover`
 * alternative to {@link SPECIAL_TEAMS_RETURN} would turn **14 defensive
 * touchdowns** into `ret_td` as well. It would not, and has not since
 * `DEFENSIVE_RETURN` was widened to `/(interception|fumble)\s+(return|recovery)/`.
 * Measured over all **2,339** scoring plays of the 2025 season: the loose variant
 * goes from 26 matches to **27**, and the single addition is George Holani, below.
 * Not one of the season's **19** fumble touchdowns — 17 worded `"Fumble
 * Recovery"`, 2 worded `"Fumble Return"` — leaks, because
 * {@link isSpecialTeamsReturnTouchdown} consults `DEFENSIVE_RETURN` first and
 * every one of them matches it. The anchoring stays anyway: a pattern that is
 * correct only by virtue of a different pattern in front of it is one edit away
 * from not being.
 *
 * ## Still not recognised, deliberately
 *
 * `"George Holani Recovered Kickoff in End Zone for a Touchdown"` (issue #158) is
 * left out, and **the reason is what ESPN pays rather than a collision with
 * fumble recoveries** — the reason this comment gave until 2026-08-17, which the
 * measurement above retires.
 *
 * A Seattle kickoff was muffed by Pittsburgh and recovered in the end zone, which
 * is a coverage-team score rather than a return. **ESPN pays the player 0 and
 * Seattle's D/ST 6**, filing it under stat id **104**, its fumble-return
 * touchdown; Holani's ESPN fantasy `appliedTotal` for 2025 week 2 is 0. Tank01
 * mirrors ESPN — `Defense.defTD: "1"`, `Kicking.kickReturnTD: "0"`. **Sleeper
 * disagrees** and pays him `st_td` 6. We score exactly what ESPN scores, so a
 * `ret_td` of 0 here is the right answer rather than a gap waiting on evidence.
 */
const DEFENSIVE_RETURN = /\b(interception|fumble)\s+(return|recovery)\b/i;
/**
 * A return, named by what was returned.
 *
 * **The second alternative used to be a bare `return of blocked`**, and it was
 * narrowed on 2026-08-17 to name the kick, so that it carries the same exclusion
 * {@link BLOCKED_KICK_RECOVERY} spells out below: a blocked **extra point**
 * taken the other way is a two-point defensive conversion return, not a
 * touchdown. That mattered only once {@link isTouchdownScoringPlay} stopped
 * insisting on a `scoreType` of `"TD"` — the equality test was previously doing
 * the job this narrowing now does explicitly, which is exactly the shape of
 * guard that stops holding the moment somebody edits the thing in front of it.
 *
 * No known string moves. All four blocked-kick returns name a punt or a field
 * goal: `"22 Yd Return of Blocked Punt"`, `"35 yd. return of blocked punt"`,
 * `"76 Yd Return of Blocked Field Goal"`.
 */
const SPECIAL_TEAMS_RETURN =
  /\b(kickoff|kick|punt)\s+return\b|\breturn\s+of\s+blocked\s+(kick|punt|field\s+goal|fg)\b/i;
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
 * Whether a special-teams touchdown was a **blocked kick**.
 *
 * A narrowing of {@link isSpecialTeamsReturnTouchdown} that **says nothing about
 * scoring**: a blocked-kick touchdown pays the scorer his `ret_td` and the unit
 * its six exactly as any other special-teams score does, and all four 2025
 * examples reconcile against ESPN on both. It exists for one consumer — the
 * `defensiveOrSpecialTeamsTds` cross-check in `box-score.ts` — because **ESPN
 * files a blocked-kick touchdown as a _defensive_ score**, stat id 93, "Def.
 * blocked kick for TD", rather than as a return. So Tank01's counter holds one of
 * these **once** where it holds an ordinary return by a defensive player twice,
 * and a check that does not know the difference reports a discrepancy on a
 * correctly scored game.
 *
 * Every observed wording puts "blocked" immediately before the kick, in both the
 * recovered and the returned form, so this is {@link BLOCKED_KICK_RECOVERY}'s own
 * anchor rather than a second vocabulary:
 *
 *     Blocked Kick Recovered by Jordan Davis (PHI) …        -> true
 *     Marshawn Kneeland Blocked Punt Recovery in End Zone   -> true
 *     Sydney Brown 35 yd. return of blocked punt            -> true
 *     Jared Verse 76 Yd Return of Blocked Field Goal        -> true
 *     Marcus Jones 87 Yd Punt Return                        -> false
 *
 * Not {@link isBlockedKick}, which answers a different question — it matches the
 * bare word anywhere, including `"(Joshua Karty PAT blocked)"` on a rushing
 * touchdown, which is a block that scored for nobody.
 */
export function isBlockedKickTouchdown(scoreText: string): boolean {
  return BLOCKED_KICK_RECOVERY.test(scoreText);
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

/*
 * `scoredInMainClause` used to live here — a raw substring test, safe only
 * because it was asked exclusively about players the play already named in
 * `playerIDs`, and saying so. It was removed on 2026-08-17 when return
 * touchdowns stopped being gated on `playerIDs` at all, because that gate
 * dropped the scorer outright on `20241229_CAR@TB`. Its own docstring named the
 * condition for widening — "not safe … without a stricter comparison" — and
 * `returnTouchdownCredits` is that comparison: normalised name forms, every
 * spelling, and a refusal when more than one player answers. Deleted rather than
 * left, so nothing reaches for the weaker one.
 */

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

/**
 * A Tank01 decimal as an exact integer and the power of ten it is scaled by.
 *
 * `"-0.5"` becomes `{ scaled: -5, scale: 1 }`.
 *
 * {@link parseStatValue} cannot serve here and the reason is the whole point of
 * a separate function: it ends in `Math.round`, so `"13.3"` comes back as `13`
 * and `"-0.5"` as `-0` or `-1` depending on the tie rule. A cross-check built on
 * it would be comparing against numbers the provider never sent — measured, that
 * mistake fires on **178 of 344** average-bearing rows in the conformance
 * corpus. It is the natural mistake to make, because every other read in
 * `box-score.ts` goes through `parseStatValue`.
 *
 * **Scaled integers because invariant 2 does not stop at the scoring engine.**
 * `4 * 13.3` is `53.20000000000000284` in IEEE754, and a tolerance sized to
 * absorb that is a tolerance sized to hide arithmetic error rather than to
 * describe the provider's rounding — two different quantities wearing one
 * number, which is how a threshold stops meaning anything. James Conner's
 * 39 yards on 12 carries false-fires on the float route, in a corpus game,
 * today.
 *
 * `null` for anything that is not a plain decimal: a ratio like `"3-16"`, an
 * empty string, an absent field, a non-string. More than three decimal places is
 * refused too, so `10 ** scale` stays far inside the safe-integer range for
 * every product built on this. Nothing Tank01 has been observed to send carries
 * more than one — all 345 rushing, receiving and passing averages in the corpus
 * are a single decimal place.
 */
export function parseDecimalStat(raw: unknown): { scaled: number; scale: number } | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) ? { scaled: raw, scale: 0 } : null;
  }
  if (typeof raw !== "string") return null;

  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(raw.trim());
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  // The digits are joined and the sign applied afterwards, so `"-0.5"` is -5
  // rather than a negative zero followed by a positive 5.
  const digits = Number.parseInt(`${whole}${fraction}`, 10);
  if (!Number.isSafeInteger(digits)) return null;

  return { scaled: sign === "-" ? -digits : digits, scale: fraction.length };
}
