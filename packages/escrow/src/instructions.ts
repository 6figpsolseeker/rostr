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
import { leagueIdBytes, leaguePda, membershipPda, scoresPdaFor, vaultPda } from "./program.js";
import { TIEBREAKER_DISCRIMINANTS } from "./scores.js";
import { startDeadlineFor } from "./start.js";
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
  /**
   * Unix seconds. A number for ordinary use, or a decimal string for values an
   * `i64` can hold and a JS number cannot — which a hostile creator may well
   * choose, and a test must be able to express.
   */
  readonly refundUnlockAt: number | string;
  /**
   * The frozen draft time, unix seconds.
   *
   * Not the deadline itself: `startDeadlineFor` derives that, so the value
   * anchored and the value `anchorTermMismatches` expects come from one line of
   * code rather than two that have to agree.
   */
  readonly draftScheduledAt: number;
  /**
   * The deadline itself, overriding the derivation above.
   *
   * **Nothing in the app passes this**, and nothing should: the anchor route
   * recomputes the expected value from the signed rules and refuses an account
   * that differs, so a league anchored with anything else is one nobody can
   * join. It exists for the same reason `refundUnlockAt` accepts a string — a
   * test has to be able to express a league whose deadline falls in seconds,
   * which no real draft time can produce.
   */
  readonly startDeadline?: number;
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
      // Derived from the frozen draft time, never chosen. `anchorTermMismatches`
      // recomputes it from the signed rules and refuses an account that differs,
      // so this is the only value that can survive the anchor route.
      startDeadline: new BN(params.startDeadline ?? startDeadlineFor(params.draftScheduledAt)),
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

export type StartSeasonParams = {
  readonly leagueId: string;
  /** The wallet that created the league. No other key can send this. */
  readonly commissioner: PublicKey;
};

/**
 * Declare a league's season started, closing its failed-league refund.
 *
 * Sent once, by the commissioner, immediately before the draft order is drawn —
 * `drawDraftOrder` refuses a pot league until the chain says `started`. Mark
 * first and draw second, deliberately: drawing first and failing to mark would
 * leave a live season whose members can withdraw out of it.
 *
 * It changes no term and moves no token. Its only effect is which of two refund
 * schedules the members are on, and both end with them holding their own money.
 * A league that is never marked releases every stake at its deadline — so the
 * failure of this transaction is the safe direction, not the dangerous one.
 */
export async function startSeasonIx(
  program: Program<RostrEscrow>,
  params: StartSeasonParams,
): Promise<TransactionInstruction> {
  return program.methods
    .startSeason()
    .accountsPartial({
      league: leaguePda(params.leagueId),
      commissioner: params.commissioner,
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

export type InitializeScoresParams = {
  readonly leagueId: string;
  /** The commissioner's wallet. Pays the rent and is the only key accepted. */
  readonly commissioner: PublicKey;
  /**
   * Teams in a stable order, each with the wallet its prize would be paid to.
   *
   * The positions become team indices for every game posted afterwards, so the
   * order must not change between building this and sending it. It comes from
   * `settlementPlan` in `@rostr/db`, which reads it from the roster.
   */
  readonly roster: readonly { readonly teamId: string; readonly wallet: PublicKey }[];
  readonly oracle: PublicKey;
  /** Tiebreaker names in the signed order — mapped here, never by the caller. */
  readonly tiebreakers: readonly string[];
  readonly playoffWeeks: readonly number[];
  readonly regularSeasonWeeks: number;
  readonly playoffTeams: number;
  readonly firstRoundByes: number;
  readonly thirdPlace: boolean;
};

/**
 * Write a league's payee roster and the terms its result is derived under.
 *
 * Once, before the season is declared started, by the commissioner. Everything
 * it carries is derivable from the frozen rules and the roster that formed, and
 * `drawDraftOrder` refuses to draw a league whose account disagrees with them —
 * so this is a transcription rather than a choice, and the only correct input is
 * whatever `settlementPlan` produced.
 *
 * **The wallet in each roster entry is not what the program stores.** It is used
 * to derive that member's `Membership` PDA, which is passed alongside; the
 * program reads the wallet out of that account instead. A caller who could name
 * a wallet directly could name somebody else's.
 */
export async function initializeScoresIx(
  program: Program<RostrEscrow>,
  params: InitializeScoresParams,
): Promise<TransactionInstruction> {
  const league = leaguePda(params.leagueId);

  return program.methods
    .initializeScores({
      teamIds: params.roster.map((entry) => Array.from(leagueIdBytes(entry.teamId))),
      oracle: params.oracle,
      tiebreakers: Buffer.from(
        params.tiebreakers.map((name) => {
          const value = TIEBREAKER_DISCRIMINANTS[name];
          if (value === undefined) throw new Error(`unknown tiebreaker: ${name}`);
          return value;
        }),
      ),
      playoffWeeks: Buffer.from(params.playoffWeeks),
      regularSeasonWeeks: params.regularSeasonWeeks,
      playoffTeams: params.playoffTeams,
      firstRoundByes: params.firstRoundByes,
      thirdPlace: params.thirdPlace,
    })
    .accountsPartial({
      league,
      scores: scoresPdaFor(league),
      commissioner: params.commissioner,
    })
    .remainingAccounts(
      params.roster.map((entry) => ({
        pubkey: membershipPda(league, entry.wallet),
        isSigner: false,
        isWritable: false,
      })),
    )
    .instruction();
}
