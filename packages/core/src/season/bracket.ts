/**
 * The playoff bracket, and the consolation bracket beside it.
 *
 * Pure, like the rest of this directory. Nothing here reads a clock or a
 * database: given the seeded field and whatever results exist so far, it returns
 * the whole bracket — the rounds already played, the round to play next, and who
 * has won if anyone has.
 *
 * ## Rebuilt from results, never accumulated
 *
 * `buildBracket` walks the bracket from round one on every call rather than
 * storing who advanced. That costs nothing at this size and buys the property
 * that matters: **a bracket is a function of the field and the scores.** A
 * corrected stat line that flips a Week 15 game reshapes Week 16 automatically,
 * with no stored "winner" left disagreeing with the score it came from. In a pot
 * league the bracket decides who is paid, so it must be recomputable by anyone
 * holding the same inputs.
 *
 * ## The higher seed wins a tie
 *
 * `winnerOf` in `results.ts` answers `null` for equal totals, which is right for
 * the regular season — a tie is a real outcome there. A bracket cannot have one:
 * somebody has to play next week. `docs/RULES.md` §5 says the higher seed
 * advances, and that is the only place the two differ.
 *
 * ## Reseeding, not a fixed ladder
 *
 * Every round pairs the best surviving seed against the worst. So the Week 16
 * opponent of the top seed depends on who won in Week 15 — which is what
 * "Week 16 pairs the top seed against the lower surviving seed" in §5 means, and
 * it is why the bracket cannot be drawn in advance.
 */

import type { MatchupResult } from "./standings.js";

export class BracketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BracketError";
  }
}

export interface BracketEntrant {
  readonly teamId: string;
  /** Seed within this bracket, 1-based. Fixed at entry and never re-derived. */
  readonly seed: number;
}

export interface BracketGame {
  readonly week: number;
  /** 1-based, counting from the first round this bracket plays. */
  readonly round: number;
  /** The higher seed, which is the only thing "home" means in a bracket. */
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  /** "Semifinal", "Championship", "Third place" — for display only. */
  readonly label: string;
  /** Null until the game has been scored. */
  readonly winnerTeamId: string | null;
  /** True when equal totals sent the higher seed through. */
  readonly decidedBySeed: boolean;
}

export interface BracketRound {
  readonly week: number;
  readonly round: number;
  readonly label: string;
  /** Everyone still alive going into this round, best seed first. */
  readonly entrants: readonly BracketEntrant[];
  readonly games: readonly BracketGame[];
  /** Teams sitting this round out and advancing anyway. */
  readonly byes: readonly BracketEntrant[];
  /** Everyone through to the next round, or `null` while a game is unscored. */
  readonly survivors: readonly BracketEntrant[] | null;
}

export interface Bracket {
  readonly rounds: readonly BracketRound[];
  readonly champion: string | null;
  readonly runnerUp: string | null;
  /**
   * The third-place game, when this bracket has one. It is not part of the
   * ladder — nobody advances out of it — so it sits beside the rounds rather
   * than in them. `null` before the semifinals resolve.
   */
  readonly thirdPlaceGame: BracketGame | null;
}

export interface BuildBracketInput {
  /** The field in seed order, best first. Seeds are positions in this array. */
  readonly field: readonly string[];
  /** The weeks this bracket may use, ascending. */
  readonly weeks: readonly number[];
  /**
   * How many top seeds sit out the first round.
   *
   * Taken from the league's frozen `byeSeeds` rather than derived, because it is
   * a number members signed. `validateLeagueRules` already forces it to the only
   * value that resolves, so the two agree — but if they ever stopped agreeing,
   * the signed one should win.
   */
  readonly firstRoundByes: number;
  /** Finalised results, any week. A game not yet scored is simply absent. */
  readonly results: readonly MatchupResult[];
  /** Whether the losing semifinalists play for third place. */
  readonly thirdPlace: boolean;
}

/**
 * The whole bracket, as far as the results reach.
 *
 * Rounds beyond the last completed one are not invented — the ladder stops at
 * the first round with an unscored game, because who plays next genuinely is not
 * known yet.
 */
