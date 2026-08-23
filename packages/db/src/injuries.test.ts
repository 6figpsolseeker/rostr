import { afterEach, describe, expect, it } from "vitest";
import { NFL } from "@rostr/core";
import type { ProviderInjury, StatsProvider } from "@rostr/stats";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { syncInjuries } from "./injuries.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** Only `listInjuries` is ever called; the rest exist to satisfy the interface. */
function providerReturning(injuries: ProviderInjury[]): StatsProvider {
  return {
    name: "test",
    listPlayers: () => Promise.resolve([]),
    listGames: () => Promise.resolve([]),
    getBoxScore: () => Promise.reject(new Error("not used")),
    listInjuries: () => Promise.resolve(injuries),
    healthCheck: () => Promise.resolve({ ok: true }),
  } as unknown as StatsProvider;
}

interface Fixture {
  client: PGliteClient;
  ids: Map<string, string>;
}

/** Three players: one out, one questionable, one fit. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const [rb] = await db.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
    [sport!.id],
  );

  const ids = new Map<string, string>();
  for (const ref of ["hurt", "iffy", "fit"]) {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, ref, ref, rb!.id],
    );
    ids.set(ref, row!.id);
  }

  await db.query("UPDATE players SET injury_designation = 'Out' WHERE external_ref = 'hurt'");
  await db.query(
    "UPDATE players SET injury_designation = 'Questionable' WHERE external_ref = 'iffy'",
  );

  return { client: db, ids };
}

async function designationOf(fx: Fixture, ref: string): Promise<string | null> {
  const [row] = await fx.client.query<{ injury_designation: string | null }>(
    "SELECT injury_designation FROM players WHERE external_ref = $1",
    [ref],
  );
  return row?.injury_designation ?? null;
}

describe("syncInjuries", () => {
  it("applies a new designation", async () => {
    const fx = await setup();
    await syncInjuries(
      fx.client,
      providerReturning([
        { externalRef: "hurt", designation: "Out", description: "hamstring" },
        { externalRef: "iffy", designation: "Questionable", description: null },
        { externalRef: "fit", designation: "Doubtful", description: "ankle" },
      ]),
      NFL.key,
    );

    expect(await designationOf(fx, "fit")).toBe("Doubtful");
  });

  it("clears a player who no longer appears in the list", async () => {
    const fx = await setup();

    // The half that is easy to miss. `listInjuries` filters to players who
    // *have* a designation, so somebody who recovers stops appearing rather
    // than being returned with a null — and a sync that only applied the rows
    // it received could never clear anything.
    const result = await syncInjuries(
      fx.client,
      providerReturning([{ externalRef: "hurt", designation: "Out", description: null }]),
      NFL.key,
    );

    expect(await designationOf(fx, "iffy")).toBeNull();
    expect(result.cleared).toBe(1);
  });

  it("keeps a stale designation from holding a healthy player on IR", async () => {
    const fx = await setup();

    // Not cosmetic. `isIrEligible` reads this column, so a designation that
    // never clears keeps a recovered player exempt from the roster limit for
    // the rest of the season — the owner's IR rule reopened from the ingest
    // side.
    await syncInjuries(
      fx.client,
      providerReturning([
        { externalRef: "iffy", designation: "Questionable", description: null },
      ]),
      NFL.key,
    );

    expect(await designationOf(fx, "hurt")).toBeNull();
  });

  it("refuses an empty list rather than clearing everybody", async () => {
    const fx = await setup();

    // A provider returning nothing is far likelier to be a bad response than a
    // week in which nobody in the NFL is injured. Applying it would empty every
    // injured reserve in every league at once, and nothing would report it.
    const result = await syncInjuries(fx.client, providerReturning([]), NFL.key);

    expect(result).toEqual({ designated: 0, cleared: 0, providerReturned: 0 });
    expect(await designationOf(fx, "hurt")).toBe("Out");
    expect(await designationOf(fx, "iffy")).toBe("Questionable");
  });

  it("counts only what actually changed", async () => {
    const fx = await setup();

    // Both rows already say this. A run that reported them as updates would
    // make an hourly job look like it was rewriting the league every hour.
    const result = await syncInjuries(
      fx.client,
      providerReturning([
        { externalRef: "hurt", designation: "Out", description: null },
        { externalRef: "iffy", designation: "Questionable", description: null },
      ]),
      NFL.key,
    );

    expect(result.designated).toBe(0);
    expect(result.cleared).toBe(0);
  });

  it("distinguishes a quiet run from an empty provider response", async () => {
    const fx = await setup();

    // Both matter to the cron: any non-null outcome makes `cron:status` read
    // FAILING, so a quiet hour must look different from a broken feed or the
    // job shows red through the whole offseason and takes the real alarm with
    // it.
    const quiet = await syncInjuries(
      fx.client,
      providerReturning([
        { externalRef: "hurt", designation: "Out", description: null },
        { externalRef: "iffy", designation: "Questionable", description: null },
      ]),
      NFL.key,
    );
    const broken = await syncInjuries(fx.client, providerReturning([]), NFL.key);

    expect(quiet.providerReturned).toBe(2);
    expect(broken.providerReturned).toBe(0);
    expect(quiet.designated).toBe(broken.designated);
  });

  it("updates a designation that changed", async () => {
    const fx = await setup();
    const result = await syncInjuries(
      fx.client,
      providerReturning([
        { externalRef: "hurt", designation: "Questionable", description: null },
        { externalRef: "iffy", designation: "Questionable", description: null },
      ]),
      NFL.key,
    );

    expect(await designationOf(fx, "hurt")).toBe("Questionable");
    expect(result.designated).toBe(1);
  });

  it("ignores a player the provider knows and we do not", async () => {
    const fx = await setup();

    // A player list that ran after ours. Nothing to update, and inventing a row
    // would put a player in the database with no position and no club.
    await expect(
      syncInjuries(
        fx.client,
        providerReturning([
          { externalRef: "hurt", designation: "Out", description: null },
          { externalRef: "stranger", designation: "Out", description: null },
        ]),
        NFL.key,
      ),
    ).resolves.toBeDefined();

    const [row] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM players WHERE external_ref = 'stranger'",
    );
    expect(row?.n).toBe(0);
  });
});
