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
  //
  // Sampling one player is not enough — categories only appear when a player has
  // stats in them, so the first entry is often a punter. This walks every player
  // in a box score and unions the field names per category.
  console.log("\nBox score");
  const games = await client.get<Record<string, unknown>[]>("getNFLGamesForWeek", {
    week: "1",
    seasonType: "reg",
    season: "2025",
  });

  const game = games[0];
  if (!game || typeof game["gameID"] !== "string") {
    console.log("  No games returned.");
    return;
  }

  const box = await client.get<Record<string, unknown>>("getNFLBoxScore", {
    gameID: game["gameID"],
  });

  console.log(`  ${game["gameID"]}`);
  console.log(`  Top-level keys: ${Object.keys(box).join(", ")}`);

  const playerStats = (box["playerStats"] ?? {}) as Record<string, Record<string, unknown>>;
  const fieldsByCategory = new Map<string, Set<string>>();
  const exampleByCategory = new Map<string, string>();

  for (const player of Object.values(playerStats)) {
    for (const [category, value] of Object.entries(player)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;

      const fields = fieldsByCategory.get(category) ?? new Set<string>();
      for (const field of Object.keys(value as Record<string, unknown>)) fields.add(field);
      fieldsByCategory.set(category, fields);

      if (!exampleByCategory.has(category)) {
        exampleByCategory.set(
          category,
          `${String(player["longName"])} -> ${JSON.stringify(value)}`,
        );
      }
    }
  }

  console.log(`\n  ${Object.keys(playerStats).length} players with stats.\n`);
  for (const [category, fields] of [...fieldsByCategory].sort()) {
    console.log(`  [${category}]`);
    console.log(`    fields:  ${[...fields].sort().join(", ")}`);
    console.log(`    example: ${exampleByCategory.get(category)?.slice(0, 220)}`);
  }

  // Defensive points allowed is not a player stat — it comes from team scoring,
  // and the engine needs it emitted explicitly even when zero.
  if (box["DST"] !== undefined) {
    console.log(`\n  [DST] ${JSON.stringify(box["DST"]).slice(0, 400)}`);
  }

  // Field goal distances and two-point conversions do not appear in the stat
  // categories at all — only aggregate counts do. If they exist anywhere it is
  // here, in the play-by-play scoring summary.
  const scoringPlays = box["scoringPlays"];
  if (Array.isArray(scoringPlays)) {
    console.log(`\n  [scoringPlays] ${scoringPlays.length} plays`);
    const first = scoringPlays[0] as Record<string, unknown> | undefined;
    if (first) console.log(`    fields: ${Object.keys(first).sort().join(", ")}`);

    for (const play of scoringPlays as Record<string, unknown>[]) {
      console.log(
        `    ${String(play["scoreType"] ?? "?").padEnd(4)} | ${String(play["score"] ?? "")}`,
      );
    }
    console.log(`\n    full first play: ${JSON.stringify(scoringPlays[0])}`);
  }
}

const command = process.argv[2] ?? "check";

const run = command === "probe" ? probe : check;

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
