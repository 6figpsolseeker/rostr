/**
 * What each corpus game is FOR.
 *
 * ## The failure this exists to prevent
 *
 * A corpus of real games that reconciles perfectly and contains no scoring D/ST,
 * no missed field goal and no unusual `scoreType` is **worthless and looks
 * green**. Every check in `corpus.test.ts` would pass on it, every future run
 * would keep passing, and the first regression in the translator would be found
 * on a Sunday in October — by which point the week has finalised and, because a
 * finalised week is never rescored, the wrong score is permanent.
 *
 * So a game does not merely sit in the corpus; it **claims** something. Each
 * claim is one of the classes below, and `corpus.test.ts` re-derives every claim
 * from the fixture on every run. A fixture that is recaptured, trimmed or
 * replaced and no longer contains the rare thing it was chosen for fails
 * immediately, saying which class went missing, rather than quietly becoming an
 * ordinary game.
 *
 * ## Read from the Tank01 fixture, never from ESPN
 *
 * Every detector below takes the raw Tank01 response. That is deliberate and it
 * is the point of the file: ESPN's `scoringType` labels are richer and easier to
 * search — `"Blocked Punt Touchdown"` is right there — but coverage asserted
 * against ESPN would certify that *ESPN* still describes the play, which is not
 * the question. The translator reads Tank01. `SCORE_TYPE_BP` exists precisely
 * because Tank01 files that play under a value **ESPN does not publish at all**
 * — ESPN leaves `scoringType` null on it — so an ESPN-driven search cannot find
 * the one play in two seasons that cost twelve points.
 *
 * ## These are detectors, not scoring logic
 *
 * Where a detector needs to know who a play names, it matches on surnames rather
 * than reusing the translator's own name resolution. That is a deliberate
 * approximation: the only job here is to answer "is the rare shape still in this
 * file". Nothing in this module is consulted when scoring.
 *
 * ## What is shared with the translator, and what is deliberately copied
 *
 * The play-text patterns are **imported**, because they are the vocabulary for
 * describing these events and a second set of regexes would drift from the first
 * without anything noticing.
 *
 * {@link NOT_A_TOUCHDOWN} is **copied**, and that is the one exception. The
 * translator asks the same question through `isTouchdownScoringPlay`, which is a
 * deny-list precisely because the answer has been wrong twice — so it is the
 * value most likely to move, and a detector that moved with it would report a
 * translator regression as *lost coverage*. Measured: reverting the deny-list to
 * `scoreType === "TD"` used to fail `20241208_BUF@LAR` twice, once truthfully in
 * the ledger and once misleadingly here. Now it fails once, in the ledger, where
 * the message names the six points.
 */

import {
  bucketFieldGoal,
  isBlockedKick,
  isBlockedKickTouchdown,
  isDefensiveReturnTouchdown,
  isSpecialTeamsReturnTouchdown,
  isSuccessfulTwoPointConversion,
  mainClause,
  parseFieldGoalYards,
  parseStatValue,
  TANK01_TEAM_BLOCKED_KICK_FIELDS,
} from "../tank01/stat-map.js";

/** A copy of the translator's deny-list. See the module note on why it is a copy. */
const NOT_A_TOUCHDOWN: ReadonlySet<string> = new Set(["FG", "SF", "2PTC"]);

const isTouchdown = (scoreType: string | null | undefined): boolean =>
  !NOT_A_TOUCHDOWN.has((scoreType ?? "").trim().toUpperCase());

interface RawPlay {
  score?: string;
  scoreType?: string;
  team?: string;
  playerIDs?: string[];
}

interface RawPlayer {
  playerID?: string;
  longName?: string;
  team?: string;
  teamAbv?: string;
  [category: string]: unknown;
}

interface RawBox {
  gameID?: string;
  scoringPlays?: RawPlay[];
  playerStats?: Record<string, RawPlayer>;
  DST?: Record<string, Record<string, unknown> | undefined>;
  teamStats?: Record<string, Record<string, unknown> | undefined>;
}

// ---------------------------------------------------------------------------
// Small readers over the raw shape
// ---------------------------------------------------------------------------

