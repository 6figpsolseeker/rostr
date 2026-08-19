/**
 * Tank01 box score -> registry stat lines.
 *
 * The translation layer, and the only place a provider's shape is understood.
 *
 * ## How attribution works
 *
 * Tank01 duplicates each scoring play into the record of **every player involved
 * in it**, as well as listing them all at the top level. So a kicker's own
 * `scoringPlays` array contains exactly his field goals, and a returner's
 * contains exactly his returns.
 *
 * That means field-goal distances and return touchdowns can be attributed by
 * reading each player's own plays — no name matching, no guessing at the order
 * of `playerIDs`. Verified: Brandon Aubrey (`3953687`) in `20250904_DAL@PHI`
 * carries both his 41- and 53-yard field goals, and his `Kicking.fgMade` is
 * `"2"`, which matches.
 *
 * Two-point conversions are the exception, and are handled less confidently —
 * see `twoPointCredit`.
 */

import type { StatLine } from "@rostr/core";
import {
  bucketFieldGoal,
  isBlockedKick,
  isBlockedKickTouchdown,
  isKnownScoreType,
  isSpecialTeamsReturnTouchdown,
  parseDecimalStat,
  isSuccessfulTwoPointConversion,
  isTouchdownScoringPlay,
  isUncountedSpecialTeamsScoreType,
  mainClause,
  parseFieldGoalYards,
  parseStatValue,
  TANK01_DST_MAP,
  TANK01_STAT_MAP,
  TANK01_TEAM_BLOCKED_KICK_FIELDS,
  TANK01_TEAM_DEF_ST_TD_FIELD,
  TANK01_TEAM_STATS_MAP,
} from "./stat-map.js";

interface ScoringPlay {
  score?: string;
  scoreType?: string;
  team?: string;
  teamID?: string;
  playerIDs?: string[];
}

interface RawPlayer {
  playerID?: string;
  longName?: string;
  team?: string;
  teamAbv?: string;
  scoringPlays?: ScoringPlay[];
  [category: string]: unknown;
}

export interface TranslatedBoxScore {
  readonly gameRef: string;
  /** Player stat lines, keyed by Tank01 `playerID`. */
  readonly players: ReadonlyMap<string, readonly StatLine[]>;
  /** Team defense stat lines, keyed by team abbreviation. */
  readonly teamDefense: ReadonlyMap<string, readonly StatLine[]>;
  /**
   * Anything that did not reconcile.
   *
   * Never silently absorbed: a translation that quietly drops a stat produces
   * wrong scores that look right.
   *
   * **A warning is not a reason to discard the game.** It used to be: the
   * adapter threw on any warning at all, so one kicker whose `Kicking.fgMade`
   * disagreed with the field goals parsed from his own scoring plays threw away
   * every player in the game. Composed with clock-based finalisation that is not
   * "retry later" — the game is still `FINAL`, so the postponement fallback does
   * not fire, and the week settles with sixteen real starters on zero,
   * permanently, with no signal anywhere.
   */
  readonly warnings: readonly string[];
  /**
   * Reasons this response cannot be used at all.
   *
   * The distinction is the point. `warnings` means "we read this and something
   * did not add up" — drop the affected stat, keep the other ninety players.
   * `fatal` means "we could not read this", which is the only case where
   * discarding is right.
   */
  readonly fatal: readonly string[];
}

function accumulate(into: Map<string, number>, statKey: string, value: number): void {
  into.set(statKey, (into.get(statKey) ?? 0) + value);
}

/**
 * The team-defence rules scored from a tier table rather than per unit.
 *
 * These are the ones where **absent is not zero**. The scoring engine reads a
 * missing stat as "did not play", so a unit that pitched a shutout and reported
 * nothing would forfeit the bonus rather than earn it. `def_pts_allowed` was
 * the only member until `def_yds_allowed` arrived with the ESPN alignment; the
 * comments here used to say "the sport's only tiered rule" and that is why this
 * is a set rather than a comparison.
 */
const TIERED_DST_KEYS: ReadonlySet<string> = new Set(["def_pts_allowed", "def_yds_allowed"]);

function toStatLines(totals: ReadonlyMap<string, number>): StatLine[] {
  return [...totals].map(([statKey, value]) => ({ statKey, value }));
}

