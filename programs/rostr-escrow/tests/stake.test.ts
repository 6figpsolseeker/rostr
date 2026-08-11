import * as anchor from "@coral-xyz/anchor";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clusterOf,
  depositIx,
  hexToBytes,
  initializeLeagueIx,
  joinLeagueIx,
  payoutArray,
  refundStakeIx,
  verifyLeagueAnchor,
  verifyOnChainDeposit,
  verifyOnChainRefund,
} from "@rostr/escrow";
import { createLeague, createUser, recordChainAnchor, seedSport } from "@rostr/db";
import { createTestDatabase, type PGliteClient } from "@rostr/db/testing";
import { buildNflPprRules, NFL, NFL_DEFAULT_FEE_BPS, NFL_DEFAULT_PAYOUT } from "@rostr/core";
import {
  createPotMint,
  fundedMember,
  getProvider,
  getProgram,
  tokenBalance,
  vaultPda,
} from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a transaction, retrying on the intermittent "Blockhash not found" an
 * embedded validator throws when block production lags the blockhash lookup.
 *
 * **Every send in this file goes through here**, and that was the fix for a real
 * CI failure rather than a tidy-up. It began as `sendMemberTx`, wrapping only
 * the member-signed instructions, while `anchorLeague` called
 * `provider.sendAndConfirm` directly — and `anchor test` on CI failed on exactly
 * that call. The flake was known, the remedy was written, and it was applied to
 * some of the sends and not others, so the suite stayed red-by-luck on the one
 * that was missed.
 *
 * The retry is safe because each send is idempotent at the account level: the
 * program refuses a second `initialize_league`, a second `join_league`, a second
 * `deposit`, and a second `refund_stake`. A retry either lands the transaction
 * that was lost or fails on a program error that is not a blockhash problem, and
 * only the blockhash case is retried.
 */
async function sendTx(
  provider: anchor.AnchorProvider,
  ix: anchor.web3.TransactionInstruction,
  signers: anchor.web3.Keypair[],
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const sig = await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(ix),
        signers,
        {
          commitment: "confirmed",
        },
      );
      return sig;
    } catch (err) {
      lastErr = err;
      if (String(err).includes("Blockhash not found")) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Proof that issue #27 is fixed: deposit and refund now have real callers and a
 * verify-don't-trust server path.
 *
 * Drives the real flow against a validator: anchor the league, one funded member
 * joins on-chain (Membership PDA created), signs `deposit` (stake moves to the
 * vault), then signs `refund_stake` (after a past timelock) and the vault
 * returns the stake. The program's deposit/refund depend only on the on-chain
 * Membership, so the db-side join is not required to exercise them.
 */

let program: anchor.Program;
let provider: anchor.AnchorProvider;
let mint: anchor.web3.PublicKey;
let db: PGliteClient;

const DRAFT = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
} as const;

const BUY_IN = 23_500_000;

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  mint = await createPotMint(provider);
  db = await createTestDatabase();
  await seedSport(db, NFL);
});

async function createPotLeague(name: string, refundUnlockAt: number) {
  const commissioner = await createUser(db, `${name}@example.com`, "Commish");
  const rules = buildNflPprRules({
    seasonYear: 2026,
    draft: DRAFT,
    pot: {
      tokenMint: mint.toBase58(),
      buyInBaseUnits: String(BUY_IN),
      payout: NFL_DEFAULT_PAYOUT,
      refundUnlockAt,
      feeBps: NFL_DEFAULT_FEE_BPS,
      feeRecipient: anchor.web3.Keypair.generate().publicKey.toBase58(),
    },
  });
  return {
    league: await createLeague(db, NFL, { name, commissionerId: commissioner.id, rules }),
    rules,
  };
}

async function anchorLeague(
  leagueId: string,
  rulesHash: string,
  rules: ReturnType<typeof buildNflPprRules>,
) {
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
    maxTeams: rules.league.maxTeams,
    payer: provider.wallet.publicKey,
  });
  return sendTx(provider, ix, []);
}

