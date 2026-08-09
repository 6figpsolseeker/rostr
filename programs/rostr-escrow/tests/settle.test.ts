import * as anchor from "@coral-xyz/anchor";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clusterOf,
  escrowProgram,
  hexToBytes,
  initializeLeagueIx,
  joinLeagueIx,
  depositIx,
  payoutArray,
  postFinalStandingsIx,
  payoutFeeIx,
  payoutPrizeIx,
  verifyLeagueAnchor,
  verifySettlement,
} from "@rostr/escrow";
import { createLeague, createUser, recordChainAnchor, seedSport } from "@rostr/db";
import { createTestDatabase, type PGliteClient } from "@rostr/db/testing";
import {
  buildNflPprRules,
  NFL,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
} from "@rostr/core";
import {
  createPotMint,
  fundedMember,
  getProvider,
  getProgram,
  retryTx,
  sendMemberTx,
  tokenBalance,
  vaultPda,
} from "./helpers";

/**
 * Proof that issue #28 is addressed: the program now has a settlement path.
 *
 * This is the honest trust-minimized bridge, not the final trustless payout.
 * The one trusted input is `post_final_standings`, signed by the settle
 * authority (here the league creator). Everything after it — the fee, the
 * per-prize split, that each winner was a member, and that it runs once — is
 * enforced on-chain. A future on-chain score oracle would replace the authority.
 *
 * Drives the real flow on a validator: anchor, five members join + stake, the
 * authority freezes standings, then fee + five prize payments drain the vault
 * exactly per the frozen split.
 */

let program: anchor.Program;
let provider: anchor.AnchorProvider;
let mint: anchor.web3.PublicKey;
let db: PGliteClient;

const DRAFT = { type: "SNAKE", mode: "SLOW", pickSeconds: 14_400, scheduledAt: 1_756_400_000 } as const;
const BUY_IN = 23_500_000;

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  mint = await createPotMint(provider);
  db = await createTestDatabase();
  await seedSport(db, NFL);
});

async function createPotLeague(name: string, feeBps: number, feeRecipient: anchor.web3.PublicKey) {
  const commissioner = await createUser(db, `${name}@example.com`, "Commish");
  const rules = buildNflPprRules({
    seasonYear: 2026,
    draft: DRAFT,
    pot: {
      tokenMint: mint.toBase58(),
      buyInBaseUnits: String(BUY_IN),
      payout: NFL_DEFAULT_PAYOUT,
      refundUnlockAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      feeBps,
      feeRecipient: feeRecipient.toBase58(),
    },
  });
  return {
    league: await createLeague(db, NFL, { name, commissionerId: commissioner.id, rules }),
    rules,
  };
}

async function anchorLeague(leagueId: string, rulesHash: string, rules: ReturnType<typeof buildNflPprRules>) {
  const pot = rules.pot;
  if (!pot) throw new Error("expected a pot league");
  const ix = await initializeLeagueIx(program, {
    leagueId,
    rulesHash: hexToBytes(rulesHash),
    mint,
    buyInBaseUnits: pot.buyInBaseUnits,
    refundUnlockAt: pot.refundUnlockAt,
    payoutBps: payoutArray(pot.payout),
    feeBps: pot.feeBps,
    feeRecipient: new anchor.web3.PublicKey(pot.feeRecipient),
    settleAuthority: provider.wallet.publicKey,
    maxTeams: rules.league.maxTeams,
    payer: provider.wallet.publicKey,
  });
  return provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [], { commitment: "confirmed" });
}