/**
 * A name reduced to something two spellings of the same person share.
 *
 * Lower-cased, punctuation removed, common suffixes dropped. Removing the dots
 * is what makes an abbreviation comparable: `R.Stevenson` becomes `rstevenson`,
 * and so does the initial-plus-surname form built from `Rhamondre Stevenson`.
 */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[.'’‘`-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The spellings of `longName` a play might plausibly use.
 *
 * Two, because `docs/TANK01.md` records both: the full name, and the
 * initial-plus-surname form Tank01 uses in some plays (`(J.Elliott kick)`).
 * Matching only the first is issue #81's fourth defect — `R.Stevenson` and
 * `Rhamondre Stevenson Jr.` both scored nothing, silently, on a play worth two
 * points.
 */
function nameForms(longName: string): readonly string[] {
  const full = normaliseName(longName);
  if (!full) return [];

  const parts = full.split(" ");
  const surname = parts[parts.length - 1] ?? "";
  const initial = parts[0]?.[0] ?? "";

  // `rstevenson` — what `R.Stevenson` normalises to, dots and all removed.
  const abbreviated = parts.length > 1 && initial && surname ? `${initial}${surname}` : null;

  return abbreviated ? [full, abbreviated] : [full];
}

interface RosterEntry {
  readonly playerID: string;
  readonly longName: string;
  readonly forms: readonly string[];
}

/**
 * Every named player in the game, with the spellings a play might use.
 *
 * Built once and shared by the two passes that resolve a name to a player. A
 * player carrying no stat categories at all is still in here as long as Tank01
 * gave him a `longName` — which matters more than it sounds, because those are
 * exactly the players the per-player loops cannot see. J.J. Russell's entire
 * record in `20241229_CAR@TB` is a `snapCounts` block, and he scored a
 * touchdown.
 */
function rosterOf(playerStats: Record<string, RawPlayer>): readonly RosterEntry[] {
  return Object.values(playerStats)
    .filter((player) => player.playerID && player.longName)
    .map((player) => ({
      playerID: player.playerID as string,
      longName: player.longName as string,
      forms: nameForms(player.longName as string),
    }));
}

/**
 * Everyone credited with a two-point conversion in this game, by player id.
 *
 * ## Why this is a game-level pass and not a per-player one
 *
 * It used to be decided inside `translatePlayer`, over that player's own
 * `scoringPlays`, gated on `playerIDs` including him. Both halves lose people.
 *
 * `playerIDs` names the players from the **touchdown**, not the conversion
 * (issue #155). In `20250907_MIA@IND` the conversion receiver Julian Hill is
 * absent from it — and Tank01's entire record for him in that game carries no
 * `scoringPlays` and no `Receiving` block at all, so his own loop ran zero
 * times whatever the gate said. The conversion exists only on *other* players'
 * records. Nothing that iterates a player's own plays can ever find him.
 *
 * So the plays are scanned once for the game, and names in the parenthetical are
 * resolved against every player in it. Measured across 2025 weeks 1–3: six
 * conversions, one dropped.
 *
 * ## Every parenthetical, not the first
 *
 * `docs/TANK01.md:105` records a play whose first parenthetical is a team code —
 * `Blocked Kick Recovered by Jordan Davis (PHI) …`. Taking `[0]` and stopping
 * would miss a conversion noted in a later one.
 *
 * ## Ambiguity credits nobody, and says so
 *
 * If two players in the game answer to the same spelling — two Stevensons, one
 * abbreviation — this credits neither and warns. Crediting the wrong one is
 * strictly worse than crediting no one: it takes two points from the player who
 * earned them *and* hands them to somebody who did not, so the error is doubled
 * and lands in two different teams' totals.
 */
function twoPointCreditsByPlayer(
  scoringPlays: readonly ScoringPlay[],
  playerStats: Record<string, RawPlayer>,
  warnings: string[],
): Map<string, number> {
  const credits = new Map<string, number>();
  const roster = rosterOf(playerStats);

  for (const play of scoringPlays) {
    const text = play.score ?? "";

    for (const [, inner] of text.matchAll(/\(([^)]*)\)/g)) {
      const parenthetical = inner ?? "";
      if (!isSuccessfulTwoPointConversion(parenthetical)) continue;

      const haystack = normaliseName(parenthetical);
      const matched = roster.filter((player) =>
        player.forms.some((form) => haystack.includes(form)),
      );

      // Group by the form that matched, so two different people matching two
      // different names is the ordinary two-player conversion rather than an
      // ambiguity — it is only ambiguous when one spelling fits two people.
      const bySpelling = new Map<string, typeof matched>();
      for (const player of matched) {
        const form = player.forms.find((f) => haystack.includes(f)) ?? "";
        bySpelling.set(form, [...(bySpelling.get(form) ?? []), player]);
      }

      for (const [form, candidates] of bySpelling) {
        if (candidates.length > 1) {
          warnings.push(
            `two-point conversion "${parenthetical}": "${form}" matches ` +
              `${candidates.map((c) => c.longName).join(" and ")}, so neither is credited`,
          );
          continue;
        }
        const only = candidates[0];
        if (only) credits.set(only.playerID, (credits.get(only.playerID) ?? 0) + 1);
      }

      if (matched.length === 0) {
        // Silence here is what let two points vanish with `warnings: []`. A
        // conversion definitely happened — the text says so — and nobody in the
        // game answered to any name in it.
        warnings.push(
          `two-point conversion "${parenthetical}" names no player this game recognises, ` +
            `so nobody was credited for it`,
        );
      }
    }
  }

  return credits;
}

/**
 * Everyone credited with a special-teams return touchdown, by player id.
 *
 * ## Why this is a game-level pass, like the conversions above
 *
 * It used to run inside each player's own loop, over his own `scoringPlays`,
 * gated on `play.playerIDs` naming him. **Both halves lose the scorer**, and
 * unlike the conversion case they lose him on a play that is entirely his.
 * Verbatim, from `20241229_CAR@TB`:
 *
 *     TD | TB | J.J. Russell 23 Yd Return of Blocked Punt (Chase McLaughlin Kick)
 *        | playerIDs: ["3150744"]
 *
 * `3150744` is the kicker. The returner is not in `playerIDs`, and Tank01's
 * whole record for him in that game is a `snapCounts` block — no `scoringPlays`,
 * no `Defense` — so his own loop ran zero times whatever the gate said. Six
 * points, in silence, on a play whose text names him first. This is issue #155's
 * shape exactly, one category over.
 *
 * ## The main clause, and only one scorer
 *
 * A conversion legitimately credits two players — a passer and a receiver — so
 * that pass tolerates several matches. A return touchdown has exactly one
 * scorer, so several distinct matches is a fact about our name matching rather
 * than about the play, and this refuses instead.
 *
 * **`playerIDs` is the tiebreak, not the gate.** Demoting it that far and no
 * further is deliberate: this pass matches names against every player in the
 * game, where the old per-player check was only ever asked about players the
 * play already named, and `scoredInMainClause` said in as many words that
 * widening it needed a stricter comparison. Falling back to the intersection
 * makes the new rule a superset of the old one — anything the gate used to
 * credit uniquely is still credited — so the only behaviour that can be lost is
 * a play crediting *two* players six points each, which was never right.
 */
