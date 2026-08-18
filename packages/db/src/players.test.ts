import { afterEach, describe, expect, it } from "vitest";
import { NFL } from "@rostr/core";
import { loadPlayerProfile } from "./players.js";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

const SEASON = 2026;

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

interface Fixture {
  client: PGliteClient;
  sportId: string;
  playerId: string;
  statKeys: Map<string, string>;
}

/** One receiver on PHI, with a bye and a week-1 fixture against DAL. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const [position] = await db.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'WR'",
    [sport!.id],
  );

  const [player] = await db.query<{ id: string }>(
    `INSERT INTO players
       (sport_id, external_ref, full_name, primary_position_id, team_ref,
        image_url, jersey_number, height_inches, weight_pounds, birth_date, college,
        draft_year, draft_round, draft_pick,
        injury_designation, injury_description, injury_return_date)
     VALUES ($1, 'p1', 'A. Receiver', $2, 'PHI',
             'https://example.test/p1.png', '18', 74, 205, '1999-04-02', 'Alabama',
             2021, 1, 10, 'Questionable', 'Hamstring', '2026-10-04')
     RETURNING id`,
    [sport!.id, position!.id],
  );

  await db.query(
    `INSERT INTO player_seasons (player_id, season, team_ref, bye_week) VALUES ($1, $2, 'PHI', 9)`,
    [player!.id, SEASON],
  );

  await db.query(
    `INSERT INTO games (sport_id, external_ref, season, week, home_team_ref, away_team_ref,
                        kickoff_at, status)
     VALUES ($1, 'g1', $2, 1, 'DAL', 'PHI', now() - interval '4 hours', 'FINAL')`,
    [sport!.id, SEASON],
  );

  const statKeys = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM stat_keys WHERE sport_id = $1",
        [sport!.id],
      )
    ).map((row) => [row.key, row.id]),
  );

  return { client: db, sportId: sport!.id, playerId: player!.id, statKeys };
}

async function writeStat(
  fx: Fixture,
  week: number,
  key: string,
  value: number,
  options: { source?: string; revision?: number } = {},
): Promise<void> {
  await fx.client.query(
    `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, revision, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      fx.playerId,
      SEASON,
      week,
      fx.statKeys.get(key)!,
      value,
      options.revision ?? 0,
      options.source ?? "tank01",
    ],
  );
}

describe("loadPlayerProfile", () => {
  it("returns the biography as stored", async () => {
    const fx = await setup();
    const profile = await loadPlayerProfile(fx.client, fx.playerId, SEASON);

    expect(profile).toMatchObject({
      fullName: "A. Receiver",
      teamRef: "PHI",
      imageUrl: "https://example.test/p1.png",
      byeWeek: 9,
      bio: {
        jerseyNumber: "18",
        heightInches: 74,
        weightPounds: 205,
        birthDate: "1999-04-02",
        college: "Alabama",
        draft: { year: 2021, round: 1, pick: 10 },
      },
      injury: {
        designation: "Questionable",
        description: "Hamstring",
        returnDate: "2026-10-04",
      },
    });
  });

  it("gives back a calendar day rather than a timestamp", async () => {
    // The driver hands a `date` column back as a `Date` here and as a string in
    // production. Routed through a timezone instead of trimmed, a birthday just
    // after midnight UTC renders as the day before for every reader west of it.
    const fx = await setup();
    const profile = await loadPlayerProfile(fx.client, fx.playerId, SEASON);
    expect(profile?.bio.birthDate).toBe("1999-04-02");
  });

  it("answers null for a player who does not exist", async () => {
    // The id arrives from a URL. A stale link deserves a 404, not a 500.
    const fx = await setup();
    const missing = await loadPlayerProfile(
      fx.client,
      "00000000-0000-0000-0000-000000000000",
      SEASON,
    );
    expect(missing).toBeNull();
  });

  it("groups stat lines by week, ascending, and hands them back raw", async () => {
    // Raw, because two leagues score the same line differently. A points value
    // computed here would be one league's answer shown to both.
    const fx = await setup();
    await writeStat(fx, 2, "rec", 5);
    await writeStat(fx, 1, "rec", 7);
    await writeStat(fx, 1, "rec_yd", 92);

    const profile = await loadPlayerProfile(fx.client, fx.playerId, SEASON);

    expect(profile?.weeks.map((week) => week.week)).toEqual([1, 2]);
    expect(profile?.weeks[0]?.stats).toEqual(
      expect.arrayContaining([
        { statKey: "rec", value: 7 },
        { statKey: "rec_yd", value: 92 },
      ]),
    );
  });

  it("names the opponent, and marks an away game", async () => {
    const fx = await setup();
    await writeStat(fx, 1, "rec", 7);

    const profile = await loadPlayerProfile(fx.client, fx.playerId, SEASON);
    // PHI played at DAL, so the row reads "@DAL" rather than "DAL".
    expect(profile?.weeks[0]).toMatchObject({ opponent: "@DAL", gameStatus: "FINAL" });
  });

  it("uses the current revision and not the one it superseded", async () => {
    const fx = await setup();
    await writeStat(fx, 1, "rec", 7, { revision: 0 });
    await writeStat(fx, 1, "rec", 9, { revision: 1 });

    const profile = await loadPlayerProfile(fx.client, fx.playerId, SEASON);
    expect(profile?.weeks[0]?.stats).toEqual([{ statKey: "rec", value: 9 }]);
  });

  it("reads one source, so two providers do not double a week", async () => {
    // `stat_lines_current` keys on source as well as revision, so a second
    // provider covering the same player is a second row. Unfiltered, the card
    // would show him catching every pass twice — and only for the players both
    // providers cover, so the distortion would be uneven rather than obvious.
    const fx = await setup();
    await writeStat(fx, 1, "rec", 7, { source: "tank01" });
    await writeStat(fx, 1, "rec", 7, { source: "sportsdataio" });

    const profile = await loadPlayerProfile(fx.client, fx.playerId, SEASON);
    expect(profile?.weeks[0]?.stats).toEqual([{ statKey: "rec", value: 7 }]);
  });

  it("still reports a week whose game is missing from the schedule", async () => {
    // A stat line with no game row is a hole in the schedule sync, not a reason
    // to drop the week — the points were still scored and still count.
    const fx = await setup();
    await writeStat(fx, 5, "rec", 4);

    const profile = await loadPlayerProfile(fx.client, fx.playerId, SEASON);
    expect(profile?.weeks[0]).toMatchObject({ week: 5, opponent: null, gameStatus: null });
  });

  it("reports a player with no profile data at all rather than refusing him", async () => {
    // Every profile column is nullable, and a pool synced before migration 0032
    // has all of them null. The card falls back to initials; it must not 404.
    const fx = await setup();
    const [bare] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id)
       SELECT $1, 'p2', 'B. Nobody', primary_position_id FROM players WHERE id = $2
       RETURNING id`,
      [fx.sportId, fx.playerId],
    );

    const profile = await loadPlayerProfile(fx.client, bare!.id, SEASON);
    expect(profile).toMatchObject({
      fullName: "B. Nobody",
      imageUrl: null,
      injury: null,
      bio: { college: null, draft: null },
      weeks: [],
    });
  });
});
