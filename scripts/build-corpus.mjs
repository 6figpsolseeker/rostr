/**
 * Regenerate the conformance corpora.
 *
 * Two of them now: seeding (`computeStandings`) and the playoff ladder
 * (`buildBracket`). Between them they are the shared spec for the Rust
 * derivation kernel that issue #28 needs on-chain, and they are **generated,
 * never edited** — a hand-written expectation is a third implementation with no
 * tests of its own.
 *
 *   pnpm corpus:build
 *
 * `corpus.test.ts` and `bracket-corpus.test.ts` fail when a checked-in file no
 * longer matches what the TypeScript produces, which is the signal to run this.
 * Read the diff before committing it: a change here means the derivation moved,
 * and the Rust kernel is now wrong until it is updated to match.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serialiseCorpus } from "../packages/core/dist/season/conformance/corpus.js";
import { serialiseBracketCorpus } from "../packages/core/dist/season/conformance/bracket-corpus.js";

const corpora = [
  ["standings-corpus.json", serialiseCorpus],
  ["bracket-corpus.json", serialiseBracketCorpus],
];

for (const [name, serialise] of corpora) {
  const target = fileURLToPath(
    new URL(`../packages/core/src/season/conformance/${name}`, import.meta.url),
  );
  writeFileSync(target, serialise());
  process.stdout.write(`wrote ${target}\n`);
}