function returnTouchdownCredits(
  scoringPlays: readonly ScoringPlay[],
  playerStats: Record<string, RawPlayer>,
  warnings: string[],
): Map<string, number> {
  const credits = new Map<string, number>();
  const roster = rosterOf(playerStats);

  for (const play of scoringPlays) {
    const text = play.score ?? "";
    if (!isTouchdownScoringPlay(play.scoreType)) continue;
    if (!isSpecialTeamsReturnTouchdown(text)) continue;

    // The complement of the window a conversion is read in: who scored is
    // outside the parentheses, the PAT or conversion inside them.
    const haystack = normaliseName(mainClause(text));
    const matched = roster.filter((player) =>
      player.forms.some((form) => haystack.includes(form)),
    );

    const distinct = [...new Map(matched.map((player) => [player.playerID, player])).values()];

    const candidates =
      distinct.length === 1
        ? distinct
        : distinct.filter((player) => play.playerIDs?.includes(player.playerID));

    const only = candidates.length === 1 ? candidates[0] : undefined;

    if (!only) {
      // Never silent. A return touchdown definitely happened — the text says so
      // and the unit is about to be paid six for it — so a scorer we cannot name
      // is six points nobody receives, which is the failure this whole pass
      // exists to make loud.
      warnings.push(
        distinct.length === 0
          ? `return touchdown "${text}" names no player this game recognises, ` +
              `so nobody was credited for it`
          : `return touchdown "${text}" matches ` +
              `${distinct.map((c) => c.longName).join(" and ")}, so nobody was credited for it`,
      );
      continue;
    }

    credits.set(only.playerID, (credits.get(only.playerID) ?? 0) + 1);
  }

  return credits;
}

/**
 * Cross-check the conversions parsed from text against the numbers Tank01 gives.
 *
 * Field goals have had this since they were written, for the reason stated
 * there: string parsing in a scoring path fails quietly. Two-point conversions
 * had no equivalent, which is exactly why issue #155's two points disappeared
 * with no warning at all — and `Passing.passingTwoPointConversion` was sitting
 * in the same payload the whole time.
 *
 * **A check, never a source.** `passingTwoPointConversion` and
 * `receivingTwoPointConversion` stay deliberately unmapped — `stat-map.test.ts`
 * locks the exclusion — because a player named in a parenthetical *and* carrying
 * the numeric field would otherwise be credited twice, which is four points for
 * one conversion. Either/or. This reads them only to disagree out loud.
 */
function crossCheckTwoPoint(
  playerStats: Record<string, RawPlayer>,
  credits: ReadonlyMap<string, number>,
  warnings: string[],
): void {
  for (const player of Object.values(playerStats)) {
    if (!player.playerID) continue;

    const passing = (player as unknown as { Passing?: Record<string, unknown> }).Passing;
    const reported = parseStatValue(passing?.["passingTwoPointConversion"]);
    if (reported === null || reported === 0) continue;

    const parsed = credits.get(player.playerID) ?? 0;
    if (parsed !== reported) {
      warnings.push(
        `${player.longName ?? player.playerID}: Tank01 reports ${reported} two-point ` +
          `conversion pass(es) but ${parsed} were credited from the scoring text`,
      );
    }
  }
}

/**
 * Render a scaled integer back as the decimal it came from.
 *
 * Warning text only. Dividing would put a float in a file that has none, and the
 * rendered figure is the actionable half of the message — `-2.0` is the number
 * that turned out to be right in the one case anybody has checked.
 */
function formatScaled(scaled: number, scale: number): string {
  const unit = 10 ** scale;
  const sign = scaled < 0 ? "-" : "";
  const magnitude = Math.abs(scaled);
  if (scale === 0) return `${sign}${magnitude}`;
  return `${sign}${Math.trunc(magnitude / unit)}.${String(magnitude % unit).padStart(scale, "0")}`;
}

/**
 * Cross-check rushing yards against the average reported for them.
 *
 * `rushAvg` is `rushYds / carries` rounded to a tenth, so the two fields are one
 * fact stated twice and either checks the other. In `20251013_CHI@WSH` they
 * disagree: Caleb Williams reads `carries 4, rushYds 3, rushAvg -0.5`, and four
 * carries at -0.5 is **-2**. ESPN's own play-by-play reconstructs to -2
 * (+1, +4, -5, -2) and Sleeper agrees on every field, so the yards are wrong and
 * the average is right — Tank01 inherits ESPN's row verbatim, error included.
 * Refs #157.
 *
 * **A check, never a source**, the same relationship {@link crossCheckTwoPoint}
 * has with `passingTwoPointConversion`. `rushAvg` stays unmapped and nothing
 * here changes a score: the average carries one decimal place, so deriving yards
 * from it would replace a wrong number with a vague one — over four carries
 * "-0.5" narrows the truth only to somewhere between -2.2 and -1.8. `RULES.md`
 * §7 corrects a figure with a second source, not with better arithmetic on the
 * same one.
 *
 * **Verified against every other endpoint before settling for detection.**
 * `getNFLGamesForPlayer` returns the identical wrong row, `getNFLPlayerInfo`
 * carries season totals only, `getNFLScoresOnly` has leaders and Williams is not
 * one, and Tank01 publishes no play-by-play at any price. The correct -2 exists
 * nowhere in the provider, which is why this warns rather than repairs.
 *
 * ## The tolerance is the exact rounding bound, and it is tight
 *
 * `carries * rushAvg` is not `rushYds` even when both are right, because the
 * average is rounded: James Conner's 39 yards on 12 carries reports `"3.3"`, and
 * 12 x 3.3 is 39.6. Rounding to one place moves the average by at most half of
 * that place, so the product moves by at most `carries / 2` of it. Doubling both
 * sides clears the half and leaves the comparison entirely in integers of the
 * average's own final decimal place.
 *
 * **Conner sits exactly on the bound, in a corpus game**, so the comparison must
 * be `<=`; a strict `<` warns on correct data on the first run. Measured over all
 * 117 rushing lines in the thirteen corpus games: every one reproduces
 * `round(rushYds / carries, 1)` exactly and the widest gap is Conner's, at the
 * bound. Caleb Williams misses it by a factor of 25.
 */
