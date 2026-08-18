/**
 * Where the corpus lives on disk, and how to read it.
 *
 * Shared by `corpus.test.ts` and by `scripts/build-stats-corpus.mjs` so the two
 * cannot disagree about a path — a generator writing somewhere the test does not
 * look would leave a stale ledger passing forever.
 *
 * The raw Tank01 responses stay in `__fixtures__/` alongside the ones
 * `box-score.test.ts` already imports by name. They are the same artifacts, and
 * a game worth a hand-written unit test is usually worth a corpus row as well;
 * splitting them would mean capturing several of them twice.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "./manifest.js";
import type { EspnFixture, SleeperFixture } from "./capture.js";
import type { SleeperIdMap } from "./sleeper.js";
import type { Ledger } from "./ledger.js";

/**
 * The package root, found by walking up to `package.json`.
 *
 * Not a path relative to this module, because this module runs from two places:
 * `src/` under vitest, and `dist/` when the CLI is invoked the way every other
 * `pnpm stats:*` script invokes it. `tsc` does not copy JSON into `dist`, so a
 * relative path resolves to a directory that exists in one case and not the
 * other — which surfaced as the capture command failing on a fixture the test
 * was reading happily.
 */
function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(directory, "package.json"))) return directory;
    directory = resolve(directory, "..");
  }
  throw new Error("cannot locate the @rostr/stats package root from " + import.meta.url);
}

const FIXTURES = join(packageRoot(), "src", "tank01", "__fixtures__");

const root = (relative: string): string => join(FIXTURES, relative);

export const FIXTURE_ROOT = FIXTURES;
export const CORPUS_ROOT = root("corpus");

export const manifestPath = (): string => root("corpus/manifest.json");
export const idMapPath = (): string => root("corpus/sleeper-players.json");
export const boxScorePath = (fileName: string): string => root(fileName);
export const ledgerPath = (gameRef: string): string => root(`corpus/ledgers/${gameRef}.json`);
export const sleeperPath = (gameRef: string): string => root(`corpus/sleeper/${gameRef}.json`);
export const espnPath = (gameRef: string): string => root(`corpus/espn/${gameRef}.json`);

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export const readManifest = (): Manifest => readJson<Manifest>(manifestPath());
export const readIdMap = (): SleeperIdMap => readJson<SleeperIdMap>(idMapPath());
export const readBoxScore = (fileName: string): unknown =>
  readJson<unknown>(boxScorePath(fileName));
export const readLedger = (gameRef: string): Ledger => readJson<Ledger>(ledgerPath(gameRef));
export const readSleeper = (gameRef: string): SleeperFixture =>
  readJson<SleeperFixture>(sleeperPath(gameRef));
export const readEspn = (gameRef: string): EspnFixture =>
  readJson<EspnFixture>(espnPath(gameRef));

/**
 * Write a fixture as prettier would.
 *
 * Two-space JSON with a trailing newline. Keeping the generated files inside
 * `format:check` rather than exempting them in `.prettierignore` is the cheaper
 * arrangement here: the generator's output is already prettier's, so there is
 * nothing to exempt, and a file somebody edited by hand shows up in the
 * formatter as well as in the comparison.
 */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Every raw Tank01 box score in `__fixtures__/`, by file name.
 *
 * Used by the test that refuses a captured game nobody put in the manifest. A
 * response sitting in the tree unclaimed is one nobody is checking anything
 * against — which is how a fixture captured for an investigation comes to look
 * like coverage.
 */
export function boxScoreFileNames(): readonly string[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((name) => name.startsWith("box-score") && name.endsWith(".json"))
    .sort();
}

/**
 * Every file under one of the generated corpus directories, as game refs.
 *
 * Used by the test that requires each directory to hold exactly the games the
 * manifest names — in **both** directions. A missing file is caught anyway by the
 * eager reads in `corpus.test.ts`, but an **orphan** is not: a ledger left behind
 * by a game somebody removed from the manifest sits in the tree forever, is
 * compared against nothing, and reads as coverage. That is the same failure
 * {@link boxScoreFileNames} exists to catch one directory up.
 */
export function corpusFileNames(directory: "ledgers" | "sleeper" | "espn"): readonly string[] {
  return readdirSync(join(CORPUS_ROOT, directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}
