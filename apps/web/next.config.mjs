import { fileURLToPath } from "node:url";

/**
 * Next.js infers the workspace root by walking up for a lockfile, and picks the
 * **highest** one it finds. On a machine with a stray `package.json` in the home
 * directory — one `npm i` in the wrong terminal is enough — that resolves to the
 * home directory itself, and Next then traces and watches every sibling project,
 * every download, every unrelated folder under it.
 *
 * The symptom is not an error. `next dev` prints "Starting…", never reaches
 * "Ready", and serves nothing, which reads as a broken app rather than as a
 * misconfigured root. It is worse over WSL, where each of those stats crosses a
 * filesystem boundary.
 *
 * So the root is stated rather than inferred. It is this repo, always, whatever
 * else exists on the machine.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The credentials live in the **repo root** `.env`, and Next does not look there.
 *
 * Every other entry point reads it explicitly — `node --env-file-if-exists=.env`
 * in `db:migrate`, `db:sync`, `stats:probe` and the rest — so one file has always
 * held the whole configuration, which is what `docs/SETUP-REQUIRED.md` documents.
 * Next only loads `.env` from the app directory, so `next dev` saw none of it.
 *
 * The symptom was not a missing-configuration message. `db()` threw
 * "DATABASE_URL is not set" *inside a route*, the route returned a 500 with an
 * empty body, and the browser reported `Failed to execute 'json' on 'Response'`
 * — a JSON parse error, three layers away from the cause. Following the setup
 * instructions exactly produced it, which is why the web app had never been run
 * against a real database by anyone.
 *
 * `process.loadEnvFile` is Node's own parser — the same one behind
 * `--env-file`, which is how every other entry point reads this exact file — so
 * there is one parser and no new dependency. It runs here because
 * `next.config.mjs` is evaluated before anything reads `process.env`, including
 * the `NEXT_PUBLIC_` inlining.
 *
 * Copying the file into `apps/web/` would also work and is worse: two copies of
 * a secret that drift, in a file that is gitignored so the drift is invisible.
 *
 * Missing is not an error. A fresh checkout has no `.env` at all, and the app
 * should still start and then fail with the specific message the missing value
 * deserves — `db()`'s pointer to `docs/SETUP-REQUIRED.md` says far more than a
 * config-time crash would.
 */
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // No .env, or an unreadable one. Deliberate — see above.
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them itself.
  transpilePackages: ["@rostr/core", "@rostr/db", "@rostr/pinning"],
  serverExternalPackages: ["pg"],
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