function crossCheckRushing(player: RawPlayer, warnings: string[]): void {
  const rushing = player["Rushing"] as Record<string, unknown> | undefined;
  if (!rushing) return;

  const yards = parseStatValue(rushing["rushYds"]);
  // Nothing was scored from this block, and an unreadable `rushYds` is already
  // reported by the category loop — the same field and the same fault. Two
  // warnings for one would read as two problems.
  if (yards === null) return;

  const who = player.longName ?? player.playerID ?? "an unnamed player";
  const carries = parseStatValue(rushing["carries"]);
  const average = parseDecimalStat(rushing["rushAvg"]);

  if (carries === null || average === null) {
    // Not a silent skip. The average is the only second opinion on rushing yards
    // arriving inside the same response, so a shape this cannot read switches the
    // check off while everything stays green — which is exactly the condition
    // `rush_yd` was already in when #157 was filed.
    warnings.push(
      `${who}: rush_yd was not cross-checked against the average — Rushing.carries is ` +
        `${JSON.stringify(rushing["carries"])} and Rushing.rushAvg is ` +
        `${JSON.stringify(rushing["rushAvg"])}`,
    );
    return;
  }

  // An average over no carries states no fact about the yards, so there is
  // nothing here to contradict. Tank01 files it as "0.0" rather than omitting it.
  if (carries === 0) return;

  const impliedScaled = carries * average.scaled;
  const reportedScaled = yards * 10 ** average.scale;
  if (2 * Math.abs(impliedScaled - reportedScaled) <= carries) return;

  warnings.push(
    `${who}: Rushing.rushYds is ${yards} but ${carries} carries at ` +
      `${formatScaled(average.scaled, average.scale)} a carry implies ` +
      `${formatScaled(impliedScaled, average.scale)} — they disagree by more than ` +
      `rounding, and which is right needs a second source`,
  );
}

function translatePlayerWithConversions(
  player: RawPlayer,
  warnings: string[],
  /** Decided for the whole game — see `twoPointCreditsByPlayer`. */
  twoPointConversions: number,
  /** Decided for the whole game — see `returnTouchdownCredits`. */
  returnTouchdowns: number,
): { playerID: string; lines: StatLine[] } | null {
  const playerID = player.playerID;
  if (!playerID) return null;

  const totals = new Map<string, number>();

  // 1. Ordinary category stats.
  for (const [category, value] of Object.entries(player)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;

    for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
      const statKey = TANK01_STAT_MAP[`${category}.${field}`];
      if (!statKey) continue;

      const parsed = parseStatValue(raw);
      if (parsed === null) {
        warnings.push(
          `${player.longName ?? playerID}: ${category}.${field} = ${JSON.stringify(raw)} is not a number`,
        );
        continue;
      }
      if (parsed !== 0) accumulate(totals, statKey, parsed);
    }
  }

  // 1b. Rushing yards against the average reported for them. See below.
  crossCheckRushing(player, warnings);

  // 2. Field goals, whose distances exist only in this player's own play text.
  //
  //    Still per-player, and it is the one thing here that should be: a kicker's
  //    own `scoringPlays` array is exactly his own field goals, which is what
  //    makes distance attribution need no name matching at all, and `fgMade` is
  //    on the same record to check it against.
  let fieldGoalsParsed = 0;

  for (const play of player.scoringPlays ?? []) {
    const text = play.score ?? "";
    const involved = play.playerIDs?.includes(playerID) ?? false;
    if (!involved) continue;

    if (play.scoreType === "FG") {
      const yards = parseFieldGoalYards(text);
      if (yards === null) {
        warnings.push(`${player.longName ?? playerID}: unparseable field goal "${text}"`);
        continue;
      }
      accumulate(totals, bucketFieldGoal(yards), 1);
      fieldGoalsParsed++;
    }
  }

  // Return touchdowns and two-point conversions are both decided for the whole
  // game rather than here, and for the same reason in the end: the player who
  // scored is often absent from the play's `playerIDs`, and sometimes has no
  // `scoringPlays` of his own at all. See `returnTouchdownCredits` and
  // `twoPointCreditsByPlayer`.
  if (returnTouchdowns > 0) accumulate(totals, "ret_td", returnTouchdowns);
  if (twoPointConversions > 0) accumulate(totals, "two_pt", twoPointConversions);

  // 3. Cross-check parsed field goals against the count Tank01 reports.
  //    Text parsing in a scoring path fails quietly; this is what makes it fail
  //    loudly instead.
  //
  //    Missed field goals are *not* derived here. `Kicking.fgMissed` is a real
  //    field — verified in the captured fixture — so it is mapped directly in
  //    `TANK01_STAT_MAP` like any other count. Computing `fgAttempts - fgMade`
  //    instead would have been a second definition of the same number, free to
  //    disagree with the first.
  const kicking = player["Kicking"] as Record<string, unknown> | undefined;
  const fgMade = parseStatValue(kicking?.["fgMade"]) ?? 0;
  if (fgMade !== fieldGoalsParsed) {
    warnings.push(
      `${player.longName ?? playerID}: Kicking.fgMade is ${fgMade} but ${fieldGoalsParsed} ` +
        `field goal(s) were parsed from scoring plays — distances may be wrong`,
    );
  }

  return { playerID, lines: toStatLines(totals) };
}

/**
 * Which team blocked the kick in this scoring play.
 *
 * `play.team` is the team that **scored** the play, and a blocked kick reaches
 * the scoring list in two shapes that put different teams there:
 *
 *   - A block on somebody else's kick, noted in the trailing parenthetical of
 *     *their* touchdown — `"Blake Corum 1 Yd Rush (Joshua Karty PAT blocked)"`.
 *     `play.team` is the kicking team, so the blocker is the opponent.
 *   - A block returned for a score — `"Blocked Kick Recovered by Jordan Davis
 *     (PHI) … 61 Yd Touchown Return"`. Here `play.team` is the **blocking** team,
 *     because they are the ones who scored.
 *
 * Both strings are recorded verbatim in `docs/TANK01.md`. The original code
 * assumed the first shape always held and derived the blocker as "the other
 * team", which credited the second shape's two points to the team whose kick was
 * blocked — a four-point swing between two defenses, usually on two different
 * rosters, with no warning.
 *
 * **And the two shapes compose**, which is what the first fix missed: a return
 * touchdown whose own extra point is blocked is both at once. Deciding on the
 * presence of "return" anywhere in the text put that case back where it started.
 */