export function buildBracket(input: BuildBracketInput): Bracket {
  if (input.field.length < 2) {
    throw new BracketError(`A bracket needs at least two teams, got ${input.field.length}`);
  }
  if (input.firstRoundByes < 0 || input.firstRoundByes >= input.field.length) {
    throw new BracketError(
      `firstRoundByes (${input.firstRoundByes}) must be between 0 and ${input.field.length - 1}`,
    );
  }

  const scores = indexResults(input.results);
  const rounds: BracketRound[] = [];

  let alive: readonly BracketEntrant[] = input.field.map((teamId, index) => ({
    teamId,
    seed: index + 1,
  }));

  // The bracket plays the *last* weeks of the window, not the first. A field
  // needing fewer rounds than there are weeks — a four-team consolation bracket
  // in a three-week window — must still finish in the championship week, because
  // that is the week the payout settles.
  const roundCount = roundsNeeded(alive.length, input.firstRoundByes);
  if (roundCount > input.weeks.length) {
    throw new BracketError(
      `A ${alive.length}-team bracket needs ${roundCount} rounds but only ` +
        `${input.weeks.length} weeks are available`,
    );
  }
  const weeks = input.weeks.slice(input.weeks.length - roundCount);

  for (const [index, week] of weeks.entries()) {
    const entrants = alive;
    const byeCount = index === 0 ? input.firstRoundByes : byesNeeded(entrants.length);
    const { games, byes } = pairRound(entrants, byeCount, week, index + 1, scores);

    const survivors = games.every((game) => game.winnerTeamId !== null)
      ? [...byes, ...games.map((game) => entrantOf(game.winnerTeamId!, entrants))].sort(
          (a, b) => a.seed - b.seed,
        )
      : null;

    rounds.push({
      week,
      round: index + 1,
      label: labelFor(entrants.length),
      entrants,
      games,
      byes,
      survivors,
    });

    if (!survivors) break;
    alive = survivors;
  }

  const final = rounds.at(-1);
  const decided = rounds.length === weeks.length && final?.survivors?.length === 1;

  return {
    rounds,
    champion: decided ? (final?.survivors?.[0]?.teamId ?? null) : null,
    runnerUp: decided ? loserOf(final?.games[0]) : null,
    thirdPlaceGame: input.thirdPlace
      ? buildThirdPlace(rounds, weeks.length, weeks.at(-1), scores)
      : null,
  };
}

/**
 * Who finished third, or `null` while the game is unplayed.
 *
 * Separate from the bracket's own ladder because third place is a prize
 * (`docs/RULES.md` §7 pays it 5%) rather than a step toward one.
 */
