import * as anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccount, createMint } from "@solana/spl-token";
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

  it("refuses members beyond the league's size", async () => {
    const args = validArgs({ maxTeams: 2 });
    const league = await initialize(args);

    for (let i = 0; i < 2; i++) {
      await join(league, await fundedMember(provider, mint, BUY_IN), args.rulesHash);
    }

    const extra = await fundedMember(provider, mint, BUY_IN);
    await expectError(join(league, extra, args.rulesHash), "LeagueFull");
  });
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
