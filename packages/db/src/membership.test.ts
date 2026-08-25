import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import {
  buildJoinMessage,
  buildNflPprRules,
  NFL,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
} from "@rostr/core";
import type { DraftRules, LeagueRules, PotRules } from "@rostr/core";
import { createLeague, getLeagueRules, recordChainAnchor } from "./leagues.js";
import { createUser, linkWallet } from "./identity.js";
import {
  addBot,
  getJoinMessage,
  getMembershipProofs,
  getOnChainDeposit,
  getOnChainJoin,
  getOnChainRefund,
  JoinError,
  joinLeague,
  memberWallet,
  recordOnChainDeposit,
  recordOnChainJoin,
  recordOnChainRefund,
  removeBot,
} from "./membership.js";
import { seedSport } from "./sports.js";
import { createDraftRecord, drawDraftOrder, FixedSettlementAccount } from "./draft.js";
import { FixedBeacon } from "./randomness.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

/**
 * Thirty days out, relative rather than a literal date.
 *
 * The field locks at the scheduled draft time (migration `0028`), compared
 * against the database clock — so a fixed date would pass until it arrived and
 * then start failing every test here that adds a team. `0028` also requires
 * `drafts.scheduled_at` to equal this exact number.
 */
const SCHEDULED = new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 24 * 3600 * 1000);
const SCHEDULED_SECONDS = Math.floor(SCHEDULED.getTime() / 1000);

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: SCHEDULED_SECONDS,
};

const POT: PotRules = {
  tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  buyInBaseUnits: "50000000",
  payout: NFL_DEFAULT_PAYOUT,
  // Derived, because the floor is derived. `earliestRefundUnlock` is roughly the
  // draft plus 186 days, so a literal here silently became "376 days too early"
  // the moment the draft date started moving with the clock.
  refundUnlockAt: SCHEDULED_SECONDS + 200 * 24 * 3600,
  feeBps: NFL_DEFAULT_FEE_BPS,
  feeRecipient: "6dNUCTMTgoHhbfgDzKtiPvBpJ2LzMwGqBpKmUDgQtNMK",
  settlementOracle: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
};

function keypair(seed: number): { secret: Uint8Array; address: string } {
  const secret = new Uint8Array(32).fill(seed);
  return { secret, address: bs58.encode(ed25519.getPublicKey(secret)) };
}

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  leagueName: string;
  rulesHash: string;
  rules: LeagueRules;
}

async function setup(overrides: Partial<LeagueRules> = {}): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = {
    ...buildNflPprRules({ seasonYear: 2026, draft: DRAFT, pot: POT }),
    ...overrides,
  } as LeagueRules;

  const league = await createLeague(db, NFL, {
    name: "The Money League",
    commissionerId: commissioner.id,
    rules,
  });

  // Anchored, because joining an unanchored league is refused — see the check in
  // `joinLeague`. This calls the real `recordChainAnchor` rather than reaching
  // into the column, so a fixture cannot drift into a state the application
  // could not produce.
  await recordChainAnchor(db, league.id, {
    signature: "5".repeat(88),
    cluster: "localnet",
  });

  return {
    client: db,
    leagueId: league.id,
    leagueName: "The Money League",
    rulesHash: league.rulesHash,
    rules,
  };
}

async function member(
  fx: Fixture,
  seed: number,
  email: string,
): Promise<{ userId: string; address: string; secret: Uint8Array }> {
  const user = await createUser(fx.client, email, `User ${seed}`);
  const kp = keypair(seed);
  await linkWallet(fx.client, user.id, kp.address);
  return { userId: user.id, address: kp.address, secret: kp.secret };
}

function signJoin(fx: Fixture, address: string, secret: Uint8Array): string {
  const message = buildJoinMessage({
    leagueId: fx.leagueId,
    leagueName: fx.leagueName,
    rulesHash: fx.rulesHash,
    walletAddress: address,
    seasonYear: fx.rules.seasonYear,
  });
  return bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret));
}