function blockingTeamOf(play: ScoringPlay, teamAbvs: readonly string[]): string | null {
  const scoringTeam = play.team ?? "";
  if (!scoringTeam) return null;

  const text = play.score ?? "";

  // **Where the word sits, not whether the play mentions a return.**
  //
  // Reading the whole text for "return" or "recovered" looks equivalent and is
  // not, because the two shapes compose: a punt-return touchdown whose own extra
  // point is then blocked — `"Jahan Dotson 70 Yd punt return (Jake Elliott PAT
  // blocked)"` — is a return *and* a trailing parenthetical, and the block
  // belongs to the opponent. Matching on "return" credits it to the team that
  // got blocked, which is the same four-point swing this function was written to
  // fix, surviving in the one case where both forms appear at once.
  //
  // The parenthetical is the reliable discriminator because it is what the
  // bracket means: it annotates the *conversion attempt* on somebody else's
  // score, so a block noted there was made by the other team. A block in the
  // play body is the play itself, and the team on the play is the one that made
  // it.
  const blockedInParenthetical = /\([^)]*\bblock(?:ed|s)?\b[^)]*\)/i.test(text);

  if (blockedInParenthetical) return teamAbvs.find((abv) => abv !== scoringTeam) ?? null;
  return scoringTeam;
}

/**
 * The `teamStats` block, indexed by team rather than by side.
 *
 * `DST.home` and `teamStats.home` name the same team in every captured game, so
 * matching on the side would work. It matches on `teamAbv` anyway, because a
 * defensive stat credited to the wrong team is a swing between two rosters and
 * this file has already made that mistake twice — see `blockingTeamOf`.
 */
function teamStatsByAbv(raw: unknown): Map<string, Record<string, unknown>> {
  const block = (raw ?? {}) as Record<string, unknown>;
  const byAbv = new Map<string, Record<string, unknown>>();

  for (const side of ["home", "away"] as const) {
    const unit = block[side] as Record<string, unknown> | undefined;
    if (!unit || typeof unit !== "object") continue;

    const teamAbv = String(unit["teamAbv"] ?? "");
    if (teamAbv) byAbv.set(teamAbv, unit);
  }

  return byAbv;
}

/**
 * Blocked kicks this team made, summed from the three `teamStats` counters.
 *
 * `null` when the block carries none of the three fields at all — which is not a
 * zero, it is "this response does not have them", and the caller falls back to
 * the scoring text rather than reporting no blocks.
 */
function blockedKicksFromTeamStats(unit: Record<string, unknown> | undefined): number | null {
  if (!unit) return null;

  let total: number | null = null;

  for (const field of TANK01_TEAM_BLOCKED_KICK_FIELDS) {
    if (unit[field] === undefined) continue;

    const parsed = parseStatValue(unit[field]);
    if (parsed === null) continue;

    total = (total ?? 0) + parsed;
  }

  return total;
}

/**
 * The name forms of every player on this team credited with a defensive
 * touchdown in this game.
 *
 * This reads `Defense.defTD`, which {@link TANK01_STAT_MAP} deliberately no
 * longer maps to a stat key. Reading a field and paying a roster spot for it are
 * different things: nothing can start an individual defender, so the per-player
 * value is not a score — but it is exactly the evidence needed to tell whether a
 * special-teams touchdown is *already inside* `DST.defTD`.
 *
 * Proven on `20250928_CAR@NE`: Marcus Jones is the only player in the game with
 * `Defense.defTD` (`"1"`), and New England's `DST.defTD` is `"1"`. The team
 * figure is the sum of the player figures.
 */
function defensiveTouchdownScorers(
  playerStats: Record<string, RawPlayer>,
  teamAbv: string,
): readonly (readonly string[])[] {
  const scorers: (readonly string[])[] = [];

  for (const player of Object.values(playerStats)) {
    const team = String(player.team ?? player.teamAbv ?? "");
    if (team !== teamAbv || !player.longName) continue;

    const defence = player["Defense"] as Record<string, unknown> | undefined;
    if ((parseStatValue(defence?.["defTD"]) ?? 0) > 0) scorers.push(nameForms(player.longName));
  }

  return scorers;
}

/**
 * Team defense stat lines.
 *
 * `ptsAllowed` is emitted **even when zero**, because the scoring engine treats
 * an absent stat as "did not play" and a shutout would otherwise silently
 * forfeit its bonus.
 *
 * Three of the seven D/ST rules cannot be read off the `DST` block alone, and
 * each is handled in its own block below with the evidence that settled it:
 * blocked kicks come from `teamStats`, the unit's touchdowns from `DST.defTD`
 * plus the special-teams scores it does not already contain, and safeties from
 * `DST.safeties` cross-read against the `"SF"` scoring plays.
 *
 * @param raw the `DST` block
 * @param teamStats the `teamStats` block — a different shape, see {@link teamStatsByAbv}
 * @param playerStats needed for `Defense.defTD`, which is evidence rather than a score
 */
