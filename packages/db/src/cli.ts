/**
 * Database CLI.
 *
 *   pnpm db:migrate   apply pending migrations
 *   pnpm db:status    show what is applied and what is pending
 *   pnpm db:seed      insert the sport registry
 *   pnpm db:audit     check exposure: grants, RLS, and BYPASSRLS roles
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

      case "audit": {
        // Written because an assumption about this went unverified and turned
        // out to be wrong: Supabase's ALTER DEFAULT PRIVILEGES had granted anon
        // full read/write/TRUNCATE on every table our migrations created,
        // regardless of the dashboard's "auto-expose" setting. Nothing was
        // reachable — the Data API was off and RLS was on — but the whole
        // guarantee rested on RLS never being switched off on any one table.
        //
        // A configuration you have to remember to check is one you stop
        // checking. This makes it a command.
        const grants = await client.query<{
          grantee: string;
          table_name: string;
          privs: string;
        }>(
          `SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
             FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
            GROUP BY grantee, table_name
            ORDER BY grantee, table_name`,
        );

        const unprotected = await client.query<{ table_name: string }>(
          `SELECT c.relname AS table_name
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
            ORDER BY c.relname`,
        );

        const bypass = await client.query<{ rolname: string }>(
          `SELECT rolname FROM pg_roles WHERE rolbypassrls ORDER BY rolname`,
        );

        console.log(`Roles that bypass RLS: ${bypass.map((r) => r.rolname).join(", ")}`);
        console.log(
          `Tables without RLS enabled: ${
            unprotected.length === 0 ? "none" : unprotected.map((r) => r.table_name).join(", ")
          }`,
        );

        if (grants.length === 0) {
          console.log("Data API grants to anon/authenticated: none\n\nOK");
          break;
        }

        console.error(`\nFAIL — ${grants.length} table(s) granted to Data API roles:\n`);
        for (const grant of grants) {
          console.error(`  ${grant.grantee} -> ${grant.table_name}: ${grant.privs}`);
        }
        console.error(
          "\nThe anon key ships in browser JavaScript. Re-run migrations, or see" +
            "\nmigrations/0007_revoke_api_grants.sql.",
        );
        process.exit(1);
        break;
      }

      default:
        console.error(`Unknown command "${command}". Use migrate, status, seed, or audit.`);
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
