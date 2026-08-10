/**
 * The playoff and consolation brackets, persisted.
 *
 * The shape of a bracket is decided in `@rostr/core`; this module supplies its
 * inputs and writes out the fixtures it names. It decides nothing.
 *
 * ## Fixtures appear one round at a time, and that is not a limitation
 *
 * A bracket cannot be written in advance because every round reseeds off the
 * last. So `advancePlayoffs` writes the round that is now known and stops —
 * called after each playoff week finalises, it lays the next week's games.
 *
 * ## Seeded from the regular season alone
 *
 * `loadWeekResults` is asked for `REGULAR` rows only. A bracket game counting
 * toward a record would move the seeds the bracket was built from, and the
 * standings would chase the results they produced.
 *
 * ## Nobody declares a winner
 *
 * `championship()` reads the bracket off the scores. There is no column holding
 * a champion and no endpoint that sets one — `docs/RULES.md` §7 says the result
 * is derived, and a stored winner would be a value somebody could be persuaded
 * to change.
 */

import { buildBracket, computeStandings, consolationField, playoffField } from "@rostr/core";
import type { Bracket, BracketGame, LeagueRules } from "@rostr/core";
import type { SqlClient } from "./client.js";
import { getLeagueRules } from "./leagues.js";
import { withTransaction } from "./transaction.js";
import { loadWeekResults } from "./week.js";
import type { MatchupPhase } from "./week.js";

export class PlayoffError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LEAGUE_NOT_FOUND"
      | "REGULAR_SEASON_UNFINISHED"
      | "NOT_ENOUGH_TEAMS"
      | "NO_PLAYOFF_WEEKS",
  ) {
    super(message);
    this.name = "PlayoffError";
  }
}

export interface BracketState {
  readonly phase: Exclude<MatchupPhase, "REGULAR">;
  readonly bracket: Bracket;
  /** Seeded field, best first. Positions are seeds. */
  readonly field: readonly string[];
}

export interface PlayoffState {
  readonly playoffs: BracketState | null;
  readonly consolation: BracketState | null;
  readonly champion: string | null;
  readonly runnerUp: string | null;
  readonly thirdPlace: string | null;
  readonly consolationWinner: string | null;
  /** Best regular-season record — the Week 14 prize, decided by seeding. */
  readonly regularSeasonWinner: string | null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Both brackets, rebuilt from the scores.
 *
 * Cheap enough to call on every page load: two small queries and some
 * arithmetic. Nothing is cached, because a cached bracket is a second answer
 * that can disagree with the first.
 */
export async function playoffState(db: SqlClient, leagueId: string): Promise<PlayoffState> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new PlayoffError("League has no rules", "LEAGUE_NOT_FOUND");

  const rules = stored.rules;
  const seeds = await seedOrder(db, leagueId, rules);

  const playoffs = await bracketFor(
    db,
    leagueId,
    rules,
    "PLAYOFF",
    playoffField(seeds, rules.schedule.playoffTeams).map((row) => row.teamId),
  );

  const consolation = rules.schedule.consolationBracket
    ? await bracketFor(
        db,
        leagueId,
        rules,
        "CONSOLATION",
        consolationField(seeds, rules.schedule.playoffTeams).map((row) => row.teamId),
      )
    : null;

  return {
    playoffs,
    consolation,
    champion: playoffs?.bracket.champion ?? null,
    runnerUp: playoffs?.bracket.runnerUp ?? null,
    thirdPlace: playoffs?.bracket.thirdPlaceGame?.winnerTeamId ?? null,
    consolationWinner: consolation?.bracket.champion ?? null,
    regularSeasonWinner: seeds[0]?.teamId ?? null,
  };
}

/** The regular-season standings, which are the bracket's seeding. */
async function seedOrder(db: SqlClient, leagueId: string, rules: LeagueRules) {
  const teams = await db.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = $1 ORDER BY slot",
    [leagueId],
  );
  const results = await loadWeekResults(
    db,
    leagueId,
    rules.schedule.regularSeasonWeeks,
    "REGULAR",
  );

  return computeStandings(
    teams.map((team) => team.id),
    results,
    rules.schedule.tiebreakers,
  );
}

