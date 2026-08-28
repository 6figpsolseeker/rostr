import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL, teamOnClock } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createDraftRecord } from "./draft.js";
import { createUser } from "./identity.js";
import { createLeague } from "./leagues.js";
import { NOTIFICATION_URGENCY, notificationsForUser } from "./notifications.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const NOW = new Date("2026-09-01T12:00:00Z");

/** Comfortably beyond `DRAFT_SOON_MS`, so nothing fires unless a test wants it. */
const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: Math.floor(new Date("2026-09-20T00:00:00Z").getTime() / 1000),
};

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  seats: { teamId: string; userId: string }[];
}

async function fixture(scheduledAt: number = DRAFT.scheduledAt): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.test", "Commish");
  const league = await createLeague(db, NFL, {
    name: "Sunday Scaries",
    commissionerId: commissioner.id,
    rules: buildNflPprRules({
      seasonYear: 2026,
      draft: { ...DRAFT, scheduledAt },
    }) as LeagueRules,
  });

  const seats: { teamId: string; userId: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const seat = await addTestTeam(db, league.id, `Team ${i + 1}`);
    seats.push(seat);

    await db.query(
      `INSERT INTO wallets (user_id, address, verified_at)
       VALUES ($1::uuid, 'w-' || $1::text, now())`,
      [seat.userId],
    );
    await db.query(
      `INSERT INTO league_memberships (league_id, user_id, team_id, wallet_id, rules_hash, signature)
       SELECT $1::uuid, $2::uuid, $3::uuid, w.id, repeat('a', 64), 'sig'
         FROM wallets w WHERE w.user_id = $2::uuid LIMIT 1`,
      [league.id, seat.userId, seat.teamId],
    );
    await db.query("UPDATE teams SET draft_position = $2 WHERE id = $1", [seat.teamId, i + 1]);
  }

  await createDraftRecord(db, {
    leagueId: league.id,
    rounds: 15,
    pickSeconds: DRAFT.pickSeconds,
    scheduledAt: new Date(scheduledAt * 1000),
  });

  return { client: db, leagueId: league.id, seats };
}

/** Start the draft with `picks` already made. */
async function draftInProgress(fx: Fixture, picks: number): Promise<void> {
  const [draft] = await fx.client.query<{ id: string }>(
    "SELECT id FROM drafts WHERE league_id = $1",
    [fx.leagueId],
  );
  await fx.client.query(
    "UPDATE drafts SET status = 'IN_PROGRESS', clock_started_at = $2 WHERE id = $1",
    [draft!.id, NOW.toISOString()],
  );

  const order = fx.seats.map((seat) => seat.teamId);
  for (let i = 0; i < picks; i++) {
    const [player] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id)
       SELECT s.id, $1, $2, p.id FROM sports s
         JOIN positions p ON p.sport_id = s.id AND p.key = 'RB'
        WHERE s.key = 'nfl' RETURNING id`,
      [`p-${fx.leagueId}-${i}`, `Player ${i}`],
    );
    await fx.client.query(
      `INSERT INTO draft_picks (draft_id, pick_number, round, team_id, player_id, source)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL')`,
      [
        draft!.id,
        i + 1,
        Math.floor(i / order.length) + 1,
        teamOnClock(i + 1, order),
        player!.id,
      ],
    );
  }
}