const plays = (box: RawBox): readonly RawPlay[] => box.scoringPlays ?? [];
const players = (box: RawBox): readonly RawPlayer[] => Object.values(box.playerStats ?? {});

const sides = <T>(block: Record<string, T | undefined> | undefined): readonly T[] =>
  (["home", "away"] as const).map((side) => block?.[side]).filter((unit): unit is T => !!unit);

function category(player: RawPlayer, name: string): Record<string, unknown> | undefined {
  const value = player[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function statOf(player: RawPlayer, categoryName: string, field: string): number {
  return parseStatValue(category(player, categoryName)?.[field]) ?? 0;
}

function unitNumber(unit: Record<string, unknown>, field: string): number | null {
  return parseStatValue(unit[field]);
}

/**
 * The surnames a scoring play's `playerIDs` point at.
 *
 * Lower-cased last words of each named player's `longName`, with the common
 * generational suffixes dropped. Deliberately crude — see the module note on
 * why a detector does not share the translator's name resolution.
 */
function surnamesOf(play: RawPlay, box: RawBox): readonly string[] {
  const byId = box.playerStats ?? {};
  return (play.playerIDs ?? [])
    .map((id) => byId[id]?.longName ?? "")
    .map((name) => surname(name))
    .filter(Boolean);
}

function surname(longName: string): string {
  const words = longName
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[.'’`-]/g, "")
    .trim()
    .split(/\s+/);
  return words[words.length - 1] ?? "";
}

const flatten = (text: string): string => text.toLowerCase().replace(/[.'’`-]/g, "");

const specialTeamsTouchdowns = (box: RawBox): readonly RawPlay[] =>
  plays(box).filter(
    (play) => isTouchdown(play.scoreType) && isSpecialTeamsReturnTouchdown(play.score ?? ""),
  );

// ---------------------------------------------------------------------------
// The classes
// ---------------------------------------------------------------------------

/**
 * Every coverage class, with what it means and how it is detected.
 *
 * **Only classes some game actually claims belong here.** The test asserts that
 * every registered class is claimed by at least one game, so adding a class
 * speculatively turns the suite red until a game is captured for it — which is
 * the right pressure, and the reason this list is short rather than aspirational.
 */
export const COVERAGE_CLASSES: Readonly<Record<string, (box: RawBox) => boolean>> = {
  /**
   * A scoring play filed under `scoreType: "BP"`.
   *
   * The single most valuable row in the corpus. `BP` sat in the feed for two
   * seasons costing 12 points every time it appeared — 6 to the returner, 6 to
   * the unit — because both payers asked `scoreType === "TD"`. There is exactly
   * one such play in 2024 and 2025, so if this fixture stops containing it the
   * deny-list in `isTouchdownScoringPlay` has no test data left at all.
   */
  SCORE_TYPE_BP: (box) =>
    plays(box).some((play) => (play.scoreType ?? "").toUpperCase() === "BP"),

  /**
   * Two scoring plays with identical text.
   *
   * Real — Chris Boswell kicked two 48-yarders in the same game, and
   * `Kicking.fgMade` agrees that both happened. Worth a class because it is what
   * proves the ESPN republication check pairs plays by *claiming* each row once
   * rather than by set membership: a check that asked "does ESPN contain this
   * text" would pass a feed that had silently dropped one of the two.
   */
  DUPLICATE_SCORING_PLAY_TEXT: (box) => {
    const seen = new Set<string>();
    return plays(box).some((play) => {
      const text = (play.score ?? "").trim();
      if (!text) return false;
      if (seen.has(text)) return true;
      seen.add(text);
      return false;
    });
  },

  /** A made field goal of under 40 yards. */
  FG_0_39: (box) => hasFieldGoalBucket(box, "fg_0_39"),
  /** A made field goal of 40-49 yards. */
  FG_40_49: (box) => hasFieldGoalBucket(box, "fg_40_49"),
  /** A made field goal of 50-59 yards. */
  FG_50_59: (box) => hasFieldGoalBucket(box, "fg_50_59"),
  /**
   * A made field goal of 60 yards or more.
   *
   * The bucket that only exists because ESPN pays 6 for one and 5 for a
   * 55-yarder. Twelve were kicked in 2025, so a corpus without one is not
   * exercising the top of the only ladder a single player can move.
   */
  FG_60_PLUS: (box) => hasFieldGoalBucket(box, "fg_60_plus"),

  /**
   * A missed field goal.
   *
   * Worth a class of its own because it is the one kicking stat with no scoring
   * play behind it: a miss never appears in the text the distances are parsed
   * from, so it is read from `Kicking.fgMissed` and nothing cross-checks it.
   */
  FG_MISSED: (box) => players(box).some((player) => statOf(player, "Kicking", "fgMissed") > 0),

  /** A safety. */
  SAFETY: (box) => plays(box).some((play) => (play.scoreType ?? "").toUpperCase() === "SF"),

  /**
   * A safety whose text is nothing but a name and the word.
   *
   * `"Kaevon Merriweather Safety"` — no yardage, no verb, no parenthetical, and
   * no tokens in common with the other observed form (`"Defensive Holding in
   * Endzone for Safety"`). Nothing in the translator parses safety text today —
   * a safety is counted from `scoreType` and `team` — and that is exactly why
   * this is worth pinning: the terse form is the one a future text-driven
   * attribution would silently fail on, and it is in the corpus before anybody
   * writes one.
   *
   * The pattern is **a name and the word**, not "alphabetic words ending in
   * Safety". The looser version matched `"Defensive Holding in Endzone for
   * Safety"` — which is the exact form this class exists to be distinguished
   * from — and certified the wrong fixture as covering it.
   */
  SAFETY_TERSE: (box) =>
    plays(box).some(
      (play) =>
        (play.scoreType ?? "").toUpperCase() === "SF" &&
        /^[A-Z][a-z'’.-]+ [A-Z][A-Za-z'’.-]+(?: (?:Jr\.?|Sr\.?|II|III|IV))? Safety$/.test(
          (play.score ?? "").trim(),
        ),
    ),

  /**
   * A defence that allowed no points — the top tier of `def_pts_allowed`.
   *
   * The tier that only scores at all because `box-score.ts` emits `ptsAllowed`
   * when it is zero. Absent is "did not play" to the scoring engine, so without
   * this class nothing in the corpus proves the shutout bonus is ever paid.
   */
  DST_SHUTOUT: (box) => sides(box.DST).some((unit) => unitNumber(unit, "ptsAllowed") === 0),

  /** A defence that allowed under 100 yards — the top tier of `def_yds_allowed`. */
  DST_YARDS_TOP_TIER: (box) =>
    sides(box.DST).some((unit) => {
      const yards = unitNumber(unit, "ydsAllowed");
      return yards !== null && yards < 100;
    }),

  /**
   * A defence that allowed 46 points or more — the open-ended bottom tier.
   *
   * Both ladders end in a tier with no upper bound, and an uncovered tier value
   * **throws** in the scoring engine rather than scoring zero. A corpus of
   * ordinary games never reaches either end.
   */
  DST_POINTS_BOTTOM_TIER: (box) =>
    sides(box.DST).some((unit) => (unitNumber(unit, "ptsAllowed") ?? 0) >= 46),

  /** A defence that allowed 550 yards or more — the other open-ended bottom tier. */
  DST_YARDS_BOTTOM_TIER: (box) =>
    sides(box.DST).some((unit) => (unitNumber(unit, "ydsAllowed") ?? 0) >= 550),

  /**
   * A blocked kick that led to no score.
   *
   * 27 of the 44 blocked kicks in 2025 did not, and until `teamStats` was read
   * they were worth nothing — 54 points invisible to a translator that only
   * parses scoring text. This is the class that keeps the numeric source
   * exercised rather than the text one.
   */
  BLOCKED_KICK_NO_SCORE: (box) =>
    sides(box.teamStats).some((unit) =>
      TANK01_TEAM_BLOCKED_KICK_FIELDS.some((field) => (unitNumber(unit, field) ?? 0) > 0),
    ) && !plays(box).some((play) => isBlockedKick(play.score ?? "")),

  /**
   * A blocked kick taken to the end zone.
   *
   * The play ESPN files as a *defensive* touchdown (stat id 93) while Tank01's
   * text calls it a return, which is what makes the
   * `defensiveOrSpecialTeamsTds` cross-check need to know the difference.
   */
  BLOCKED_KICK_TOUCHDOWN: (box) =>
    plays(box).some(
      (play) => isTouchdown(play.scoreType) && isBlockedKickTouchdown(play.score ?? ""),
    ),

  /**
   * A scoring play whose text uses an abbreviated name.
   *
   * The detector matches **any** scoring play, not only a special-teams one; the
   * known instance happens to be a return, and the trap it guards is not.
   *
   * `"Sydney Brown 35 yd. return of blocked punt (J.Elliott kick)"` — lowercase,
   * a full stop after "yd", and `J.Elliott` rather than `Jake Elliott`. Tank01's
   * play text comes from more than one source, and the abbreviated form is what
   * `nameForms` exists for; a corpus with only well-formed names would never
   * exercise it.
   */
  ABBREVIATED_NAME_IN_PLAY: (box) =>
    plays(box).some((play) => /\b[A-Z]\.[A-Z][a-z]/.test(play.score ?? "")),

  /**
   * A special-teams touchdown whose scorer `playerIDs` does not name.
   *
   * The defect that cost `20241229_CAR@TB` six points in silence: the array held
   * the kicker alone, and the returner's entire record in the game was a
   * `snapCounts` block. `playerIDs` is a tiebreak rather than a gate because of
   * this shape, and this is the fixture that says so.
   */
  SCORER_NOT_IN_PLAYERIDS: (box) =>
    specialTeamsTouchdowns(box).some((play) => {
      const clause = flatten(mainClause(play.score ?? ""));
      return !surnamesOf(play, box).some((name) => clause.includes(name));
    }),

  /**
   * A successful two-point conversion.
   *
   * Read from the parenthetical, cross-checked against
   * `Passing.passingTwoPointConversion`, and never from the numeric field —
   * either/or, or one conversion is worth four points.
   */
  TWO_POINT_CONVERSION: (box) =>
    plays(box).some((play) =>
      [...(play.score ?? "").matchAll(/\(([^)]*)\)/g)].some(([, inner]) =>
        isSuccessfulTwoPointConversion(inner ?? ""),
      ),
    ),

  /**
   * A two-point conversion whose receiver the play's `playerIDs` does not name.
   *
   * `playerIDs` names the players from the **touchdown**, not the conversion, so
   * a receiver who caught only the conversion is absent from it.
   *
   * **The shape is real; the defect it was captured for is not, any more.**
   * `box-score.ts` resolves the receiver out of the parenthetical text, so the
   * checked-in ledger credits Julian Hill `two_pt: 1` and Sleeper's `rec_2pt`
   * agrees — there is no disagreement to declare, and `manifestProblems` would
   * reject a stale entry that claimed one. This docstring described the silence
   * in the present tense long after it stopped happening.
   *
   * The class stays because the *input* shape is what makes the resolution
   * necessary: a fixture where the conversion's receiver is missing from
   * `playerIDs` is what would notice the text path being removed. #155 remains
   * open for the cases the text does not name.
   */
  TWO_PT_RECEIVER_NOT_IN_PLAYERIDS: (box) =>
    plays(box).some((play) => {
      const named = surnamesOf(play, box);
      return [...(play.score ?? "").matchAll(/\(([^)]*)\)/g)].some(([, inner]) => {
        const parenthetical = inner ?? "";
        if (!isSuccessfulTwoPointConversion(parenthetical)) return false;
        const receiver = /\bpass to ([a-z'’.-]+(?: [a-z'’.-]+)+?) for\b/i.exec(parenthetical);
        if (!receiver?.[1]) return false;
        return !named.some((name) => flatten(receiver[1] ?? "").includes(name));
      });
    }),

  /**
   * A touchdown returned or recovered off a fumble or an interception.
   *
   * A **negative** class: this play must be paid to the unit as `def_td` and
   * must never reach the scorer as `ret_td`. `isSpecialTeamsReturnTouchdown`
   * consults `DEFENSIVE_RETURN` first for exactly this reason, and the guard is
   * one loosened regex away from not holding.
   */
  FUMBLE_OR_INTERCEPTION_RETURN_TD: (box) =>
    plays(box).some(
      (play) =>
        isTouchdown(play.scoreType) &&
        isDefensiveReturnTouchdown(play.score ?? "") &&
        /\bfumble\b/i.test(play.score ?? ""),
    ),

  /**
   * A special-teams touchdown scored by a team that also has a `Defense.defTD`.
   *
   * The overlap `DST.defTD` already contains, because ESPN files a punt return
   * by a *defensive* player as a defensive score too. Six such plays in 2025,
   * 36 points, every one of them paid twice before the subtraction went in.
   */
  DST_TD_OVERLAP: (box) =>
    specialTeamsTouchdowns(box).some((play) =>
      players(box).some(
        (player) =>
          String(player.team ?? player.teamAbv ?? "") === play.team &&
          statOf(player, "Defense", "defTD") > 0,
      ),
    ),

  /**
   * A special-teams touchdown where no player on the scoring team has a
   * `Defense.defTD`.
   *
   * The other side of the same subtraction, and the reason it is a subtraction
   * rather than a deletion: here `DST.defTD` reads zero and the scoring text is
   * the only evidence the unit scored at all. Removing the text term outright
   * would have been the larger error in the other direction.
   */
  DST_TD_NO_OVERLAP: (box) =>
    specialTeamsTouchdowns(box).some(
      (play) =>
        !players(box).some(
          (player) =>
            String(player.team ?? player.teamAbv ?? "") === play.team &&
            statOf(player, "Defense", "defTD") > 0,
        ),
    ),

  /**
   * A kickoff muffed by the receiving team and recovered in the end zone.
   *
   * `"George Holani Recovered Kickoff in End Zone for a Touchdown"` — a coverage
   * score rather than a return, and a **negative** class: ESPN pays the player 0
   * and the unit 6, filing it under stat id 104, and Holani's ESPN fantasy
   * `appliedTotal` for that week is 0. We score what ESPN scores, so `ret_td`
   * must stay 0 here.
   *
   * **Only the Tank01 shape is asserted here, and that is worth saying because
   * the obvious reading is wrong.** Sleeper does pay `st_td` 6 for this play, so
   * it looks like a declared divergence — but Holani has no Sleeper row in the
   * trimmed fixture, no entry in `sleeper-players.json`, and no ledger row of his
   * own (we score him 0, and `ledger.ts` drops an empty line). Nothing compares
   * him against anything; he is the `unjoinable` entry for issue #185. So this
   * class proves the *translator* still refuses to pay a recovery as a return,
   * and proves nothing about the disagreement machinery.
   */
  KICKOFF_RECOVERY_NOT_A_RETURN: (box) =>
    plays(box).some(
      (play) =>
        isTouchdown(play.scoreType) &&
        /\brecovered\s+kickoff\b/i.test(play.score ?? "") &&
        !isSpecialTeamsReturnTouchdown(play.score ?? ""),
    ),

  /**
   * A player carrying `Defense.fumblesRecovered` for falling on his own fumble.
   *
   * 185 player-weeks of 2025 did, worth 384 points to whoever happened to roster
   * them, which is why no per-player defensive field is mapped. The class keeps
   * a real example of the contamination in the corpus so the exclusion cannot be
   * argued about from memory.
   */
  OWN_FUMBLE_RECOVERY: (box) =>
    players(box).some(
      (player) =>
        statOf(player, "Defense", "fumbles") > 0 &&
        statOf(player, "Defense", "fumblesRecovered") > 0,
    ),
};

export type CoverageClass = keyof typeof COVERAGE_CLASSES;

function hasFieldGoalBucket(box: RawBox, bucket: string): boolean {
  return plays(box).some((play) => {
    if ((play.scoreType ?? "").toUpperCase() !== "FG") return false;
    const yards = parseFieldGoalYards(play.score ?? "");
    return yards !== null && bucketFieldGoal(yards) === bucket;
  });
}

/** Which of the registered classes this raw box score actually contains. */
export function classesIn(box: unknown): readonly string[] {
  return Object.entries(COVERAGE_CLASSES)
    .filter(([, detect]) => detect(box as RawBox))
    .map(([name]) => name);
}
