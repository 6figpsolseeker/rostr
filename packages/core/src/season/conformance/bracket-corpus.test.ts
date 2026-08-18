/**
 * The guard on the bracket corpus.
 *
 * Same job as `corpus.test.ts`: the corpus only stops a Rust kernel disagreeing
 * with `buildBracket` while the checked-in file still matches what the
 * TypeScript produces. Otherwise it is a snapshot both sides drift away from,
 * with the Rust conformance test passing the whole time and proving nothing.
 * This fails on the commit that causes the drift rather than in January.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBracketCorpus, serialiseBracketCorpus } from "./bracket-corpus.js";
import { BRACKET_CASES } from "./bracket-cases.js";

const CORPUS_PATH = fileURLToPath(new URL("./bracket-corpus.json", import.meta.url));

describe("the bracket conformance corpus", () => {
  it("matches what buildBracket produces today", () => {
    // If this fails, either the ladder changed — in which case the Rust kernel
    // is now wrong and must be updated in the same pass — or a case was added.
    // Regenerate with `pnpm corpus:build`.
    expect(readFileSync(CORPUS_PATH, "utf8")).toBe(serialiseBracketCorpus());
  });

  it("records an outcome for every case, and only one", () => {
    for (const entry of buildBracketCorpus()) {
      const built = entry.rounds !== undefined;
      const refused = entry.refusal !== undefined;
      expect(built || refused, `${entry.name} recorded neither`).toBe(true);
      expect(built && refused, `${entry.name} recorded both`).toBe(false);
    }
  });

  it("pins all three refusal codes", () => {
    // A code with no case is a code the Rust side can implement any way it
    // likes and never be caught. `INVARIANT` matters most of the three: it is
    // the one that means our ladder is broken rather than that league's rules
    // are, and it is thrown from the code that decides who is paid.
    const seen = new Set(
      buildBracketCorpus().flatMap((entry) => (entry.refusal ? [entry.refusal] : [])),
    );
    expect([...seen].sort()).toEqual(["FIELD_TOO_SMALL", "INVARIANT", "NOT_ENOUGH_WEEKS"]);
  });

  it("covers a decided bracket, an undecided one, and a tie broken by seed", () => {
    const corpus = buildBracketCorpus();

    // A champion, so the path settlement reads is exercised at all. `typeof`
    // rather than a null check because the field is absent on a refusal and
    // `null` on a bracket still in progress — three states, not two.
    expect(corpus.some((entry) => typeof entry.champion === "string")).toBe(true);
    // And a bracket still in progress, so "no champion yet" is distinguished
    // from "champion is null because the walk broke".
    expect(corpus.some((entry) => entry.rounds && entry.champion === null)).toBe(true);
    // The one place bracket scoring differs from the regular season.
    expect(
      corpus.some((entry) =>
        entry.rounds?.some((round) => round.games.some((game) => game.decidedBySeed)),
      ),
    ).toBe(true);
  });

  it("covers a played third-place game and a league that does not play one", () => {
    const corpus = buildBracketCorpus();
    expect(corpus.some((entry) => typeof entry.thirdPlaceHolder === "string")).toBe(true);
    expect(corpus.some((entry) => entry.thirdPlace && entry.thirdPlaceGame === null)).toBe(
      true,
    );
    expect(corpus.some((entry) => !entry.thirdPlace && entry.rounds)).toBe(true);
  });

  it("covers a round where somebody takes a bye", () => {
    // Byes are the half of `pairRound` a power-of-two-only kernel skips, and
    // the default six-team shape uses them.
    const corpus = buildBracketCorpus();
    expect(corpus.some((entry) => entry.rounds?.some((round) => round.byes.length > 0))).toBe(
      true,
    );
  });

  it("gives every case a reason for existing", () => {
    // `why` is carried into the JSON so the Rust side reads it too. A case
    // nobody can justify is a case nobody will maintain.
    for (const testCase of BRACKET_CASES) {
      expect(testCase.why.length, testCase.name).toBeGreaterThan(20);
    }
  });
});
