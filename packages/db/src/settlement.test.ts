import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { buildNflPprRules, NFL, NFL_DEFAULT_FEE_BPS, NFL_DEFAULT_PAYOUT } from "@rostr/core";
import type { DraftRules, LeagueRules, PotRules } from "@rostr/core";
import { createLeague } from "./leagues.js";
import { createUser, linkWallet } from "./identity.js";
import { seedSport } from "./sports.js";
import { settlementPlan, SettlementPlanError } from "./settlement.js";
import { addTestTeam, createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

/**
 * The contents of a league's settlement account, derived rather than chosen.
 *
 * These are the values a commissioner signs and the draw then re-derives and
 * compares. **The two derivations must agree**, and they live in different
 * packages — this one in `@rostr/db` and `expectedScoreTerms` in
 * `@rostr/escrow` — so a disagreement would refuse an account this very function
 * produced. The bye count is the field where that is most likely, and it has its
 * own case below.
 */

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const SCHEDULED = new Date(Math.floor(Date.now() / 1000) * 1000 + 30 * 24 * 3600 * 1000);
const SCHEDULED_SECONDS = Math.floor(SCHEDULED.getTime() / 1000);

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: SCHEDULED_SECONDS,
};

const ORACLE = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";

const POT: PotRules = {
  tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  buyInBaseUnits: "10000000",
  payout: NFL_DEFAULT_PAYOUT,
  refundUnlockAt: SCHEDULED_SECONDS + 200 * 24 * 3600,
  feeBps: NFL_DEFAULT_FEE_BPS,
  feeRecipient: "6dNUCTMTgoHhbfgDzKtiPvBpJ2LzMwGqBpKmUDgQtNMK",
  settlementOracle: ORACLE,
};

async function league(teamCount: number, pot: PotRules | null = POT) {
  db = await createTestDatabase();
  await seedSport(db, NFL);
  const commissioner = await createUser(db, "commish@example.com", "Commish");
  const rules = buildNflPprRules({
    seasonYear: 2026,
    draft: DRAFT,
    ...(pot ? { pot } : {}),
  }) as LeagueRules;

  const created = await createLeague(db, NFL, {
    name: "Money League",
    commissionerId: commissioner.id,
    rules,
  });

  for (let i = 0; i < teamCount; i++) {
    const team = await addTestTeam(db, created.id, `Team ${i + 1}`);
    // `addTestTeam` produces the rows a real join produces minus the signature,
    // and a settlement roster needs the wallet behind each of them.
    const user = await createUser(db, `member${i}@example.com`, `Member ${i}`);
    // A real key, because `linkWallet` decodes it. Deterministic per index so a
    // failure names the same wallet every run.
    const address = bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(i + 1)));
    await linkWallet(db, user.id, address);
    const [wallet] = await db.query<{ id: string }>(
      "SELECT id FROM wallets WHERE address = $1",
      [address],
    );
    await db.query(
      `INSERT INTO league_memberships (league_id, user_id, team_id, wallet_id, rules_hash, signature)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [created.id, user.id, team.teamId, wallet!.id, created.rulesHash, "sig"],
    );
  }

  return { client: db, leagueId: created.id };
}

describe("settlementPlan", () => {
  it("pairs every team with the wallet its prize would be paid to", async () => {
    // The pairing nothing on-chain otherwise holds, and the entire reason the
    // settlement account exists.
    const fx = await league(4);
    const plan = await settlementPlan(fx.client, fx.leagueId);

    expect(plan.roster).toHaveLength(4);
    for (const entry of plan.roster) {
      expect(entry.wallet.length).toBeGreaterThan(30);
      expect(entry.teamId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Distinct wallets: two teams sharing a payee would send both prizes to one
    // person, and the program refuses it — but the plan should never produce it.
    expect(new Set(plan.roster.map((e) => e.wallet)).size).toBe(4);
  });

  it("carries the terms from the signed rules, not from anywhere else", async () => {
    const fx = await league(4);
    const plan = await settlementPlan(fx.client, fx.leagueId);

    expect(plan.oracle).toBe(ORACLE);
    expect(plan.tiebreakers).toEqual([
      "WIN_PCT",
      "POINTS_FOR",
      "HEAD_TO_HEAD",
      "POINTS_AGAINST",
      "LOWEST_TEAM_ID",
    ]);
    expect(plan.playoffWeeks).toEqual([15, 16, 17]);
    expect(plan.regularSeasonWeeks).toBe(14);
    expect(plan.playoffTeams).toBe(6);
    expect(plan.thirdPlace).toBe(true);
  });

  it("derives the bye count from the field that actually formed", async () => {
    /*
      The one value that is not a straight copy, and the one the draw is most
      likely to disagree with. `expectedScoreTerms` in `@rostr/escrow` makes the
      same choice from the same inputs; if these two ever diverge, the draw
      refuses an account this function produced and the league cannot play.

      Four teams in a six-seat playoff is a derived count of zero; six teams is
      the signed `byeSeeds` of two.
    */
    const small = await league(4);
    expect((await settlementPlan(small.client, small.leagueId)).firstRoundByes).toBe(0);
    await small.client.close();

    const full = await league(6);
    expect((await settlementPlan(full.client, full.leagueId)).firstRoundByes).toBe(2);
  });

  it("refuses a free league, which has nothing to settle", async () => {
    const fx = await league(4, null);
    await expect(settlementPlan(fx.client, fx.leagueId)).rejects.toMatchObject({
      code: "NOT_A_POT_LEAGUE",
    });
  });

  it("refuses a team with no wallet rather than writing a payee that cannot be paid", async () => {
    // Unreachable through the front door — a pot league is joined by signing
    // from a wallet — and refused anyway, because the account is write-once and
    // a prize with nowhere to go could never be corrected.
    const fx = await league(2);
    await fx.client.query("DELETE FROM league_memberships WHERE league_id = $1", [fx.leagueId]);

    await expect(settlementPlan(fx.client, fx.leagueId)).rejects.toMatchObject({
      code: "TEAM_WITHOUT_WALLET",
    });
  });

  it("refuses a league with no teams", async () => {
    const fx = await league(0);
    await expect(settlementPlan(fx.client, fx.leagueId)).rejects.toSatisfy(
      (error: unknown) => error instanceof SettlementPlanError && error.code === "NO_TEAMS",
    );
  });
});
