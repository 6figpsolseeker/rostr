/**
 * The head-to-head: who you are playing, and where it stands.
 *
 * This is the screen a manager actually looks at on a Sunday, and it is mostly
 * assembly — the scoring engine, the stored schedule and the stat lines all
 * existed and had no way to be shown side by side.
 *
 * ## A finalised week shows the number that was finalised
 *
 * Points are recomputed from `stat_lines_current` on every read, which is how a
 * live score stays live. But once `finalized_at` is set that number is history:
 * it decided a win, a playoff seed, and in weeks 14 and 17 a payout. A stat
 * correction landing afterwards changes `stat_lines_current` and must **not**
 * change the result.
 *
 * So a finalised matchup reports the stored total and, when the live recompute
 * disagrees, says so through `restatedMilliPoints` rather than quietly
 * displaying one number or the other. A correction that arrives too late to
 * count is a real event and hiding it would be the kind of silent restatement
 * this project exists to make impossible.
 *
 * ## Still to play is the number that matters
 *
 * Being ahead by twenty with three players left is a different position from
 * being ahead by twenty with none, and no total conveys that. `yetToPlay` and
 * `inProgress` come from `games.kickoff_at` and the game status, the same source
 * every lineup lock is derived from.
 */

import { indexScoringRules, scoreTeamLineup } from "@rostr/core";
import type { PlayerScore, TeamLineup } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";
import { loadLineup, loadWeekStats } from "./lineups.js";
import type { MatchupPhase } from "./week.js";

export class MatchupError extends Error {
  constructor(
    message: string,
    readonly code: "LEAGUE_NOT_FOUND" | "NO_SCHEDULE",
  ) {
    super(message);
    this.name = "MatchupError";
  }
}

/** Where a player's game stands. Absent from the schedule reads as a bye. */
export type PlayerGameState = "BYE" | "YET_TO_PLAY" | "IN_PROGRESS" | "FINAL";

export interface PlayerLine {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  /** The slot he occupies, or `BENCH`. */
  readonly slot: string;
  readonly milliPoints: number;
  /** False for bench and IR — scored so it can be shown, never added up. */
  readonly counted: boolean;
  readonly gameState: PlayerGameState;
  readonly kickoffAt: Date | null;
}

export interface MatchupSide {
  readonly teamId: string;
  readonly teamName: string;
  readonly isBot: boolean;
  /** The authoritative total: stored once final, live before that. */
  readonly milliPoints: number;
  /**
   * What the score would be under today's stat lines, when a finalised week
   * disagrees with them. `null` whenever it does not — which is almost always.
   */
  readonly restatedMilliPoints: number | null;
  readonly starters: readonly PlayerLine[];
  readonly bench: readonly PlayerLine[];
  /** Starters whose game has not kicked off. */
  readonly yetToPlay: number;
  /** Starters whose game is under way. */
  readonly inProgress: number;
}

export interface MatchupView {
  readonly week: number;
  readonly phase: MatchupPhase;
  readonly finalized: boolean;
  readonly home: MatchupSide;
  /** `null` on a bye — an odd league leaves one team without an opponent. */
  readonly away: MatchupSide | null;
}

interface TeamRow {
  id: string;
  name: string;
  is_bot: boolean;
}

/**
 * Every matchup in a league's week, scored.
 *
 * All of them rather than only yours: a manager checks the other games too, and
 * one query for the week beats one per matchup.
 */
export async function loadWeekMatchups(
  db: SqlClient,
  leagueId: string,
  week: number,
  now: Date,
): Promise<readonly MatchupView[]> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new MatchupError("League has no rules", "LEAGUE_NOT_FOUND");

  const scheduled = await db.query<{
    week: number;
    phase: MatchupPhase;
    home_team_id: string | null;
    away_team_id: string | null;
    home_milli_points: number | null;
    away_milli_points: number | null;
    finalized_at: string | null;
  }>(
    `SELECT week, phase, home_team_id, away_team_id,
            home_milli_points, away_milli_points, finalized_at
       FROM matchups
      WHERE league_id = $1 AND week = $2
      ORDER BY id`,
    [leagueId, week],
  );
  if (scheduled.length === 0) return [];

  const [league] = await db.query<{ season: number }>(
    "SELECT season FROM leagues WHERE id = $1",
    [leagueId],
  );

  const teams = new Map(
    (
      await db.query<TeamRow>("SELECT id, name, is_bot FROM teams WHERE league_id = $1", [
        leagueId,
      ])
    ).map((team) => [team.id, team]),
  );

  const season = Number(league?.season ?? 0);
  const stats = await loadWeekStats(db, stored.rules.sportKey, season, week);
  const scoring = indexScoringRules(stored.rules.scoring);
  const context = await playerContext(db, leagueId, season, week);

  const views: MatchupView[] = [];

  for (const row of scheduled) {
    if (!row.home_team_id) continue;

    const finalized = row.finalized_at !== null;

    const side = async (teamId: string, storedPoints: number | null): Promise<MatchupSide> => {
      const team = teams.get(teamId);
      const assignments = await loadLineup(db, teamId, week, stored.rules);
      const starting = new Set(
        assignments.map((a) => a.playerId).filter((id): id is string => id !== null),
      );

      const rostered = await db.query<{ player_id: string }>(
        "SELECT player_id FROM roster_entries WHERE team_id = $1 AND released_at IS NULL",
        [teamId],
      );

      const lineup: TeamLineup = {
        teamId,
        assignments,
        bench: rostered.map((r) => r.player_id).filter((id) => !starting.has(id)),
      };

      // Scored through the same function the cron uses, so this screen cannot
      // disagree with the result that decides the standings.
      const scored = scoreTeamLineup(lineup, stats, scoring, stored.rules.roster);
      const live = scored.milliPoints;

      const lines = scored.players.map((player) => toLine(player, context, now));
      const starters = lines.filter((line) => line.counted);

      // Final wins over live: the stored number is what the week was settled on.
      const authoritative = finalized && storedPoints !== null ? Number(storedPoints) : live;

      return {
        teamId,
        teamName: team?.name ?? "Unknown",
        isBot: team?.is_bot ?? false,
        milliPoints: authoritative,
        restatedMilliPoints: finalized && live !== authoritative ? live : null,
        starters,
        bench: lines.filter((line) => !line.counted),
        yetToPlay: starters.filter((line) => line.gameState === "YET_TO_PLAY").length,
        inProgress: starters.filter((line) => line.gameState === "IN_PROGRESS").length,
      };
    };

    views.push({
      week: Number(row.week),
      phase: row.phase,
      finalized,
      home: await side(row.home_team_id, row.home_milli_points),
      away: row.away_team_id ? await side(row.away_team_id, row.away_milli_points) : null,
    });
  }

  return views;
}

