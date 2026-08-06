/**
 * Stats provider CLI.
 *
 *   pnpm stats:check    verify TANK01_API_KEY works
 *   pnpm stats:probe    fetch a sample and print its shape
 *
 * `probe` exists because the field names in `tank01/stat-map.ts` were written
 * from documentation, not from a live response. Run it once the key is in place
 * and confirm they match before trusting any scoring built on top.
 */

import { Tank01Client } from "./tank01/client.js";

function apiKey(): string {
  const key = process.env["TANK01_API_KEY"];
  if (!key) {
    console.error(
      "TANK01_API_KEY is not set.\n\n" +
        "  1. Sign up at https://rapidapi.com\n" +
        "  2. Subscribe (Basic, $0) to the Tank01 NFL API\n" +
        "  3. Copy the X-RapidAPI-Key value\n" +
        "  4. Add it to .env:  TANK01_API_KEY=...\n\n" +
        "See docs/SETUP-REQUIRED.md.",
    );
    process.exit(1);
  }
  return key;
}

async function check(): Promise<void> {
  const client = new Tank01Client({ apiKey: apiKey() });
  const health = await client.healthCheck();

  console.log(`${health.ok ? "OK  " : "FAIL"}  ${health.provider}: ${health.detail}`);
  if (!health.ok) process.exit(1);
}

async function probe(): Promise<void> {
  const client = new Tank01Client({ apiKey: apiKey() });

  console.log("Teams");
  const teams = await client.get<Record<string, unknown>[]>("getNFLTeams");
  const firstTeam = teams[0];
  if (firstTeam) {
    console.log(`  ${teams.length} teams. Fields: ${Object.keys(firstTeam).join(", ")}`);
  }

  console.log("\nPlayers");
  const players = await client.get<Record<string, unknown>[]>("getNFLPlayerList");
  const firstPlayer = players[0];
  if (firstPlayer) {
    console.log(`  ${players.length} players. Fields: ${Object.keys(firstPlayer).join(", ")}`);
    console.log(`  Sample: ${JSON.stringify(firstPlayer).slice(0, 300)}`);
  }

  // The important one: confirm the stat field names in stat-map.ts are real.
  console.log("\nBox score shape");
  const games = await client.get<Record<string, unknown>[]>("getNFLGamesForWeek", {
    week: "1",
    seasonType: "reg",
    season: "2025",
  });
  const game = games[0];
  if (game && typeof game["gameID"] === "string") {
    const box = await client.get<Record<string, unknown>>("getNFLBoxScore", {
      gameID: game["gameID"],
    });
    const playerStats = box["playerStats"] as Record<string, unknown> | undefined;
    const samplePlayer = playerStats ? Object.values(playerStats)[0] : undefined;

    if (samplePlayer && typeof samplePlayer === "object") {
      console.log(`  Categories: ${Object.keys(samplePlayer).join(", ")}`);
      console.log(`  Sample: ${JSON.stringify(samplePlayer).slice(0, 600)}`);
    }
  }
}

const command = process.argv[2] ?? "check";

const run = command === "probe" ? probe : check;

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
