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

import { gameAvailability, indexScoringRules, scoreTeamLineup } from "@rostr/core";
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

/**
 * Where a player's game stands.
 *
 * `TIME_TBD` is a stored fixture whose hour the NFL has not fixed — the row
 * carries a conservative stand-in kickoff, so the clock passing it must **not**
 * read as the game having started. `UNSCHEDULED` is the weaker case: no row at
 * all on a week that is not the team's bye. Both used to be indistinguishable
 * from `BYE`, and a bye means the opposite thing to anyone deciding a lineup.
 * See `gameAvailability` in `@rostr/core`.
 */
export type PlayerGameState =
  "BYE" | "UNSCHEDULED" | "TIME_TBD" | "YET_TO_PLAY" | "IN_PROGRESS" | "FINAL";

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
  /**
   * Starters whose fixture exists but has no kickoff time yet.
   *
   * Counted apart from `yetToPlay` rather than folded into it: that number is
   * "points still to come, at a known time", and this one carries no time at
   * all. Adding them would make a side with a fixture still awaiting its time
   * look ready to play when nobody can say what hour it starts.
   */
  readonly unscheduled: number;
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

      const lines = scored.players.map((player) => toLine(player, context, week, now));
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
        unscheduled: starters.filter(
          (line) => line.gameState === "UNSCHEDULED" || line.gameState === "TIME_TBD",
        ).length,
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
  /** `games.kickoff_tbd` — the kickoff above is a conservative stand-in. */
  readonly kickoffTbd: boolean;
  /** This season's bye week, null when unrecorded. Separates a bye from a
   * fixture whose kickoff time is not fixed yet. */
  readonly byeWeek: number | null;
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
    kickoff_tbd: boolean | null;
    bye_week: number | null;
  }>(
    `SELECT DISTINCT p.id,
            p.full_name,
            pos.key AS position,
            g.kickoff_at,
            g.status,
            g.kickoff_tbd,
            ps.bye_week
       FROM roster_entries r
       JOIN teams t ON t.id = r.team_id
       JOIN players p ON p.id = r.player_id
       JOIN positions pos ON pos.id = p.primary_position_id
       LEFT JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = $2
        AND g.week = $3
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
       LEFT JOIN player_seasons ps
         ON ps.player_id = p.id
        AND ps.season = $2
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
        kickoffTbd: row.kickoff_tbd === true,
        byeWeek: row.bye_week === null ? null : Number(row.bye_week),
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
  week: number,
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
    gameState: gameStateOf(facts, week, now),
    kickoffAt: facts?.kickoffAt ?? null,
  };
}

function gameStateOf(facts: PlayerFacts | undefined, week: number, now: Date): PlayerGameState {
  // No game in this week's schedule, and there are two reasons for that. A bye
  // means he cannot score, and the screen should say so rather than show a
  // hopeful zero. A fixture awaiting its time means he will play and nobody yet
  // knows at what hour — telling a manager the first when the second is true is
  // what gets the player dropped in the week that decides the season.
  if (!facts || facts.kickoffAt === null) {
    const availability = gameAvailability({
      kickoffAt: facts?.kickoffAt ?? null,
      byeWeek: facts?.byeWeek ?? null,
      week,
    });
    return availability === "UNSCHEDULED" ? "UNSCHEDULED" : "BYE";
  }

  const status = (facts.gameStatus ?? "").toUpperCase();
  if (status === "FINAL") return "FINAL";

  // A provisional kickoff is not a kickoff, and the clock passing it says
  // nothing. `syncGames` stores the earliest hour the game could start, so a
  // fixture actually played at 20:20 would otherwise read as under way from
  // 13:00 — seven hours of a manager being told a game is live before it has
  // begun, in the week the season is decided. The provider's own status is
  // still believed, so this resolves itself the moment the game really starts.
  if (facts.kickoffTbd && status !== "IN_PROGRESS") return "TIME_TBD";

  // The clock decides when the provider has not spoken. Kickoff has passed and
  // the game is not final, so it is under way — a player sitting on zero at
  // half time must not read as "still to come", because that is the difference
  // between a manager thinking they are live and knowing they have lost.
  return facts.kickoffAt.getTime() <= now.getTime() ? "IN_PROGRESS" : "YET_TO_PLAY";
}