function translateTeamDefense(
  raw: Record<string, unknown>,
  teamStats: unknown,
  playerStats: Record<string, RawPlayer>,
  scoringPlays: readonly ScoringPlay[],
  teamAbvs: readonly string[],
  warnings: string[],
): Map<string, StatLine[]> {
  const result = new Map<string, StatLine[]>();
  const statsByAbv = teamStatsByAbv(teamStats);

  for (const side of ["home", "away"] as const) {
    const unit = raw[side] as Record<string, unknown> | undefined;
    if (!unit) continue;

    const teamAbv = String(unit["teamAbv"] ?? "");
    if (!teamAbv) continue;

    const team = statsByAbv.get(teamAbv);
    const totals = new Map<string, number>();

    for (const [field, statKey] of Object.entries(TANK01_DST_MAP)) {
      const parsed = parseStatValue(unit[field]);
      if (parsed === null) {
        // This translator used to be the only one with no `warnings` array, so a
        // missing or unparseable field vanished in silence. That matters most
        // for the tiered rules: absent is not zero, and a unit that still emits
        // a sack looks like it played and scored 2 rather than 12. The rest are
        // worth reporting too — a field the provider renamed should not read as
        // a quiet zero.
        if (unit[field] !== undefined) {
          warnings.push(
            `${teamAbv}: ${field} is ${JSON.stringify(unit[field])}, which is not a number — ` +
              `${statKey} was dropped`,
          );
        } else if (TIERED_DST_KEYS.has(statKey)) {
          warnings.push(
            `${teamAbv}: the box score carries no ${field}, so ${statKey} was dropped — ` +
              `it is a tiered rule and absent is not zero`,
          );
        }
        continue;
      }

      // The tiered rules are meaningful at zero; the rest are not worth
      // emitting. A shutout that reported nothing would silently forfeit its
      // bonus, and so would a defence that allowed no yards.
      if (parsed !== 0 || TIERED_DST_KEYS.has(statKey)) {
        accumulate(totals, statKey, parsed);
      }
    }

    // ---------------------------------------------------------------------
    // Team-level counters that are a source in their own right
    // ---------------------------------------------------------------------
    //
    // Only `def_2pt_ret` so far. Kept apart from the `DST` loop above because the
    // block genuinely does not carry the field, not as a stylistic split — and
    // apart from the blocked-kick and safety sections below because those
    // reconcile two readings against each other and this has exactly one.
    //
    // Not emitted at zero. It is a plain counter rather than a tiered rule, so
    // absent and zero score the same, and every unit in the league carrying an
    // explicit `def_2pt_ret: 0` would be a row a week for an event that happens
    // about once a season.
    for (const [field, statKey] of Object.entries(TANK01_TEAM_STATS_MAP)) {
      if (team?.[field] === undefined) continue;

      const parsed = parseStatValue(team[field]);
      if (parsed === null) {
        warnings.push(
          `${teamAbv}: ${field} is ${JSON.stringify(team[field])}, which is not a number — ` +
            `${statKey} was dropped`,
        );
        continue;
      }
      if (parsed !== 0) accumulate(totals, statKey, parsed);
    }

    // ---------------------------------------------------------------------
    // Blocked kicks
    // ---------------------------------------------------------------------
    //
    // **The `teamStats` counters are the source; the scoring text is a floor.**
    //
    // `def_blk_kick` used to be derived only from scoring-play text, which can
    // only ever see a block that led to a score. **27 of the 44 blocked kicks in
    // the 2025 season did not**, so 54 points were invisible — including New
    // Orleans' blocked field goal in week 1, the game captured as
    // `__fixtures__/box-score-blocked-fg.json`, where no scoring play mentions a
    // block at all.
    //
    // The two sources are combined by taking the larger rather than by adding,
    // and that is load-bearing: `teamStats` **does** count a block that scored.
    // Proven on `20251103_ARI@DAL`, where Marshawn Kneeland recovered a blocked
    // punt in the end zone for a touchdown and Dallas's `blockedPunt` reads
    // `"1"`. Adding the two would have paid Dallas twice for one block.
    //
    // Neither source can over-count — each counts distinct real events — so the
    // larger is the better lower bound, and only a *text* count in excess of the
    // numeric one is worth reporting. The reverse is the ordinary case, 27 times
    // a season, and warning about it would be noise.
    const blockedFromText = scoringPlays.filter(
      (play) => isBlockedKick(play.score ?? "") && blockingTeamOf(play, teamAbvs) === teamAbv,
    ).length;
    const blockedFromTeamStats = blockedKicksFromTeamStats(team);

    if (blockedFromTeamStats !== null && blockedFromText > blockedFromTeamStats) {
      warnings.push(
        `${teamAbv}: teamStats reports ${blockedFromTeamStats} blocked kick(s) but ` +
          `${blockedFromText} were read from the scoring text — the larger was used`,
      );
    }

    const blockedKicks = Math.max(blockedFromTeamStats ?? 0, blockedFromText);
    if (blockedKicks > 0) accumulate(totals, "def_blk_kick", blockedKicks);

    // ---------------------------------------------------------------------
    // Defensive and special-teams touchdowns
    // ---------------------------------------------------------------------
    //
    // `RULES.md` §1 pays the D/ST 6 for a "defensive **or special teams**
    // touchdown", and pays the returner his own `ret_td` for the same play —
    // different roster spots, usually different managers, so that pair is not a
    // double-count.
    //
    // **`DST.defTD` is not "defensive scores", and this comment used to say it
    // was.** It is the sum of the players' own `Defense.defTD`, and ESPN files a
    // punt or kickoff return by a *defensive* player there too. So the unit's
    // special-teams touchdown was already in it whenever the returner happened
    // to be a defender, and adding one from the text paid the same touchdown
    // twice: New England scored 2 for Marcus Jones's single 87-yard punt return
    // in week 4. Six such plays in 2025, 36 points.
    //
    // Removing the addition outright would have been the larger error in the
    // other direction. When the returner is *not* a defensive player, `DST.defTD`
    // is `0` and the text is the only evidence the unit scored at all — Rashid
    // Shaheed's punt return in `20251218_LAR@SEA` is exactly that, and Marshawn
    // Kneeland's blocked-punt recovery is that plus a wording the old pattern did
    // not recognise.
    //
    // So the overlap is subtracted rather than the term: a special-teams
    // touchdown counts for the unit **unless the player who scored it carries a
    // `Defense.defTD` of his own**, in which case `DST.defTD` already holds it.
    //
    // `play.team` is the team that scored, which for a return is the returning
    // team — the opposite of the blocked-kick case above, where the block is
    // usually noted on the opponent's score. That is why this cannot reuse
    // `blockingTeamOf`.
    //
    // **The `scoreType` gate is a deny-list now, not `=== "TD"`.** It was the
    // latter until 2026-08-17 and Tank01 has a fifth value: `20241208_BUF@LAR`
    // files Hunter Long's blocked-punt return under `BP`, so the Rams' unit was
    // paid nothing for a special-teams touchdown — and nothing else made it up,
    // because `DST.defTD` reads `"0"` for that game too. See
    // `isTouchdownScoringPlay` for why the question is asked negatively. The
    // guard against a non-scoring play that merely mentions a return is
    // `isSpecialTeamsReturnTouchdown`, which names the event, rather than a
    // vocabulary we have now been wrong about twice.
    const defensiveScorers = defensiveTouchdownScorers(playerStats, teamAbv);
    const specialTeamsTds = scoringPlays.filter(
      (play) =>
        isTouchdownScoringPlay(play.scoreType) &&
        play.team === teamAbv &&
        isSpecialTeamsReturnTouchdown(play.score ?? ""),
    );

    const alreadyInDefTd = specialTeamsTds.filter((play) => {
      const clause = normaliseName(mainClause(play.score ?? ""));
      return defensiveScorers.some((forms) => forms.some((form) => clause.includes(form)));
    });

    const unitTds = specialTeamsTds.length - alreadyInDefTd.length;
    if (unitTds > 0) accumulate(totals, "def_td", unitTds);

    // A check, never a source. `defensiveOrSpecialTeamsTds` double-counts the
    // same play the way this code used to — New England reads 2 for one return —
    // so subtracting `DST.defTD` recovers Tank01's own independent count of the
    // special-teams half. Disagreement means our pattern saw a different number
    // of special-teams touchdowns than the provider did, which is how
    // `"Marshawn Kneeland Blocked Punt Recovery in End Zone"` went a season
    // unrecognised. Refs #158.
    //
    // **A blocked kick is filed once, not twice, and this cried wolf on every
    // one it could see.** ESPN classifies a blocked-kick touchdown as a
    // *defensive* score — stat id 93 — rather than as a return, so it appears in
    // `defensiveOrSpecialTeamsTds` a single time while an ordinary return by a
    // defensive player appears twice. Measured on 2025: Marcus Jones's punt
    // return reads `2, 1`, and Jordan Davis's and Will McDonald's blocked-kick
    // touchdowns read `1, 1` — the subtraction gives 0 where the scoring text
    // legitimately sees 1, on a game we score exactly as ESPN does.
    //
    // What is subtracted is the blocked kicks **already inside `DST.defTD`**,
    // not every blocked kick, and the distinction is the whole of the fix.
    // `defensiveOrSpecialTeamsTds` drops the second count only when the first is
    // present: Marshawn Kneeland's blocked-punt recovery reads `1, 0`, because
    // Tank01 carries no `Defense` block for him at all, and excluding it would
    // move a silent game to a warning while quieting the loud one. Four of the
    // season's five blocked-kick touchdowns took the first path.
    //
    // Narrowed rather than dropped, because this is still the only thing that
    // would find a novel wording without a season sweep — and a warning that
    // fires on correct data is how the next real one gets dismissed.
    //
    // **And a `BP` play is in neither counter**, which is the same defect
    // arriving from the other side. Newly relevant because such a play now
    // reaches `specialTeamsTds` at all: before the deny-list above it was
    // excluded from the count *and* from the scoring, so the comparison happened
    // to balance while both halves were wrong. See
    // `isUncountedSpecialTeamsScoreType`, which records that this rests on the
    // single `BP` play in two seasons.
    const uncountedByType = specialTeamsTds.filter((play) =>
      isUncountedSpecialTeamsScoreType(play.scoreType),
    );
    const blockedInDefTd = alreadyInDefTd.filter(
      (play) => isBlockedKickTouchdown(play.score ?? "") && !uncountedByType.includes(play),
    ).length;
    const readFromText = specialTeamsTds.length - blockedInDefTd - uncountedByType.length;

    const reportedDefStTds = parseStatValue(team?.[TANK01_TEAM_DEF_ST_TD_FIELD]);
    const reportedDefTds = parseStatValue(unit["defTD"]);
    if (reportedDefStTds !== null && reportedDefTds !== null) {
      const expected = reportedDefStTds - reportedDefTds;

      /*
        A negative `expected` is the provider contradicting itself, not a gap in
        our pattern matching, and until this branch existed it was reported as
        the latter.

        `DST.defTD` is the sum of the players' own `Defense.defTD`, and
        `defensiveOrSpecialTeamsTds` counts defensive *and* special-teams scores
        — so the first is a subset of the second and cannot exceed it. When it
        does, `DST.defTD` is the field that is wrong, and `TANK01_DST_MAP` pays
        `def_td` straight off it.

        Twice in 2025, both confirmed against Sleeper and the scoring text:
        `20250921_CIN@MIN` reads 3 against 2 for Isaiah Rodgers' two returns
        (6 phantom points), and `20251109_ARI@SEA` reads 4 against 2 for
        DeMarcus Lawrence's two fumble recoveries (12). It does not stop at that
        unit either — ESPN derives points allowed by subtracting 6 per defensive
        touchdown from the opponent's score, using the same wrong count, and
        `def_pts_allowed` is tiered, so the *other* team's unit can move a tier
        on a touchdown nobody scored. Refs #157.

        **Reported, never corrected.** `defensiveOrSpecialTeamsTds` agrees with
        the scoring text and with Sleeper in both games, which makes preferring
        it tempting — and it is documented next door as double-counting a return
        by a defensive player, so it is not a field to score from. Picking a
        winner between two provider counters on the evidence of two games is a
        scoring change made by us rather than by a second source, which is what
        `RULES.md` §7 exists to forbid.
      */
      const impossible = expected < 0;
      if (impossible) {
        warnings.push(
          `${teamAbv}: DST.defTD is ${reportedDefTds} but teamStats counts only ` +
            `${reportedDefStTds} defensive or special teams touchdown(s) in the whole ` +
            `game, which cannot both be true — def_td was scored as ` +
            `${totals.get("def_td") ?? 0}`,
        );
      }

      /*
        The special-teams comparison is meaningful only while `defTD` is within
        `defOrSt`. Below that its own input is incoherent and it has no opinion:
        `expected` is negative, so it reports "implies -2 special teams
        touchdown(s)", which is not an implication but arithmetic on a number
        just established to be wrong. The checked-in ledger for
        `20251109_ARI@SEA` carried exactly that string.

        Written as an explicit precondition rather than as `else if` on the
        branch above. The two conditions are complements today and an `else`
        would make that a fact about statement order — this file has twice been
        bitten by a guard that held only by virtue of what sat in front of it
        (`SPECIAL_TEAMS_RETURN` behind `DEFENSIVE_RETURN`, and
        `isTouchdownScoringPlay`). Same output, one fewer way for a later edit
        to restore the nonsense.
      */
      if (!impossible && expected !== readFromText) {
        // Every exclusion is named. The check is narrowed in two places now, and
        // a reader who does not already know about ESPN's stat id 93 or about
        // `BP` would otherwise read a suppressed play as a play nobody counted.
        const excluded = [
          ...(blockedInDefTd > 0
            ? [`${blockedInDefTd} blocked-kick touchdown(s) ESPN files as defensive`]
            : []),
          ...(uncountedByType.length > 0
            ? [`${uncountedByType.length} scored under a scoreType Tank01 does not total`]
            : []),
        ];

        warnings.push(
          `${teamAbv}: teamStats implies ${expected} special teams touchdown(s) ` +
            `(${TANK01_TEAM_DEF_ST_TD_FIELD} ${reportedDefStTds} - DST.defTD ` +
            `${reportedDefTds}) but ${readFromText} were read from the ` +
            `scoring text` +
            (excluded.length > 0 ? `, excluding ${excluded.join(" and ")}` : ""),
        );
      }
    }

    // ---------------------------------------------------------------------
    // Safeties
    // ---------------------------------------------------------------------
    //
    // Combined the same way as blocked kicks, and for the same reason: a safety
    // always scores, so it always reaches `scoringPlays` as a `scoreType` of
    // `"SF"` whose `team` is the defense that scored it — verified on
    // `20250921_ARI@SF`, where Arizona's away score moves 13 -> 15 on
    // `"Defensive Holding in Endzone for Safety"`.
    //
    // In that game `DST.safeties` reads `"1"` and agrees. It was reported not to
    // in a full-season sweep, which this could not reproduce; rather than pick a
    // winner, both are read and the larger is used, since neither can count a
    // safety that did not happen. **Disagreement in either direction is
    // reported**, because there are only about a dozen safeties in a season and
    // each is worth 2 points to a unit.
    const safetiesFromPlays = scoringPlays.filter(
      (play) => play.scoreType === "SF" && play.team === teamAbv,
    ).length;
    const safetiesReported = totals.get("def_safety") ?? 0;

    if (safetiesFromPlays !== safetiesReported) {
      warnings.push(
        `${teamAbv}: DST.safeties is ${safetiesReported} but ${safetiesFromPlays} ` +
          `safety scoring play(s) were found — the larger was used`,
      );
      const safeties = Math.max(safetiesFromPlays, safetiesReported);
      if (safeties > 0) totals.set("def_safety", safeties);
    }

    result.set(teamAbv, toStatLines(totals));
  }

  return result;
}

