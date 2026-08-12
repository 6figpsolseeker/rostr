import { randomUUID } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccount, createMint } from "@solana/spl-token";
import {
  depositIx,
  escrowProgram,
  initializeFreeLeagueIx,
  initializeLeagueIx,
  joinLeagueIx,
  leaguePda as clientLeaguePda,
  payoutArray,
  refundStakeIx,
  vaultPda as clientVaultPda,
} from "@rostr/escrow";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type FreeLeagueArgs,
  type InitArgs,
  MINT_DECIMALS,
  type Member,
  createPotMint,
  expectError,
  fundedMember,
  getProgram,
  getProvider,
  leaguePda,
  membershipPda,
  tokenBalance,
  validArgs,
  validFreeArgs,
  vaultPda,
} from "./helpers";

/**
 * D3, D4, D5 — joining, staking, and the timelock refund.
 *
 * The refund tests are the ones that matter most. Everything else in this
 * program can be wrong and recoverable; funds that cannot be withdrawn are not.
 */

const BUY_IN = 10_000_000;

let program: anchor.Program;
let provider: anchor.AnchorProvider;
let mint: anchor.web3.PublicKey;

const initialize = async (args: InitArgs): Promise<anchor.web3.PublicKey> => {
  const league = leaguePda(program, args.leagueId);
  await program.methods
    .initializeLeague(args)
    .accounts({
      league,
      mint,
      vault: vaultPda(program, league),
      payer: provider.wallet.publicKey,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  return league;
};

const join = async (league: anchor.web3.PublicKey, member: Member, rulesHash: number[]) =>
  program.methods
    .joinLeague(rulesHash)
    .accounts({
      league,
      membership: membershipPda(program, league, member.keypair.publicKey),
      member: member.keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([member.keypair])
    .rpc();

const deposit = async (
  league: anchor.web3.PublicKey,
  member: Member,
  tokenAccount?: anchor.web3.PublicKey,
) =>
  program.methods
    .deposit()
    .accounts({
      league,
      membership: membershipPda(program, league, member.keypair.publicKey),
      vault: vaultPda(program, league),
      memberTokenAccount: tokenAccount ?? member.tokenAccount,
      member: member.keypair.publicKey,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    })
    .signers([member.keypair])
    .rpc();

const refund = async (league: anchor.web3.PublicKey, member: Member) =>
  program.methods
    .refundStake()
    .accounts({
      league,
      membership: membershipPda(program, league, member.keypair.publicKey),
      vault: vaultPda(program, league),
      memberTokenAccount: member.tokenAccount,
      member: member.keypair.publicKey,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    })
    .signers([member.keypair])
    .rpc();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  mint = await createPotMint(provider);
});

describe("join_league", () => {
  it("records a membership against the accepted rules hash", async () => {
    const args = validArgs();
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);

    await join(league, member, args.rulesHash);

    const membership = await program.account.membership.fetch(
      membershipPda(program, league, member.keypair.publicKey),
    );
    expect(membership.league.toBase58()).toBe(league.toBase58());
    expect(membership.member.toBase58()).toBe(member.keypair.publicKey.toBase58());
    expect(membership.deposited.toString()).toBe("0");
    expect(membership.refunded).toBe(false);

    const account = await program.account.league.fetch(league);
    expect(account.memberCount).toBe(1);
  });

  /**
   * The whole point of D3. A client that showed one rule set cannot enrol
   * someone under another, because the member signs a transaction naming the
   * hash and the program compares it to the league's.
   */
  it("rejects a rules hash that is not the league's", async () => {
    const args = validArgs();
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);

    const wrong = [...args.rulesHash];
    wrong[0] = (wrong[0] + 1) % 256;

    await expectError(join(league, member, wrong), "RulesHashMismatch");
  });

  it("will not seat the same member twice", async () => {
    const args = validArgs();
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);

    await join(league, member, args.rulesHash);
    // The membership PDA is seeded by league and member, so a second join
    // collides with an existing account rather than needing its own check.
    await expect(join(league, member, args.rulesHash)).rejects.toThrow();
  });

  it("seats past the declared size rather than refusing, and that is the fix for #18", async () => {
    // This asserted `LeagueFull` until 2026-08-11. The check it tested guarded a
    // guest list the program cannot read: being *in a league* is a Postgres fact
    // and a `Membership` here only means "this wallet has a stake", so seats went
    // first-come to anyone on the internet while the real roster was decided
    // elsewhere. At roughly 0.011 SOL for twelve, and with no instruction that
    // closes a `Membership` or decrements `member_count`, claiming them all
    // bricked a league permanently.
    //
    // Size is enforced in `joinLeague` against the actual roster, and always was.
    const args = validArgs({ maxTeams: 2 });
    const league = await initialize(args);

    for (let i = 0; i < 2; i++) {
      await join(league, await fundedMember(provider, mint, BUY_IN), args.rulesHash);
    }

    const extra = await fundedMember(provider, mint, BUY_IN);
    await join(league, extra, args.rulesHash);

    const account = await program.account.league.fetch(league);
    expect(account.memberCount).toBe(3);
    // Still published, still compared against the signed rules by
    // `anchorTermMismatches`. Disclosure, not a gate.
    expect(account.maxTeams).toBe(2);
  });

  // NOT TESTED, deliberately: that `member_count` saturates at 255 instead of
  // erroring. Reaching it needs 255 real transactions against a validator, which
  // is minutes of CI for one assertion — and `checked_add` there would be the
  // same denial vector the seat cap was, so the reasoning is recorded in
  // `join_league` where the one line lives rather than pretended at here.
});

