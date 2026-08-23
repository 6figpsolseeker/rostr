import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL, teamOnClock } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createDraftRecord } from "./draft.js";
import { createUser } from "./identity.js";
import { createLeague } from "./leagues.js";
import { leaguesForUser } from "./my-leagues.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
};

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  /** Four seats, in draft order 1..4, with their owning users. */
  seats: { teamId: string; userId: string }[];
}

/** A league with four seated members and a scheduled draft. */
async function fixture(name = "Sunday Scaries"): Promise<Fixture> {
  db ??= await createTestDatabase();
  const client = db;
  await seedSport(client, NFL).catch(() => undefined);

  const commissioner = await createUser(client, `${name}@example.test`, "Commish");
  const league = await createLeague(client, NFL, {
    name,
    commissionerId: commissioner.id,
    rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
  });

  const seats: { teamId: string; userId: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const seat = await addTestTeam(client, league.id, `${name} Team ${i + 1}`);
    seats.push({ teamId: seat.teamId, userId: seat.userId });

    await client.query(
      `INSERT INTO wallets (user_id, address, verified_at)
       VALUES ($1::uuid, 'w-' || $1::text || '-' || $2::text, now())`,
      [seat.userId, String(i)],
    );
    await client.query(
      `INSERT INTO league_memberships (league_id, user_id, team_id, wallet_id, rules_hash, signature)
       SELECT $1::uuid, $2::uuid, $3::uuid, w.id, repeat('a', 64), 'sig'
         FROM wallets w WHERE w.user_id = $2::uuid LIMIT 1`,
      [league.id, seat.userId, seat.teamId],
    );
    // Draft order 1..4, so `onTheClock` has something to compare against.
    await client.query("UPDATE teams SET draft_position = $2 WHERE id = $1", [
      seat.teamId,
      i + 1,
    ]);
  }

  await createDraftRecord(client, {
    leagueId: league.id,
    rounds: 15,
    pickSeconds: DRAFT.pickSeconds,
    scheduledAt: new Date(DRAFT.scheduledAt * 1000),
  });

  return { client, leagueId: league.id, seats };
}

/** Put the draft in progress with `picks` already made. */
async function withPicks(fx: Fixture, picks: number): Promise<void> {
  const [draft] = await fx.client.query<{ id: string }>(
    "SELECT id FROM drafts WHERE league_id = $1",
    [fx.leagueId],
  );
  // Both together: `clock_only_while_running` in `0009` makes IN_PROGRESS and a
  // running clock the same fact, so setting one without the other is a state the
  // app cannot produce and the database will not hold.
  await fx.client.query(
    "UPDATE drafts SET status = 'IN_PROGRESS', clock_started_at = now() WHERE id = $1",
    [draft!.id],
  );

  // `seedSport` seeds the registry — sports, positions, stat keys — and not a
  // player pool, so the picks need somebody to be picked.
  const players: { id: string }[] = [];
  for (let i = 0; i < picks; i++) {
    const [player] = await fx.client.query<{ id: string }>(
      `INSERT INTO players (sport_id, external_ref, full_name, primary_position_id)
       SELECT s.id, $1, $2, p.id
         FROM sports s
         JOIN positions p ON p.sport_id = s.id AND p.key = 'RB'
        WHERE s.key = 'nfl'
       RETURNING id`,
      [`pick-${fx.leagueId}-${i}`, `Player ${i + 1}`],
    );
    players.push(player!);
  }

  for (let i = 0; i < picks; i++) {
    // The order is 1..4 by `draft_position`, so the snake decides which seat
    // owns pick i+1 — asked of the engine rather than restated here.
    const order = fx.seats.map((seat) => seat.teamId);
    await fx.client.query(
      `INSERT INTO draft_picks (draft_id, pick_number, round, team_id, player_id, source)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL')`,
      [
        draft!.id,
        i + 1,
        Math.floor(i / order.length) + 1,
        teamOnClock(i + 1, order),
        players[i]!.id,
      ],
    );
  }
}

describe("leaguesForUser", () => {
  it("lists a league you joined, with your team", async () => {
    const fx = await fixture();
    const mine = await leaguesForUser(fx.client, fx.seats[0]!.userId);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      leagueId: fx.leagueId,
      name: "Sunday Scaries",
      state: "FORMING",
      teamCount: 4,
      teamId: fx.seats[0]!.teamId,
      onTheClock: false,
    });
  });

  it("shows nothing to somebody who is in no league", async () => {
    const fx = await fixture();
    const stranger = await createUser(fx.client, "stranger@example.test", "Stranger");

    expect(await leaguesForUser(fx.client, stranger.id)).toEqual([]);
  });

  it("does not list a league you were only invited to", async () => {
    // Membership is the source, and an invitation grants nothing. A hub that
    // listed invitations as leagues would be claiming you are in them.
    const fx = await fixture();
    const invitee = await createUser(fx.client, "invited@example.test", "Invited");
    await fx.client.query(
      `INSERT INTO league_invitations (league_id, invited_user_id, invited_by_user_id, addressed_as)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'USERNAME')`,
      [fx.leagueId, invitee.id, fx.seats[0]!.userId],
    );

    expect(await leaguesForUser(fx.client, invitee.id)).toEqual([]);
  });

  it("names the round from the picks, not from a stored counter", async () => {
    // Four teams, five picks made, so pick six is the next one — round two.
    const fx = await fixture();
    await withPicks(fx, 5);

    const [league] = await leaguesForUser(fx.client, fx.seats[0]!.userId);
    expect(league?.currentRound).toBe(2);
    expect(league?.draftStatus).toBe("IN_PROGRESS");
  });

  it("says who is on the clock, and agrees with the engine", async () => {
    // Five picks made means pick six is next. Round two runs backwards, so pick
    // six belongs to seat three — which is `teamOnClock`'s answer, and the whole
    // point is that this module asks rather than restates.
    const fx = await fixture();
    await withPicks(fx, 5);

    const order = fx.seats.map((seat) => seat.teamId);
    const expected = teamOnClock(6, order);

    for (const seat of fx.seats) {
      const [league] = await leaguesForUser(fx.client, seat.userId);
      expect(league?.onTheClock).toBe(seat.teamId === expected);
    }
  });

  it("nobody is on the clock before the draft starts", async () => {
    const fx = await fixture();
    const [league] = await leaguesForUser(fx.client, fx.seats[0]!.userId);

    expect(league?.onTheClock).toBe(false);
    expect(league?.currentRound).toBeNull();
  });

  it("carries the draft time so a row can say when it starts", async () => {
    const fx = await fixture();
    const [league] = await leaguesForUser(fx.client, fx.seats[0]!.userId);

    expect(league?.draftScheduledAt).toBe(DRAFT.scheduledAt);
    expect(league?.rounds).toBe(15);
  });
});
