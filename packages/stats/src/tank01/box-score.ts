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
  isSpecialTeamsReturnTouchdown,
  isSuccessfulTwoPointConversion,
  parseFieldGoalYards,
  parseStatValue,
  scoredInMainClause,
  TANK01_DST_MAP,
  TANK01_STAT_MAP,
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

  const roster = Object.values(playerStats)
    .filter((player) => player.playerID && player.longName)
    .map((player) => ({
      playerID: player.playerID as string,
      longName: player.longName as string,
      forms: nameForms(player.longName as string),
    }));

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

function translatePlayerWithConversions(
  player: RawPlayer,
  warnings: string[],
  /** Decided for the whole game — see `twoPointCreditsByPlayer`. */
  twoPointConversions: number,
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

  // 2. Scoring plays this player was involved in.
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
      continue;
    }

    if (play.scoreType === "TD") {
      // The scorer is whoever the main clause names — not `playerIDs[0]`, which
      // is the conversion passer when the parenthetical holds a successful
      // two-pointer. See `scoredInMainClause`.
      if (
        isSpecialTeamsReturnTouchdown(text) &&
        player.longName &&
        scoredInMainClause(text, player.longName)
      ) {
        accumulate(totals, "ret_td", 1);
      }
    }
  }

  // Two-point conversions are decided for the whole game, not here: the player
  // credited is often absent from this play's `playerIDs` and sometimes has no
  // `scoringPlays` of his own at all. See `twoPointCreditsByPlayer`.
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
 * Team defense stat lines.
 *
 * `ptsAllowed` is emitted **even when zero**, because the scoring engine treats
 * an absent stat as "did not play" and a shutout would otherwise silently
 * forfeit its bonus.
 *
 * Blocked kicks are credited to the team that *blocked* one, which is the
 * opponent of the team whose kick it was.
 */
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

function translateTeamDefense(
  raw: Record<string, unknown>,
  scoringPlays: readonly ScoringPlay[],
  teamAbvs: readonly string[],
  warnings: string[],
): Map<string, StatLine[]> {
  const result = new Map<string, StatLine[]>();

  for (const side of ["home", "away"] as const) {
    const unit = raw[side] as Record<string, unknown> | undefined;
    if (!unit) continue;

    const teamAbv = String(unit["teamAbv"] ?? "");
    if (!teamAbv) continue;

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

    for (const play of scoringPlays) {
      const text = play.score ?? "";

      if (isBlockedKick(text) && blockingTeamOf(play, teamAbvs) === teamAbv) {
        accumulate(totals, "def_blk_kick", 1);
      }

      // A kickoff or punt return pays the **unit** as well as the returner.
      //
      // `RULES.md` §1 pays the D/ST for a "defensive or special teams
      // touchdown", and §1 also says the returner keeps his own `ret_td` for the
      // same play — different roster spots, usually different managers, so this
      // is not double-counting. We were paying only the returner, because
      // `def_td` came solely from `DST.defTD`, which counts *defensive* scores.
      // Ten times in weeks 1-6 of 2025 alone, at 6 points each.
      //
      // `play.team` is the team that scored, which for a return is the returning
      // team — the opposite of the blocked-kick case above, where the block is
      // usually noted on the opponent's score. That is why this cannot reuse
      // `blockingTeamOf`.
      //
      // Gated on `scoreType` so a non-scoring play that merely mentions a return
      // cannot pay six points, and `isSpecialTeamsReturnTouchdown` already
      // refuses interception and fumble returns, which `DST.defTD` has counted
      // already.
      if (
        play.scoreType === "TD" &&
        isSpecialTeamsReturnTouchdown(text) &&
        play.team === teamAbv
      ) {
        accumulate(totals, "def_td", 1);
      }
    }

    result.set(teamAbv, toStatLines(totals));
  }

  return result;
}

/** Translate a raw `getNFLBoxScore` response. */
export function translateBoxScore(raw: unknown): TranslatedBoxScore {
  const box = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const gameRef = String(box["gameID"] ?? "");
  const playerStats = (box["playerStats"] ?? {}) as Record<string, RawPlayer>;
  const scoringPlays = (box["scoringPlays"] ?? []) as ScoringPlay[];

  /*
    Conversions first, and for the game rather than per player.

    The credited player is frequently not in the play's `playerIDs` — those name
    the touchdown's participants — and is sometimes a player with no
    `scoringPlays` and no receiving block of his own at all (issue #155). No
    amount of looking at one player's own record finds him; the conversion only
    exists on somebody else's.
  */
  const twoPoint = twoPointCreditsByPlayer(scoringPlays, playerStats, warnings);
  crossCheckTwoPoint(playerStats, twoPoint, warnings);

  const players = new Map<string, readonly StatLine[]>();
  for (const player of Object.values(playerStats)) {
    const translated = translatePlayerWithConversions(
      player,
      warnings,
      player.playerID ? (twoPoint.get(player.playerID) ?? 0) : 0,
    );
    if (translated) players.set(translated.playerID, translated.lines);
  }

  const dst = (box["DST"] ?? {}) as Record<string, unknown>;
  const teamAbvs = [
    String((dst["home"] as Record<string, unknown> | undefined)?.["teamAbv"] ?? ""),
    String((dst["away"] as Record<string, unknown> | undefined)?.["teamAbv"] ?? ""),
  ].filter(Boolean);

  const teamDefense = translateTeamDefense(dst, scoringPlays, teamAbvs, warnings);

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