describe("the field locks when the seed exists", () => {
  /**
   * A free league whose scheduled draft time is already behind us.
   *
   * The rules carry the same past instant the `drafts` row does — `0028` requires
   * that — and nothing refuses a past draft date at *this* layer: the create
   * route does, through `draftDateProblem`, because `validateLeagueRules` has to
   * stay a pure function of the frozen document.
   */
  async function draftTimePassed(minutesAgo = 5): Promise<Fixture> {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    // Truncated to whole seconds: the rules store `scheduledAt` in seconds, and
    // `0028` compares the two exactly. The production route builds the date as
    // `scheduledAt * 1000`, so it is exact there by construction.
    const scheduled = new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 1000) * 1000);
    const commissioner = await createUser(db, "commish@example.com", "Commish");
    const rules = buildNflPprRules({
      seasonYear: 2026,
      draft: { ...DRAFT, scheduledAt: Math.floor(scheduled.getTime() / 1000) },
    }) as LeagueRules;

    const league = await createLeague(db, NFL, {
      name: "Late League",
      commissionerId: commissioner.id,
      rules,
    });
    await recordChainAnchor(db, league.id, {
      signature: "5".repeat(88),
      cluster: "localnet",
    });

    // The team is seated *before* the draft row exists, which is the only order
    // that still works — and is how a real league fills.
    await addTestTeam(db, league.id, "Early Bird");

    await createDraftRecord(db, {
      leagueId: league.id,
      rounds: 14,
      pickSeconds: 14_400,
      scheduledAt: scheduled,
    });

    const stored = await getLeagueRules(db, league.id);
    return {
      client: db,
      leagueId: league.id,
      leagueName: "Late League",
      rulesHash: stored!.hash,
      rules: stored!.rules,
    };
  }

  it("refuses a join once the scheduled draft time has passed", async () => {
    const fx = await draftTimePassed();
    const m = await member(fx, 9, "late@example.com");

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "Too Late",
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof JoinError && e.code === "FIELD_LOCKED");
  });

  it("refuses to hand out a join message it would then refuse to honour", async () => {
    // A signature costs a wallet approval. Issuing one for a seat that cannot be
    // taken is worse than saying no.
    const fx = await draftTimePassed();

    await expect(getJoinMessage(fx.client, fx.leagueId, keypair(9).address)).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "FIELD_LOCKED",
    );
  });

  it("refuses a team insert at the database, with no application check involved", async () => {
    // **This is the test that pins the security property.** Everything else
    // pins the error message. The application checks are a courtesy; the trigger
    // is the guarantee, and it holds for any path that reaches the table.
    const fx = await draftTimePassed();
    const [user] = await fx.client.query<{ id: string }>(
      "INSERT INTO users (email, display_name) VALUES ('raw@example.test', 'Raw') RETURNING id",
    );

    await expect(
      fx.client.query(
        `INSERT INTO teams (league_id, owner_id, is_bot, name, slot)
         VALUES ($1, $2, false, 'Raw', 99)`,
        [fx.leagueId, user!.id],
      ),
    ).rejects.toThrow(/field locked/i);
  });

  it("refuses a team delete at the database too", async () => {
    // Removing a team changes the field exactly as adding one does, and
    // delete-then-add is an unbounded re-roll rather than a single blind draw.
    // `0010` guarded INSERT only.
    const fx = await draftTimePassed();
    const [team] = await fx.client.query<{ id: string }>(
      "SELECT id FROM teams WHERE league_id = $1",
      [fx.leagueId],
    );

    await expect(
      fx.client.query("DELETE FROM teams WHERE id = $1", [team!.id]),
    ).rejects.toThrow(/field locked/i);
  });

  it("still accepts a join before the scheduled time", async () => {
    // The negative control. Without it, a trigger that refused every insert
    // would pass every test above.
    const fx = await setup();
    const m = await member(fx, 8, "early@example.com");

    const result = await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature: signJoin(fx, m.address, m.secret),
      teamName: "In Time",
    });

    expect(result.slot).toBe(1);
  });

  it("accepts a join into a league that has not scheduled a draft yet", async () => {
    // `createLeague` and `createDraftRecord` are separate transactions, so a
    // league with no `drafts` row is the ordinary state between them — not a
    // locked field.
    db = await createTestDatabase();
    await seedSport(db, NFL);
    const commissioner = await createUser(db, "c2@example.com", "Commish");
    const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules;
    const league = await createLeague(db, NFL, {
      name: "Unscheduled",
      commissionerId: commissioner.id,
      rules,
    });

    await expect(addTestTeam(db, league.id, "Anybody")).resolves.toBeTruthy();
  });

  it("refuses removeBot once the scheduled time has passed", async () => {
    // The residual grind, and the direction that matters most: shrinking the
    // field and re-adding is a repeatable re-roll.
    db = await createTestDatabase();
    await seedSport(db, NFL);

    const scheduled = new Date(Math.floor((Date.now() - 5 * 60_000) / 1000) * 1000);
    const commissioner = await createUser(db, "c3@example.com", "Commish");
    const rules = buildNflPprRules({
      seasonYear: 2026,
      draft: { ...DRAFT, scheduledAt: Math.floor(scheduled.getTime() / 1000) },
    }) as LeagueRules;
    const league = await createLeague(db, NFL, {
      name: "Bot League",
      commissionerId: commissioner.id,
      rules,
    });
    await addTestTeam(db, league.id, "Human 1");
    await addBot(db, league.id, "Robo");

    await createDraftRecord(db, {
      leagueId: league.id,
      rounds: 14,
      pickSeconds: 14_400,
      scheduledAt: scheduled,
    });

    await expect(removeBot(db, league.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "FIELD_LOCKED",
    );
  });

  it("refuses addBot once the scheduled time has passed", async () => {
    const fx = await draftTimePassed();

    await expect(addBot(fx.client, fx.leagueId, "Robo")).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "FIELD_LOCKED",
    );
  });

  it("refuses a drafts row whose time disagrees with the frozen rules", async () => {
    // The lock instant has to be the number members signed. These two were a
    // year apart in this repo's own fixtures, and nothing noticed.
    db = await createTestDatabase();
    await seedSport(db, NFL);
    const commissioner = await createUser(db, "c4@example.com", "Commish");
    const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules;
    const league = await createLeague(db, NFL, {
      name: "Mismatched",
      commissionerId: commissioner.id,
      rules,
    });

    await expect(
      createDraftRecord(db, {
        leagueId: league.id,
        rounds: 14,
        pickSeconds: 14_400,
        scheduledAt: new Date(SCHEDULED.getTime() + 86_400_000),
      }),
    ).rejects.toThrow(/frozen rules/i);
  });

  it("refuses to move a scheduled draft time", async () => {
    const fx = await setup();
    await createDraftRecord(fx.client, {
      leagueId: fx.leagueId,
      rounds: 14,
      pickSeconds: 14_400,
      scheduledAt: SCHEDULED,
    });

    await expect(
      fx.client.query("UPDATE drafts SET scheduled_at = $2 WHERE league_id = $1", [
        fx.leagueId,
        new Date(SCHEDULED.getTime() + 3_600_000),
      ]),
    ).rejects.toThrow(/cannot be moved/i);
  });
});

