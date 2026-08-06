/**
 * Stats provider CLI.
 *
 *   check                 verify TANK01_API_KEY works
 *   probe                 live response shapes, unioned across a whole box score
 *   verify <weeks>        hunt rare scoring events across many games
 *   discover              which endpoints exist, and what each returns
 *   deep                  detail on the endpoints we actually use
 *
 * These are investigation tools, not part of the running system. They exist
 * because the stat map was originally written from documentation and three of
 * its field names were wrong — see `docs/TANK01.md`. Anything asserted about
 * Tank01 should be reproducible with one of these commands.
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

/**
 * Hunt for the stats we are least sure about.
 *
 * Three things could not be confirmed from a single box score, because they
 * simply did not occur in that game: a lost fumble by an offensive player, a
 * two-point conversion, and a blocked kick. This scans a week of games until it
 * finds each, and prints the raw shape.
 */
async function verify(): Promise<void> {
  const client = new Tank01Client({ apiKey: apiKey() });
  const weeks = (process.argv[3] ?? "1,2,3").split(",");

  const scoreTypes = new Map<string, string>();
  /** Every "(...)" trailer seen on a scoring play, with an example. */
  const parentheticals = new Map<string, string>();
  const blocked: string[] = [];
  let games = 0;

  for (const week of weeks) {
    const schedule = await client.get<Record<string, unknown>[]>("getNFLGamesForWeek", {
      week,
      seasonType: "reg",
      season: "2025",
    });

    for (const game of schedule) {
      if (typeof game["gameID"] !== "string") continue;
      games++;

      const box = await client.get<Record<string, unknown>>("getNFLBoxScore", {
        gameID: game["gameID"],
      });

      for (const play of (box["scoringPlays"] ?? []) as Record<string, unknown>[]) {
        const type = String(play["scoreType"] ?? "");
        const text = String(play["score"] ?? "");

        if (!scoreTypes.has(type)) scoreTypes.set(type, text);

        for (const match of text.matchAll(/\(([^)]*)\)/g)) {
          // Normalise away player names so patterns collapse together.
          const shape = (match[1] ?? "")
            .replace(/[A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+)+/g, "<NAME>")
            .trim();
          if (!parentheticals.has(shape)) parentheticals.set(shape, text);
        }

        if (/block/i.test(text)) blocked.push(`${type} | ${text}`);
      }
    }
  }

  console.log(`Scanned ${games} games across 2025 weeks ${weeks.join(", ")}.\n`);

  console.log("scoreType values:");
  for (const [type, example] of [...scoreTypes].sort()) {
    console.log(`  ${type.padEnd(6)} e.g. ${example.slice(0, 90)}`);
  }

  console.log("\nParenthetical forms (the PAT / conversion slot):");
  for (const [shape, example] of [...parentheticals].sort()) {
    console.log(`  "${shape}"`);
    console.log(`      e.g. ${example.slice(0, 100)}`);
  }

  console.log("\nBlocked kicks:");
  console.log(
    blocked.length > 0
      ? blocked.map((b) => `  ${b}`).join("\n")
      : "  NONE across the scanned games",
  );
}

/**
 * Enumerate what Tank01 actually offers.
 *
 * Endpoint names come from Tank01's own naming convention and guide pages, but
 * whether each exists — and what it returns — is settled by calling it.
 */
const CANDIDATE_ENDPOINTS: readonly { path: string; params?: Record<string, string> }[] = [
  { path: "getNFLTeams" },
  { path: "getNFLTeams", params: { rosters: "true", topPerformers: "true" } },
  { path: "getNFLTeamRoster", params: { teamAbv: "PHI", getStats: "true" } },
  { path: "getNFLPlayerList" },
  { path: "getNFLPlayerInfo", params: { playerName: "jalen_hurts", getStats: "true" } },
  { path: "getNFLGamesForWeek", params: { week: "1", seasonType: "reg", season: "2025" } },
  { path: "getNFLGamesForDate", params: { gameDate: "20250904" } },
  { path: "getNFLGamesForPlayer", params: { playerID: "3918298", season: "2025" } },
  { path: "getNFLTeamSchedule", params: { teamAbv: "PHI", season: "2025" } },
  { path: "getNFLScoresOnly", params: { gameDate: "20250904" } },
  { path: "getNFLBoxScore", params: { gameID: "20250904_DAL@PHI" } },
  { path: "getNFLGameInfo", params: { gameID: "20250904_DAL@PHI" } },
  { path: "getNFLNews", params: { fantasyNews: "true", maxItems: "5" } },
  { path: "getNFLProjections", params: { week: "1", archiveSeason: "2025" } },
  { path: "getNFLDFS", params: { date: "20250904" } },
  { path: "getNFLBettingOdds", params: { gameDate: "20250904" } },
  { path: "getNFLDepthCharts" },
  { path: "getNFLTeamStats", params: { teamAbv: "PHI", season: "2025" } },
  { path: "getNFLADP", params: { adpType: "PPR" } },
  { path: "getNFLChangelog", params: { maxDays: "3" } },
];

function describeShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const first = value[0];
    return (
      `array[${value.length}]` +
      (first !== undefined && depth < 1 ? ` of ${describeShape(first, depth + 1)}` : "")
    );
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object{${keys.slice(0, 14).join(", ")}${keys.length > 14 ? `, +${keys.length - 14}` : ""}}`;
  }
  return typeof value;
}

async function discover(): Promise<void> {
  const client = new Tank01Client({ apiKey: apiKey() });

  for (const { path, params } of CANDIDATE_ENDPOINTS) {
    const label = params ? `${path} (${Object.keys(params).join(",")})` : path;
    try {
      const body = await client.get<unknown>(path, params ?? {});
      console.log(`\nOK   ${label}`);
      console.log(`     ${describeShape(body)}`);

      const sample = Array.isArray(body)
        ? body[0]
        : typeof body === "object" && body !== null
          ? Object.values(body as Record<string, unknown>)[0]
          : body;
      if (sample !== undefined) {
        console.log(`     sample: ${JSON.stringify(sample).slice(0, 320)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\nFAIL ${label}`);
      console.log(`     ${message.slice(0, 160)}`);
    }
  }
}

/** Deep look at the endpoints that matter most to us. */
async function deep(): Promise<void> {
  const client = new Tank01Client({ apiKey: apiKey() });

  console.log("=== ADP (draft rankings) ===");
  const adp = await client.get<Record<string, unknown>>("getNFLADP", { adpType: "PPR" });
  console.log(`  adpDate=${String(adp["adpDate"])}  adpType=${String(adp["adpType"])}`);
  const adpList = adp["adpList"] as Record<string, unknown>[] | undefined;
  if (adpList) {
    console.log(`  ${adpList.length} players`);
    console.log(
      `  fields: ${Object.keys(adpList[0] ?? {})
        .sort()
        .join(", ")}`,
    );
    for (const entry of adpList.slice(0, 5)) console.log(`    ${JSON.stringify(entry)}`);
  }

  console.log("\n=== Projections ===");
  const proj = await client.get<Record<string, unknown>>("getNFLProjections", {
    week: "1",
    archiveSeason: "2025",
  });
  const players = proj["playerProjections"] as Record<string, unknown> | undefined;
  if (players) {
    const [id, first] = Object.entries(players)[0] ?? [];
    console.log(`  ${Object.keys(players).length} players projected`);
    console.log(
      `  fields: ${Object.keys(first as object)
        .sort()
        .join(", ")}`,
    );
    console.log(`  sample (${id}): ${JSON.stringify(first).slice(0, 400)}`);
  }
  const teamDef = proj["teamDefenseProjections"] as Record<string, unknown> | undefined;
  if (teamDef) {
    const first = Object.values(teamDef)[0];
    console.log(
      `  team defense fields: ${Object.keys(first as object)
        .sort()
        .join(", ")}`,
    );
  }

  console.log("\n=== Player game log (season-to-date source) ===");
  const log = await client.get<Record<string, unknown>>("getNFLGamesForPlayer", {
    playerID: "3918298",
    season: "2025",
  });
  console.log(`  ${Object.keys(log).length} games returned for one player in one call`);

  console.log("\n=== Teams with rosters embedded ===");
  const teams = await client.get<Record<string, unknown>[]>("getNFLTeams", {
    rosters: "true",
  });
  const roster = teams[0]?.["Roster"] as Record<string, unknown> | undefined;
  console.log(`  ${teams.length} teams, first has ${Object.keys(roster ?? {}).length} players`);
  console.log(`  byeWeeks: ${JSON.stringify(teams[0]?.["byeWeeks"])}`);

  console.log("\n=== Changelog ===");
  try {
    const changelog = await client.get<unknown>("getNFLChangelog", { maxDays: "3" });
    console.log(`  ${JSON.stringify(changelog).slice(0, 300)}`);
  } catch (error) {
    console.log(`  ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`);
  }
}

const command = process.argv[2] ?? "check";

const run =
  command === "probe"
    ? probe
    : command === "verify"
      ? verify
      : command === "discover"
        ? discover
        : command === "deep"
          ? deep
          : check;

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
