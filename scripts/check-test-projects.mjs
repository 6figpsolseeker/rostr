#!/usr/bin/env node
/**
 * Every package must have both halves of its TypeScript project.
 *
 * Each package tsconfig excludes its own `*.test.ts` files so that `dist/` holds
 * only shippable source. That is right, and for the repo's first year it was
 * also the only thing standing between 74 test files and the compiler: excluded
 * from emit had quietly become excluded from checking, and `pnpm typecheck`
 * reported success over files it had never read. One of them referenced a type
 * that does not exist in its scope — `waivers.test.ts` used `RosterShape`
 * without importing it, and the file compiled under no configuration at all.
 * Issue #257.
 *
 * The fix is a second `noEmit` project per package. The risk is that the sixth
 * package gets added by copying the fifth's `tsconfig.json` and not its
 * `tsconfig.test.json`, which fails silently and in exactly the same way — and
 * git history shows that is how the hole spread the first time: the `exclude`
 * was present at file creation in all five packages, and git reports the escrow
 * one as `copy from packages/db/tsconfig.json`. It was never a decision. So it
 * is asserted here rather than remembered.
 *
 * ## Why the `references` arrays must match
 *
 * `extends` does not inherit `references`. A test project that omits an edge its
 * build project has still resolves the import — through the workspace symlink to
 * `dist/*.d.ts` — so it typechecks the tests against whatever was last built
 * rather than against source. That failure presents as a **passing** typecheck,
 * which is the same shape as the defect this whole file exists to prevent.
 * `vitest.alias.ts` makes the matching argument for the runtime side.
 *
 * Reads JSON and nothing else, so it runs before `pnpm install` and reports in
 * seconds rather than behind a full install and build.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_GLOB = "src/**/*.test.ts";

/**
 * A scanner rather than a regex, because these files are JSONC and a regex that
 * strips `//` would eat half of `tsconfig.base.json`'s `$schema` URL.
 */
const stripJsonc = (text) => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      out += c;
      while (++i < text.length) {
        out += text[i];
        if (text[i] === "\\") {
          out += text[++i];
          continue;
        }
        if (text[i] === '"') break;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
};

const read = (p) => JSON.parse(stripJsonc(readFileSync(p, "utf8")));

/**
 * Whether a project's own `include` can still reach a test file.
 *
 * The assertions below check that a test project exists, emits nothing, and is
 * referenced. None of that is worth anything if its `include` no longer
 * matches a test: the project compiles zero files, every check here passes, and
 * `pnpm typecheck` goes green over code nobody is reading — which is the exact
 * shape of the defect this script was written for (#257), one level up.
 *
 * Most test configs omit `include` entirely and inherit the package's, which
 * already reaches the tests once `exclude` is reset — that case is fine. Only a
 * config that overrides it has to prove the override still covers them.
 * `packages/stats` does override it, to add the Tank01 JSON fixtures, so this is
 * reachable by an ordinary edit rather than hypothetical.
 */
const reachesTests = (config) => {
  const include = config.include;
  if (include === undefined) return true; // Inherited from the build config.
  return include.some((pattern) => pattern.includes("*") && pattern.endsWith(".ts"));
};
const paths = (refs) => (refs ?? []).map((r) => r.path).sort();

const problems = [];
const rootConfig = read(join(root, "tsconfig.json"));
const referenced = new Set(paths(rootConfig.references));

const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

for (const name of packages) {
  const dir = join(root, "packages", name);
  const buildPath = join(dir, "tsconfig.json");
  const testPath = join(dir, "tsconfig.test.json");

  if (!existsSync(buildPath)) continue; // Not a TypeScript package.

  const build = read(buildPath);
  if (!(build.exclude ?? []).includes(TEST_GLOB)) {
    problems.push(
      `packages/${name}/tsconfig.json no longer excludes ${TEST_GLOB}. Removing it makes ` +
        `tsc emit dist/*.test.js and dist/*.test.d.ts. Tests are checked by ` +
        `tsconfig.test.json instead.`,
    );
  }

  if (!existsSync(testPath)) {
    problems.push(
      `packages/${name}/tsconfig.test.json is missing, so every *.test.ts in that package ` +
        `is typechecked by nothing. Copy one from a sibling.`,
    );
    continue;
  }

  const test = read(testPath);
  if (test.compilerOptions?.noEmit !== true) {
    problems.push(
      `packages/${name}/tsconfig.test.json must set "noEmit": true, or it will emit tests ` +
        `into dist/.`,
    );
  }
  if (!reachesTests(test)) {
    problems.push(
      `packages/${name}/tsconfig.test.json overrides "include" with a list that cannot ` +
        `reach a test file, so it compiles none of them and every other check here still ` +
        `passes. If you are narrowing it deliberately, the project has no reason to exist.`,
    );
  }

  if ((test.exclude ?? null) === null || test.exclude.length > 0) {
    problems.push(
      `packages/${name}/tsconfig.test.json must set "exclude": [], or it inherits the build ` +
        `config's exclusion and checks no test file — the exact defect it exists to prevent.`,
    );
  }

  const buildRefs = paths(build.references);
  const testRefs = paths(test.references);
  if (buildRefs.join("|") !== testRefs.join("|")) {
    problems.push(
      `packages/${name}/tsconfig.test.json references [${testRefs.join(", ")}] but ` +
        `tsconfig.json references [${buildRefs.join(", ")}]. They must match: a missing edge ` +
        `resolves through dist/*.d.ts instead of source, so the tests are checked against ` +
        `whatever was last built and the typecheck passes anyway.`,
    );
  }

  for (const [label, path] of [
    ["build", `./packages/${name}`],
    ["test", `./packages/${name}/tsconfig.test.json`],
  ]) {
    if (!referenced.has(path)) {
      problems.push(
        `tsconfig.json does not reference "${path}". pnpm typecheck runs "tsc --build" ` +
          `against that file and nothing else, so the ${label} project for @rostr/${name} ` +
          `is not being checked.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) with the TypeScript project graph:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nSee scripts/check-test-projects.mjs for why this is checked.\n");
  process.exit(1);
}

console.log(`TypeScript project graph OK: ${packages.length} packages, both halves each.`);