describe("joinLeague", () => {
  it("joins with a valid signature and takes slot 1", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    const result = await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature: signJoin(fx, m.address, m.secret),
      teamName: "Team A",
    });

    expect(result.slot).toBe(1);
    expect(result.teamId).toBeTruthy();
  });

  it("assigns ascending slots", async () => {
    const fx = await setup();
    const a = await member(fx, 1, "a@example.com");
    const b = await member(fx, 2, "b@example.com");

    const first = await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: a.userId,
      walletAddress: a.address,
      signature: signJoin(fx, a.address, a.secret),
      teamName: "A",
    });
    const second = await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: b.userId,
      walletAddress: b.address,
      signature: signJoin(fx, b.address, b.secret),
      teamName: "B",
    });

    expect([first.slot, second.slot]).toEqual([1, 2]);
  });

  it("rejects a signature over different rules", async () => {
    // The attack that matters: sign a permissive rule set, present it against a
    // league with different ones. The server rebuilds the message from the
    // database, so the forgery cannot match.
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    const forged = bs58.encode(
      ed25519.sign(
        new TextEncoder().encode(
          buildJoinMessage({
            leagueId: fx.leagueId,
            leagueName: fx.leagueName,
            rulesHash: "0".repeat(64),
            walletAddress: m.address,
            seasonYear: fx.rules.seasonYear,
          }),
        ),
        m.secret,
      ),
    );

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: forged,
        teamName: "A",
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "INVALID_SIGNATURE",
    );
  });

  it("rejects a signature from a wallet the user does not control", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");
    const attacker = keypair(99);

    await linkWallet(fx.client, m.userId, attacker.address);

    // Signed by seed 1's key, but claiming to be the attacker's address.
    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: attacker.address,
        signature: signJoin(fx, attacker.address, m.secret),
        teamName: "A",
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "INVALID_SIGNATURE",
    );
  });

  it("rejects a wallet not linked to the user", async () => {
    const fx = await setup();
    const user = await createUser(fx.client, "a@example.com", "A");
    const kp = keypair(5);

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: user.id,
        walletAddress: kp.address,
        signature: signJoin(fx, kp.address, kp.secret),
        teamName: "A",
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "WALLET_NOT_LINKED",
    );
  });

  it("rejects a malformed wallet address", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: "not-a-key",
        signature: "whatever",
        teamName: "A",
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof JoinError && e.code === "INVALID_WALLET");
  });

  it("rejects joining twice", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");
    const signature = signJoin(fx, m.address, m.secret);

    await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature,
      teamName: "A",
    });

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature,
        teamName: "A2",
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof JoinError && e.code === "ALREADY_JOINED");
  });

  it("rejects an unknown league", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    await expect(
      joinLeague(fx.client, {
        leagueId: "00000000-0000-4000-8000-000000000000",
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "LEAGUE_NOT_FOUND",
    );
  });

  it("rejects joining a league that has moved past forming", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");
    await fx.client.query("UPDATE leagues SET state = 'DRAFTING' WHERE id = $1", [fx.leagueId]);

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof JoinError && e.code === "LEAGUE_CLOSED");
  });

  it("rejects joining a full league", async () => {
    const fx = await setup();
    for (let i = 0; i < 12; i++) await addTestTeam(fx.client, fx.leagueId, `Team ${i}`);

    const m = await member(fx, 1, "a@example.com");
    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof JoinError && e.code === "LEAGUE_FULL");
  });

  it("joins into a gap rather than refusing, when a slot has been vacated", async () => {
    /*
      **This test previously asserted the opposite, and that is issue #73.**

      It was called "says LEAGUE_FULL when the slot index refuses", and it staged
      a league whose only team sat at slot 2 — a gap at slot 1 — then asserted
      the join was refused. Its comment explained the state as the loser of a
      concurrent-join race, because a real race cannot be staged on
      single-connection PGlite.

      But a hole below `max(slot)` is not what losing a race looks like. It is
      what `removeBot` and `removeMember` leave behind, and under the old
      `count(*) + 1` arithmetic it bricked the league permanently. Somebody had
      the defect on screen, read it as the race, and wrote it down as correct.

      The fixture is kept and the assertion inverted, because the state it builds
      is exactly the one that used to fail.
    */
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    await fx.client.query(
      "INSERT INTO teams (league_id, owner_id, is_bot, name, slot) VALUES ($1, NULL, true, $2, 2)",
      [fx.leagueId, "Squatter"],
    );

    // `count(*)` is 1 and `max(slot)` is 2. The old arithmetic derived 2 and
    // collided; the slot asserted here is what says which formula ran.
    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
      }),
    ).resolves.toMatchObject({ slot: 3 });
  });

  it("lets the replacement for a removed member in, when max(slot) says full and the count does not", async () => {
    /*
      **The discriminating case, and the one the test below cannot see.**

      That test stages count 12 and max 13 against a cap of 12 — both say full,
      so it passes whether the capacity gate reads `count(*)` or `max(slot)`.
      Harmonising the two, which is the natural-looking cleanup since they sit
      thirty lines apart, would therefore stay green while reintroducing #73 at
      the capacity gate — and in its worst form: a league with a visibly free
      seat refusing every join forever, because joining is the only thing that
      raises the number.

      Here they disagree. Twelve teams, the one at slot 5 removed: count is 11,
      `max(slot)` is 12, the cap is 12. The seat is genuinely free and the join
      must succeed. Removing the *top* slot would not do — that drops max as
      well, and the two agree again.
    */
    const fx = await setup();
    for (let i = 0; i < 12; i++) await addTestTeam(fx.client, fx.leagueId, `Team ${i}`);
    await fx.client.query("DELETE FROM teams WHERE league_id = $1 AND slot = 5", [fx.leagueId]);

    const [before] = await fx.client.query<{ n: number; hi: number }>(
      "SELECT count(*)::int AS n, max(slot)::int AS hi FROM teams WHERE league_id = $1",
      [fx.leagueId],
    );
    expect(before).toMatchObject({ n: 11, hi: 12 });

    const m = await member(fx, 1, "replacement@example.com");
    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "Replacement",
      }),
    ).resolves.toMatchObject({ slot: 13 });
  });

  it("still refuses a full league whose slots are not contiguous", async () => {
    /*
      The capacity check must survive the fix, and this is the case that proves
      it rather than the contiguous one above.

      Under the old arithmetic the seat cap was enforced twice: once by
      `count(*) >= maxTeams`, and once by accident, because two joiners deriving
      the same `count + 1` collided on the unique index. `max + 1` removes the
      second, so the first has to hold on its own — including on a field with a
      hole in it, where `max(slot)` has run ahead of the count.

      Twelve teams occupying slots 1..13 with slot 5 vacated: the count says
      full, the highest slot says there is room. The count is the one that
      decides.
    */
    const fx = await setup();
    for (let i = 0; i < 13; i++) await addTestTeam(fx.client, fx.leagueId, `Team ${i}`);
    await fx.client.query("DELETE FROM teams WHERE league_id = $1 AND slot = 5", [fx.leagueId]);

    const [row] = await fx.client.query<{ n: number; hi: number }>(
      "SELECT count(*)::int AS n, max(slot)::int AS hi FROM teams WHERE league_id = $1",
      [fx.leagueId],
    );
    expect(row).toMatchObject({ n: 12, hi: 13 });

    const m = await member(fx, 1, "a@example.com");
    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "Late",
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof JoinError && e.code === "LEAGUE_FULL");
  });

  it("records the signature as a permanent proof of consent", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");
    const signature = signJoin(fx, m.address, m.secret);

    await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature,
      teamName: "A",
    });

    const proofs = await getMembershipProofs(fx.client, fx.leagueId);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.signature).toBe(signature);
    expect(proofs[0]?.rulesHash).toBe(fx.rulesHash);
    expect(proofs[0]?.walletAddress).toBe(m.address);
  });
});

