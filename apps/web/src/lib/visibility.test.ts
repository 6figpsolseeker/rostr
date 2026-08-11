import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { addTestTeam, createTestDatabase } from "@rostr/db/testing";
import type { PGliteClient } from "@rostr/db/testing";
import { createLeague, createUser } from "@rostr/db";

/**
 * `visibility` is a frozen, member-signed rule, and until this it was enforced
 * nowhere — written to the `leagues` row at creation and never read back.
 *
 * These drive `leagueReadAccess` against a real database with the session
 * mocked, because the question it answers is entirely "who is asking, and what
 * did this league's members sign". The routes and pages are thin over it.
 */

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

let db: PGliteClient | undefined;
let viewer: { id: string } | null = null;

vi.mock("./db", () => ({ db: () => db! }));
vi.mock("./session", () => ({ currentUser: () => Promise.resolve(viewer) }));

const { leagueReadAccess } = await import("./visibility.js");

afterEach(async () => {
  await db?.close();
  db = undefined;
  viewer = null;
});

async function league(visibility: "PRIVATE" | "PUBLIC"): Promise<string> {
  db = await createTestDatabase();
  const { seedSport } = await import("@rostr/db");
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({
    seasonYear: 2026,
    draft: DRAFT,
    league: { visibility },
  }) as LeagueRules;

  const created = await createLeague(db, NFL, {
    name: "Test League",
    commissionerId: commissioner.id,
    rules,
  });
  return created.id;
}

describe("leagueReadAccess", () => {
  it("lets anyone read a public league", async () => {
    // Being findable is what public means, and `/api/leagues` already publishes
    // these ids.
    const id = await league("PUBLIC");
    expect(await leagueReadAccess(id)).toEqual({ ok: true, isMember: false });
  });

  it("refuses a private league to a signed-out stranger", async () => {
    const id = await league("PRIVATE");
    expect(await leagueReadAccess(id)).toEqual({ ok: false, reason: "PRIVATE" });
  });

  it("refuses a private league to a signed-in non-member", async () => {
    // Having an account is not membership. The link is not the capability.
    const id = await league("PRIVATE");
    const stranger = await createUser(db!, "stranger@example.com", "Stranger");
    viewer = { id: stranger.id };

    expect(await leagueReadAccess(id)).toEqual({ ok: false, reason: "PRIVATE" });
  });

  it("lets a member read their own private league", async () => {
    const id = await league("PRIVATE");
    const member = await addTestTeam(db!, id, "Member");
    viewer = { id: member.userId };

    expect(await leagueReadAccess(id)).toEqual({ ok: true, isMember: true });
  });

  it("reports a league that does not exist as not found, not as private", async () => {
    // Distinct reasons because the caller answers them the same way — a 404 —
    // and would otherwise have no way to tell a typo'd id from a refusal.
    await league("PUBLIC");
    expect(await leagueReadAccess("00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
  });

  it("reads the frozen rules, not the denormalised column", async () => {
    // The column is a copy written at creation. Members signed the document, so
    // the document decides — and a future bug in that write must not be able to
    // quietly open a private league.
    const id = await league("PRIVATE");
    await db!.query("UPDATE leagues SET visibility = 'PUBLIC' WHERE id = $1", [id]);

    expect(await leagueReadAccess(id)).toEqual({ ok: false, reason: "PRIVATE" });
  });
});
