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

function toStatLines(totals: ReadonlyMap<string, number>): StatLine[] {
  return [...totals].map(([statKey, value]) => ({ statKey, value }));
}

/**
 * Which players a two-point conversion should credit.
 *
 * The least certain part of this file. The conversion is described inside the
 * parenthetical of a touchdown:
 *
 *     (Rhamondre Stevenson Run for Two-Point Conversion)
 *     (Tua Tagovailoa Pass to Julian Hill for Two-Point Conversion)
 *
 * `playerIDs` on the play does not distinguish the touchdown scorer from the
 * conversion participants, so this matches the player's `longName` **within the
 * parenthetical only** — a narrow enough window that a coincidental match is
 * implausible, unlike matching against the whole play text where the touchdown
 * scorer's name also appears.
 *
 * Our rules award 2 points for a conversion pass, rush, *and* reception, so both
 * the passer and the receiver are credited.
 */
function twoPointCredit(scoreText: string, longName: string): boolean {
  const parenthetical = /\(([^)]*)\)/.exec(scoreText)?.[1];
  if (!parenthetical || !isSuccessfulTwoPointConversion(parenthetical)) return false;

  return parenthetical.includes(longName);
}

function translatePlayer(
  player: RawPlayer,
  warnings: string[],
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
      // The returner is named first, so only credit the primary scorer.
      if (isSpecialTeamsReturnTouchdown(text) && play.playerIDs?.[0] === playerID) {
        accumulate(totals, "ret_td", 1);
      }
      if (player.longName && twoPointCredit(text, player.longName)) {
        accumulate(totals, "two_pt", 1);
      }
    }
  }

  // 3. Cross-check parsed field goals against the count Tank01 reports.
  //    Text parsing in a scoring path fails quietly; this is what makes it fail
  //    loudly instead.
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
 */
function blockingTeamOf(play: ScoringPlay, teamAbvs: readonly string[]): string | null {
  const scoringTeam = play.team ?? "";
  if (!scoringTeam) return null;

  const text = play.score ?? "";
  // A return or a recovery means the team on the play is the one that blocked it.
  const scoredByTheBlocker = /\brecover(?:ed|y)\b/i.test(text) || /\breturn\b/i.test(text);

  if (scoredByTheBlocker) return scoringTeam;
  return teamAbvs.find((abv) => abv !== scoringTeam) ?? null;
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
        // for `def_pts_allowed`: it is the sport's only TIERED rule, absent is
        // not zero, and a unit that still emits a sack looks like it played and
        // scored 2 rather than 12. The rest are worth reporting too — a field
        // the provider renamed should not read as a quiet zero.
        if (unit[field] !== undefined) {
          warnings.push(
            `${teamAbv}: ${field} is ${JSON.stringify(unit[field])}, which is not a number — ` +
              `${statKey} was dropped`,
          );
        } else if (statKey === "def_pts_allowed") {
          warnings.push(
            `${teamAbv}: the box score carries no ${field}, so ${statKey} was dropped — ` +
              `this is the only tiered rule in the sport and absent is not zero`,
          );
        }
        continue;
      }

      // Points allowed is meaningful at zero; the rest are not worth emitting.
      if (parsed !== 0 || statKey === "def_pts_allowed") {
        accumulate(totals, statKey, parsed);
      }
    }

    for (const play of scoringPlays) {
      if (!isBlockedKick(play.score ?? "")) continue;
      if (blockingTeamOf(play, teamAbvs) === teamAbv) accumulate(totals, "def_blk_kick", 1);
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

  const players = new Map<string, readonly StatLine[]>();
  for (const player of Object.values(playerStats)) {
    const translated = translatePlayer(player, warnings);
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
