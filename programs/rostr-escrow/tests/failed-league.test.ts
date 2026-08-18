import * as anchor from "@coral-xyz/anchor";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type InitArgs,
  type Member,
  createPotMint,
  expectError,
  fundedMember,
  getProgram,
  getProvider,
  leaguePda,
  membershipPda,
  startSeason,
  tokenBalance,
  validArgs,
  vaultPda,
} from "./helpers.js";

/**
 * A league that never starts gives the money back — issue #170.
 *
 * ## What this is proving
 *
 * Before this, the only way tokens left a vault was `refund_stake` after
 * `refund_unlock_at`, which `earliestRefundUnlock` puts a season and sixty days
 * past the draft. For a league that filled and played, that is right: the
 * timelock is late so a refund and a payout can never both be legal, and
 * whoever transacts first cannot take the pot.
 *
 * For a league that **never started** it was absurd. A pot league that reached
 * its draft time one short of its buy-ins, or with an odd field, had nothing to
 * settle and no season to protect — and its members waited six months for money
 * that was never at stake in anything.
 *
 * ## The shape, and why it fails safe
 *
 * The program cannot tell a failed league from a running one: the roster, the
 * draft and who has paid are all Postgres facts. So the default is failure. A
 * league that was ready calls `start_season` inside its window; one that was not
 * never does, and its members are released the instant the window shuts.
 * **Doing nothing is what returns the money**, which is the direction a rule
 * about other people's money should fail in.
 *
 * ## Reading the clock in these tests
 *
 * Deadlines are set a few seconds out and waited for, the same way `pot.test.ts`
 * reaches the ordinary timelock — the validator's clock follows real time and
 * cannot be warped. Note it *drifts behind* wall time on a long-lived ledger, so
 * sleeping past a deadline is reliable while picking a past wall time is not.
 * See CLAUDE.md on validator drift if several of these fail at once.
 */

const BUY_IN = 5_000_000;

let provider: anchor.AnchorProvider;
let program: anchor.Program;
let mint: anchor.web3.PublicKey;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  mint = await createPotMint(provider);
});

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

const deposit = async (league: anchor.web3.PublicKey, member: Member) =>
  program.methods
    .deposit()
    .accounts({
      league,
      membership: membershipPda(program, league, member.keypair.publicKey),
      vault: vaultPda(program, league),
      mint,
      memberTokenAccount: member.tokenAccount,
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

/** A league whose start window shuts in ~3s, with the timelock a year out. */
const failingSoon = (overrides: Partial<InitArgs> = {}): InitArgs =>
  validArgs({
    buyIn: new anchor.BN(BUY_IN),
    startDeadline: new anchor.BN(Math.floor(Date.now() / 1000) + 3),
    ...overrides,
  });

describe("a league that never starts", () => {
  it("returns every stake when its start window shuts, with the timelock a year away", async () => {
    const args = failingSoon();
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);

    await join(league, member, args.rulesHash);
    await deposit(league, member);
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(BigInt(BUY_IN));

    // Before the window shuts, nothing has failed yet, so the ordinary timelock
    // still governs — and it is a year out.
    await expectError(refund(league, member), "RefundLocked");

    await sleep(5000);

    // Nobody declared it started, so it failed, so the money is theirs.
    await refund(league, member);
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(0n);
    expect(await tokenBalance(provider, member.tokenAccount)).toBe(BigInt(BUY_IN));
  });

  /**
   * The claim never expires, and that is deliberate.
   *
   * A refund window that closes is a way for money to become permanently stuck,
   * which is the one outcome this program exists to prevent. Members forget;
   * forgetting must cost them nothing. (#169 emails them, and must never gate
   * this.)
   */
  it("keeps the claim open indefinitely rather than expiring it", async () => {
    const args = failingSoon();
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);

    await join(league, member, args.rulesHash);
    await deposit(league, member);

    await sleep(9000);

    await refund(league, member);
    expect(await tokenBalance(provider, member.tokenAccount)).toBe(BigInt(BUY_IN));
  });

  it("releases every member, not merely the first to ask", async () => {
    const args = failingSoon();
    const league = await initialize(args);
    const one = await fundedMember(provider, mint, BUY_IN);
    const two = await fundedMember(provider, mint, BUY_IN);

    await join(league, one, args.rulesHash);
    await deposit(league, one);
    await join(league, two, args.rulesHash);
    await deposit(league, two);

    await sleep(5000);

    await refund(league, one);
    await refund(league, two);
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(0n);

    const account = await program.account["league"]!.fetch(league);
    expect((account as { totalDeposited: anchor.BN }).totalDeposited.toString()).toBe("0");
  });

  it("still refuses a second withdrawal", async () => {
    const args = failingSoon();
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);

    await join(league, member, args.rulesHash);
    await deposit(league, member);
    await sleep(5000);
    await refund(league, member);

    await expectError(refund(league, member), "AlreadyRefunded");
  });
});

