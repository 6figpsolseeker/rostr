#!/usr/bin/env node
/**
 * Refuse a migration numbered at or below the base branch's highest.
 *
 * `packages/db/migrations/README.md` states the rule:
 *
 *   > Take the next number **above main's highest**, and **renumber on rebase if
 *   > main moved**. Never merge a PR whose migration number is at or below
 *   > main's head.
 *
 * ## Why this cannot be a test
 *
 * The runner already refuses a file numbered below one already applied, and
 * `migrate.test.ts` already refuses two files sharing a number. Neither can see
 * this case, and the reason is the same for both: `createTestDatabase()` builds
 * an **empty** PGlite database, so `schema_migrations` is empty, `maxApplied` is
 * 0, and every filename order is legal. The suite is green and the deployed
 * database — which has an applied maximum — refuses to start. That asymmetry is
 * on the record in this repo's own history: *"on a fresh database migrations
 * sort and apply in order so maxApplied never overtakes, which means CI stays
 * green while a deployed database refuses to start."*
 *
 * So it needs the base branch, which a test does not have and git does.
 *
 * ## What deliberately is not here
 *
 * An earlier draft also asked the GitHub API what numbers other open pull
 * requests had claimed. That is the case where two branches each correctly take
 * the next free number — and it is covered better by requiring branches to be up
 * to date before merging, which makes the merge ref contain whatever just
 * landed, so the repo's **own** duplicate check fires before the merge instead
 * of on `main` after it. A status check is stamped on a head SHA and does not
 * re-run when the base moves, so an API answer here is a photograph that branch
 * protection would treat as current.
 *
 * That leaves this with no network call, no token, and no behaviour difference
 * on a pull request from a fork — which matters, because two of the outside
 * contributions to this repo have come from forks.
 *
 * ## Run it on every pull request
 *
 * Not path-filtered to `packages/db/migrations/**`. GitHub reports a required
 * check that never fires as permanently pending, so a filtered job as a required
 * context blocks every pull request that does not touch the filtered paths. It
 * exits 0 quickly when there is nothing to say instead.
 *
 * Usage: `node scripts/check-migration-numbers.mjs <base-ref>`
 * Needs the base ref fetched — `fetch-depth: 0` on the checkout.
 */

import { execFileSync } from "node:child_process";

const MIGRATIONS_DIR = "packages/db/migrations";
const FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Exit codes. 1 is a real finding; 3 is "could not tell", which is not the same. */
const FOUND_A_PROBLEM = 1;
const BAD_USAGE = 2;
const COULD_NOT_TELL = 3;

const baseRef = process.argv[2];
if (!baseRef) {
  console.error("usage: check-migration-numbers.mjs <base-ref>");
  process.exit(BAD_USAGE);
}

/**
 * Migration filenames at a git ref.
 *
 * A failure here means the ref is missing or git is unhappy — an infrastructure
 * problem, not a numbering one. It exits 3 rather than 1 so that a red check
 * means what it says. A check that goes red for reasons unrelated to the diff is
 * a check people learn to ignore, and this one only earns its place by being
 * believed.
 */
function migrationsAt(ref) {
  let out;
  try {
    out = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_DIR], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(
      `Could not read ${MIGRATIONS_DIR} at "${ref}".\n` +
        `  git said: ${String(error.stderr ?? error.message).trim()}\n\n` +
        `  This is a checkout problem, not a numbering problem. The base ref has to\n` +
        `  be fetched — set "fetch-depth: 0" on actions/checkout, which does not\n` +
        `  fetch it by default.`,
    );
    process.exit(COULD_NOT_TELL);
  }

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => path.slice(MIGRATIONS_DIR.length + 1))
    .filter((name) => FILENAME.test(name));
}

const versionOf = (name) => Number(FILENAME.exec(name)[1]);

const baseNames = migrationsAt(baseRef);
const baseVersions = new Set(baseNames.map(versionOf));
const baseHighest = baseNames.reduce((max, name) => Math.max(max, versionOf(name)), 0);

// On a pull request, HEAD is the merge ref — base plus this branch — so
// subtracting the base's own files leaves exactly what this branch adds. A
// rename shows up as one addition, because the old name never existed at the
// merge base.
const ours = migrationsAt("HEAD").filter((name) => !baseNames.includes(name));

const problems = [];

for (const name of ours) {
  const version = versionOf(name);
  if (version > baseHighest) continue;

  problems.push(
    baseVersions.has(version)
      ? `${name} is version ${version}, and ${baseRef} already has a migration at ` +
          `that version.\n` +
          `    Both files would sit in one tree, and \`loadMigrations\` throws\n` +
          `    \`Duplicate migration version ${version}\` — failing every\n` +
          `    database-backed test in the repo.`
      : `${name} is version ${version}, at or below ${baseRef}'s highest ` +
          `(${baseHighest}).\n` +
          `    Migrations are forward-only, so any database that has already applied\n` +
          `    version ${baseHighest} will refuse this one permanently — while a fresh\n` +
          `    database applies it happily, which is why the test suite cannot see this.\n` +
          `    Renumber it above ${baseHighest}.`,
  );
}

if (problems.length > 0) {
  console.error(`Migration numbering against ${baseRef} (highest ${baseHighest}):\n`);
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error("See packages/db/migrations/README.md.");
  process.exit(FOUND_A_PROBLEM);
}

console.log(
  ours.length === 0
    ? `No new migrations against ${baseRef}.`
    : `Migration numbering fine: ${ours.join(", ")} (${baseRef} highest ${baseHighest}).`,
);
