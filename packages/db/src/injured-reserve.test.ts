import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, buildRosterShape, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser } from "./identity.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase, recordStatements } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { activateFromIr, IrError, moveToIr } from "./injured-reserve.js";
import { dropPlayer } from "./waivers.js";

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

  /*
    In season, because that is where these tests live.

    `createLeague` leaves a league `FORMING`, and since #279 a roster move is
    refused outside `IN_SEASON`/`PLAYOFFS` — the draft is how a roster is filled
    before then. Every fixture here describes a league that has drafted and is
    playing; without this line they describe one that cannot transact at all,
    which is a different subject from the one being tested.

    Set directly rather than driven through `startDraft` and a full pick
    sequence, which would make every waiver test a draft test.
  */
  await db.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [league.id]);

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
  it("takes the capacity key before reading the roster — #277", async () => {
    /*
      **This function's `FOR UPDATE` is not enough, and its own comment used to
      say it was.**

      `heldForCapacity(..., { lock: true })` locks the rows already visible to
      its snapshot, which stops two activations racing each other. It cannot stop
      a concurrent `addFreeAgent`, because that one contributes an *insert* — a
      row that does not exist yet is a phantom, and no row lock under READ
      COMMITTED blocks one. Both read the same roster, both find room, and the
      team lands one over.

      Asserted as a statement rather than an outcome for the reason given in
      `roster-capacity.test.ts`: PGlite is one connection, so the contention
      itself is unobservable here.
    */
    const fx = await setup();
    await moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });
    const rec = recordStatements(fx.client);

    await activateFromIr(rec.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
    });

    const begin = rec.statements.findIndex((sql) => sql.trim() === "BEGIN");
    const commit = rec.statements.findIndex((sql) => sql.trim() === "COMMIT");
    const lock = rec.statements.findIndex(
      (sql) => sql === "SELECT pg_advisory_xact_lock(hashtext($1), $2)",
    );
    const rosterRead = rec.statements.findIndex(
      (sql, index) => index > begin && sql.includes("FOR UPDATE OF r"),
    );

    expect(lock, "a key is taken at all").toBeGreaterThan(begin);
    expect(lock).toBeLessThan(commit);
    expect(rosterRead, "the roster is read inside the transaction").toBeGreaterThan(begin);
    expect(rosterRead, "the roster is read after the key").toBeGreaterThan(lock);
    expect(rec.params[lock]?.[0], "the shared namespace").toBe("roster.capacity");
    // Matched on the exact statement rather than a substring, because the name
    // of the shared variant contains the whole of the exclusive one and does
    // not conflict with itself. And on the connection, because handing this the
    // outer client where the transaction handle was meant is invisible in a
    // statement log and releases the lock immediately against a pool.
    expect(rec.connections[lock]).toBe(rec.connections[begin]);
    expect(rec.connections[lock]).not.toBe("outer");

    // The league lock goes after the key, never before it: a transaction
    // waiting on the key must hold nothing, or the key can close a cycle.
    const league = rec.statements.findIndex(
      (sql, index) =>
        index > begin && sql === "SELECT state FROM leagues WHERE id = $1 FOR SHARE",
    );
    expect(league, "the league is locked inside the transaction").toBeGreaterThan(begin);
    expect(league, "after the capacity key").toBeGreaterThan(lock);
  });

  it("holds the league while stashing, and takes no capacity key", async () => {
    /*
      Two assertions in one because the second is the interesting one: a
      placement can only *lower* counted size, so it cannot carry a team over
      its limit and has no business holding the key that exists for writers
      which raise it. A future reader adding one here for symmetry would be
      adding contention for nothing.

      The league lock is needed for the other direction: the waiver run resolves
      against one league-wide snapshot, and a placement committing mid-run makes
      its exemption count wrong by one — failing a legitimate claim.
    */
    const fx = await setup();
    const rec = recordStatements(fx.client);

    await moveToIr(rec.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });

    const begin = rec.statements.findIndex((sql) => sql.trim() === "BEGIN");
    const league = rec.statements.findIndex(
      (sql, index) =>
        index > begin && sql === "SELECT state FROM leagues WHERE id = $1 FOR SHARE",
    );
    const roster = rec.statements.findIndex(
      (sql, index) => index > begin && sql.includes("FOR UPDATE OF r"),
    );

    expect(league, "the league is locked inside the transaction").toBeGreaterThan(begin);
    expect(roster, "the roster is read after it").toBeGreaterThan(league);
    expect(rec.connections[league]).toBe(rec.connections[begin]);
    expect(
      rec.statements.some((sql) => sql === "SELECT pg_advisory_xact_lock(hashtext($1), $2)"),
      "a placement takes no capacity key",
    ).toBe(false);
  });

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