/** The one matchup a team is in, or `null` if they have a bye or are not playing. */
export async function loadTeamMatchup(
  db: SqlClient,
  leagueId: string,
  teamId: string,
  week: number,
  now: Date,
): Promise<MatchupView | null> {
  const all = await loadWeekMatchups(db, leagueId, week, now);

  return (
    all.find((view) => view.home.teamId === teamId || view.away?.teamId === teamId) ?? null
  );
}

// ---------------------------------------------------------------------------
// Player context
// ---------------------------------------------------------------------------

interface PlayerFacts {
  readonly name: string;
  readonly position: string;
  readonly kickoffAt: Date | null;
  readonly gameStatus: string | null;
}

/**
 * Names, positions and kickoff state for everyone rostered in the league.
 *
 * One query for the whole league rather than one per player: a 12-team league is
 * around 200 rostered players and this screen polls.
 */
async function playerContext(
  db: SqlClient,
  leagueId: string,
  season: number,
  week: number,
): Promise<ReadonlyMap<string, PlayerFacts>> {
  const rows = await db.query<{
    id: string;
    full_name: string;
    position: string;
    kickoff_at: string | null;
    status: string | null;
  }>(
    `SELECT DISTINCT p.id,
            p.full_name,
            pos.key AS position,
            g.kickoff_at,
            g.status
       FROM roster_entries r
       JOIN teams t ON t.id = r.team_id
       JOIN players p ON p.id = r.player_id
       JOIN positions pos ON pos.id = p.primary_position_id
       LEFT JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = $2
        AND g.week = $3
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
      WHERE t.league_id = $1 AND r.released_at IS NULL`,
    [leagueId, season, week],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: row.full_name,
        position: row.position,
        kickoffAt: row.kickoff_at ? new Date(row.kickoff_at) : null,
        gameStatus: row.status,
      },
    ]),
  );
}

/**
 * A scored player plus everything the screen needs to explain his number.
 *
 * The game state is deliberately not derived from whether he has points: a
 * player can be well into his game with nothing to show for it, and reading zero
 * as "has not played" would tell a manager they are still live when they are
 * not.
 */
function toLine(
  player: PlayerScore,
  context: ReadonlyMap<string, PlayerFacts>,
  now: Date,
): PlayerLine {
  const facts = context.get(player.playerId);

  return {
    playerId: player.playerId,
    name: facts?.name ?? player.playerId,
    position: facts?.position ?? "",
    slot: player.slotType,
    milliPoints: player.milliPoints,
    counted: player.counted,
    gameState: gameStateOf(facts, now),
    kickoffAt: facts?.kickoffAt ?? null,
  };
}

function gameStateOf(facts: PlayerFacts | undefined, now: Date): PlayerGameState {
  // No game in this week's schedule: a bye. His slot never locks and he cannot
  // score, which the screen should say rather than showing a hopeful zero.
  if (!facts || facts.kickoffAt === null) return "BYE";

  const status = (facts.gameStatus ?? "").toUpperCase();
  if (status === "FINAL") return "FINAL";

  // The clock decides when the provider has not spoken. Kickoff has passed and
  // the game is not final, so it is under way — a player sitting on zero at
  // half time must not read as "still to come", because that is the difference
  // between a manager thinking they are live and knowing they have lost.
  return facts.kickoffAt.getTime() <= now.getTime() ? "IN_PROGRESS" : "YET_TO_PLAY";
}
