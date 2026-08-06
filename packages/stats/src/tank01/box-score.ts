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
   */
  readonly warnings: readonly string[];
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
function translateTeamDefense(
  raw: Record<string, unknown>,
  scoringPlays: readonly ScoringPlay[],
  teamAbvs: readonly string[],
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
      if (parsed === null) continue;

      // Points allowed is meaningful at zero; the rest are not worth emitting.
      if (parsed !== 0 || statKey === "def_pts_allowed") {
        accumulate(totals, statKey, parsed);
      }
    }

    // A blocked kick belongs to whoever blocked it — the other team.
    for (const play of scoringPlays) {
      if (!isBlockedKick(play.score ?? "")) continue;

      const kickingTeam = play.team ?? "";
      const blockingTeam = teamAbvs.find((abv) => abv !== kickingTeam);
      if (blockingTeam === teamAbv) accumulate(totals, "def_blk_kick", 1);
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

  const teamDefense = translateTeamDefense(dst, scoringPlays, teamAbvs);

  return { gameRef, players, teamDefense, warnings };
}
