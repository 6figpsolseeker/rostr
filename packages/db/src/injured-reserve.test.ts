import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { activateFromIr, IrError, moveToIr } from "./injured-reserve.js";

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

const NOW = new Date("2026-09-16T12:00:00Z");

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  teamId: string;
  players: Map<string, string>;
}

/** One team holding four players: three carrying an OUT designation, one fit. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const league = await createLeague(db, NFL, {
    name: "IR League",
    commissionerId: commissioner.id,
    rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
  });

  const { teamId } = await addTestTeam(db, league.id, "The Stashers");

  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    NFL.key,
  ]);
  const [rb] = await db.query<{ id: string }>(
    "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
    [sport!.id],
  );

  const players = new Map<string, string>();
  for (const handle of ["hurt", "fit", "alsohurt", "third"]) {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
       VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
      [sport!.id, handle, handle, rb!.id],
    );
    players.set(handle, row!.id);
    await db.query(
      "INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')",
      [teamId, row!.id],
    );
  }

  await db.query("UPDATE players SET injury_designation = 'OUT' WHERE id = ANY($1)", [
    [players.get("hurt"), players.get("alsohurt"), players.get("third")],
  ]);

  return { client: db, leagueId: league.id, teamId, players };
}

describe("moveToIr", () => {
  it("stashes an injured player without releasing him", async () => {
    const fx = await setup();
    await moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });

    // Still owned. IR is where a player sits, not whether he is on the roster —
    // nobody else may add him and every ownership check still sees him.
    const [row] = await fx.client.query<{ on_ir: boolean; released_at: string | null }>(
      "SELECT on_ir, released_at FROM roster_entries WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("hurt")],
    );
    expect(row?.on_ir).toBe(true);
    expect(row?.released_at).toBeNull();
  });

  it("refuses a healthy player", async () => {
    const fx = await setup();
    // The owner's rule, at the door: a player on IR must actually be injured.
    await expect(
      moveToIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get("fit")!,
        week: 2,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOT_INJURED" });
  });

  it("refuses once every slot is genuinely occupied", async () => {
    const fx = await setup();
    for (const handle of ["hurt", "alsohurt"]) {
      await moveToIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get(handle)!,
        week: 2,
        now: NOW,
      });
    }

    // Two slots in the default rules, both taken by genuinely injured players.
    await expect(
      moveToIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get("third")!,
        week: 2,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "IR_FULL" });
  });

  it("frees a slot when its occupant recovers", async () => {
    const fx = await setup();
    for (const handle of ["hurt", "alsohurt"]) {
      await moveToIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get(handle)!,
        week: 2,
        now: NOW,
      });
    }

    // He is on IR and no longer entitled to be, so he holds the slot against
    // nobody. The exemption being conditional frees the room as well as
    // removing the benefit.
    await fx.client.query("UPDATE players SET injury_designation = NULL WHERE id = $1", [
      fx.players.get("hurt"),
    ]);

    await expect(
      moveToIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get("third")!,
        week: 2,
        now: NOW,
      }),
    ).resolves.toMatchObject({ playerId: fx.players.get("third") });
  });

  it("refuses somebody who is not on the roster", async () => {
    const fx = await setup();
    await fx.client.query("DELETE FROM roster_entries WHERE player_id = $1", [
      fx.players.get("third"),
    ]);

    await expect(
      moveToIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get("third")!,
        week: 2,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOT_ON_ROSTER" });
  });
});

describe("activateFromIr", () => {
  it("brings a player back", async () => {
    const fx = await setup();
    await moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });

    await activateFromIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
    });

    const [row] = await fx.client.query<{ on_ir: boolean }>(
      "SELECT on_ir FROM roster_entries WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("hurt")],
    );
    expect(row?.on_ir).toBe(false);
  });

  it("activates a recovered player even though the roster is over its counted limit", async () => {
    const fx = await setup();
    await moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });
    await fx.client.query("UPDATE players SET injury_designation = NULL WHERE id = $1", [
      fx.players.get("hurt"),
    ]);

    // The asymmetry that keeps continuous enforcement safe. Activation is the
    // fix for an over-full roster, so refusing it for capacity would trap the
    // team in the state it is trying to leave.
    await expect(
      activateFromIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get("hurt")!,
      }),
    ).resolves.toMatchObject({ playerId: fx.players.get("hurt") });
  });

  it("refuses a player who is not on IR", async () => {
    const fx = await setup();
    await expect(
      activateFromIr(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.teamId,
        playerId: fx.players.get("fit")!,
      }),
    ).rejects.toMatchObject({ code: "NOT_ON_IR" });
  });
});

describe("the check constraint", () => {
  it("will not let a released player stay on injured reserve", async () => {
    const fx = await setup();
    await moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });

    // `0038`'s constraint. Without it a drop leaves `on_ir` true on a
    // historical row, and any count that forgot `released_at` would exempt
    // somebody who left months ago.
    await expect(
      fx.client.query("UPDATE roster_entries SET released_at = now() WHERE player_id = $1", [
        fx.players.get("hurt"),
      ]),
    ).rejects.toBeTruthy();
  });
});

describe("IrError", () => {
  it("carries a code a route can map to a status", () => {
    expect(new IrError("nope", "NOT_INJURED").code).toBe("NOT_INJURED");
  });
});