describe("bots", () => {
  /**
   * A free league with one human, so a bot is both permitted and useful.
   *
   * The pot fixture above cannot hold one at all: `buildNflPprRules` forces
   * `maxBots` to zero whenever there is money, because a bot has no wallet and a
   * bot champion would leave the largest share with no recipient.
   */
  async function freeLeague(humans = 1): Promise<Fixture> {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    const commissioner = await createUser(db, "commish@example.com", "Commish");
    const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules;
    const league = await createLeague(db, NFL, {
      name: "Free League",
      commissionerId: commissioner.id,
      rules,
    });

    await recordChainAnchor(db, league.id, {
      signature: "5".repeat(88),
      cluster: "localnet",
    });

    for (let i = 0; i < humans; i++) {
      await addTestTeam(db, league.id, `Human ${i + 1}`);
    }

    return {
      client: db,
      leagueId: league.id,
      leagueName: "Free League",
      rulesHash: league.rulesHash,
      rules,
    };
  }

  describe("a league survives a removal", () => {
    /*
      Issue #73, end to end through the real product paths — no hand-crafted rows.

      `joinLeague` derived its slot from `count(*) + 1` while `addBot` used
      `max(slot) + 1`, and both removal paths hard-delete without renumbering.
      After any non-top deletion the next joiner derived an occupied slot,
      `UNIQUE (league_id, slot)` refused it, and it surfaced as `LEAGUE_FULL` —
      permanently, because joining is the only thing that would raise the count.
    */

    it("lets somebody join after a bot is removed", async () => {
      /*
        **The mandatory sequence**, not an exotic one. `drawDraftOrder` refuses
        an odd number of *rows*, so a league that squared an odd field with a bot
        and then found one more manager cannot draft until the bot goes — which
        is precisely what `removeBot` is for.
      */
      const fx = await freeLeague(3);
      await addBot(fx.client, fx.leagueId, "Robo");
      await addTestTeam(fx.client, fx.leagueId, "Human 4");

      await removeBot(fx.client, fx.leagueId);

      const m = await member(fx, 1, "late@example.com");
      const team = await joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "Late",
      });

      // The number, not merely that it resolved: `count(*) + 1` would be 5,
      // which the bot's departure left occupied. Pinning 6 is what says the
      // derivation changed rather than the symptom being papered over.
      expect(team.slot).toBe(6);
    });

    it("lets somebody join after a member is removed", async () => {
      // The second trigger, which the issue does not mention and which needs no
      // bot — so it fires in leagues that allow none.
      const fx = await freeLeague(3);
      await fx.client.query("DELETE FROM teams WHERE league_id = $1 AND slot = 2", [
        fx.leagueId,
      ]);

      const m = await member(fx, 1, "late@example.com");
      const team = await joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "Late",
      });

      expect(team.slot).toBe(4);
    });

    it("keeps join order readable across a gap", async () => {
      // The only thing anything reads `slot` for is `ORDER BY` — the draft
      // shuffle's input, standings order, a waiver tiebreak. A gap must not
      // disturb that, which is what makes gaps acceptable rather than damage to
      // be repaired by renumbering.
      const fx = await freeLeague(3);
      await fx.client.query("DELETE FROM teams WHERE league_id = $1 AND slot = 2", [
        fx.leagueId,
      ]);

      const m = await member(fx, 1, "late@example.com");
      await joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "Late",
      });

      const rows = await fx.client.query<{ name: string; slot: number }>(
        "SELECT name, slot FROM teams WHERE league_id = $1 ORDER BY slot",
        [fx.leagueId],
      );
      expect(rows.map((r) => r.name)).toEqual(["Human 1", "Human 3", "Late"]);
    });
  });

  it("adds a bot with no owner", async () => {
    const fx = await freeLeague();
    const bot = await addBot(fx.client, fx.leagueId, "Robo");

    const [row] = await fx.client.query<{ is_bot: boolean; owner_id: string | null }>(
      "SELECT is_bot, owner_id FROM teams WHERE id = $1",
      [bot.teamId],
    );
    expect(row?.is_bot).toBe(true);
    expect(row?.owner_id).toBeNull();
  });

  it("shares the slot sequence with human teams", async () => {
    const fx = await freeLeague();
    const bot = await addBot(fx.client, fx.leagueId, "Robo");

    expect(bot.slot).toBe(2);
  });

  it("records no consent, because there is nobody to consent", async () => {
    const fx = await freeLeague();
    await addBot(fx.client, fx.leagueId, "Robo");

    expect(await getMembershipProofs(fx.client, fx.leagueId)).toEqual([]);
  });

  it("does not require an anchor", async () => {
    // A bot signs nothing, stakes nothing, and consents to nothing, so there is
    // no consent for the anchor to protect.
    db = await createTestDatabase();
    await seedSport(db, NFL);

    const commissioner = await createUser(db, "unanchored@example.com", "Commish");
    const league = await createLeague(db, NFL, {
      name: "Unanchored",
      commissionerId: commissioner.id,
      rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
    });
    await addTestTeam(db, league.id, "Human");

    await expect(addBot(db, league.id, "Robo")).resolves.toMatchObject({ slot: 2 });
  });

  describe("refusals", () => {
    it("refuses a league that plays for a pot", async () => {
      // The reason the cap exists at all. A bot cannot be paid, so a bot in a
      // paying position would leave that share with nowhere to go — on-chain,
      // where there is nobody to appeal to.
      const fx = await setup();
      await addTestTeam(fx.client, fx.leagueId, "Human");

      await expect(addBot(fx.client, fx.leagueId, "Robo")).rejects.toSatisfy(
        (e: unknown) => e instanceof JoinError && e.code === "BOTS_NOT_ALLOWED",
      );
    });

    it("says why, rather than just refusing", async () => {
      const fx = await setup();
      await addTestTeam(fx.client, fx.leagueId, "Human");

      await expect(addBot(fx.client, fx.leagueId, "Robo")).rejects.toThrow(/cannot be paid/i);
    });

    it("refuses a second bot", async () => {
      // One squares an odd number of friends. More is a different game.
      const fx = await freeLeague(3);
      await addBot(fx.client, fx.leagueId, "Robo");

      await expect(addBot(fx.client, fx.leagueId, "Robo II")).rejects.toSatisfy(
        (e: unknown) => e instanceof JoinError && e.code === "BOT_LIMIT",
      );
    });

    it("refuses when the managers already make an even number", async () => {
      // A bot would then give somebody a bye rather than prevent one, which is
      // the opposite of the point.
      const fx = await freeLeague(2);

      await expect(addBot(fx.client, fx.leagueId, "Robo")).rejects.toSatisfy(
        (e: unknown) => e instanceof JoinError && e.code === "EVEN_WITHOUT_BOT",
      );
    });
  });

  describe("removeBot", () => {
    it("gives the seat back when a person turns up", async () => {
      const fx = await freeLeague();
      await addBot(fx.client, fx.leagueId, "Robo");

      await removeBot(fx.client, fx.leagueId);

      const [count] = await fx.client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM teams WHERE league_id = $1 AND is_bot",
        [fx.leagueId],
      );
      expect(Number(count?.n)).toBe(0);
    });

    it("lets a bot be added again afterwards", async () => {
      const fx = await freeLeague();
      await addBot(fx.client, fx.leagueId, "Robo");
      await removeBot(fx.client, fx.leagueId);

      await expect(addBot(fx.client, fx.leagueId, "Robo again")).resolves.toBeTruthy();
    });

    it("refuses once the draft order is drawn", async () => {
      // The order is derived from the set of teams, and a trigger locks the
      // field at the draw precisely so nobody can change it afterwards. This is
      // the check that makes deleting a team safe at all — before the draw the
      // bot has no roster, no lineup and no matchup to orphan.
      //
      // Three humans, not the default one, because the draw now refuses a field
      // below `minHumans` and a bot cannot make up the difference. Not two: a
      // bot is only permitted at an *odd* human count, so `addBot` would refuse
      // first and this test would never reach the draw it is about. Two humans
      // and no bot would also pass, and vacuously — `removeBot` checks the draw
      // before it checks whether a bot exists, so it would throw the right error
      // for the wrong reason.
      const fx = await freeLeague(3);
      await addBot(fx.client, fx.leagueId, "Robo");

      await createDraftRecord(fx.client, {
        leagueId: fx.leagueId,
        rounds: 14,
        pickSeconds: 90,
        scheduledAt: SCHEDULED,
      });
      await drawDraftOrder(fx.client, {
        leagueId: fx.leagueId,
        beacon: new FixedBeacon([
          {
            slot: 1,
            blockhash: "5xot9PVkphiX2adznghwrAuxGs2zeWisNSxMW6hU6Hkj",
            blockTime: SCHEDULED_SECONDS + 1,
          },
        ]),
        settlement: new FixedSettlementAccount(),
        now: new Date(SCHEDULED.getTime() + 5_000),
      });

      await expect(removeBot(fx.client, fx.leagueId)).rejects.toSatisfy(
        (e: unknown) => e instanceof JoinError && e.code === "DRAFT_ALREADY_DRAWN",
      );
    });

    it("refuses when the league has no bot", async () => {
      const fx = await freeLeague();

      await expect(removeBot(fx.client, fx.leagueId)).rejects.toSatisfy(
        (e: unknown) => e instanceof JoinError && e.code === "BOT_NOT_FOUND",
      );
    });
  });
});

