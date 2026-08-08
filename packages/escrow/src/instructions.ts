/**
 * Instruction builders.
 *
 * These return a `TransactionInstruction` and never send anything. Signing is
 * the caller's business, and it matters that it stays that way: a league is
 * anchored by its commissioner's own wallet and a stake is moved by the
 * member's, so no key of ours is ever involved. Nothing here needs a private
 * key, and there is no server-side signer to lose.
 *
 * Account wiring lives here rather than in the app so there is one place that
 * knows which accounts each instruction wants. Getting that wrong in a second
 * copy would be an error the type system cannot see — the IDL takes an account
 * list, and any list of the right length type-checks.
 */

import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";

import { ESCROW_IDL } from "./idl.js";
import { leagueIdBytes, leaguePda, membershipPda, vaultPda } from "./program.js";
import type { RostrEscrow } from "./types.js";

/**
 * A typed handle on the program.
 *
 * The provider supplies a connection; none of the builders below use it to
 * fetch anything, so a read-only provider is enough to construct instructions.
 */
export function escrowProgram(provider: Provider): Program<RostrEscrow> {
  return new Program(ESCROW_IDL as unknown as Idl, provider);
}

/** Indices into the payout array. Mirrors the `prize` module in the program. */
export const PRIZE_ORDER = [
  "CHAMPION",
  "RUNNER_UP",
  "REGULAR_SEASON",
  "CONSOLATION",
  "THIRD_PLACE",
] as const;

export type PrizeKey = (typeof PRIZE_ORDER)[number];

/**
 * Turn the rule set's payout list into the positional array the program stores.
 *
 * **The order is `PRIZE_ORDER`, not the declaration order of `PrizeKey` in
 * `@rostr/core`** — those differ, and serialising from the wrong one reshuffles
 * the split silently, with no error anywhere. This function exists so that
 * mistake can only be made once.
 */
export function payoutArray(
  shares: readonly { readonly prize: string; readonly basisPoints: number }[],
): number[] {
  return PRIZE_ORDER.map((prize) => {
    const share = shares.find((s) => s.prize === prize);
    return share?.basisPoints ?? 0;
  });
}

export type InitializeLeagueParams = {
  /** The league's Postgres UUID. */
  readonly leagueId: string;
  /** SHA-256 of the canonical rule set, as 32 bytes. */
  readonly rulesHash: Uint8Array;
  readonly mint: PublicKey;
  /** Base units, as a decimal string — a u64, so never a JS number. */
  readonly buyInBaseUnits: string;
  readonly refundUnlockAt: number;
  readonly payoutBps: readonly number[];
  readonly feeBps: number;
  readonly feeRecipient: PublicKey;
  readonly maxTeams: number;
  /** Pays rent, and holds no privileges afterwards. */
  readonly payer: PublicKey;
};

export async function initializeLeagueIx(
  program: Program<RostrEscrow>,
  params: InitializeLeagueParams,
): Promise<TransactionInstruction> {
  const league = leaguePda(params.leagueId);

  return program.methods
    .initializeLeague({
      leagueId: [...leagueIdBytes(params.leagueId)],
      rulesHash: [...params.rulesHash],
      buyIn: new BN(params.buyInBaseUnits),
      refundUnlockAt: new BN(params.refundUnlockAt),
      payoutBps: [...params.payoutBps],
      feeBps: params.feeBps,
      feeRecipient: params.feeRecipient,
      maxTeams: params.maxTeams,
    })
    .accountsPartial({
      league,
      mint: params.mint,
      vault: vaultPda(league),
      payer: params.payer,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export type InitializeFreeLeagueParams = {
  readonly leagueId: string;
  readonly rulesHash: Uint8Array;
  readonly maxTeams: number;
  readonly payer: PublicKey;
};

/** A league that plays for nothing still anchors its rules. */
export async function initializeFreeLeagueIx(
  program: Program<RostrEscrow>,
  params: InitializeFreeLeagueParams,
): Promise<TransactionInstruction> {
  return program.methods
    .initializeFreeLeague({
      leagueId: [...leagueIdBytes(params.leagueId)],
      rulesHash: [...params.rulesHash],
      maxTeams: params.maxTeams,
    })
    .accountsPartial({
      league: leaguePda(params.leagueId),
      payer: params.payer,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export type JoinLeagueParams = {
  readonly leagueId: string;
  /** The hash the member is accepting. The program requires it to match. */
  readonly rulesHash: Uint8Array;
  readonly member: PublicKey;
};

export async function joinLeagueIx(
  program: Program<RostrEscrow>,
  params: JoinLeagueParams,
): Promise<TransactionInstruction> {
  const league = leaguePda(params.leagueId);

  return program.methods
    .joinLeague([...params.rulesHash])
    .accountsPartial({
      league,
      membership: membershipPda(league, params.member),
      member: params.member,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export type DepositParams = {
  readonly leagueId: string;
  readonly mint: PublicKey;
  readonly member: PublicKey;
  /**
   * The member's token account. Defaults to their associated account, which is
   * what a wallet will hold.
   */
  readonly memberTokenAccount?: PublicKey;
};

/** Stakes exactly the league's buy-in. There is no amount to pass. */
export async function depositIx(
  program: Program<RostrEscrow>,
  params: DepositParams,
): Promise<TransactionInstruction> {
  const league = leaguePda(params.leagueId);

  return program.methods
    .deposit()
    .accountsPartial({
      league,
      membership: membershipPda(league, params.member),
      vault: vaultPda(league),
      memberTokenAccount:
        params.memberTokenAccount ?? getAssociatedTokenAddressSync(params.mint, params.member),
      member: params.member,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export type RefundParams = DepositParams;

/**
 * Withdraw your own stake after the timelock.
 *
 * Signed by the member alone — nobody can trigger someone else's refund, however
 * well-meant.
 */
export async function refundStakeIx(
  program: Program<RostrEscrow>,
  params: RefundParams,
): Promise<TransactionInstruction> {
  const league = leaguePda(params.leagueId);

  return program.methods
    .refundStake()
    .accountsPartial({
      league,
      membership: membershipPda(league, params.member),
      vault: vaultPda(league),
      memberTokenAccount:
        params.memberTokenAccount ?? getAssociatedTokenAddressSync(params.mint, params.member),
      member: params.member,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}