describe("deposit", () => {
  it("moves exactly the buy-in into the vault", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);
    await join(league, member, args.rulesHash);

    await deposit(league, member);

    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(BigInt(BUY_IN));
    expect(await tokenBalance(provider, member.tokenAccount)).toBe(0n);

    const membership = await program.account.membership.fetch(
      membershipPda(program, league, member.keypair.publicKey),
    );
    expect(membership.deposited.toString()).toBe(String(BUY_IN));

    const account = await program.account.league.fetch(league);
    expect(account.totalDeposited.toString()).toBe(String(BUY_IN));
  });

  it("will not take a second stake from the same member", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    // Funded for two buy-ins, so the rejection is the program's rule and not
    // simply an empty wallet.
    const member = await fundedMember(provider, mint, BUY_IN * 2);
    await join(league, member, args.rulesHash);

    await deposit(league, member);
    await expectError(deposit(league, member), "AlreadyDeposited");

    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(BigInt(BUY_IN));
  });

  it("rejects a stake in a different token", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);
    await join(league, member, args.rulesHash);

    // A whole other mint — an "index fund with price risk", in the words of
    // docs/RULES.md § 7, is what accepting this would create.
    const otherMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      MINT_DECIMALS,
    );
    const otherAccount = await createAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      otherMint,
      member.keypair.publicKey,
    );

    await expectError(deposit(league, member, otherAccount), "WrongMint");
  });

  it("rejects staking out of someone else's token account", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);
    const victim = await fundedMember(provider, mint, BUY_IN);
    await join(league, member, args.rulesHash);

    await expectError(deposit(league, member, victim.tokenAccount), "NotTokenOwner");
    expect(await tokenBalance(provider, victim.tokenAccount)).toBe(BigInt(BUY_IN));
  });

  it("rejects a stake from someone who never joined", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const stranger = await fundedMember(provider, mint, BUY_IN);

    // No membership account exists, so there is nothing to deposit against.
    await expect(deposit(league, stranger)).rejects.toThrow();
  });

  it("rejects a stake in a league that plays for nothing", async () => {
    const args: FreeLeagueArgs = validFreeArgs();
    const league = leaguePda(program, args.leagueId);
    await program.methods
      .initializeFreeLeague(args)
      .accounts({
        league,
        payer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const member = await fundedMember(provider, mint, BUY_IN);
    await join(league, member, args.rulesHash);

    // A free league has no vault at all, so this fails on account resolution
    // before `LeagueHasNoPot` is ever reached — which is the stronger outcome.
    await expect(deposit(league, member)).rejects.toThrow();
    expect(await tokenBalance(provider, member.tokenAccount)).toBe(BigInt(BUY_IN));
  });
});