describe("joining an unanchored league", () => {
  /** The same league, without the anchor the other fixture applies. */
  async function unanchored(): Promise<Fixture> {
    db = await createTestDatabase();
    await seedSport(db, NFL);

    const commissioner = await createUser(db, "commish@example.com", "Commish");
    const rules = buildNflPprRules({
      seasonYear: 2026,
      draft: DRAFT,
      pot: POT,
    }) as LeagueRules;

    const league = await createLeague(db, NFL, {
      name: "The Money League",
      commissionerId: commissioner.id,
      rules,
    });

    return {
      client: db,
      leagueId: league.id,
      leagueName: "The Money League",
      rulesHash: league.rulesHash,
      rules,
    };
  }

  it("is refused", async () => {
    // Joining signs the rules hash, and the point of that signature is that the
    // rules are provably fixed. Before the anchor, the only thing holding them
    // still is a row in our own database.
    const fx = await unanchored();
    const m = await member(fx, 1, "a@example.com");

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "LEAGUE_NOT_ANCHORED",
    );
  });

  it("is allowed once anchored", async () => {
    const fx = await unanchored();
    const m = await member(fx, 1, "a@example.com");

    await recordChainAnchor(fx.client, fx.leagueId, {
      signature: "5".repeat(88),
      cluster: "localnet",
    });

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
      }),
    ).resolves.toMatchObject({ slot: 1 });
  });

  it("refuses an anchor on the wrong cluster", async () => {
    // The PDA is identical on every cluster, so a devnet anchor and a mainnet
    // one are indistinguishable without saying which was meant — and a devnet
    // anchor is not an anchor for a real stake.
    const fx = await unanchored();
    const m = await member(fx, 1, "a@example.com");

    await recordChainAnchor(fx.client, fx.leagueId, {
      signature: "5".repeat(88),
      cluster: "devnet",
    });

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
        requireCluster: "mainnet-beta",
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof JoinError && e.code === "WRONG_CLUSTER");
  });

  it("accepts a matching cluster", async () => {
    const fx = await unanchored();
    const m = await member(fx, 1, "a@example.com");

    await recordChainAnchor(fx.client, fx.leagueId, {
      signature: "5".repeat(88),
      cluster: "mainnet-beta",
    });

    await expect(
      joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: "A",
        requireCluster: "mainnet-beta",
      }),
    ).resolves.toMatchObject({ slot: 1 });
  });
});

