/**
 * Turning the cases into the corpus both implementations read.
 *
 * The expectations are **produced by running `computeStandings`**, so the JSON
 * cannot disagree with the TypeScript. `corpus.test.ts` asserts the checked-in
 * file still equals what this produces, which is what stops it becoming an
 * August snapshot that both sides drift away from while the conformance test
 * keeps passing and proves nothing.
 */

import { computeStandings, StandingsError, winPercentageBasisPoints } from "../standings.js";
import { CASES } from "./cases.js";
import type { CorpusCase } from "./cases.js";

/**
 * Why a derivation refused.
 *
 * TypeScript throws and Rust returns a `Result`, so the corpus records a *code*
 * rather than a message — a message is prose and will drift, a code is the
 * contract. The mapping is a decision rather than a translation, so it lives
 * here where both sides can read it.
 */
export type RefusalCode =
  /** The chain ran out with teams still tied. */
  | "TIEBREAKERS_EXHAUSTED"
  /** No tiebreakers were supplied at all. */
  | "NO_TIEBREAKERS"
  /** A result named a team that is not in the league. */
  | "UNKNOWN_TEAM";

export interface CorpusSeed {
  readonly teamId: string;
  readonly seed: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly milliPointsFor: number;
  readonly milliPointsAgainst: number;
  readonly games: number;
  /**
   * Win percentage in basis points.
   *
   * Recorded even though no ordering depends on it, because the *arithmetic*
   * needs pinning and the ordering cannot pin it: every win percentage is a
   * multiple of `5000 / games`, so at any league size anyone plays two teams
   * cannot straddle a rounding boundary. Half-up and truncation therefore
   * produce identical seeds on every case here — verified by trying it — and
   * differ only in this number.
   */
  readonly winPctBasisPoints: number;
  /** Which link separated this team from the one above, or `null` for the top. */
  readonly decidedBy: string | null;
}

export interface CorpusEntry {
  readonly name: string;
  readonly why: string;
  readonly teamIds: readonly string[];
  readonly results: CorpusCase["results"];
  readonly tiebreakers: readonly string[];
  /** Exactly one of these is present. */
  readonly seeds?: readonly CorpusSeed[];
  readonly refusal?: RefusalCode;
}

/**
 * Classify a thrown `StandingsError` into the code the corpus records.
 *
 * Matching on the message is unpleasant and it is the honest option: the
 * TypeScript throws one error type for three conditions and this is the seam
 * where that becomes a problem for someone else. If `StandingsError` ever grows
 * a `code`, this collapses to reading it — and the corpus format does not
 * change, which is the point of recording a code rather than a message.
 */
function refusalOf(error: unknown): RefusalCode {
  if (!(error instanceof StandingsError)) throw error;
  if (error.message.includes("At least one tiebreaker")) return "NO_TIEBREAKERS";
  if (error.message.includes("Tiebreakers exhausted")) return "TIEBREAKERS_EXHAUSTED";
  if (error.message.includes("not in the league")) return "UNKNOWN_TEAM";
  throw new Error(`Unclassified StandingsError, corpus needs a new code: ${error.message}`);
}

/** Run every case through the real implementation and record what it did. */
export function buildCorpus(): readonly CorpusEntry[] {
  return CASES.map((testCase) => {
    const base = {
      name: testCase.name,
      why: testCase.why,
      teamIds: testCase.teamIds,
      results: testCase.results,
      tiebreakers: testCase.tiebreakers,
    };

    try {
      const standings = computeStandings(
        testCase.teamIds,
        testCase.results,
        testCase.tiebreakers,
      );
      return {
        ...base,
        seeds: standings.map((row) => ({
          teamId: row.teamId,
          seed: row.seed,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          milliPointsFor: row.milliPointsFor,
          milliPointsAgainst: row.milliPointsAgainst,
          games: row.games,
          winPctBasisPoints: winPercentageBasisPoints(row),
          decidedBy: row.decidedBy,
        })),
      };
    } catch (error) {
      return { ...base, refusal: refusalOf(error) };
    }
  });
}

/**
 * The corpus as it is written to disk.
 *
 * Two spaces and a trailing newline so a regeneration produces no diff beyond
 * the content, and prettier leaves it alone.
 */
export function serialiseCorpus(): string {
  return `${JSON.stringify({ cases: buildCorpus() }, null, 2)}\n`;
}
