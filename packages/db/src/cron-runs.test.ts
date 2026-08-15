import { afterEach, describe, expect, it, vi } from "vitest";
import { listCronRuns, recordCronRun } from "./cron-runs.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import type { SqlClient } from "./client.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
  vi.restoreAllMocks();
});

describe("recordCronRun", () => {
  it("records a job that ran cleanly", async () => {
    db = await createTestDatabase();
    await recordCronRun(db, "waivers");

    const [run] = await listCronRuns(db);
    expect(run?.name).toBe("waivers");
    expect(run?.lastOutcome).toBeNull();
    expect(run?.lastRanAt).toBeInstanceOf(Date);
  });

  it("keeps one row per job rather than a history", async () => {
    // `draft-tick` runs every minute. A row per run would be 1,440 a day and a
    // retention question, to answer something that only concerns the last run.
    db = await createTestDatabase();
    await recordCronRun(db, "draft-tick");
    await recordCronRun(db, "draft-tick");
    await recordCronRun(db, "draft-tick");

    expect(await listCronRuns(db)).toHaveLength(1);
  });

  it("records why a run did not go cleanly", async () => {
    db = await createTestDatabase();
    await recordCronRun(db, "score-week", "2 of 5 leagues had a problem");

    const [run] = await listCronRuns(db);
    expect(run?.lastOutcome).toBe("2 of 5 leagues had a problem");
  });

  it("clears the outcome when a later run succeeds", async () => {
    // Otherwise a job that failed once looks broken forever, and the signal
    // stops meaning anything.
    db = await createTestDatabase();
    await recordCronRun(db, "trades", "1 of 3 leagues failed");
    await recordCronRun(db, "trades");

    expect((await listCronRuns(db))[0]?.lastOutcome).toBeNull();
  });

  /**
   * The property the whole design rests on.
   *
   * This is bookkeeping about work, not the work. A route whose real job
   * succeeded must not report failure because the record of it failed — that
   * would make observability a new way for the crons to break, which is the
   * opposite of why it exists.
   */
  it("never throws, whatever the database does", async () => {
    const broken: SqlClient = {
      query: () => Promise.reject(new Error("connection terminated")),
      exec: () => Promise.reject(new Error("connection terminated")),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(recordCronRun(broken, "waivers")).resolves.toBeUndefined();

    // Swallowed, but not silently — a heartbeat that stops working without
    // saying so leaves exactly the blind spot it was added to remove.
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]?.[0]).toContain("waivers");
  });

  it("distinguishes jobs from each other", async () => {
    db = await createTestDatabase();
    await recordCronRun(db, "waivers");
    await recordCronRun(db, "trades", "boom");

    const byName = new Map((await listCronRuns(db)).map((run) => [run.name, run.lastOutcome]));
    expect(byName.get("waivers")).toBeNull();
    expect(byName.get("trades")).toBe("boom");
  });

  it("lists a job that has never run as absent rather than stale", async () => {
    // A missing row is as interesting as an old one — it is what "this job has
    // never fired since the table existed" looks like — so the read is
    // deliberately unfiltered and the caller compares against its own list.
    db = await createTestDatabase();
    await recordCronRun(db, "waivers");

    const names = (await listCronRuns(db)).map((run) => run.name);
    expect(names).toEqual(["waivers"]);
    expect(names).not.toContain("score-week");
  });
});