async function bracketFor(
  db: SqlClient,
  leagueId: string,
  rules: LeagueRules,
  phase: Exclude<MatchupPhase, "REGULAR">,
  field: readonly string[],
): Promise<BracketState | null> {
  // A consolation bracket can legitimately be empty — every team made the
  // playoffs — and a one-team bracket has nothing to play. Neither is an error;
  // there is simply no bracket.
  if (field.length < 2) return null;

  const results = await loadWeekResults(db, leagueId, lastWeek(rules), phase);

  return {
    phase,
    field,
    bracket: buildBracket({
      field,
      weeks: rules.schedule.playoffWeeks,
      // The main bracket carries the league's frozen bye count only when the
      // field is the size it was frozen for. A smaller field — a league that
      // never reached that many teams (a pot league gets no bots, so five
      // friends is a five-team playoff) — takes whatever byes its own size needs
      // to form a valid round, exactly as the consolation bracket does.
      //
      // Applying the frozen count to a smaller field fails in two ways, and the
      // quieter one is worse. Five teams leaves three to pair in the first round,
      // which throws. **Four teams does not throw at all** — two byes and one
      // game is a legal round — it just plays a bracket nobody agreed to: seeds
      // 1 and 2 both sit out week 15, three are alive in week 16, so seed 1 byes
      // a second time and plays one game in the entire postseason. A wrong bye
      // count changes who plays whom in a bracket that decides the pot.
      firstRoundByes:
        phase === "PLAYOFF" && field.length === rules.schedule.playoffTeams
          ? rules.schedule.byeSeeds
          : byesFor(field.length),
      results,
      // Third place is a prize, so it exists only where one is paid. The
      // consolation bracket pays its winner and nobody else.
      thirdPlace: phase === "PLAYOFF" && paysThirdPlace(rules),
    }),
  };
}

function paysThirdPlace(rules: LeagueRules): boolean {
  // A free league has no payout to read, and playing a game for a prize that
  // does not exist is still the right answer: it is the difference between
  // finishing third and finishing fourth, and people care about that.
  if (!rules.pot) return true;
  return rules.pot.payout.some(
    (share) => share.prize === "THIRD_PLACE" && share.basisPoints > 0,
  );
}

function byesFor(field: number): number {
  let power = 1;
  while (power < field) power *= 2;
  return power - field;
}

function lastWeek(rules: LeagueRules): number {
  return rules.schedule.playoffWeeks.at(-1) ?? rules.schedule.regularSeasonWeeks;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface AdvanceOutcome {
  readonly written: number;
  readonly games: readonly BracketGame[];
}

/**
 * Write whichever bracket fixtures are now known and missing.
 *
 * Safe to call at any point in the playoffs and safe to call repeatedly: it
 * writes only games that both exist in the rebuilt bracket and have no row yet.
 * Run after each playoff week finalises, and once when the regular season does.
 *
 * Refuses before the regular season is complete. Seeding off a partial season
 * would produce a bracket that changes under the teams in it.
 */
export async function advancePlayoffs(
  db: SqlClient,
  leagueId: string,
): Promise<AdvanceOutcome> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new PlayoffError("League has no rules", "LEAGUE_NOT_FOUND");

  const rules = stored.rules;
  if (rules.schedule.playoffWeeks.length === 0) {
    throw new PlayoffError("This league has no playoff weeks", "NO_PLAYOFF_WEEKS");
  }

  const [unfinished] = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM matchups
      WHERE league_id = $1 AND phase = 'REGULAR' AND finalized_at IS NULL`,
    [leagueId],
  );
  if (Number(unfinished?.count ?? 0) > 0) {
    throw new PlayoffError(
      `${unfinished?.count} regular-season games are not final yet`,
      "REGULAR_SEASON_UNFINISHED",
    );
  }

  const state = await playoffState(db, leagueId);
  const wanted: { phase: MatchupPhase; game: BracketGame }[] = [];

  for (const side of [state.playoffs, state.consolation]) {
    if (!side) continue;
    for (const round of side.bracket.rounds) {
      for (const game of round.games) wanted.push({ phase: side.phase, game });
    }
    if (side.bracket.thirdPlaceGame) {
      wanted.push({ phase: side.phase, game: side.bracket.thirdPlaceGame });
    }
  }

  const existing = await db.query<{ week: number; home_team_id: string; away_team_id: string }>(
    `SELECT week, home_team_id, away_team_id FROM matchups
      WHERE league_id = $1 AND phase <> 'REGULAR'`,
    [leagueId],
  );
  const already = new Set(
    existing.flatMap((row) => [
      `${row.week}:${row.home_team_id}:${row.away_team_id}`,
      `${row.week}:${row.away_team_id}:${row.home_team_id}`,
    ]),
  );

  const missing = wanted.filter(
    ({ game }) => !already.has(`${game.week}:${game.homeTeamId}:${game.awayTeamId}`),
  );
  if (missing.length === 0) return { written: 0, games: [] };

  await withTransaction(db, async (tx) => {
    for (const { phase, game } of missing) {
      await tx.query(
        `INSERT INTO matchups (league_id, week, phase, round, home_team_id, away_team_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [leagueId, game.week, phase, game.round, game.homeTeamId, game.awayTeamId],
      );
    }
  });

  return { written: missing.length, games: missing.map(({ game }) => game) };
}

