import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "vitest";
import {
  earliestRefundUnlock,
  NFL_DEFAULT_SCHEDULE,
  NFL_DEFAULT_SETTLEMENT,
} from "@rostr/core";

/**
 * Shared setup for the program tests.
 *
 * Not a `*.test.ts`, so vitest does not collect it — see the include pattern in
 * `vitest.program.config.ts`.
 */

export const PRIZE = {
  CHAMPION: 0,
  RUNNER_UP: 1,
  REGULAR_SEASON: 2,
  CONSOLATION: 3,
  THIRD_PLACE: 4,
} as const;

/** docs/RULES.md § 7. Sums to 10000, champion strictly largest. */
export const DEFAULT_PAYOUT = [6000, 1500, 1000, 1000, 500];

/** $5 and $50, in a six-decimal stablecoin's base units. A range, not a price. */
export const MIN_BUY_IN_BASE_UNITS = 5_000_000;
export const MAX_BUY_IN_BASE_UNITS = 50_000_000;

/** Six decimals, matching USDC — and required by the program. */
export const MINT_DECIMALS = 6;

/** 1%, the default protocol fee. */
export const DEFAULT_FEE_BPS = 100;

/** 5% — the on-chain ceiling, not the fee. */
export const MAX_FEE_BPS = 500;

export type InitArgs = {
  leagueId: number[];
  rulesHash: number[];
  buyIn: anchor.BN;
  refundUnlockAt: anchor.BN;
  payoutBps: number[];
  feeBps: number;
  feeRecipient: anchor.web3.PublicKey;
  maxTeams: number;
  startDeadline: anchor.BN;
};

export type FreeLeagueArgs = {
  leagueId: number[];
  rulesHash: number[];
  maxTeams: number;
};

export const getProvider = (): anchor.AnchorProvider => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  return provider;
};

/**
 * Built from the IDL on disk rather than `anchor.workspace`, which resolves
 * program names differently across Anchor versions. The address travels in the
 * IDL itself, so this cannot disagree with what was just deployed.
 */
export const getProgram = (provider: anchor.AnchorProvider): anchor.Program => {
  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target", "idl", "rostr_escrow.json"), "utf8"),
  ) as anchor.Idl;
  return new anchor.Program(idl, provider);
};

/** A fresh league id per test, so tests never collide on a PDA. */
export const freshLeagueId = (): number[] => [
  ...anchor.web3.Keypair.generate().publicKey.toBytes().slice(0, 16),
];

export const leaguePda = (program: anchor.Program, leagueId: number[]): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("league"), Buffer.from(leagueId)],
    program.programId,
  )[0];

export const vaultPda = (
  program: anchor.Program,
  league: anchor.web3.PublicKey,
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), league.toBuffer()],
    program.programId,
  )[0];

export const membershipPda = (
  program: anchor.Program,
  league: anchor.web3.PublicKey,
  member: anchor.web3.PublicKey,
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("membership"), league.toBuffer(), member.toBuffer()],
    program.programId,
  )[0];

export const validArgs = (overrides: Partial<InitArgs> = {}): InitArgs => {
  const base = {
    leagueId: freshLeagueId(),
    // Any non-zero 32 bytes stands in for a real SHA-256 of the canonical rules.
    rulesHash: Array.from({ length: 32 }, (_, i) => (i + 1) % 256),
    buyIn: new anchor.BN(10_000_000),
    refundUnlockAt: new anchor.BN(Math.floor(Date.now() / 1000) + 365 * 24 * 3600),
    payoutBps: [...DEFAULT_PAYOUT],
    feeBps: DEFAULT_FEE_BPS,
    feeRecipient: anchor.web3.Keypair.generate().publicKey,
    maxTeams: 12,
    ...overrides,
  };

  /*
    The start deadline has to stay strictly inside the refund unlock, and many
    tests here override the unlock to a few seconds out so they can sleep past
    it. A fixed default would make every one of those fail at `initialize_league`
    with `StartDeadlineAfterRefundUnlock` — so derive it from whatever unlock the
    caller actually chose.

    A week out for a realistic league; one second inside the unlock for the short
    ones. Both satisfy `now < start_deadline < refund_unlock_at`.
  */
  // BN arithmetic throughout, never `.toNumber()`: one test deliberately passes
  // `i64::MAX` as the unlock, and bn.js throws above 53 bits — which would abort
  // that test here, in the fixture, instead of reaching the ceiling it exists to
  // prove.
  const week = new anchor.BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  const justInside = base.refundUnlockAt.subn(1);

  return {
    ...base,
    startDeadline: overrides.startDeadline ?? (justInside.lt(week) ? justInside : week),
  };
};

