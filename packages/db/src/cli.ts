/**
 * Database CLI.
 *
 *   pnpm db:migrate   apply pending migrations
 *   pnpm db:status    show what is applied and what is pending
 *   pnpm db:seed      insert the sport registry
 *
 * Reads DATABASE_URL from the environment. Nothing here is needed to run the
 * test suite — that uses PGlite and no credentials at all.
 */

import { NFL } from "@rostr/core";
import { loadMigrations, migrate } from "./migrate.js";
import { createPostgresClient } from "./postgres.js";
import { seedSport } from "./sports.js";

function connectionString(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error(
      "DATABASE_URL is not set.\n\n" +
        "Create a Supabase project, then put its connection string in .env:\n" +
        "  DATABASE_URL=postgresql://...\n\n" +
        "See docs/SETUP-REQUIRED.md.",
    );
    process.exit(1);
  }
  return url;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "migrate";
  const client = createPostgresClient(connectionString());

  try {
    switch (command) {
      case "migrate": {
        const result = await migrate(client);
        if (result.applied.length === 0) {
          console.log(`Up to date — ${result.skipped.length} migrations already applied.`);
        } else {
          for (const name of result.applied) console.log(`applied  ${name}`);
          console.log(`\n${result.applied.length} migration(s) applied.`);
        }
        break;
      }

      case "status": {
        const onDisk = loadMigrations();
        const applied = await client
          .query<{ version: number }>("SELECT version FROM schema_migrations")
          .catch(() => []);
        const appliedVersions = new Set(applied.map((r) => Number(r.version)));

        for (const m of onDisk) {
          console.log(
            `${appliedVersions.has(m.version) ? "applied " : "PENDING "} ${m.filename}`,
          );
        }
        break;
      }

      case "seed": {
        const ids = await seedSport(client, NFL);
        console.log(
          `Seeded ${NFL.key}: ${ids.statKeyIds.size} stat keys, ` +
            `${ids.positionIds.size} positions, ${ids.slotTypeIds.size} slot types.`,
        );
        break;
      }

      default:
        console.error(`Unknown command "${command}". Use migrate, status, or seed.`);
        process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