/**
 * Say so when a play carries a `scoreType` this adapter has never seen.
 *
 * **The tripwire, and the only reason it is worth its noise.** `"BP"` sat in the
 * feed for two seasons costing 12 points every time it appeared, and what found
 * it was somebody sweeping 544 games by hand. Nothing in the pipeline said
 * anything, because an unrecognised value is *inert* here by design — no
 * `switch`, no throw, just a set of equality tests that all miss. Inert is the
 * right behaviour and silent is not.
 *
 * Distinct values, once each per game, because the interesting thing is that a
 * value exists rather than how many plays carry it — and a warning repeated
 * ninety times is one nobody finishes reading.
 *
 * Not fatal, and not a reason to drop the play either: {@link
 * isTouchdownScoringPlay} deliberately treats an unfamiliar type as eligible, so
 * the scoring already does the best available thing. This only makes sure
 * somebody gets to check whether it was right.
 */
function reportUnknownScoreTypes(
  scoringPlays: readonly ScoringPlay[],
  warnings: string[],
): void {
  const unknown = new Set(
    scoringPlays
      .map((play) => play.scoreType)
      .filter((scoreType) => !isKnownScoreType(scoreType))
      .map((scoreType) => String(scoreType)),
  );

  for (const scoreType of unknown) {
    warnings.push(
      `scoreType ${JSON.stringify(scoreType)} has not been seen before — it was treated ` +
        `as a possible touchdown, and what it actually is should be checked against ESPN`,
    );
  }
}