describe("releasing a player who is on injured reserve", () => {
  /*
    **A manager could not drop a player they had put on IR.**

    `0038` asserts `CHECK (NOT on_ir OR released_at IS NULL)` — IR is a state of
    a *rostered* player, so a released row must not still claim one of the
    league's IR slots. Right, and nothing in the product upheld it: four places
    set `released_at` and not one of them cleared `on_ir`. Every drop, every
    free-agent swap-out, every awarded waiver claim's drop, and every executed
    trade of an IR'd player raised a constraint violation instead.

    The test below is the reason it survived. It asserts the constraint fires on
    a hand-written UPDATE and treats that as the feature — which it is — while
    never once asking what the product's own release paths do. The constraint
    was checked against a statement no code in this repo executes, and the four
    that do were never staged.

    The waiver run's site is the worst of them: it throws inside
    `processWaivers`' transaction, so the whole league's cycle rolls back, the
    claims stay PENDING, and `leaguesDueForWaivers` re-selects that league every
    hour, forever. The trade site rolls back a trade the league already approved,
    which `ASSET_GONE` exists to make impossible.
  */
  it("lets a manager drop a player who is on IR", async () => {
    const fx = await setup();
    const playerId = fx.players.get("hurt")!;
    await moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId,
      week: 2,
      now: NOW,
    });

    await expect(
      dropPlayer(fx.client, fx.leagueId, fx.teamId, playerId, NOW),
    ).resolves.toBeTruthy();

    const [row] = await fx.client.query<{ on_ir: boolean; released_at: string | null }>(
      "SELECT on_ir, released_at FROM roster_entries WHERE player_id = $1",
      [playerId],
    );

    // Released, and no longer holding an IR slot. Both halves matter: the row
    // stays for the audit trail, and a count that forgot `released_at` must not
    // exempt somebody who left months ago — which is what the constraint is for.
    expect(row?.released_at).not.toBeNull();
    expect(row?.on_ir).toBe(false);
  });

  it("frees the IR slot for somebody else once the drop lands", async () => {
    // The consequence of leaving `on_ir` set on a released row, had the
    // constraint not refused it outright. Two IR slots, one used and dropped:
    // the allowance has to come back.
    const fx = await setup();
    const dropped = fx.players.get("hurt")!;
    await moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: dropped,
      week: 2,
      now: NOW,
    });
    await dropPlayer(fx.client, fx.leagueId, fx.teamId, dropped, NOW);

    const [held] = await fx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM roster_entries
        WHERE team_id = $1 AND on_ir AND released_at IS NULL`,
      [fx.teamId],
    );
    expect(held?.n).toBe(0);
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

describe("activation may not push a roster past the limit — #272", () => {
  /*
    `activateFromIr` was an unconditional flag flip. A team at the limit could
    bring back a player who was still genuinely hurt and sit at `totalSlots + 1`
    — a second route past the line #250 drew, and the one the function's own
    docstring was accidentally defending.

    That argument is sound for a *recovered* player: he already counts,
    activation costs nothing, and refusing would trap the roster in an illegal
    state. It never covered a player who is still out, where activation is +1
    and leaving him stashed is legal and stable.

    The fixture is why this was reachable at all — every test in this file ran
    on a four-player roster against fourteen slots, ten short of the boundary
    the rule lives on.
  */

  const SHAPE = buildRosterShape(
    (buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules).roster,
    NFL,
  );

  /** Top the team up to `rows` unreleased players, all fit. */
  const fillTo = async (fx: Fixture, rows: number): Promise<void> => {
    const [sport] = await fx.client.query<{ id: string }>(
      "SELECT id FROM sports WHERE key = $1",
      [NFL.key],
    );
    const [rb] = await fx.client.query<{ id: string }>(
      "SELECT id FROM positions WHERE sport_id = $1 AND key = 'RB'",
      [sport!.id],
    );
    const [held] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM roster_entries WHERE team_id = $1 AND released_at IS NULL",
      [fx.teamId],
    );

    for (let i = held!.n; i < rows; i++) {
      const handle = `filler-${i}`;
      const [player] = await fx.client.query<{ id: string }>(
        `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, team_ref)
         VALUES ($1, $2, $3, $4, 'CIN') RETURNING id`,
        [sport!.id, handle, handle, rb!.id],
      );
      await fx.client.query(
        "INSERT INTO roster_entries (team_id, player_id, acquired_via) VALUES ($1, $2, 'DRAFT')",
        [fx.teamId, player!.id],
      );
    }
  };

  /** Counted size, worked out here rather than imported, so the test agrees independently. */
  const countedFor = async (fx: Fixture): Promise<number> => {
    const rows = await fx.client.query<{ on_ir: boolean; designation: string | null }>(
      `SELECT r.on_ir, p.injury_designation AS designation
         FROM roster_entries r JOIN players p ON p.id = r.player_id
        WHERE r.team_id = $1 AND r.released_at IS NULL`,
      [fx.teamId],
    );
    const genuine = rows.filter((row) => row.on_ir && row.designation === "OUT").length;
    return rows.length - Math.min(genuine, SHAPE.irSlots);
  };

  const stash = async (fx: Fixture, handle: string) =>
    moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get(handle)!,
      week: 2,
      now: NOW,
    });

  const activate = async (fx: Fixture, handle: string) =>
    activateFromIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get(handle)!,
    });

  it("refuses to bring back a player who is still out, when the roster is full", async () => {
    const fx = await setup();
    await stash(fx, "hurt");
    // One stashed and exempt, fourteen counting: exactly at the limit.
    await fillTo(fx, SHAPE.totalSlots + 1);

    expect(await countedFor(fx)).toBe(SHAPE.totalSlots);

    await expect(activate(fx, "hurt")).rejects.toMatchObject({
      code: "ROSTER_WOULD_OVERFLOW",
    });

    // Says the number, and says the stash is not a problem to be solved.
    await expect(activate(fx, "hurt")).rejects.toThrow(/15 players and the limit is 14/);
    await expect(activate(fx, "hurt")).rejects.toThrow(/as long as he needs it/);

    // And he is still on injured reserve, which is the legal state he was in.
    const [row] = await fx.client.query<{ on_ir: boolean }>(
      "SELECT on_ir FROM roster_entries WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("hurt")],
    );
    expect(row?.on_ir).toBe(true);
  });

  it("still brings back a recovered player from a roster already over the limit", async () => {
    /*
      The escape route, and the reason the predicate asks what the move costs
      rather than whether the player is exempt. This team is over the limit
      because his designation cleared — refusing here would trap it in the
      illegal state instead of letting the manager resolve it.
    */
    const fx = await setup();
    await stash(fx, "hurt");
    await fillTo(fx, SHAPE.totalSlots + 1);

    await fx.client.query("UPDATE players SET injury_designation = NULL WHERE id = $1", [
      fx.players.get("hurt"),
    ]);

    expect(await countedFor(fx)).toBe(SHAPE.totalSlots + 1);
    await expect(activate(fx, "hurt")).resolves.toBeDefined();
  });

  it("allows it when the roster has room", async () => {
    const fx = await setup();
    await stash(fx, "hurt");
    await fillTo(fx, SHAPE.totalSlots);

    // Thirteen counting, one exempt: bringing him back lands exactly on the
    // limit, which is legal.
    expect(await countedFor(fx)).toBe(SHAPE.totalSlots - 1);
    await expect(activate(fx, "hurt")).resolves.toBeDefined();
    expect(await countedFor(fx)).toBe(SHAPE.totalSlots);
  });

  it("allows the one that costs nothing when more are hurt than there are slots", async () => {
    /*
      The case a predicate keyed on "is this player exempt" gets wrong, and the
      reason this one is keyed on the delta instead.

      `irExemptCount` caps exemptions at `irSlots` **by count, not identity** —
      three stashed players against two slots means two exemptions and no way
      to say which two. So the first activation costs nothing: one of the three
      was already counting. Only the second one raises the count.

      A predicate asking `onIr && isIrEligible` answers yes for all three and
      refuses all three, every one wrongly.
    */
    const fx = await setup();
    await stash(fx, "hurt");
    await stash(fx, "alsohurt");

    // A third stash needs a slot to free first, which is how a real roster
    // reaches this state: a designation lifts, the slot frees, it comes back.
    await fx.client.query(
      "UPDATE players SET injury_designation = 'QUESTIONABLE' WHERE id = $1",
      [fx.players.get("hurt")],
    );
    await stash(fx, "third");
    await fx.client.query("UPDATE players SET injury_designation = 'OUT' WHERE id = $1", [
      fx.players.get("hurt"),
    ]);

    await fillTo(fx, SHAPE.totalSlots + 2);

    // Three stashed, two slots: fourteen counting, at the limit.
    expect(await countedFor(fx)).toBe(SHAPE.totalSlots);

    // Free — one of the three was already counting.
    await expect(activate(fx, "hurt")).resolves.toBeDefined();
    expect(await countedFor(fx)).toBe(SHAPE.totalSlots);

    // This one genuinely costs a slot.
    await expect(activate(fx, "alsohurt")).rejects.toMatchObject({
      code: "ROSTER_WOULD_OVERFLOW",
    });
  });
});

describe("injured reserve and the league's state — #311", () => {
  /*
    Every other member-facing roster path asks whether the league is playing
    before it writes. These two never did, so a player could be parked or
    brought back while a league was forming, drafting, settled or dissolved.

    **Placement and activation get different answers during a draft, and that is
    the ruling rather than an oversight** (owner, 2026-09-18):

    - Parking is refused. The draft decides roster legality in memory against
      its own picks and never reads `roster_entries`, so an IR flag set mid-draft
      is invisible to it. Parking *lowers* a team's counted size, which is the
      direction that lets the engine believe a team has room it does not — and a
      pick can then land it over the limit its members signed.
    - Bringing a player back is allowed. Not because it lowers anything — it
      raises counted size — but because activation is the only way a player
      leaves that slot without being dropped, and nothing in this design ever
      forces a player off a roster. Refusing it is how a recoverable state
      becomes a permanent one.
  */

  const setState = (fx: Fixture, state: string) =>
    fx.client.query("UPDATE leagues SET state = $2 WHERE id = $1", [fx.leagueId, state]);

  /** Park the hurt player while the league is still playing. */
  const park = (fx: Fixture) =>
    moveToIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });

  const activate = (fx: Fixture) =>
    activateFromIr(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
    });

  it("refuses to park a player while the draft is running", async () => {
    const fx = await setup();
    await setState(fx, "DRAFTING");

    await expect(park(fx)).rejects.toMatchObject({ code: "LEAGUE_NOT_IN_SEASON" });
  });

  it("still lets a parked player be brought back while the draft is running", async () => {
    /*
      The asymmetry, and the half that would be easy to lose to a tidy-up that
      gave both calls the same gate.

      **Unreachable in production today, and the state is forced here to say so
      rather than to simulate something that happens.** League state only moves
      forward, `startDraft` refuses anything but `FORMING`, and `moveToIr` — the
      only writer of `on_ir = true` — now needs `IN_SEASON` or `PLAYOFFS`. So no
      league can be `DRAFTING` with anybody parked, and this call would answer
      `NOT_ON_IR` long before the gate mattered.

      The carve-out stays because it is the correct answer to the question, not
      because anything asks it yet: the cost of allowing it is nothing, while
      refusing it is what would trap a team if the state machine ever gained a
      backwards edge or a league were ever redrafted. A gate that is wrong only
      in a state nobody can reach is still wrong, and it is cheaper to be right
      now than to rediscover why later.
    */
    const fx = await setup();
    await park(fx);
    await setState(fx, "DRAFTING");

    await activate(fx);

    const [row] = await fx.client.query<{ on_ir: boolean }>(
      "SELECT on_ir FROM roster_entries WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("hurt")],
    );
    expect(row?.on_ir).toBe(false);
  });

  it("refuses both before the league has drafted", async () => {
    const fx = await setup();
    await park(fx);
    await setState(fx, "FORMING");

    await expect(park(fx)).rejects.toMatchObject({ code: "LEAGUE_NOT_IN_SEASON" });
    await expect(activate(fx)).rejects.toMatchObject({ code: "LEAGUE_NOT_IN_SEASON" });
  });

  it("refuses both once the season is over", async () => {
    // Rosters are final. Both directions, because neither means anything now.
    const fx = await setup();
    await park(fx);

    for (const state of ["SETTLED", "DISSOLVED"]) {
      await setState(fx, state);
      await expect(park(fx), state).rejects.toMatchObject({ code: "LEAGUE_NOT_IN_SEASON" });
      await expect(activate(fx), state).rejects.toMatchObject({ code: "LEAGUE_NOT_IN_SEASON" });
    }
  });

  it("allows both through the playoffs", async () => {
    // The weeks an injury matters most. A gate that stopped at `IN_SEASON`
    // would shut injured reserve exactly when a team most needs the slot.
    const fx = await setup();
    await setState(fx, "PLAYOFFS");

    await park(fx);
    await activate(fx);

    const [row] = await fx.client.query<{ on_ir: boolean }>(
      "SELECT on_ir FROM roster_entries WHERE team_id = $1 AND player_id = $2",
      [fx.teamId, fx.players.get("hurt")],
    );
    expect(row?.on_ir).toBe(false);
  });

  it("reads the state under the lock, not before the transaction", async () => {
    /*
      `recordPick` sets `IN_SEASON` in the transaction that commits the final
      pick, and this lock conflicts with that write — so the read either sees
      `DRAFTING` and refuses, or sees `IN_SEASON` after the last pick has landed.
      There is no window between them. Read on the bare client instead and the
      answer is about a moment that has already passed, which `waivers.ts`
      records having shipped once.
    */
    const fx = await setup();
    const rec = recordStatements(fx.client);

    await moveToIr(rec.client, {
      leagueId: fx.leagueId,
      teamId: fx.teamId,
      playerId: fx.players.get("hurt")!,
      week: 2,
      now: NOW,
    });

    const begin = rec.statements.findIndex((sql) => sql.trim() === "BEGIN");
    const stateRead = rec.statements.findIndex(
      (sql, index) =>
        index > begin && sql === "SELECT state FROM leagues WHERE id = $1 FOR SHARE",
    );

    expect(stateRead, "the state is read inside the transaction").toBeGreaterThan(begin);
    expect(rec.connections[stateRead]).toBe(rec.connections[begin]);
  });
});
