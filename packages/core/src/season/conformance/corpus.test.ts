/**
 * The guard on the corpus.
 *
 * The corpus exists so a Rust kernel and `computeStandings` cannot disagree.
 * That only works while the checked-in file still matches what the TypeScript
 * produces — otherwise it is a snapshot of August that both sides drift away
 * from, with the Rust conformance test passing the whole time and proving
 * nothing. This is the test that makes the drift loud, and it fails on the
 * commit that causes it rather than in December.
 *
 * Same shape as `prize-order.test.ts`, which describes its own equivalent as
 * guarding the guard.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCorpus, serialiseCorpus } from "./corpus.js";
import { CASES, TEAM } from "./cases.js";

const CORPUS_PATH = fileURLToPath(new URL("./standings-corpus.json", import.meta.url));

describe("the standings conformance corpus", () => {
  it("matches what computeStandings produces today", () => {
    // If this fails, either the derivation changed — in which case the Rust
    // kernel is now wrong and must be updated in the same pass — or a case was
    // added. Regenerate with `pnpm corpus:build`.
    expect(readFileSync(CORPUS_PATH, "utf8")).toBe(serialiseCorpus());
  });

  it("records an outcome for every case, and only one", () => {
    for (const entry of buildCorpus()) {
      const hasSeeds = entry.seeds !== undefined;
      const hasRefusal = entry.refusal !== undefined;
      expect(hasSeeds || hasRefusal, `${entry.name} recorded neither`).toBe(true);
      expect(hasSeeds && hasRefusal, `${entry.name} recorded both`).toBe(false);
    }
  });

  it("covers both outcomes, so neither branch is untested", () => {
    const corpus = buildCorpus();
    expect(corpus.some((entry) => entry.seeds)).toBe(true);
    expect(corpus.some((entry) => entry.refusal)).toBe(true);
  });

  it("pins all three refusal codes", () => {
    // A code with no case is a code the Rust side can implement any way it
    // likes and never be caught.
    const seen = new Set(
      buildCorpus().flatMap((entry) => (entry.refusal ? [entry.refusal] : [])),
    );
    expect([...seen].sort()).toEqual([
      "NO_TIEBREAKERS",
      "TIEBREAKERS_EXHAUSTED",
      "UNKNOWN_TEAM",
    ]);
  });

  it("gives every case a reason for existing", () => {
    // `why` is carried into the JSON so the Rust side reads it too. A case
    // nobody can justify is a case nobody will maintain.
    for (const testCase of CASES) {
      expect(testCase.why.length, testCase.name).toBeGreaterThan(20);
    }
  });

  /**
   * The assumption `LOWEST_TEAM_ID` rests on, asserted rather than trusted.
   *
   * TypeScript sorts the id with `localeCompare`; a Rust kernel holding a team
   * as sixteen raw UUID bytes compares bytes. Those agree for canonical
   * lowercase hex and diverge the moment case or a non-hex character appears —
   * `"a"` sorts after `"Z"` under `localeCompare` and before it by byte.
   * Postgres `gen_random_uuid()` produces lowercase hex, so this holds in
   * production; it is asserted here because the corpus is what a Rust
   * implementation will be written against, and a corpus that quietly violated
   * it would teach the wrong lesson.
   */
  it("uses ids whose string order and byte order agree", () => {
    const byString = [...TEAM].sort((a, b) => a.localeCompare(b));
    const byBytes = [...TEAM].sort((a, b) => {
      const x = a.replaceAll("-", "");
      const y = b.replaceAll("-", "");
      return x < y ? -1 : x > y ? 1 : 0;
    });
    expect(byString).toEqual(byBytes);

    for (const teamId of TEAM) {
      expect(teamId, "corpus ids must be canonical lowercase hex").toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});