/**
 * Leagues whose playoffs have fixtures to lay.
 *
 * A league qualifies when its regular season is complete and the current week is
 * a playoff week — cheap to over-report, since `advancePlayoffs` writes nothing
 * when there is nothing missing.
 */
export async function leaguesInPlayoffs(db: SqlClient): Promise<readonly string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM leagues WHERE state IN ('IN_SEASON', 'PLAYOFFS')`,
  );

  return rows.map((row) => row.id);
}

/**
 * Move a league into `PLAYOFFS` once its regular season is behind it.
 *
 * State is what tells the rest of the system which jobs a league belongs to. A
 * league that stayed `IN_SEASON` through January would keep looking like one
 * still playing fixtures it has already played.
 */
export async function enterPlayoffs(db: SqlClient, leagueId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE leagues SET state = 'PLAYOFFS'
      WHERE id = $1 AND state = 'IN_SEASON'
        AND NOT EXISTS (
          SELECT 1 FROM matchups
           WHERE league_id = $1 AND phase = 'REGULAR' AND finalized_at IS NULL
        )
      RETURNING id`,
    [leagueId],
  );

  return rows.length > 0;
}

/**
 * Who won what, once everything is played.
 *
 * The five prizes `docs/RULES.md` §7 names, or `null` for any not yet decided.
 * This is what settlement reads — and it reads it from the scores, which is why
 * there is no way to write it.
 */
export interface Championship {
  readonly champion: string | null;
  readonly runnerUp: string | null;
  readonly thirdPlace: string | null;
  readonly regularSeason: string | null;
  readonly consolation: string | null;
  /** True when every prize the league pays has a holder. */
  readonly complete: boolean;
}

export async function championship(db: SqlClient, leagueId: string): Promise<Championship> {
  const stored = await getLeagueRules(db, leagueId);
  if (!stored) throw new PlayoffError("League has no rules", "LEAGUE_NOT_FOUND");

  const state = await playoffState(db, leagueId);
  const paid = new Set(
    (stored.rules.pot?.payout ?? [])
      .filter((share) => share.basisPoints > 0)
      .map((share) => share.prize),
  );

  const outcome = {
    champion: state.champion,
    runnerUp: state.runnerUp,
    thirdPlace: state.thirdPlace,
    regularSeason: state.regularSeasonWinner,
    consolation: state.consolationWinner,
  };

  const required: [string, string | null][] = [
    ["CHAMPION", outcome.champion],
    ["RUNNER_UP", outcome.runnerUp],
    ["THIRD_PLACE", outcome.thirdPlace],
    ["REGULAR_SEASON", outcome.regularSeason],
    ["CONSOLATION", outcome.consolation],
  ];

  return {
    ...outcome,
    // A free league pays nothing, so nothing is required and the champion alone
    // settles it. A pot league needs every prize it actually pays.
    complete:
      paid.size === 0
        ? outcome.champion !== null
        : required.every(([prize, holder]) => !paid.has(prize as never) || holder !== null),
  };
}
