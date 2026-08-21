import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createUser } from "./identity.js";
import { createDraftRecord } from "./draft.js";
import { createLeague } from "./leagues.js";
import { removeMember } from "./membership.js";
import { seedSport } from "./sports.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** Far enough ahead that the field is open unless a test closes it. */
const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
};

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  commissioner: string;
  /** A seated member who is not the commissioner. */
  memberTeam: string;
  memberUser: string;
}

/**
 * A forming league, its commissioner, and one seated member.
 *
 * `addTestTeam` creates the user *and* the team — the same rows a real join
 * produces, minus the signature — so the member here is its own user rather
 * than one made separately and grafted on. What it does not create is the
 * wallet and the consent row, and `removeMember` deletes the consent row, so
 * both are added here.
 *
 * Every parameter is cast. In an `INSERT ... SELECT` Postgres cannot deduce a
 * bare select-list parameter's type, and the same `$2` compared against
 * `w.user_id` in the `WHERE` forces uuid — which is the "inconsistent types
 * deduced" error, not a schema problem.
 */
async function fixture(
  overrides?: Partial<LeagueRules>,
  /** Seconds. Past values build a league whose field has already locked. */
  scheduledAt: number = DRAFT.scheduledAt,
): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.test", "Commish");

  const league = await createLeague(db, NFL, {
    name: "Removable",
    commissionerId: commissioner.id,
    rules: {
      ...buildNflPprRules({ seasonYear: 2026, draft: { ...DRAFT, scheduledAt } }),
      ...overrides,
    } as LeagueRules,
  });

  const seat = await addTestTeam(db, league.id, "Route 66");

  await db.query(
    `INSERT INTO wallets (user_id, address, verified_at)
     VALUES ($1::uuid, 'wallet-' || $1::text, now())`,
    [seat.userId],
  );

  await db.query(
    `INSERT INTO league_memberships (league_id, user_id, team_id, wallet_id, rules_hash, signature)
     SELECT $1::uuid, $2::uuid, $3::uuid, w.id, repeat('a', 64), 'sig'
       FROM wallets w WHERE w.user_id = $2::uuid LIMIT 1`,
    [league.id, seat.userId, seat.teamId],
  );

  // Scheduled *after* the seat is taken, and that ordering is load-bearing for
  // the field-lock case. `0028`'s trigger fires on a `teams` INSERT and reads
  // the draft row; with no draft row there is nothing to lock — the state its
  // own comment calls the ordinary one between `createLeague` and
  // `createDraftRecord`. It is also the only way to build a league that is
  // already past its draft time with somebody in it, since `scheduled_at` is
  // write-once.
  await createDraftRecord(db, {
    leagueId: league.id,
    rounds: 15,
    pickSeconds: DRAFT.pickSeconds,
    scheduledAt: new Date(scheduledAt * 1000),
  });

  return {
    client: db,
    leagueId: league.id,
    commissioner: commissioner.id,
    memberTeam: seat.teamId,
    memberUser: seat.userId,
  };
}
const teamCount = async (fx: Fixture): Promise<number> => {
  const [row] = await fx.client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM teams WHERE league_id = $1",
    [fx.leagueId],
  );
  return Number(row?.n ?? 0);
};

