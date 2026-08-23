import { afterEach, describe, expect, it } from "vitest";
import { NFL } from "@rostr/core";
import { compareSources, ingestSecondSource, SECOND_STAT_SOURCE } from "./second-source.js";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const SEASON = 2026;
const WEEK = 1;
const PRIMARY = "tank01";

interface Fixture {
  client: PGliteClient;
  /** A receiver, joined to Sleeper by a numeric id. */
  receiver: string;
  /** Washington's D/ST, joined by a team abbreviation. */
  washington: string;
  statKeys: Map<string, string>;
}

async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const positions = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM positions WHERE sport_id = $1",
        [sport!.id],
      )
    ).map((row) => [row.key, row.id]),
  );
  const statKeys = new Map(
    (
      await db.query<{ id: string; key: string }>(
        "SELECT id, key FROM stat_keys WHERE sport_id = $1",
        [sport!.id],
      )
    ).map((row) => [row.key, row.id]),
  );

  const [receiver] = await db.query<{ id: string }>(
    `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref,
                          second_source_ref)
     VALUES ($1, '4262921', 'A. Receiver', $2, 'MIN', '5045')
     RETURNING id`,
    [sport!.id, positions.get("WR")!],
  );

  // Our abbreviation is `WSH`; Sleeper keys the unit under `WAS`, so the stored
  // join key is Sleeper's — which is the adapter's job and the thing that was
  // wrong until 2026-08-22.
  const [washington] = await db.query<{ id: string }>(
    `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref,
                          second_source_ref)
     VALUES ($1, 'DST_WSH', 'Washington Commanders', $2, 'WSH', 'WAS')
     RETURNING id`,
    [sport!.id, positions.get("DEF")!],
  );

  return { client: db, receiver: receiver!.id, washington: washington!.id, statKeys };
}

/** A primary-source row, so there is something to disagree with. */
async function primary(
  fx: Fixture,
  playerId: string,
  key: string,
  value: number,
): Promise<void> {
  await fx.client.query(
    `INSERT INTO stat_lines (player_id, season, week, stat_key_id, value, revision, source)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [playerId, SEASON, WEEK, fx.statKeys.get(key)!, value, PRIMARY],
  );
}

const storedValue = async (
  fx: Fixture,
  playerId: string,
  key: string,
): Promise<number | null> => {
  const [row] = await fx.client.query<{ value: number }>(
    `SELECT value FROM stat_lines_current
      WHERE player_id = $1 AND season = $2 AND week = $3 AND stat_key_id = $4 AND source = $5`,
    [playerId, SEASON, WEEK, fx.statKeys.get(key)!, SECOND_STAT_SOURCE],
  );
  return row ? Number(row.value) : null;
};

describe("ingestSecondSource", () => {
  it("writes a player's week, joined by the provider's own id", async () => {
    const fx = await setup();

    const result = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 7, rec_yd: 92, rec_td: 1 } },
    });

    expect(result.joined).toBe(1);
    expect(result.unjoined).toBe(0);
    expect(result.written).toBeGreaterThan(0);
    expect(await storedValue(fx, fx.receiver, "rec")).toBe(7);
    expect(await storedValue(fx, fx.receiver, "rec_yd")).toBe(92);
  });

  it("joins Washington's defence, which is the one team whose key differs", async () => {
    // We carry `WSH` and Sleeper keys the unit `WAS`. Until the adapter applied
    // the alias this unit never joined, and the failure was the quiet kind: the
    // second source silently covered 31 of 32 defences, which looks exactly like
    // two feeds that agree.
    const fx = await setup();

    const result = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      // Sleeper's field is `sack`; `def_sack` is *our* key, and passing it
      // would translate to nothing. Checked against a live week rather than
      // assumed from the name.
      stats: { WAS: { pts_allow: 17, sack: 3 } },
    });

    expect(result.joined).toBe(1);
    expect(await storedValue(fx, fx.washington, "def_sack")).toBe(3);
  });

  it("counts a player it cannot join rather than dropping them", async () => {
    // A join that quietly covers fewer players each week is indistinguishable
    // from two sources that increasingly agree.
    const fx = await setup();

    const result = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 7 }, "999999": { rec: 3 } },
    });

    expect(result.joined).toBe(1);
    expect(result.unjoined).toBe(1);
  });

  it("re-running an unchanged week writes nothing", async () => {
    // Revision numbers stay a record of real corrections rather than of how
    // many times a job ran.
    const fx = await setup();
    const stats = { "5045": { rec: 7, rec_yd: 92 } };

    const first = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats,
    });
    const second = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats,
    });

    expect(first.written).toBeGreaterThan(0);
    expect(second.written).toBe(0);
  });

  it("a corrected value becomes a new revision, and the view shows it", async () => {
    const fx = await setup();

    await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 7 } },
    });
    await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 9 } },
    });

    expect(await storedValue(fx, fx.receiver, "rec")).toBe(9);
  });

  it("never touches the primary source's rows", async () => {
    // Nothing scores from the second source, and this is what makes that true
    // rather than merely intended.
    const fx = await setup();
    await primary(fx, fx.receiver, "rec", 7);

    await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 9 } },
    });

    const [row] = await fx.client.query<{ value: number }>(
      `SELECT value FROM stat_lines_current
        WHERE player_id = $1 AND stat_key_id = $2 AND source = $3`,
      [fx.receiver, fx.statKeys.get("rec")!, PRIMARY],
    );
    expect(Number(row?.value)).toBe(7);
  });
});

describe("compareSources", () => {
  it("reports a stat the two disagree on", async () => {
    const fx = await setup();
    await primary(fx, fx.receiver, "rec", 7);

    const result = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 9 } },
    });

    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0]).toMatchObject({
      statKey: "rec",
      primary: 7,
      second: 9,
    });
  });

  it("says nothing when they agree", async () => {
    const fx = await setup();
    await primary(fx, fx.receiver, "rec", 7);

    const result = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 7 } },
    });

    expect(result.disagreements).toEqual([]);
  });

  it("a stat missing from one side that week is not a disagreement", async () => {
    // Absence is not zero. The primary saw a reception; the second source's
    // entry for this player carries no receiving fields at all, which is a gap
    // in coverage rather than a contradiction.
    //
    // There is no stat key only one provider can produce — measured on
    // 2026-08-22, the Sleeper translation emits all 26 — so the per-player,
    // per-week gap is the only shape this case really takes.
    const fx = await setup();
    await primary(fx, fx.receiver, "rec", 7);

    const result = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rush_yd: 12 } },
    });

    expect(result.disagreements).toEqual([]);
  });
  it("compares per stat, not per total", async () => {
    // Two divergences that cancel in a total are two divergences. The corpus
    // already paid for this: gating on totals hid `def_pts_allowed` gaps of six
    // and two points because both readings fell in the same scoring tier.
    const fx = await setup();
    await primary(fx, fx.receiver, "rec", 7);
    await primary(fx, fx.receiver, "rec_yd", 92);

    const result = await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK,
      stats: { "5045": { rec: 9, rec_yd: 90 } },
    });

    expect(result.disagreements.map((d) => d.statKey).sort()).toEqual(["rec", "rec_yd"]);
  });

  it("does not compare across weeks", async () => {
    const fx = await setup();
    await primary(fx, fx.receiver, "rec", 7);

    await ingestSecondSource(fx.client, {
      sportKey: NFL.key,
      season: SEASON,
      week: WEEK + 1,
      stats: { "5045": { rec: 9 } },
    });

    expect(await compareSources(fx.client, NFL.key, SEASON, WEEK, PRIMARY)).toEqual([]);
  });
});