describe("on-chain stake records (issue #27)", () => {
  it("records a deposit and reads it back", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    expect(await getOnChainDeposit(fx.client, fx.leagueId, m.address)).toBeNull();

    await recordOnChainDeposit(
      fx.client,
      fx.leagueId,
      m.address,
      "50000000",
      "4".repeat(88),
      "localnet",
    );

    const recorded = await getOnChainDeposit(fx.client, fx.leagueId, m.address);
    expect(recorded).not.toBeNull();
    expect(recorded?.depositedBaseUnits).toBe("50000000");
    expect(recorded?.depositedCluster).toBe("localnet");
    expect(recorded?.refundedAt).toBeNull();
  });

  it("records a refund against the same row", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    await recordOnChainDeposit(
      fx.client,
      fx.leagueId,
      m.address,
      "50000000",
      "4".repeat(88),
      "localnet",
    );
    await recordOnChainRefund(fx.client, fx.leagueId, m.address, "7".repeat(88), "localnet");

    const recorded = await getOnChainRefund(fx.client, fx.leagueId, m.address);
    expect(recorded).not.toBeNull();
    expect(recorded?.refundedAt).not.toBeNull();
    expect(recorded?.refundSignature).toBe("7".repeat(88));
    // The deposit columns survive the refund upsert.
    expect(recorded?.depositedBaseUnits).toBe("50000000");
  });

  it("upserts a re-posted deposit rather than duplicating", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    await recordOnChainDeposit(
      fx.client,
      fx.leagueId,
      m.address,
      "50000000",
      "4".repeat(88),
      "localnet",
    );
    await recordOnChainDeposit(
      fx.client,
      fx.leagueId,
      m.address,
      "50000000",
      "9".repeat(88),
      "devnet",
    );

    const [rows] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM league_onchain_stakes WHERE league_id = $1 AND wallet_address = $2",
      [fx.leagueId, m.address],
    );
    expect(Number(rows?.n)).toBe(1);
    const recorded = await getOnChainDeposit(fx.client, fx.leagueId, m.address);
    expect(recorded?.depositedSignature).toBe("9".repeat(88));
    expect(recorded?.depositedCluster).toBe("devnet");
  });
});