export function thirdPlaceWinner(bracket: Bracket): string | null {
  return bracket.thirdPlaceGame?.winnerTeamId ?? null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ScoreIndex {
  get(week: number, homeTeamId: string, awayTeamId: string): MatchupResult | undefined;
}

function indexResults(results: readonly MatchupResult[]): ScoreIndex {
  const map = new Map<string, MatchupResult>();
  for (const result of results) {
    if (result.awayTeamId === null) continue;
    // Both orientations. Which team a stored row calls "home" is the database's
    // business; a bracket game is looked up by its pair, not by an order.
    map.set(`${result.week}:${result.homeTeamId}:${result.awayTeamId}`, result);
    map.set(`${result.week}:${result.awayTeamId}:${result.homeTeamId}`, result);
  }

  return { get: (week, home, away) => map.get(`${week}:${home}:${away}`) };
}

/**
 * One round's games, pairing the best surviving seed against the worst.
 *
 * The top `byeCount` seeds sit out. Everyone else is paired highest-with-lowest,
 * which is what makes a bracket reward a good regular season: the prize for
 * seeding first is the weakest opponent still standing.
 */
function pairRound(
  entrants: readonly BracketEntrant[],
  byeCount: number,
  week: number,
  round: number,
  scores: ScoreIndex,
): { games: BracketGame[]; byes: BracketEntrant[] } {
  const ordered = [...entrants].sort((a, b) => a.seed - b.seed);
  const byes = ordered.slice(0, byeCount);
  const playing = ordered.slice(byeCount);

  if (playing.length % 2 !== 0) {
    throw new BracketError(
      `Round ${round} leaves ${playing.length} teams to pair, which is odd. ` +
        `A rule set producing this should have been refused at creation.`,
    );
  }

  const games: BracketGame[] = [];
  for (let i = 0; i < playing.length / 2; i++) {
    const home = playing[i]!;
    const away = playing[playing.length - 1 - i]!;
    const result = scores.get(week, home.teamId, away.teamId);
    const tied = result
      ? pointsFor(result, home.teamId) === pointsFor(result, away.teamId)
      : false;

    games.push({
      week,
      round,
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      label: labelFor(entrants.length),
      winnerTeamId: result ? advance(result, home, away) : null,
      decidedBySeed: tied,
    });
  }

  return { games, byes };
}

function pointsFor(result: MatchupResult, teamId: string): number {
  return result.homeTeamId === teamId ? result.homeMilliPoints : result.awayMilliPoints;
}

/**
 * Who goes through.
 *
 * Points decide it; equal points go to the higher seed. This is the one place
 * bracket scoring differs from the regular season, where a tie is a real result
 * and both teams keep it.
 */
function advance(result: MatchupResult, home: BracketEntrant, away: BracketEntrant): string {
  const homePoints = pointsFor(result, home.teamId);
  const awayPoints = pointsFor(result, away.teamId);

  if (homePoints > awayPoints) return home.teamId;
  if (awayPoints > homePoints) return away.teamId;

  // Equal to the milli-point. Rare, but somebody has to play next week — see
  // `docs/RULES.md` §5.
  return home.seed < away.seed ? home.teamId : away.teamId;
}

/**
 * The two losing semifinalists, in the championship week, higher seed at home.
 *
 * The semifinal is found by round number, not by taking the second-to-last round
 * built. Those differ exactly when the semifinals are half-scored: the ladder
 * stops there, so the second-to-last round is the *quarterfinal*, and pairing
 * its losers would invent a third-place game between two teams knocked out a
 * round earlier.
 */
function buildThirdPlace(
  rounds: readonly BracketRound[],
  totalRounds: number,
  week: number | undefined,
  scores: ScoreIndex,
): BracketGame | null {
  const semis = rounds.find((round) => round.round === totalRounds - 1);
  if (!semis || week === undefined || semis.games.length !== 2) return null;
  if (semis.survivors === null) return null;

  const losers = semis.games
    .map(loserOf)
    .filter((id): id is string => id !== null)
    .map((teamId) => entrantOf(teamId, semis.entrants))
    .sort((a, b) => a.seed - b.seed);

  const [home, away] = losers;
  if (!home || !away) return null;

  const result = scores.get(week, home.teamId, away.teamId);
  const tied = result
    ? pointsFor(result, home.teamId) === pointsFor(result, away.teamId)
    : false;

  return {
    week,
    round: semis.round + 1,
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    label: "Third place",
    winnerTeamId: result ? advance(result, home, away) : null,
    decidedBySeed: tied,
  };
}

function entrantOf(teamId: string, entrants: readonly BracketEntrant[]): BracketEntrant {
  const entrant = entrants.find((candidate) => candidate.teamId === teamId);
  if (!entrant) throw new BracketError(`${teamId} won a game it was not entered in`);
  return entrant;
}

function loserOf(game: BracketGame | undefined): string | null {
  if (!game?.winnerTeamId) return null;
  return game.winnerTeamId === game.homeTeamId ? game.awayTeamId : game.homeTeamId;
}

/** Byes needed to bring a round down to a power of two. */
function byesNeeded(alive: number): number {
  if (alive <= 1) return 0;
  return nextPowerOfTwo(alive) - alive;
}

function nextPowerOfTwo(n: number): number {
  let power = 1;
  while (power < n) power *= 2;
  return power;
}

/** How many rounds a field of this size takes to resolve to one team. */
function roundsNeeded(field: number, firstRoundByes: number): number {
  let alive = (field - firstRoundByes) / 2 + firstRoundByes;
  let rounds = 1;

  while (alive > 1) {
    alive = (alive + byesNeeded(alive)) / 2;
    rounds++;
  }

  return rounds;
}

/** What a round with this many teams left is called. */
function labelFor(alive: number): string {
  if (alive <= 2) return "Championship";
  if (alive <= 4) return "Semifinal";
  if (alive <= 8) return "Quarterfinal";
  return `Round of ${nextPowerOfTwo(alive)}`;
}
