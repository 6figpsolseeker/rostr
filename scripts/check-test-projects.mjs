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

/*
  `programs/` is not a package, and the pair check above does not apply to it.
  There is no `dist/` to fill, no build project, and therefore nothing excluding
  these tests — so "the build config excludes them" and "the test config
  un-excludes them" are both meaningless here, and there is no build
  `references` array for a test one to match.

  The hole is the same one, though. `programs/rostr-escrow/tests` — 105 tests
  over the program that holds the pot — was in no tsconfig at all for the
  program's entire life (#261), for the same reason `packages/` was: nothing
  asserted that it should be. So it is asserted, in the shape that fits. One
  program is not a loop worth generalising over, but the next `tests/` directory
  is the one nobody will remember.
*/
const programsDir = join(root, "programs");
const programs = existsSync(programsDir)
  ? readdirSync(programsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];

let programSuites = 0;

for (const name of programs) {
  const testsDir = join(programsDir, name, "tests");
  if (!existsSync(testsDir)) continue;
  if (!readdirSync(testsDir).some((f) => f.endsWith(".ts"))) continue;

  programSuites++;
  const rel = `./programs/${name}/tsconfig.test.json`;
  const testPath = join(programsDir, name, "tsconfig.test.json");

  if (!existsSync(testPath)) {
    problems.push(
      `programs/${name}/tests contains TypeScript but programs/${name}/tsconfig.test.json ` +
        `is missing, so every one of those files is typechecked by nothing — the same hole ` +
        `#257 closed for packages/ and #261 closed here.`,
    );
    continue;
  }

  const test = read(testPath);
  if (test.compilerOptions?.noEmit !== true) {
    problems.push(
      `programs/${name}/tsconfig.test.json must set "noEmit": true. Nothing under programs/ ` +
        `should produce a dist/ — the shippable artefact here is a .so built by cargo.`,
    );
  }

  if (!referenced.has(rel)) {
    problems.push(
      `tsconfig.json does not reference "${rel}". pnpm typecheck runs "tsc --build" against ` +
        `that file and nothing else, so the program test suite for ${name} is not checked.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) with the TypeScript project graph:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nSee scripts/check-test-projects.mjs for why this is checked.\n");
  process.exit(1);
}

console.log(
  `TypeScript project graph OK: ${packages.length} packages, both halves each; ` +
    `${programSuites} program test suite(s).`,
);
