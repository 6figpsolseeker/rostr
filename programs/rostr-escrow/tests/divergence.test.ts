import * as anchor from "@coral-xyz/anchor";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clusterOf,
  hexToBytes,
  initializeLeagueIx,
  joinLeagueIx,
  payoutArray,
  verifyLeagueAnchor,
  verifyOnChainJoin,
} from "@rostr/escrow";
import {
  createLeague,
  createUser,
  getOnChainJoin,
  joinLeague,
  linkWallet,
  recordChainAnchor,
  recordOnChainJoin,
  seedSport,
} from "@rostr/db";
import { createTestDatabase, testWallet, type PGliteClient } from "@rostr/db/testing";
import {
  buildJoinMessage,
  buildNflPprRules,
  NFL,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
} from "@rostr/core";
import {
  createPotMint,
  getProgram,
  getProvider,
  membershipPda,
  refundUnlockFor,
} from "./helpers";

/**
 * Proof that issue #26 is fixed: the on-chain join now has a real caller.
 *
 * The fix adds the on-chain half of joining (a `verifyOnChainJoin` check plus a
 * `/join-onchain` route that records it, and a `JoinPanel` step that signs
 * `join_league`). This drives the real flow end to end — `joinLeague` in
 * Postgres, then the member signs `joinLeagueIx` and the server verifies the
 * `Membership` PDA — against a real validator, and asserts the membership now
 * exists and the db record persists.
 */

let program: anchor.Program;
let provider: anchor.AnchorProvider;
let mint: anchor.web3.PublicKey;
let db: PGliteClient;

const DRAFT = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
} as const;

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  mint = await createPotMint(provider);
  db = await createTestDatabase();
  await seedSport(db, NFL);
});

async function createPotLeague(name: string) {
  const commissioner = await createUser(db, `${name}@example.com`, "Commish");
  const rules = buildNflPprRules({
    seasonYear: 2026,
    draft: DRAFT,
    pot: {
      tokenMint: mint.toBase58(),
      buyInBaseUnits: "23500000",
      payout: NFL_DEFAULT_PAYOUT,
      refundUnlockAt: refundUnlockFor(DRAFT.scheduledAt),
      feeBps: NFL_DEFAULT_FEE_BPS,
      feeRecipient: anchor.web3.Keypair.generate().publicKey.toBase58(),
    },
  });
  return {
    league: await createLeague(db, NFL, { name, commissionerId: commissioner.id, rules }),
    rules,
  };
}

async function anchorOnChain(
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
    draftScheduledAt: DRAFT.scheduledAt,
    payoutBps: payoutArray(pot.payout),
    feeBps: pot.feeBps,
    feeRecipient: new anchor.web3.PublicKey(pot.feeRecipient),
    maxTeams: rules.league.maxTeams,
    payer: provider.wallet.publicKey,
  });
  return provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [], {
    commitment: "confirmed",
  });
}

describe("on-chain join is now wired (issue #26)", () => {
  it("a member who signs join_league gets a real Membership account", async () => {
    const { league, rules } = await createPotLeague("fixed");
    const sig = await anchorOnChain(league.id, league.rulesHash, rules);
    const verdict = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    expect(verdict.ok).toBe(true);
    await recordChainAnchor(db, league.id, {
      signature: sig,
      cluster: clusterOf(provider.connection),
    });

    const wallet = testWallet(31);
    const user = await createUser(db, "fixed-member@example.com", "Member");
    await linkWallet(db, user.id, wallet.address);

    const message = buildJoinMessage({
      leagueId: league.id,
      leagueName: "fixed",
      rulesHash: league.rulesHash,
      walletAddress: wallet.address,
      seasonYear: 2026,
    });
    await joinLeague(db, {
      leagueId: league.id,
      userId: user.id,
      teamName: "Member",
      walletAddress: wallet.address,
      signature: wallet.sign(message),
      requireCluster: clusterOf(provider.connection),
    });

    // The member signs join_league from their own wallet — the step that was
    // missing before the fix. The member must be a signer and pays the rent for
    // the new Membership account, so fund it first.
    const memberKeypair = anchor.web3.Keypair.fromSeed(new Uint8Array(32).fill(31));
    const airdrop = await provider.connection.requestAirdrop(
      memberKeypair.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: airdrop, ...bh }, "confirmed");

    const ix = await joinLeagueIx(program, {
      leagueId: league.id,
      rulesHash: hexToBytes(league.rulesHash),
      member: memberKeypair.publicKey,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [memberKeypair], {
      commitment: "confirmed",
    });

    // The server side does not trust the client: it reads the Membership PDA
    // back. This is exactly what the /join-onchain route does.
    const joinVerdict = await verifyOnChainJoin(
      program,
      league.id,
      new anchor.web3.PublicKey(wallet.address),
    );
    expect(joinVerdict.ok).toBe(true);

    // And the db record persists. The route derives the wallet from the
    // caller's own consent row rather than accepting one in the body, so the
    // user id is part of the record and is what makes the row attributable.
    await recordOnChainJoin(
      db,
      league.id,
      wallet.address,
      user.id,
      "3".repeat(88),
      clusterOf(provider.connection),
    );
    const recorded = await getOnChainJoin(db, league.id, wallet.address);
    expect(recorded).not.toBeNull();
    expect(recorded?.walletAddress).toBe(wallet.address);
    expect(recorded?.userId).toBe(user.id);
  });

  it("member_count increments on-chain after the join", async () => {
    const { league, rules } = await createPotLeague("count");
    const sig = await anchorOnChain(league.id, league.rulesHash, rules);
    await recordChainAnchor(db, league.id, {
      signature: sig,
      cluster: clusterOf(provider.connection),
    });

    const wallet = testWallet(32);
    const user = await createUser(db, "count-member@example.com", "Member");
    await linkWallet(db, user.id, wallet.address);

    const message = buildJoinMessage({
      leagueId: league.id,
      leagueName: "count",
      rulesHash: league.rulesHash,
      walletAddress: wallet.address,
      seasonYear: 2026,
    });
    await joinLeague(db, {
      leagueId: league.id,
      userId: user.id,
      teamName: "Member",
      walletAddress: wallet.address,
      signature: wallet.sign(message),
      requireCluster: clusterOf(provider.connection),
    });

    const ix = await joinLeagueIx(program, {
      leagueId: league.id,
      rulesHash: hexToBytes(league.rulesHash),
      member: new anchor.web3.PublicKey(wallet.address),
    });
    const memberKeypair = anchor.web3.Keypair.fromSeed(new Uint8Array(32).fill(32));
    const airdrop = await provider.connection.requestAirdrop(
      memberKeypair.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: airdrop, ...bh }, "confirmed");
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [memberKeypair], {
      commitment: "confirmed",
    });

    const onChain = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    if (onChain.ok) {
      expect(onChain.league.memberCount).toBe(1);
    } else {
      throw new Error("league anchor missing after join");
    }

    // Referential sanity: the Membership PDA the program created is the one our
    // client derives.
    const leaguePk = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("league"), Buffer.from(league.id.replace(/-/g, ""), "hex")],
      program.programId,
    )[0];
    const memberPk = membershipPda(
      program,
      leaguePk,
      new anchor.web3.PublicKey(wallet.address),
    );
    const accountInfo = await provider.connection.getAccountInfo(memberPk);
    expect(accountInfo).not.toBeNull();
  });
});