describe("notificationsForUser", () => {
  it("says nothing when nothing is waiting", async () => {
    const fx = await fixture();
    expect(await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW)).toEqual([]);
  });

  it("names the manager on the clock, and only them", async () => {
    // Asked of the engine, never worked out here — a bell that disagreed with
    // the draft room about whose pick it is would be worse than no bell.
    const fx = await fixture();
    await draftInProgress(fx, 5);

    const order = fx.seats.map((seat) => seat.teamId);
    const expected = teamOnClock(6, order);

    for (const seat of fx.seats) {
      const items = await notificationsForUser(fx.client, seat.userId, NOW);
      const onClock = items.filter((item) => item.kind === "ON_THE_CLOCK");
      expect(onClock).toHaveLength(seat.teamId === expected ? 1 : 0);
    }
  });

  it("carries the pick deadline, so a strip can count down", async () => {
    const fx = await fixture();
    await draftInProgress(fx, 5);

    const order = fx.seats.map((seat) => seat.teamId);
    const seat = fx.seats.find((s) => s.teamId === teamOnClock(6, order))!;
    const [item] = await notificationsForUser(fx.client, seat.userId, NOW);

    expect(item?.deadline?.getTime()).toBe(NOW.getTime() + DRAFT.pickSeconds * 1000);
  });

  it("warns about a draft inside the hour, and not before", async () => {
    const soon = Math.floor((NOW.getTime() + 30 * 60_000) / 1000);
    const fx = await fixture(soon);

    const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
    expect(items.map((i) => i.kind)).toContain("DRAFT_SOON");

    // A day out is not urgent — a hub somebody visits weekly would be all noise.
    const later = await notificationsForUser(
      fx.client,
      fx.seats[0]!.userId,
      new Date(NOW.getTime() - 24 * 60 * 60_000),
    );
    expect(later.map((i) => i.kind)).not.toContain("DRAFT_SOON");
  });

  it("tells the receiver a trade is waiting on them, and nobody else", async () => {
    const fx = await fixture();
    await fx.client.query(
      `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state)
       VALUES ($1, $2, $3, 'PROPOSED')`,
      [fx.leagueId, fx.seats[0]!.teamId, fx.seats[1]!.teamId],
    );

    const receiver = await notificationsForUser(fx.client, fx.seats[1]!.userId, NOW);
    expect(receiver.map((i) => i.kind)).toContain("TRADE_AWAITING_YOU");

    const proposer = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
    expect(proposer.map((i) => i.kind)).not.toContain("TRADE_AWAITING_YOU");
  });

  it("offers the veto to the uninvolved, and not to either party", async () => {
    // The same three conditions as the electorate in §6 — in the league, not
    // involved, has not already voted.
    const fx = await fixture();
    const deadline = new Date(NOW.getTime() + 40 * 60 * 60_000);
    await fx.client.query(
      `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state, veto_deadline)
       VALUES ($1, $2, $3, 'ACCEPTED', $4)`,
      [fx.leagueId, fx.seats[0]!.teamId, fx.seats[1]!.teamId, deadline.toISOString()],
    );

    for (const [index, seat] of fx.seats.entries()) {
      const items = await notificationsForUser(fx.client, seat.userId, NOW);
      const veto = items.filter((i) => i.kind === "VETO_WINDOW");
      expect(veto).toHaveLength(index < 2 ? 0 : 1);
    }
  });

  it("stops offering a veto once you have cast one", async () => {
    const fx = await fixture();
    const [trade] = await fx.client.query<{ id: string }>(
      `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state, veto_deadline)
       VALUES ($1, $2, $3, 'ACCEPTED', $4) RETURNING id`,
      [
        fx.leagueId,
        fx.seats[0]!.teamId,
        fx.seats[1]!.teamId,
        new Date(NOW.getTime() + 40 * 60 * 60_000).toISOString(),
      ],
    );
    await fx.client.query(
      "INSERT INTO trade_vetoes (trade_id, team_id, league_id) VALUES ($1, $2, $3)",
      [trade!.id, fx.seats[2]!.teamId, fx.leagueId],
    );

    const items = await notificationsForUser(fx.client, fx.seats[2]!.userId, NOW);
    expect(items.map((i) => i.kind)).not.toContain("VETO_WINDOW");
  });

  it("drops a veto window that has closed", async () => {
    const fx = await fixture();
    await fx.client.query(
      `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state, veto_deadline)
       VALUES ($1, $2, $3, 'ACCEPTED', $4)`,
      [
        fx.leagueId,
        fx.seats[0]!.teamId,
        fx.seats[1]!.teamId,
        new Date(NOW.getTime() - 60_000).toISOString(),
      ],
    );

    const items = await notificationsForUser(fx.client, fx.seats[2]!.userId, NOW);
    expect(items.map((i) => i.kind)).not.toContain("VETO_WINDOW");
  });

  it("shows an invitation, and marks it as needing a signature", async () => {
    // Joining signs the rules hash — the one item here that asks for a wallet,
    // which the design wants visible before the click.
    const fx = await fixture();
    const invitee = await createUser(fx.client, "invited@example.test", "Invited");
    await fx.client.query(
      `INSERT INTO league_invitations (league_id, invited_user_id, invited_by_user_id, addressed_as)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'USERNAME')`,
      [fx.leagueId, invitee.id, fx.seats[0]!.userId],
    );

    const [item] = await notificationsForUser(fx.client, invitee.id, NOW);
    expect(item).toMatchObject({ kind: "INVITATION", needsSignature: true, deadline: null });
  });

  it("stays quiet about an unset lineup while autofill is on", async () => {
    // The autofill fills every empty slot at lock, so an unset lineup normally
    // costs nothing. Warning about it would be warning about a solved problem.
    const fx = await fixture();
    await fx.client.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [
      fx.leagueId,
    ]);
    await fx.client.query(
      `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
       SELECT $1, 1, st.id, 0, NULL FROM slot_types st LIMIT 1`,
      [fx.seats[0]!.teamId],
    );

    const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
    expect(items.map((i) => i.kind)).not.toContain("LINEUP_UNSET");
  });

  it("warns about an unset lineup once autofill is off", async () => {
    const fx = await fixture();
    await fx.client.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [
      fx.leagueId,
    ]);
    await fx.client.query("UPDATE teams SET autofill_enabled = false WHERE id = $1", [
      fx.seats[0]!.teamId,
    ]);
    await fx.client.query(
      `INSERT INTO lineups (team_id, week, slot_type_id, slot_index, player_id)
       SELECT $1, 1, st.id, 0, NULL FROM slot_types st LIMIT 1`,
      [fx.seats[0]!.teamId],
    );

    const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
    expect(items.map((i) => i.kind)).toContain("LINEUP_UNSET");
  });

  describe("a player who is no longer on an NFL roster", () => {
    /*
      Issue #254. `season-sync` clears `players.active` for anyone the provider
      stops listing with a club, and the player stayed on the roster scoring
      zero with nothing anywhere saying so. The only sentence in the product
      that states this fact is shown to a rival whose claim failed.
    */

    /** Put `count` players on a team, `cut` of them no longer listed. */
    const roster = async (
      fx: Fixture,
      teamId: string,
      names: readonly string[],
      cut: number,
    ) => {
      const [sport] = await fx.client.query<{ id: string }>(
        "SELECT id FROM sports WHERE key = $1",
        [NFL.key],
      );
      const [position] = await fx.client.query<{ id: string }>(
        "SELECT id FROM positions WHERE sport_id = $1 LIMIT 1",
        [sport!.id],
      );

      for (const [index, name] of names.entries()) {
        const [player] = await fx.client.query<{ id: string }>(
          `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id, active)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            sport!.id,
            `ext-${name}`,
            name,
            position!.id,
            index >= names.length - cut ? false : true,
          ],
        );
        await fx.client.query(
          `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at)
           VALUES ($1, $2, 'DRAFT', now())`,
          [teamId, player!.id],
        );
      }
    };

    const inSeason = async (fx: Fixture) =>
      fx.client.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [fx.leagueId]);

    it("names him, so the link lands somewhere the manager can act", async () => {
      // A bare count would be `unsetLineups`' shape, and wrong here: an empty
      // lineup slot is visible on arrival, and the roster panel renders every
      // player identically, so "1 player" is a fourteen-row search.
      const fx = await fixture();
      await inSeason(fx);
      await roster(fx, fx.seats[0]!.teamId, ["Adams", "Brown", "Carter"], 1);

      const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      const item = items.find((i) => i.kind === "PLAYER_OFF_NFL_ROSTER");

      expect(item).toMatchObject({
        kind: "PLAYER_OFF_NFL_ROSTER",
        leagueId: fx.leagueId,
        href: `/leagues/${fx.leagueId}/players`,
        deadline: null,
        needsSignature: false,
      });
      expect(item?.text).toBe(
        "Carter is no longer on an NFL roster in Sunday Scaries and cannot score",
      );
    });

    it("says it once per league, however many it is about", async () => {
      // `HeaderControls` keys the list on `kind:leagueId`, so a second row for
      // one league collides — and a manager holding two has one problem.
      const fx = await fixture();
      await inSeason(fx);
      await roster(fx, fx.seats[0]!.teamId, ["Adams", "Brown", "Carter"], 2);

      const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      const mine = items.filter((i) => i.kind === "PLAYER_OFF_NFL_ROSTER");

      expect(mine).toHaveLength(1);
      expect(mine[0]?.text).toBe(
        "Brown and 1 other are no longer on an NFL roster in Sunday Scaries and cannot score",
      );
    });

    it("tells the manager holding him and nobody else", async () => {
      const fx = await fixture();
      await inSeason(fx);
      await roster(fx, fx.seats[0]!.teamId, ["Adams"], 1);

      const held = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      expect(held.map((i) => i.kind)).toContain("PLAYER_OFF_NFL_ROSTER");

      const other = await notificationsForUser(fx.client, fx.seats[1]!.userId, NOW);
      expect(other.map((i) => i.kind)).not.toContain("PLAYER_OFF_NFL_ROSTER");
    });

    it("stops saying it the moment he is dropped", async () => {
      // The property that makes deriving right: nothing has to remember to
      // delete this, and `syncPlayers` re-asserts `active` every morning, so a
      // stored copy would be wrong in both directions.
      const fx = await fixture();
      await inSeason(fx);
      await roster(fx, fx.seats[0]!.teamId, ["Adams"], 1);

      await fx.client.query(
        "UPDATE roster_entries SET released_at = now() WHERE team_id = $1",
        [fx.seats[0]!.teamId],
      );

      const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      expect(items.map((i) => i.kind)).not.toContain("PLAYER_OFF_NFL_ROSTER");
    });

    it("stays quiet before the season, when nothing is being lost yet", async () => {
      // A league is `IN_SEASON` from the moment its draft completes, so this
      // covers only a draft still running — where the remedy is the draft.
      const fx = await fixture();
      await roster(fx, fx.seats[0]!.teamId, ["Adams"], 1);

      const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      expect(items.map((i) => i.kind)).not.toContain("PLAYER_OFF_NFL_ROSTER");
    });

    it("sorts below an unset lineup and above an invitation", async () => {
      /*
        Both are open-ended, so the tie is broken on cost. A lineup slot closes
        at kickoff whether or not a deadline was stored — which is why the rule
        is the window, not the field. An invitation costs nothing and expires
        never.
      */
      expect(NOTIFICATION_URGENCY.indexOf("PLAYER_OFF_NFL_ROSTER")).toBeGreaterThan(
        NOTIFICATION_URGENCY.indexOf("LINEUP_UNSET"),
      );
      expect(NOTIFICATION_URGENCY.indexOf("PLAYER_OFF_NFL_ROSTER")).toBeLessThan(
        NOTIFICATION_URGENCY.indexOf("INVITATION"),
      );
    });
  });

  describe("a roster over the limit", () => {
    /*
      The one state a manager reaches without acting: a stashed player recovers
      on the injuries cron, the exemption is read live, and the counted size
      rises with nothing written and nobody having done anything.

      This item is the safety valve on the rule. The rest of the restriction is
      discovered the moment the manager tries something; the autofill is not —
      it is a thing that silently does not happen, on a Sunday. §8 says a rule
      people would only discover by losing money to it is the wrong rule to
      have, and without this that is what it would be.
    */

    /** Give the team `rows` players, `stashed` of them on IR with a designation. */
    const roster = async (
      fx: Fixture,
      teamId: string,
      rows: number,
      stashed: { designation: string | null } | null,
    ) => {
      const [sport] = await fx.client.query<{ id: string }>(
        "SELECT id FROM sports WHERE key = $1",
        [NFL.key],
      );
      const [position] = await fx.client.query<{ id: string }>(
        "SELECT id FROM positions WHERE sport_id = $1 LIMIT 1",
        [sport!.id],
      );

      for (let i = 0; i < rows; i++) {
        const onIr = stashed !== null && i === 0;
        const handle = `over-${teamId.slice(0, 6)}-${i}`;
        const [player] = await fx.client.query<{ id: string }>(
          `INSERT INTO players
             (sport_id, external_ref, full_name, primary_position_id, injury_designation)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [sport!.id, handle, handle, position!.id, onIr ? stashed.designation : null],
        );
        await fx.client.query(
          `INSERT INTO roster_entries (team_id, player_id, acquired_via, acquired_at, on_ir)
           VALUES ($1, $2, 'DRAFT', now(), $3)`,
          [teamId, player!.id, onIr],
        );
      }
    };

    const inSeason = async (fx: Fixture) =>
      fx.client.query("UPDATE leagues SET state = 'IN_SEASON' WHERE id = $1", [fx.leagueId]);

    it("stays quiet while a genuinely stashed player keeps the team legal", async () => {
      // Fifteen rows, one genuinely out: counted fourteen, exactly at the limit
      // and perfectly legal. This is the case a check on row count gets wrong.
      const fx = await fixture();
      await inSeason(fx);
      await roster(fx, fx.seats[0]!.teamId, 15, { designation: "OUT" });

      const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      expect(items.map((i) => i.kind)).not.toContain("ROSTER_OVER_LIMIT");
    });

    it("speaks the moment he recovers, with both numbers and the way out", async () => {
      const fx = await fixture();
      await inSeason(fx);
      await roster(fx, fx.seats[0]!.teamId, 15, { designation: "OUT" });

      // The injuries cron clears it. Nothing else changes.
      await fx.client.query("UPDATE players SET injury_designation = NULL WHERE id = ANY($1)", [
        (
          await fx.client.query<{ player_id: string }>(
            "SELECT player_id FROM roster_entries WHERE team_id = $1 AND on_ir",
            [fx.seats[0]!.teamId],
          )
        ).map((row) => row.player_id),
      ]);

      const items = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      const item = items.find((i) => i.kind === "ROSTER_OVER_LIMIT");

      expect(item).toMatchObject({
        kind: "ROSTER_OVER_LIMIT",
        leagueId: fx.leagueId,
        href: `/leagues/${fx.leagueId}/players`,
        deadline: null,
      });
      expect(item?.text).toContain("holds 15 players and the limit is 14");
      expect(item?.text).toContain("release one player");
      // Says what it costs, because that half is otherwise invisible.
      expect(item?.text).toContain("autofill will not pick anyone");
    });

    it("tells the manager holding the roster and nobody else", async () => {
      const fx = await fixture();
      await inSeason(fx);
      await roster(fx, fx.seats[0]!.teamId, 15, null);

      const held = await notificationsForUser(fx.client, fx.seats[0]!.userId, NOW);
      expect(held.map((i) => i.kind)).toContain("ROSTER_OVER_LIMIT");

      const other = await notificationsForUser(fx.client, fx.seats[1]!.userId, NOW);
      expect(other.map((i) => i.kind)).not.toContain("ROSTER_OVER_LIMIT");
    });

    it("outranks an unset lineup, because it costs more and closes no later", async () => {
      expect(NOTIFICATION_URGENCY.indexOf("ROSTER_OVER_LIMIT")).toBeLessThan(
        NOTIFICATION_URGENCY.indexOf("LINEUP_UNSET"),
      );
    });
  });

  it("puts the pick clock ahead of everything else", async () => {
    // The strip shows one item, so the order decides what a manager sees. A
    // 90-second clock outranks anything measured in hours.
    const fx = await fixture();
    await draftInProgress(fx, 5);

    const order = fx.seats.map((seat) => seat.teamId);
    const onClock = fx.seats.find((s) => s.teamId === teamOnClock(6, order))!;

    await fx.client.query(
      `INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, state)
       VALUES ($1, $2, $3, 'PROPOSED')`,
      [fx.leagueId, fx.seats[0]!.teamId, onClock.teamId],
    );

    const items = await notificationsForUser(fx.client, onClock.userId, NOW);
    expect(items.length).toBeGreaterThan(1);
    expect(items[0]?.kind).toBe("ON_THE_CLOCK");
  });
});