describe("a league that starts", () => {
  it("closes the failed-league refund, leaving only the timelock", async () => {
    /*
      A wider window than `failingSoon`, and the width is the point.

      Every other test here wants the window to shut, so three seconds is
      generous. This one needs `start_season` to land *inside* it, and the setup
      before that call is five transactions — initialise, airdrop, create the
      token account, mint, join, deposit. On a busy validator that is comfortably
      more than three seconds, and the test then fails with `StartWindowClosed`
      on a league that behaved perfectly.

      It failed exactly that way on 2026-08-18, when two unrelated tests were
      added to another file and made the validator busy enough to lose the race.
      Widening the window fixes it properly; a retry would have hidden it.
    */
    const deadline = Math.floor(Date.now() / 1000) + 30;
    const args = failingSoon({ startDeadline: new anchor.BN(deadline) });
    const league = await initialize(args);
    const member = await fundedMember(provider, mint, BUY_IN);

    await join(league, member, args.rulesHash);
    await deposit(league, member);

    // Inside the window, so this lands.
    await startSeason(program, league);

    /*
      Then wait out the rest of the window, however long the setup took, so the
      assertion below is made on a league whose start window has genuinely shut.

      `refund_stake` would refuse anyway — its second opening is
      `!started && now >= start_deadline`, and `started` is true — so this is not
      load-bearing for the result. It is load-bearing for what the test *proves*:
      without it the case is "a started league cannot refund yet", which the
      timelock alone would give you.
    */
    const remaining = (deadline + 2) * 1000 - Date.now();
    if (remaining > 0) await sleep(remaining);

    // The window has shut, but the season began — so the only way out is the
    // ordinary timelock, a year from now. Without this the season would be
    // played by managers who could withdraw at any point and keep their roster,
    // their standings place and their claim on the pot.
    await expectError(refund(league, member), "RefundLocked");
    expect(await tokenBalance(provider, vaultPda(program, league))).toBe(BigInt(BUY_IN));
  });

  it("records that it started", async () => {
    const args = failingSoon();
    const league = await initialize(args);

    const before = await program.account["league"]!.fetch(league);
    expect((before as { started: boolean }).started).toBe(false);

    await startSeason(program, league);

    const after = await program.account["league"]!.fetch(league);
    expect((after as { started: boolean }).started).toBe(true);
  });

  it("cannot be started twice", async () => {
    const league = await initialize(failingSoon());
    await startSeason(program, league);
    await expectError(startSeason(program, league), "AlreadyStarted");
  });

  /**
   * The two windows are complements, and that is the whole safety argument.
   *
   * `start_season` is illegal from exactly the instant the failed-league refund
   * becomes legal. So a league can never be declared started with a vault
   * members have already withdrawn from, and a member can never be refunded out
   * of a season that has begun. Neither half has to agree with the other; there
   * is no overlap for them to disagree about.
   */
  it("cannot be started once its window has shut", async () => {
    const league = await initialize(failingSoon());
    await sleep(5000);
    await expectError(startSeason(program, league), "StartWindowClosed");
  });

  it("can only be started by the wallet that created it", async () => {
    const league = await initialize(failingSoon());
    const stranger = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(stranger.publicKey, 1_000_000_000),
      "confirmed",
    );

    await expectError(startSeason(program, league, stranger), "NotCommissioner");

    // And the real commissioner is unaffected by the attempt.
    await startSeason(program, league);
  });
});

describe("the terms that bound it", () => {
  it("refuses a start deadline already in the past", async () => {
    // Otherwise a league could be created already failed, and its first deposit
    // would be withdrawable immediately — the same failure `refund_unlock_at >
    // now` prevents for the ordinary timelock.
    await expectError(
      initialize(
        validArgs({ startDeadline: new anchor.BN(Math.floor(Date.now() / 1000) - 60) }),
      ),
      "StartDeadlineNotInFuture",
    );
  });

  it("refuses a start deadline at or after the refund unlock", async () => {
    const unlock = Math.floor(Date.now() / 1000) + 3600;
    await expectError(
      initialize(
        validArgs({
          refundUnlockAt: new anchor.BN(unlock),
          startDeadline: new anchor.BN(unlock),
        }),
      ),
      "StartDeadlineAfterRefundUnlock",
    );
  });
});
