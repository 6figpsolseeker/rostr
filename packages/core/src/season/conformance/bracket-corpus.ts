/**
 * Turning the bracket cases into the corpus both implementations read.
 *
 * The expectations are **produced by running `buildBracket`**, so the JSON
 * cannot disagree with the TypeScript. `bracket-corpus.test.ts` asserts the
 * checked-in file still equals what this produces, which is what stops it
 * becoming an August snapshot both sides drift away from while the Rust
 * conformance test passes and proves nothing.
 *
 * Same shape as `corpus.ts` next door, deliberately — two corpora with two
 * different formats would be two things to learn.
 */

import { buildBracket, BracketError, thirdPlaceWinner } from "../bracket.js";
import type { Bracket, BracketGame } from "../bracket.js";
import { BRACKET_CASES } from "./bracket-cases.js";
import type { BracketCase } from "./bracket-cases.js";

/**
 * Why a bracket could not be built.
 *
 * TypeScript throws and Rust returns a `Result`, so the corpus records a *code*
 * rather than a message. `BracketError` already carries one, unlike
 * `StandingsError` — so unlike `refusalOf` in `corpus.ts` this needs no message
 * matching, and the mapping is an identity rather than a guess.
 */
export type BracketRefusal = "FIELD_TOO_SMALL" | "NOT_ENOUGH_WEEKS" | "INVARIANT";

/** One game, stripped of the label — see the note in `bracket-cases.ts`. */
export interface CorpusGame {
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly winnerTeamId: string | null;
  readonly decidedBySeed: boolean;
}

export interface CorpusRound {
  readonly week: number;
  readonly round: number;
  readonly games: readonly CorpusGame[];
  /** Team ids sitting the round out and advancing anyway. */
  readonly byes: readonly string[];
  /** Team ids through to the next round, or `null` while a game is unscored. */
  readonly survivors: readonly string[] | null;
}

export interface BracketCorpusEntry {
  readonly name: string;
  readonly why: string;
  readonly field: readonly string[];
  readonly weeks: readonly number[];
  readonly firstRoundByes: number;
  readonly results: BracketCase["results"];
  readonly thirdPlace: boolean;
  /** Exactly one of `rounds` or `refusal` is present. */
  readonly rounds?: readonly CorpusRound[];
  readonly champion?: string | null;
  readonly runnerUp?: string | null;
  readonly thirdPlaceGame?: CorpusGame | null;
  /** What `thirdPlaceWinner` answers — pinned separately because settlement
   * reads that function, not the game. */
  readonly thirdPlaceHolder?: string | null;
  readonly refusal?: BracketRefusal;
}

const gameOf = (game: BracketGame): CorpusGame => ({
  homeTeamId: game.homeTeamId,
  awayTeamId: game.awayTeamId,
  winnerTeamId: game.winnerTeamId,
  decidedBySeed: game.decidedBySeed,
});

function roundsOf(bracket: Bracket): CorpusRound[] {
  return bracket.rounds.map((round) => ({
    week: round.week,
    round: round.round,
    games: round.games.map(gameOf),
    byes: round.byes.map((entrant) => entrant.teamId),
    survivors: round.survivors?.map((entrant) => entrant.teamId) ?? null,
  }));
}

/** Run every case through the real implementation and record what it did. */
export function buildBracketCorpus(): readonly BracketCorpusEntry[] {
  return BRACKET_CASES.map((testCase) => {
    const base = {
      name: testCase.name,
      why: testCase.why,
      field: testCase.field,
      weeks: testCase.weeks,
      firstRoundByes: testCase.firstRoundByes,
      results: testCase.results,
      thirdPlace: testCase.thirdPlace,
    };

    try {
      const bracket = buildBracket(testCase);
      return {
        ...base,
        rounds: roundsOf(bracket),
        champion: bracket.champion,
        runnerUp: bracket.runnerUp,
        thirdPlaceGame: bracket.thirdPlaceGame ? gameOf(bracket.thirdPlaceGame) : null,
        thirdPlaceHolder: thirdPlaceWinner(bracket),
      };
    } catch (error) {
      // Unlike `StandingsError`, this one carries the code already. Rethrowing
      // anything else is deliberate: an unexpected throw here is a bug in the
      // generator or in `buildBracket`, and recording it as a refusal would
      // teach the Rust side to reproduce it.
      if (!(error instanceof BracketError)) throw error;
      return { ...base, refusal: error.code };
    }
  });
}

/**
 * The corpus as it is written to disk.
 *
 * Two spaces and a trailing newline, matching `serialiseCorpus`, so a
 * regeneration produces no diff beyond the content and prettier leaves it alone.
 */
export function serialiseBracketCorpus(): string {
  return `${JSON.stringify({ cases: buildBracketCorpus() }, null, 2)}\n`;
}
