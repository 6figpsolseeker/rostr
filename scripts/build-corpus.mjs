/**
 * Regenerate the standings conformance corpus.
 *
 * The corpus is the shared spec for `computeStandings` and the Rust derivation
 * kernel that issue #28 needs on-chain. It is **generated, never edited** — a
 * hand-written expectation is a third implementation with no tests of its own.
 *
 *   pnpm corpus:build
 *
 * `corpus.test.ts` fails when the checked-in file no longer matches what the
 * TypeScript produces, which is the signal to run this. Read the diff before
 * committing it: a change here means the derivation moved, and the Rust kernel
 * is now wrong until it is updated to match.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serialiseCorpus } from "../packages/core/dist/season/conformance/corpus.js";

const target = fileURLToPath(
  new URL("../packages/core/src/season/conformance/standings-corpus.json", import.meta.url),
);

writeFileSync(target, serialiseCorpus());
process.stdout.write(`wrote ${target}\n`);