/** Translate a raw `getNFLBoxScore` response. */
export function translateBoxScore(raw: unknown): TranslatedBoxScore {
  const box = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const gameRef = String(box["gameID"] ?? "");
  const playerStats = (box["playerStats"] ?? {}) as Record<string, RawPlayer>;
  const scoringPlays = (box["scoringPlays"] ?? []) as ScoringPlay[];

  reportUnknownScoreTypes(scoringPlays, warnings);

  /*
    Conversions and return touchdowns first, and for the game rather than per
    player.

    The credited player is frequently not in the play's `playerIDs` — those name
    the touchdown's participants — and is sometimes a player with no
    `scoringPlays` and no category block of his own at all (issue #155, and
    `20241229_CAR@TB` for the return). No amount of looking at one player's own
    record finds him; the play exists only on somebody else's.
  */
  const twoPoint = twoPointCreditsByPlayer(scoringPlays, playerStats, warnings);
  crossCheckTwoPoint(playerStats, twoPoint, warnings);
  const returns = returnTouchdownCredits(scoringPlays, playerStats, warnings);

  const players = new Map<string, readonly StatLine[]>();
  for (const player of Object.values(playerStats)) {
    const translated = translatePlayerWithConversions(
      player,
      warnings,
      player.playerID ? (twoPoint.get(player.playerID) ?? 0) : 0,
      player.playerID ? (returns.get(player.playerID) ?? 0) : 0,
    );
    if (translated) players.set(translated.playerID, translated.lines);
  }

  const dst = (box["DST"] ?? {}) as Record<string, unknown>;
  const teamAbvs = [
    String((dst["home"] as Record<string, unknown> | undefined)?.["teamAbv"] ?? ""),
    String((dst["away"] as Record<string, unknown> | undefined)?.["teamAbv"] ?? ""),
  ].filter(Boolean);

  const teamDefense = translateTeamDefense(
    dst,
    box["teamStats"],
    playerStats,
    scoringPlays,
    teamAbvs,
    warnings,
  );

  // A response we cannot read at all is a different fact from one that read fine
  // with a discrepancy in it, and only the first is a reason to throw the game
  // away. See `fatal` on `TranslatedBoxScore`.
  const fatal: string[] = [];
  if (!gameRef) {
    fatal.push("the response carries no gameID, so it cannot be attributed to a game");
  }
  if (Object.keys(playerStats).length === 0) {
    fatal.push("the response carries no playerStats at all");
  }

  return { gameRef, players, teamDefense, warnings, fatal };
}