describe("memberWallet", () => {
  /**
   * The ownership half of the deposit and refund routes.
   *
   * They took `walletAddress` from the request body with no check that it
   * belonged to the caller. Composed with a refund verifier that was inverted,
   * that let any signed-in account mark any staked member as refunded — so this
   * is not a hardening nicety, it is one of the two halves of that bug.
   *
   * Deriving beats validating: there is exactly one wallet a member consented
   * with, `league_memberships` already records it beside their signature over
   * the rules hash, and a caller with no way to *name* a wallet has no way to
   * name somebody else's.
   */
  it("returns the wallet a member joined with", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature: signJoin(fx, m.address, m.secret),
      teamName: "A",
    });

    expect(await memberWallet(fx.client, fx.leagueId, m.userId)).toBe(m.address);
  });

  it("returns null for a signed-in stranger", async () => {
    // Having an account is not membership. This is what turns into a 403
    // instead of the route happily operating on whatever address it was handed.
    const fx = await setup();
    const outsider = await member(fx, 2, "b@example.com");

    expect(await memberWallet(fx.client, fx.leagueId, outsider.userId)).toBeNull();
  });

  it("never returns one member's wallet for another member", async () => {
    // The attack in one line: two real members of the same league, and asking
    // for one must not answer with the other's, whatever the caller sends.
    const fx = await setup();
    const a = await member(fx, 1, "a@example.com");
    const b = await member(fx, 2, "b@example.com");

    for (const m of [a, b]) {
      await joinLeague(fx.client, {
        leagueId: fx.leagueId,
        userId: m.userId,
        walletAddress: m.address,
        signature: signJoin(fx, m.address, m.secret),
        teamName: m.address.slice(0, 6),
      });
    }

    expect(await memberWallet(fx.client, fx.leagueId, a.userId)).toBe(a.address);
    expect(await memberWallet(fx.client, fx.leagueId, b.userId)).toBe(b.address);
  });

  it("does not leak a membership across leagues", async () => {
    // The other axis. Being a member somewhere must not answer for a league you
    // are not in — otherwise a member of league A could have an on-chain record
    // written against their wallet in league B.
    const fx = await setup();
    const other = await setup();
    const m = await member(fx, 1, "a@example.com");

    await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature: signJoin(fx, m.address, m.secret),
      teamName: "A",
    });

    expect(await memberWallet(fx.client, other.leagueId, m.userId)).toBeNull();
  });
});

