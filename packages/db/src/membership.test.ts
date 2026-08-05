import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { buildJoinMessage, buildNflPprRules, NFL, NFL_DEFAULT_PAYOUT } from "@rostr/core";
import type { DraftRules, LeagueRules, PotRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser, linkWallet } from "./identity.js";
import { addBot, getMembershipProofs, JoinError, joinLeague } from "./membership.js";
import { seedSport } from "./sports.js";
import { createTestDatabase } from "./testing.js";
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
  scheduledAt: 1_756_400_000,
};

const POT: PotRules = {
  tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  buyInBaseUnits: "50000000",
  payout: NFL_DEFAULT_PAYOUT,
  refundUnlockAt: 1_773_000_000,
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
    for (let i = 0; i < 12; i++) await addBot(fx.client, fx.leagueId, `Bot ${i}`);

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

describe("addBot", () => {
  it("adds a bot with no owner", async () => {
    const fx = await setup();
    const bot = await addBot(fx.client, fx.leagueId, "Robo");

    const [row] = await fx.client.query<{ is_bot: boolean; owner_id: string | null }>(
      "SELECT is_bot, owner_id FROM teams WHERE id = $1",
      [bot.teamId],
    );
    expect(row?.is_bot).toBe(true);
    expect(row?.owner_id).toBeNull();
  });

  it("shares the slot sequence with human teams", async () => {
    const fx = await setup();
    const m = await member(fx, 1, "a@example.com");

    await joinLeague(fx.client, {
      leagueId: fx.leagueId,
      userId: m.userId,
      walletAddress: m.address,
      signature: signJoin(fx, m.address, m.secret),
      teamName: "A",
    });
    const bot = await addBot(fx.client, fx.leagueId, "Robo");

    expect(bot.slot).toBe(2);
  });

  it("records no consent, because there is nobody to consent", async () => {
    const fx = await setup();
    await addBot(fx.client, fx.leagueId, "Robo");
    expect(await getMembershipProofs(fx.client, fx.leagueId)).toEqual([]);
  });

  it("refuses to exceed maxTeams", async () => {
    const fx = await setup();
    for (let i = 0; i < 12; i++) await addBot(fx.client, fx.leagueId, `Bot ${i}`);

    await expect(addBot(fx.client, fx.leagueId, "One too many")).rejects.toSatisfy(
      (e: unknown) => e instanceof JoinError && e.code === "LEAGUE_FULL",
    );
  });
});