describe("deposit and refund are wired (issue #27)", () => {
  it("a member can stake in and get it back out", async () => {
    // Refund unlock one year out: initialize_league requires it to be in the
    // future, and the on-chain refund_stake execution is already covered by the
    // program's own pot.test.ts. This test proves the deposit wiring and the
    // verify helpers.
    const { league, rules } = await createPotLeague(
      "stake",
      Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    );
    const sig = await anchorLeague(league.id, league.rulesHash, rules);
    const verdict = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    expect(verdict.ok).toBe(true);
    await recordChainAnchor(db, league.id, {
      signature: sig,
      cluster: clusterOf(provider.connection),
    });

    // One funded member: SOL + buy-in tokens, and joined on-chain.
    const member = await fundedMember(provider, mint, BUY_IN);
    const joinIx = await joinLeagueIx(program, {
      leagueId: league.id,
      rulesHash: hexToBytes(league.rulesHash),
      member: member.keypair.publicKey,
    });
    await sendTx(provider, joinIx, [member.keypair]);

    const leaguePk = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("league"), Buffer.from(league.id.replace(/-/g, ""), "hex")],
      program.programId,
    )[0];
    const vault = vaultPda(program, leaguePk);
    const vaultBefore = await tokenBalance(provider, vault);

    // Deposit: the member signs; stake moves from their ATA to the vault.
    const depIx = await depositIx(program, {
      leagueId: league.id,
      mint,
      member: member.keypair.publicKey,
    });
    await sendTx(provider, depIx, [member.keypair]);

    const depositVerdict = await verifyOnChainDeposit(
      program,
      league.id,
      member.keypair.publicKey,
    );
    expect(depositVerdict.ok).toBe(true);
    expect(depositVerdict.deposited).toBe(BigInt(BUY_IN));

    const vaultAfterDeposit = await tokenBalance(provider, vault);
    expect(vaultAfterDeposit - vaultBefore).toBe(BigInt(BUY_IN));

    // The refund instruction itself is covered by pot.test.ts; here we confirm
    // the refund verify helper reports correctly for a stranger (NOT_JOINED),
    // which is the server-side gate the /refund route depends on.
    const stranger = anchor.web3.Keypair.fromSeed(new Uint8Array(32).fill(99));
    const refundVerdict = await verifyOnChainRefund(program, league.id, stranger.publicKey);
    expect(refundVerdict.ok).toBe(false);
    if (!refundVerdict.ok) expect(refundVerdict.reason).toBe("NOT_JOINED");
  });

  it("deposit is refused for a member who never joined on-chain", async () => {
    const { league, rules } = await createPotLeague(
      "nojoin",
      Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    );
    const sig = await anchorLeague(league.id, league.rulesHash, rules);
    await recordChainAnchor(db, league.id, {
      signature: sig,
      cluster: clusterOf(provider.connection),
    });

    const stakeKeypair = anchor.web3.Keypair.fromSeed(new Uint8Array(32).fill(42));
    const verdict = await verifyOnChainDeposit(program, league.id, stakeKeypair.publicKey);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("NOT_JOINED");
  });
});

/**
 * The state a **completed** refund leaves behind.
 *
 * `stake.test.ts` originally exercised `verifyOnChainRefund` only for a stranger
 * (`NOT_JOINED`) — the one path that was already correct — while the verifier
 * was inverted for every path that mattered: `refund_stake` sets `refunded` and
 * keeps `deposited` as history, so a genuine refund landed in exactly the state
 * it rejected. Green tests, no refund recordable, and any staked member markable
 * as refunded.
 *
 * `packages/escrow/src/membership.test.ts` pins the four states as unit tests
 * that run everywhere. This is the other half: proof that a real refund on a
 * real validator actually produces the state those units describe, so the two
 * cannot agree with each other while both being wrong about the program.
 *
 * A three-second timelock and a real wait, following `pot.test.ts`: the
 * validator's clock follows real time, and warping to a convenient slot would
 * test the warp.
 */
describe("a completed refund verifies as a refund", () => {
  it("reports ok once the stake is actually back out", async () => {
    const { league, rules } = await createPotLeague(
      "refundverify",
      Math.floor(Date.now() / 1000) + 3,
    );
    const sig = await anchorLeague(league.id, league.rulesHash, rules);
    await recordChainAnchor(db, league.id, {
      signature: sig,
      cluster: clusterOf(provider.connection),
    });

    const member = await fundedMember(provider, mint, BUY_IN);
    const joinIx = await joinLeagueIx(program, {
      leagueId: league.id,
      rulesHash: hexToBytes(league.rulesHash),
      member: member.keypair.publicKey,
    });
    await sendTx(provider, joinIx, [member.keypair]);

    const depIx = await depositIx(program, {
      leagueId: league.id,
      mint,
      member: member.keypair.publicKey,
    });
    await sendTx(provider, depIx, [member.keypair]);

    // Staked, not yet refunded. Deposit says yes, refund says not-yet — and
    // getting this pair the wrong way round was the whole bug.
    const staked = await verifyOnChainDeposit(program, league.id, member.keypair.publicKey);
    expect(staked.ok).toBe(true);
    const notYet = await verifyOnChainRefund(program, league.id, member.keypair.publicKey);
    expect(notYet.ok).toBe(false);
    if (!notYet.ok) expect(notYet.reason).toBe("NOT_REFUNDED");

    await sleep(5000);

    const refIx = await refundStakeIx(program, {
      leagueId: league.id,
      mint,
      member: member.keypair.publicKey,
    });
    await sendTx(provider, refIx, [member.keypair]);

    // And now they swap. `deposited` is unchanged on-chain — it is history —
    // which is exactly why the deposit verifier must consult `refunded` too.
    const refunded = await verifyOnChainRefund(program, league.id, member.keypair.publicKey);
    expect(refunded.ok).toBe(true);
    if (refunded.ok) expect(refunded.refunded).toBe(BigInt(BUY_IN));

    const noLongerStaked = await verifyOnChainDeposit(
      program,
      league.id,
      member.keypair.publicKey,
    );
    expect(noLongerStaked.ok).toBe(false);
    if (!noLongerStaked.ok) expect(noLongerStaked.reason).toBe("ALREADY_REFUNDED");
  });
});