/**
 * Declare a season started, which is what closes the failed-league refund.
 *
 * Signed by the provider wallet, which is the `payer` on `initialize_league` and
 * therefore the league's recorded commissioner.
 */
export const startSeason = async (
  program: anchor.Program,
  league: anchor.web3.PublicKey,
  commissioner?: anchor.web3.Keypair,
): Promise<string> => {
  const method = program.methods.startSeason().accounts({
    league,
    commissioner: commissioner?.publicKey ?? program.provider.publicKey,
  });
  return commissioner ? method.signers([commissioner]).rpc() : method.rpc();
};

export const validFreeArgs = (overrides: Partial<FreeLeagueArgs> = {}): FreeLeagueArgs => ({
  leagueId: freshLeagueId(),
  rulesHash: Array.from({ length: 32 }, (_, i) => (i + 1) % 256),
  maxTeams: 12,
  ...overrides,
});

/**
 * Create a pot token. The provider wallet keeps mint authority.
 *
 * `decimals` is a parameter only so a test can build a mint the program must
 * refuse; every real pot token is six.
 */
export const createPotMint = async (
  provider: anchor.AnchorProvider,
  decimals: number = MINT_DECIMALS,
): Promise<anchor.web3.PublicKey> => {
  const payer = (provider.wallet as anchor.Wallet).payer;
  return createMint(provider.connection, payer, provider.wallet.publicKey, null, decimals);
};

export type Member = {
  keypair: anchor.web3.Keypair;
  tokenAccount: anchor.web3.PublicKey;
};

/** A member with SOL for fees and `balance` base units of the pot token. */
export const fundedMember = async (
  provider: anchor.AnchorProvider,
  mint: anchor.web3.PublicKey,
  balance: number,
): Promise<Member> => {
  const keypair = anchor.web3.Keypair.generate();
  const payer = (provider.wallet as anchor.Wallet).payer;

  const sig = await provider.connection.requestAirdrop(
    keypair.publicKey,
    2 * anchor.web3.LAMPORTS_PER_SOL,
  );
  const latest = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");

  const tokenAccount = await createAssociatedTokenAccount(
    provider.connection,
    payer,
    mint,
    keypair.publicKey,
  );

  if (balance > 0) {
    await mintTo(
      provider.connection,
      payer,
      mint,
      tokenAccount,
      provider.wallet.publicKey,
      balance,
    );
  }

  return { keypair, tokenAccount };
};

export const tokenBalance = async (
  provider: anchor.AnchorProvider,
  account: anchor.web3.PublicKey,
): Promise<bigint> => (await getAccount(provider.connection, account)).amount;

/** Assert the program rejected with a specific `EscrowError` variant. */
export const expectError = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toSatisfy(
    (err: unknown) => err instanceof anchor.AnchorError && err.error.errorCode.code === code,
    `expected AnchorError ${code}`,
  );
};

/**
 * A refund unlock that is legal for a league drafting at `draftScheduledAt`.
 *
 * `validateLeagueRules` now bounds this field on both sides, so a fixture cannot
 * pick a date freely. It must sit at or above `earliestRefundUnlock` and at or
 * below `latestRefundUnlock`, and the window is 90 days wide — so this takes the
 * floor and adds a day.
 *
 * **Derived from the draft, never from `Date.now()` independently.** These
 * fixtures used to pin `scheduledAt` to a fixed August 2025 timestamp while
 * computing the refund date from the wall clock, which meant the gap between
 * them widened every day and the pair was going to fall out of the legal window
 * on its own — with or without the ceiling that exposed it. A fixed date beside
 * a live clock is the same shape the create form was fixed for.
 */
export const refundUnlockFor = (draftScheduledAt: number): number =>
  earliestRefundUnlock({
    draftScheduledAt,
    regularSeasonWeeks: NFL_DEFAULT_SCHEDULE.regularSeasonWeeks,
    playoffWeeks: NFL_DEFAULT_SCHEDULE.playoffWeeks,
    payingFinalizationHours: NFL_DEFAULT_SETTLEMENT.payingFinalizationHours,
  }) +
  24 * 3600;