describe("on-chain join record (issue #26)", () => {
  /** Join the league for real, so there is a consent row to read back. */
  async function joined(
    fx: Fixture,
    seed: number,
    email: string,
  ): Promise<{ userId: string; address: string }> {
    const m = await member(fx, seed, email);
    await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature: signJoin(fx, m.address, m.secret),
      teamName: `Team ${seed}`,
    });
    return { userId: m.userId, address: m.address };
  }

  it("records and reads back a member's on-chain join", async () => {
    const fx = await setup();
    const m = await joined(fx, 1, "a@example.com");

    expect(await getOnChainJoin(fx.client, fx.leagueId, m.address)).toBeNull();

    await recordOnChainJoin(
      fx.client,
      fx.leagueId,
      m.address,
      m.userId,
      "4".repeat(88),
      "localnet",
    );

    const recorded = await getOnChainJoin(fx.client, fx.leagueId, m.address);
    expect(recorded).not.toBeNull();
    expect(recorded?.walletAddress).toBe(m.address);
    expect(recorded?.userId).toBe(m.userId);
    expect(recorded?.signature).toBe("4".repeat(88));
    expect(recorded?.cluster).toBe("localnet");
  });

  it("upserts on a re-post rather than duplicating", async () => {
    // A re-post after a lost response is the ordinary case and has to succeed.
    // This row is deliberately not write-once — see the migration header. What
    // makes it safe is that only this member's own session can write it.
    const fx = await setup();
    const m = await joined(fx, 1, "a@example.com");

    for (const [sig, cluster] of [
      ["4".repeat(88), "localnet"],
      ["9".repeat(88), "localnet"],
    ] as const) {
      await recordOnChainJoin(fx.client, fx.leagueId, m.address, m.userId, sig, cluster);
    }

    const [rows] = await fx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM league_onchain_joins WHERE league_id = $1 AND wallet_address = $2",
      [fx.leagueId, m.address],
    );
    expect(Number(rows?.n)).toBe(1);

    expect((await getOnChainJoin(fx.client, fx.leagueId, m.address))?.signature).toBe(
      "9".repeat(88),
    );
  });

  it("cannot record a join for a user who never consented", async () => {
    // The foreign key is the last line of defence behind the route, which reads
    // the wallet from the consent row rather than from the request.
    const fx = await setup();
    const m = await joined(fx, 1, "a@example.com");

    await expect(
      recordOnChainJoin(
        fx.client,
        fx.leagueId,
        m.address,
        "00000000-0000-0000-0000-000000000000",
        "4".repeat(88),
        "localnet",
      ),
    ).rejects.toThrow();
  });
});