describe("removeMember", () => {
  it("removes the seat and the consent record together", async () => {
    const fx = await fixture();

    await removeMember(fx.client, {
      leagueId: fx.leagueId,
      teamId: fx.memberTeam,
      actingUserId: fx.commissioner,
    });

    expect(await teamCount(fx)).toBe(0);

    const [membership] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM league_memberships WHERE league_id = $1",
      [fx.leagueId],
    );
    // A seat removed while its membership row survived would leave a league the
    // size checks and the draw both disagree about.
    expect(Number(membership?.n)).toBe(0);
  });

  it("refuses anyone who is not the commissioner", async () => {
    const fx = await fixture();

    await expect(
      removeMember(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.memberTeam,
        actingUserId: fx.memberUser,
      }),
    ).rejects.toMatchObject({ code: "NOT_COMMISSIONER" });

    expect(await teamCount(fx)).toBe(1);
  });

  it("refuses a team belonging to another league", async () => {
    // Scoped by league as well as id, so a commissioner cannot reach into
    // somebody else's league by guessing a UUID — the shape `vetoTrade` uses.
    const fx = await fixture();
    const outsider = await createUser(fx.client, "other@example.test", "Other");
    const other = await createLeague(fx.client, NFL, {
      name: "Elsewhere",
      commissionerId: outsider.id,
      rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
    });
    const theirSeat = await addTestTeam(fx.client, other.id, "Theirs");

    await expect(
      removeMember(fx.client, {
        leagueId: fx.leagueId,
        teamId: theirSeat.teamId,
        actingUserId: fx.commissioner,
      }),
    ).rejects.toMatchObject({ code: "TEAM_NOT_IN_LEAGUE" });
  });

  it("refuses to remove the commissioner's own team", async () => {
    // The league would be left with no commissioner and no way to appoint one.
    const fx = await fixture();
    const seat = await addTestTeam(fx.client, fx.leagueId, "The Boss");
    await fx.client.query("UPDATE teams SET owner_id = $2 WHERE id = $1", [
      seat.teamId,
      fx.commissioner,
    ]);

    await expect(
      removeMember(fx.client, {
        leagueId: fx.leagueId,
        teamId: seat.teamId,
        actingUserId: fx.commissioner,
      }),
    ).rejects.toMatchObject({ code: "CANNOT_REMOVE_COMMISSIONER" });
  });

  it("refuses a bot, which has its own path", async () => {
    const fx = await fixture();
    const [bot] = await fx.client.query<{ id: string }>(
      `INSERT INTO teams (league_id, name, slot, is_bot) VALUES ($1, 'Bot', 99, true)
       RETURNING id`,
      [fx.leagueId],
    );

    await expect(
      removeMember(fx.client, {
        leagueId: fx.leagueId,
        teamId: bot!.id,
        actingUserId: fx.commissioner,
      }),
    ).rejects.toMatchObject({ code: "IS_A_BOT" });
  });

  it("refuses once the draft order has been drawn", async () => {
    // Removing a team changes the field exactly as adding one does, and
    // delete-then-add is an unbounded re-roll of the order.
    const fx = await fixture();
    // All four together: `order_drawn_together` refuses a half-recorded draw,
    // which is exactly what stops a draw existing without the block that proves
    // it. Written directly rather than through `drawDraftOrder` because that
    // needs a beacon, and what is under test here is the refusal, not the draw.
    await fx.client.query(
      `UPDATE drafts
          SET order_drawn_at = now(), order_slot = 1, order_blockhash = 'hash',
              order_seed = repeat('b', 64)
        WHERE league_id = $1`,
      [fx.leagueId],
    );

    await expect(
      removeMember(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.memberTeam,
        actingUserId: fx.commissioner,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_ALREADY_DRAWN" });

    expect(await teamCount(fx)).toBe(1);
  });

  it("refuses once the scheduled draft time has passed", async () => {
    // Built with a past draft time rather than moved to one: `0028` makes
    // `scheduled_at` write-once and checks it against the frozen rules, so the
    // only honest way to reach this state is to create the league in it — the
    // same thing `membership.test.ts`'s own `draftTimePassed` does.
    const fx = await fixture(undefined, Math.floor(Date.now() / 1000) - 3600);

    await expect(
      removeMember(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.memberTeam,
        actingUserId: fx.commissioner,
      }),
    ).rejects.toMatchObject({ code: "FIELD_LOCKED" });
  });

  it("refuses a league with a pot, whose stakes are on-chain", async () => {
    // Deleting a row returns nobody's money: `refund_stake` needs the member's
    // own signature and the timelock. A stake with no member behind it is a
    // settlement that cannot account for itself.
    const fx = await fixture({
      // A pot league cannot allow bots — a bot has no wallet and paid no buy-in,
      // so a bot champion would leave the pot with no recipient.
      league: {
        ...(buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules).league,
        maxBots: 0,
      },
      pot: {
        tokenMint: "So11111111111111111111111111111111111111112",
        buyInBaseUnits: "10000000",
        payout: [{ prize: "CHAMPION", basisPoints: 10000 }],
        // Inside the window: after the season and its paying correction window
        // plus sixty days, and before the program's own draft + 365 ceiling.
        refundUnlockAt: DRAFT.scheduledAt + 270 * 24 * 60 * 60,
        feeBps: 100,
        feeRecipient: "So11111111111111111111111111111111111111112",
        settlementOracle: "So11111111111111111111111111111111111111112",
        requiredOracleSources: 2,
      },
    } as Partial<LeagueRules>);

    await expect(
      removeMember(fx.client, {
        leagueId: fx.leagueId,
        teamId: fx.memberTeam,
        actingUserId: fx.commissioner,
      }),
    ).rejects.toMatchObject({ code: "POT_LEAGUE" });

    expect(await teamCount(fx)).toBe(1);
  });
});