/**
 * The whole money lifecycle driven by `@rostr/escrow` rather than by the raw
 * Anchor calls the rest of this file uses.
 *
 * This is what the web app will actually run, so it is worth exercising against
 * the real program rather than trusting that the account lists match. A wrong
 * account order or a missing signer here is a runtime failure with someone's
 * stake in it; there is no type that catches it.
 */
describe("the @rostr/escrow client", () => {
  it("anchors, joins, stakes and refunds a league end to end", async () => {
    const client = escrowProgram(provider);
    const leagueId = randomUUID();
    const rulesHash = new Uint8Array(32).fill(7);
    const unlockAt = Math.floor(Date.now() / 1000) + 3;

    const send = async (ix: anchor.web3.TransactionInstruction, signer?: Member) => {
      const tx = new anchor.web3.Transaction().add(ix);
      return provider.sendAndConfirm(tx, signer ? [signer.keypair] : []);
    };

    // 1. The commissioner anchors the league from their own wallet. No key of
    //    ours is involved at any point in this test.
    await send(
      await initializeLeagueIx(client, {
        leagueId,
        rulesHash,
        mint,
        buyInBaseUnits: String(BUY_IN),
        refundUnlockAt: unlockAt,
        payoutBps: payoutArray([
          { prize: "CHAMPION", basisPoints: 6000 },
          { prize: "RUNNER_UP", basisPoints: 1500 },
          { prize: "REGULAR_SEASON", basisPoints: 1000 },
          { prize: "CONSOLATION", basisPoints: 1000 },
          { prize: "THIRD_PLACE", basisPoints: 500 },
        ]),
        feeBps: 100,
        feeRecipient: anchor.web3.Keypair.generate().publicKey,
        maxTeams: 12,
        payer: provider.wallet.publicKey,
      }),
    );

    const league = clientLeaguePda(leagueId);
    const onChain = await program.account.league.fetch(league);
    expect([...onChain.rulesHash]).toEqual([...rulesHash]);
    expect(onChain.feeBps).toBe(100);

    // 2. A member joins by accepting the hash, then stakes.
    const member = await fundedMember(provider, mint, BUY_IN);
    await send(
      await joinLeagueIx(client, { leagueId, rulesHash, member: member.keypair.publicKey }),
      member,
    );
    await send(
      await depositIx(client, {
        leagueId,
        mint,
        member: member.keypair.publicKey,
        memberTokenAccount: member.tokenAccount,
      }),
      member,
    );

    expect(await tokenBalance(provider, clientVaultPda(league))).toBe(BigInt(BUY_IN));

    // 3. And gets it back, unilaterally, once the timelock passes.
    await sleep(5000);
    await send(
      await refundStakeIx(client, {
        leagueId,
        mint,
        member: member.keypair.publicKey,
        memberTokenAccount: member.tokenAccount,
      }),
      member,
    );

    expect(await tokenBalance(provider, member.tokenAccount)).toBe(BigInt(BUY_IN));
    expect(await tokenBalance(provider, clientVaultPda(league))).toBe(0n);
  });

  it("anchors a league that plays for nothing", async () => {
    const client = escrowProgram(provider);
    const leagueId = randomUUID();
    const rulesHash = new Uint8Array(32).fill(9);

    const ix = await initializeFreeLeagueIx(client, {
      leagueId,
      rulesHash,
      maxTeams: 12,
      payer: provider.wallet.publicKey,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), []);

    const onChain = await program.account.league.fetch(clientLeaguePda(leagueId));
    expect(onChain.hasPot).toBe(false);
    expect([...onChain.rulesHash]).toEqual([...rulesHash]);
  });

  it("orders the payout array by the program's indices, not PrizeKey order", () => {
    // The two orders differ. Serialising from the wrong one reshuffles the split
    // with no error anywhere, which is why this conversion has one home.
    expect(
      payoutArray([
        { prize: "THIRD_PLACE", basisPoints: 500 },
        { prize: "CHAMPION", basisPoints: 6000 },
        { prize: "CONSOLATION", basisPoints: 1000 },
        { prize: "RUNNER_UP", basisPoints: 1500 },
        { prize: "REGULAR_SEASON", basisPoints: 1000 },
      ]),
    ).toEqual([6000, 1500, 1000, 1000, 500]);
  });
});