describe("settlement bridge (issue #28)", () => {
  it("drains the vault to the frozen standings, exactly per the split", async () => {
    const feeRecipient = anchor.web3.Keypair.generate().publicKey;
    const { league, rules } = await createPotLeague("settle", 500, feeRecipient); // 5% fee (ceiling)
    const sig = await anchorLeague(league.id, league.rulesHash, rules);
    const verdict = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    expect(verdict.ok).toBe(true);
    await recordChainAnchor(db, league.id, { signature: sig, cluster: clusterOf(provider.connection) });

    // Five members, each joins on-chain and stakes the buy-in.
    const members = await Promise.all(
      [0, 1, 2, 3, 4].map(async () => {
        const m = await fundedMember(provider, mint, BUY_IN);
        const joinIx = await joinLeagueIx(program, {
          leagueId: league.id,
          rulesHash: hexToBytes(league.rulesHash),
          member: m.keypair.publicKey,
        });
        await sendMemberTx(provider, joinIx, m.keypair);
        const depIx = await depositIx(program, {
          leagueId: league.id,
          mint,
          member: m.keypair.publicKey,
        });
        await sendMemberTx(provider, depIx, m.keypair);
        return m.keypair;
      }),
    );

    const leaguePk = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("league"), Buffer.from(league.id.replace(/-/g, ""), "hex")],
      program.programId,
    )[0];
    const vault = vaultPda(program, leaguePk);
    const feeRecipientAta = await (await import("@solana/spl-token")).getAssociatedTokenAddress(
      mint,
      feeRecipient,
    );
    // The fee recipient must have a token account to receive into. The route
    // creating the payout ensures this server-side; here we set it up directly.
    await (await import("@solana/spl-token")).createAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      feeRecipient,
    );

    const total = BigInt(BUY_IN) * 5n;
    const vaultBefore = await tokenBalance(provider, vault);
    expect(vaultBefore).toBe(total);

    const bps = payoutArray(rules.pot!.payout); // [champion, runner, regular, consolation, third]
    const feeBps = rules.pot!.feeBps;
    const feeAmount = (total * BigInt(feeBps)) / 10_000n;
    const pool = total - feeAmount;

    // The settle authority (here the league creator / provider) freezes the
    // standings. members[0..4] are champion..third place.
    const postIx = await postFinalStandingsIx(program, {
      leagueId: league.id,
      winners: members.map((m) => m.publicKey),
      settleAuthority: provider.wallet.publicKey,
    });
    await retryTx(provider, () => new anchor.web3.Transaction().add(postIx));

    const settleVerdict = await verifySettlement(program, league.id);
    expect(settleVerdict.ok).toBe(true);
    if (settleVerdict.ok) {
      expect(settleVerdict.feePaid).toBe(false);
      expect(settleVerdict.winners.map((w) => w)).toEqual(members.map((m) => m.publicKey.toBase58()));
    }

    const feeRecipientBefore = await tokenBalance(provider, feeRecipientAta);

    // Pay the fee first.
    const feeIx = await payoutFeeIx(program, { leagueId: league.id, feeRecipient, mint });
    await retryTx(provider, () => new anchor.web3.Transaction().add(feeIx));

    // Pay each prize.
    for (let i = 0; i < 5; i++) {
      const ix = await payoutPrizeIx(program, {
        leagueId: league.id,
        mint,
        winner: members[i].publicKey,
        prizeIndex: i,
      });
      await retryTx(provider, () => new anchor.web3.Transaction().add(ix));
    }

    // The vault is empty.
    const vaultAfter = await tokenBalance(provider, vault);
    expect(vaultAfter).toBe(0n);

    // The fee recipient got exactly the fee.
    const feeRecipientAfter = await tokenBalance(provider, feeRecipientAta);
    expect(feeRecipientAfter - feeRecipientBefore).toBe(feeAmount);

    // Champion got strictly the most; each winner got pool * bps[i] / 10000.
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const balances = await Promise.all(
      members.map((m) =>
        tokenBalance(provider, getAssociatedTokenAddressSync(mint, m.publicKey)),
      ),
    );
    for (let i = 0; i < 5; i++) {
      expect(balances[i]).toBe((pool * BigInt(bps[i])) / 10_000n);
    }
    expect(balances[0]).toBeGreaterThan(balances[1]); // champion > runner-up

    // Settlement is now complete and idempotent: a second payout_prize refuses.
    const dupIx = await payoutPrizeIx(program, {
      leagueId: league.id,
      mint,
      winner: members[0].publicKey,
      prizeIndex: 0,
    });
    const dupTx = new anchor.web3.Transaction().add(dupIx);
    await expect(provider.sendAndConfirm(dupTx, [], { commitment: "confirmed" })).rejects.toSatisfy(
      (e: unknown) => String(e).includes("already"),
    );
  });
});