describe("refund_stake", () => {
  it("refuses before the timelock has passed", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);
    await join(league, member, args.rulesHash);
    await deposit(league, member);

    await expectError(refund(league, member), "RefundLocked");
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(BigInt(BUY_IN));
  });

  /**
   * The guarantee the whole design rests on: after the unlock, a member gets
   * their own stake back with no reference to league state, settlement, or
   * anyone else's cooperation.
   */
  it("returns the stake unilaterally once unlocked", async () => {
    const unlockAt = Math.floor(Date.now() / 1000) + 3;
    const args = validArgs({
      buyIn: new anchor.BN(BUY_IN),
      refundUnlockAt: new anchor.BN(unlockAt),
    });
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);
    await join(league, member, args.rulesHash);
    await deposit(league, member);

    // The validator's clock follows real time, so waiting it out is the honest
    // test rather than warping to a convenient slot.
    await sleep(5000);

    await refund(league, member);

    expect(await tokenBalance(provider, member.tokenAccount)).toBe(BigInt(BUY_IN));
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(0n);

    const membership = await program.account.membership.fetch(
      membershipPda(program, league, member.keypair.publicKey),
    );
    expect(membership.refunded).toBe(true);

    const account = await program.account.league.fetch(league);
    expect(account.totalDeposited.toString()).toBe("0");
  });

  it("cannot be drained twice", async () => {
    const unlockAt = Math.floor(Date.now() / 1000) + 3;
    const args = validArgs({
      buyIn: new anchor.BN(BUY_IN),
      refundUnlockAt: new anchor.BN(unlockAt),
    });
    const league = await initialize(args);
    const funder = await fundedMember(provider, mint, BUY_IN);
    const member = await fundedMember(provider, mint, BUY_IN);
    await join(league, funder, args.rulesHash);
    await deposit(league, funder);
    await join(league, member, args.rulesHash);
    await deposit(league, member);

    await sleep(5000);

    await refund(league, member);
    await expectError(refund(league, member), "AlreadyRefunded");

    // The other member's stake is untouched by the double attempt.
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(BigInt(BUY_IN));
  });

  it("refuses a member who never staked", async () => {
    const unlockAt = Math.floor(Date.now() / 1000) + 3;
    const args = validArgs({
      buyIn: new anchor.BN(BUY_IN),
      refundUnlockAt: new anchor.BN(unlockAt),
    });
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);
    await join(league, member, args.rulesHash);

    await sleep(5000);

    await expectError(refund(league, member), "NothingDeposited");
  });

  it("will not let one member withdraw another's stake", async () => {
    const unlockAt = Math.floor(Date.now() / 1000) + 3;
    const args = validArgs({
      buyIn: new anchor.BN(BUY_IN),
      refundUnlockAt: new anchor.BN(unlockAt),
    });
    const league = await initialize(args);
    const saver = await fundedMember(provider, mint, BUY_IN);
    const thief = await fundedMember(provider, mint, BUY_IN);
    await join(league, saver, args.rulesHash);
    await deposit(league, saver);
    await join(league, thief, args.rulesHash);

    await sleep(5000);

    // The thief signs, but the membership PDA is seeded by their own key, so
    // the account they can reach is their own — which holds nothing.
    await expectError(refund(league, thief), "NothingDeposited");
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(BigInt(BUY_IN));
  });
});
