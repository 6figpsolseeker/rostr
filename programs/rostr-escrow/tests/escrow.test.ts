import { randomUUID } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import {
  ESCROW_PROGRAM_ID,
  clusterOf,
  escrowProgram,
  fetchOnChainLeague,
  hexToBytes,
  leagueIdBytes,
  verifyLeagueAnchor,
  leaguePda as clientLeaguePda,
  vaultPda as clientVaultPda,
} from "@rostr/escrow";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FEE_BPS,
  DEFAULT_PAYOUT,
  type FreeLeagueArgs,
  type InitArgs,
  MAX_BUY_IN_BASE_UNITS,
  MAX_FEE_BPS,
  MIN_BUY_IN_BASE_UNITS,
  PRIZE,
  createPotMint,
  expectError,
  getProgram,
  getProvider,
  leaguePda,
  validArgs,
  validFreeArgs,
  vaultPda,
  type EscrowProgram,
} from "./helpers.js";

/**
 * D2 — the league account and the terms frozen into it.
 *
 * These assert the *rejections* as much as the happy path. Every check in
 * `initialize_league` also exists off-chain in `validateRules()`, so a test that
 * only proved the good case would pass identically against a program with no
 * validation at all — and the off-chain copy is the one an attacker skips by
 * calling the program directly.
 */

let program: EscrowProgram;
let provider: anchor.AnchorProvider;
let mint: anchor.web3.PublicKey;

const initialize = async (args: InitArgs) => {
  const league = leaguePda(program, args.leagueId);
  return program.methods
    .initializeLeague(args)
    .accountsPartial({
      league,
      mint,
      vault: vaultPda(program, league),
      payer: provider.wallet.publicKey,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
};

const initializeFree = async (args: FreeLeagueArgs) =>
  program.methods
    .initializeFreeLeague(args)
    .accountsPartial({
      league: leaguePda(program, args.leagueId),
      payer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  mint = await createPotMint(provider);
});

describe("initialize_league", () => {
  it("freezes the league's terms on-chain", async () => {
    const args = validArgs();
    await initialize(args);

    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));

    expect([...league.rulesHash]).toEqual(args.rulesHash);
    expect(league.tokenMint.toBase58()).toBe(mint.toBase58());
    expect(league.buyIn.toString()).toBe(args.buyIn.toString());
    expect(league.refundUnlockAt.toString()).toBe(args.refundUnlockAt.toString());
    expect([...league.payoutBps]).toEqual(DEFAULT_PAYOUT);
    expect(league.maxTeams).toBe(12);
  });

  it("opens an empty vault owned by the league itself", async () => {
    const args = validArgs();
    await initialize(args);

    const league = leaguePda(program, args.leagueId);
    const vault = await getAccount(provider.connection, vaultPda(program, league));

    // The vault's authority is the league PDA, so no key held by any person can
    // move the pot — only the program, through its instructions.
    expect(vault.owner.toBase58()).toBe(league.toBase58());
    expect(vault.mint.toBase58()).toBe(mint.toBase58());
    expect(vault.amount).toBe(0n);
  });

  it("starts with no members and nothing deposited", async () => {
    const args = validArgs();
    await initialize(args);

    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect(league.memberCount).toBe(0);
    expect(league.totalDeposited.toString()).toBe("0");
  });

  it("cannot be initialised twice for the same league id", async () => {
    const args = validArgs();
    await initialize(args);
    // The second init hits the system program's "account already in use" rather
    // than one of ours, which is the point: the PDA itself is the guard.
    await expect(initialize(args)).rejects.toThrow();
  });

  it("rejects an all-zero rules hash", async () => {
    await expectError(
      initialize(validArgs({ rulesHash: new Array<number>(32).fill(0) })),
      "RulesHashMissing",
    );
  });

  it("rejects a zero buy-in", async () => {
    await expectError(initialize(validArgs({ buyIn: new anchor.BN(0) })), "BuyInZero");
  });

  it("rejects a buy-in above the cap", async () => {
    await expectError(
      initialize(validArgs({ buyIn: new anchor.BN(MAX_BUY_IN_BASE_UNITS + 1) })),
      "BuyInAboveCap",
    );
  });

  it("rejects a buy-in below the minimum", async () => {
    // A cent under $5. Small enough that the transfers to collect and pay it out
    // would cost more than the pot.
    await expectError(
      initialize(validArgs({ buyIn: new anchor.BN(MIN_BUY_IN_BASE_UNITS - 1) })),
      "BuyInBelowMinimum",
    );
  });

  it("accepts a buy-in exactly at the cap", async () => {
    const args = validArgs({ buyIn: new anchor.BN(MAX_BUY_IN_BASE_UNITS) });
    await initialize(args);
    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect(league.buyIn.toString()).toBe(String(MAX_BUY_IN_BASE_UNITS));
  });

  it("accepts a buy-in exactly at the minimum", async () => {
    const args = validArgs({ buyIn: new anchor.BN(MIN_BUY_IN_BASE_UNITS) });
    await initialize(args);
    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect(league.buyIn.toString()).toBe(String(MIN_BUY_IN_BASE_UNITS));
  });

  /**
   * The bounds are a range, not a price list. **Any** amount between them is
   * legal, down to a single base unit — there is no granularity rule, so cents
   * work as well as whole dollars and awkward amounts as well as round ones.
   *
   * Worth pinning explicitly: it would be easy for a later "tidy-up" to add a
   * whole-dollar constraint that nothing in the rules asks for.
   */
  it.each([
    ["$5.00, the floor", 5_000_000],
    ["$7.25", 7_250_000],
    ["$10.00", 10_000_000],
    ["$12.50", 12_500_000],
    ["$25.00", 25_000_000],
    ["$33.33", 33_330_000],
    ["$47.00", 47_000_000],
    ["$49.99", 49_990_000],
    ["$50.00, the ceiling", 50_000_000],
    ["a single base unit above the floor", 5_000_001],
  ])("accepts %s", async (_label, units) => {
    const args = validArgs({ buyIn: new anchor.BN(units) });
    await initialize(args);
    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect(league.buyIn.toString()).toBe(String(units));
  });

  it("rejects a league of one", async () => {
    await expectError(initialize(validArgs({ maxTeams: 1 })), "LeagueTooSmall");
  });

  it("rejects shares that do not sum to the whole pot", async () => {
    await expectError(
      initialize(validArgs({ payoutBps: [6000, 1500, 1000, 1000, 499] })),
      "PayoutNotWhole",
    );
  });

  it("rejects shares that overflow the pot", async () => {
    await expectError(
      initialize(validArgs({ payoutBps: [6000, 1500, 1000, 1000, 501] })),
      "PayoutNotWhole",
    );
  });

  it("rejects a champion share that is not the largest", async () => {
    const payout = new Array<number>(5).fill(0);
    payout[PRIZE.CHAMPION] = 3000;
    payout[PRIZE.RUNNER_UP] = 4000;
    payout[PRIZE.REGULAR_SEASON] = 1000;
    payout[PRIZE.CONSOLATION] = 1000;
    payout[PRIZE.THIRD_PLACE] = 1000;
    await expectError(initialize(validArgs({ payoutBps: payout })), "ChampionNotLargest");
  });

  it("rejects a champion share merely tied for largest", async () => {
    const payout = new Array<number>(5).fill(0);
    payout[PRIZE.CHAMPION] = 4000;
    payout[PRIZE.RUNNER_UP] = 4000;
    payout[PRIZE.REGULAR_SEASON] = 1000;
    payout[PRIZE.CONSOLATION] = 500;
    payout[PRIZE.THIRD_PLACE] = 500;
    await expectError(initialize(validArgs({ payoutBps: payout })), "ChampionNotLargest");
  });

  it("rejects a refund unlock in the past", async () => {
    await expectError(
      initialize(
        validArgs({ refundUnlockAt: new anchor.BN(Math.floor(Date.now() / 1000) - 60) }),
      ),
      "RefundUnlockNotInFuture",
    );
  });

  it("rejects i64::MAX, which used to be accepted", async () => {
    // The freeze this ceiling exists for, and the exact value `anchor.test.ts`
    // used to send and expect to succeed. `refund_stake` is the only way tokens
    // leave the vault and there is no setter, so a date 292 billion years out is
    // not a long timelock — it is a permanent one.
    //
    // Also the `saturating_add` guard: `now + MAX_REFUND_UNLOCK_HORIZON_SECONDS`
    // must fail this comparison rather than overflow-panic on a hostile input.
    await expectError(
      initialize(validArgs({ refundUnlockAt: new anchor.BN("9223372036854775807") })),
      "RefundUnlockTooFar",
    );
  });

  it("rejects a refund unlock past the two-year horizon, and accepts one inside it", async () => {
    // The pair proves it is a horizon rather than a special case for i64::MAX.
    //
    // Margins in days, never hours: a local validator can run over an hour
    // behind wall clock (see CLAUDE.md), which has already broken seven timelock
    // tests once. A boundary written as ±1h would be flaky for reasons that have
    // nothing to do with this check.
    const now = Math.floor(Date.now() / 1000);

    await expectError(
      initialize(validArgs({ refundUnlockAt: new anchor.BN(now + 800 * 24 * 3600) })),
      "RefundUnlockTooFar",
    );

    await initialize(validArgs({ refundUnlockAt: new anchor.BN(now + 700 * 24 * 3600) }));
  });

  it("rejects a mint that is not six decimals", async () => {
    // Nine decimals is SOL's convention. Accepting it would make the $50 cap
    // mean 0.05 SOL instead — the same constant, a different amount of money.
    const nineDecimals = await createPotMint(provider, 9);
    const args = validArgs();
    const league = leaguePda(program, args.leagueId);

    await expectError(
      program.methods
        .initializeLeague(args)
        .accountsPartial({
          league,
          mint: nineDecimals,
          vault: vaultPda(program, league),
          payer: provider.wallet.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "UnsupportedMintDecimals",
    );
  });
});

/**
 * The client and the program derive addresses independently — one in
 * TypeScript from a UUID, one in Rust from seed bytes. If they ever disagree,
 * every call targets an account the program never wrote, which presents as a
 * logic bug rather than a mismatched constant.
 *
 * `packages/escrow` tests the derivation is self-consistent. This is the only
 * place it can be checked against the thing it is meant to match.
 */
describe("@rostr/escrow address derivation", () => {
  it("finds the same league account the program creates", async () => {
    // A real Postgres-shaped UUID, converted the way the app will convert it.
    const uuid = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const args = validArgs({ leagueId: [...leagueIdBytes(uuid)] });

    await initialize(args);

    const fromClient = clientLeaguePda(uuid);
    // Fetching through the client's address proves the seeds agree: a wrong
    // derivation returns "account does not exist", not a wrong league.
    const league = await program.account.league.fetch(fromClient);
    expect([...league.rulesHash]).toEqual(args.rulesHash);

    expect(fromClient.toBase58()).toBe(leaguePda(program, args.leagueId).toBase58());
    expect(clientVaultPda(fromClient).toBase58()).toBe(
      vaultPda(program, fromClient).toBase58(),
    );
  });

  it("agrees with the program id the tests deploy", () => {
    expect(ESCROW_PROGRAM_ID.toBase58()).toBe(program.programId.toBase58());
  });
});

describe("the protocol fee", () => {
  it("is frozen into the league with its recipient", async () => {
    const args = validArgs();
    await initialize(args);

    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect(league.feeBps).toBe(DEFAULT_FEE_BPS);
    expect(league.feeRecipient.toBase58()).toBe(args.feeRecipient.toBase58());
  });

  it("may be zero — a league that pays us nothing is a valid league", async () => {
    const args = validArgs({
      feeBps: 0,
      feeRecipient: anchor.web3.PublicKey.default,
    });
    await initialize(args);

    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect(league.feeBps).toBe(0);
  });

  it("accepts a fee exactly at the ceiling", async () => {
    const args = validArgs({ feeBps: MAX_FEE_BPS });
    await initialize(args);

    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect(league.feeBps).toBe(MAX_FEE_BPS);
  });

  it("rejects a fee above the ceiling", async () => {
    await expectError(initialize(validArgs({ feeBps: MAX_FEE_BPS + 1 })), "FeeAboveCeiling");
  });

  it("rejects a fee with nowhere to send it", async () => {
    await expectError(
      initialize(validArgs({ feeRecipient: anchor.web3.PublicKey.default })),
      "FeeRecipientMissing",
    );
  });
});

describe("initialize_free_league", () => {
  /**
   * A league that plays for nothing still anchors its rules on-chain. Otherwise
   * "the rules are immutable and you can verify them" would be true only of
   * leagues with money in them, and every other league's guarantee would rest
   * on our database — the thing this project exists not to ask anyone to trust.
   */
  it("anchors the rules hash with no pot", async () => {
    const args = validFreeArgs();
    await initializeFree(args);

    const league = await program.account.league.fetch(leaguePda(program, args.leagueId));
    expect([...league.rulesHash]).toEqual(args.rulesHash);
    expect(league.hasPot).toBe(false);
    expect(league.buyIn.toString()).toBe("0");
    expect(league.feeBps).toBe(0);
    expect(league.tokenMint.toBase58()).toBe(anchor.web3.PublicKey.default.toBase58());
  });

  it("still rejects an all-zero rules hash", async () => {
    await expectError(
      initializeFree(validFreeArgs({ rulesHash: new Array<number>(32).fill(0) })),
      "RulesHashMissing",
    );
  });

  it("still rejects a league of one", async () => {
    await expectError(initializeFree(validFreeArgs({ maxTeams: 1 })), "LeagueTooSmall");
  });
});

/**
 * Reading a league back off the chain.
 *
 * This is what the anchoring route will call before it believes a browser that
 * says "I anchored it". A signature proves some transaction happened; only
 * fetching the account and finding our hash in it proves which.
 *
 * Tested here rather than through the route because the risk is entirely in the
 * shapes — 32 raw bytes on-chain against a 64-character hex string in Postgres,
 * a number[] from Anchor against a Uint8Array — and those are only real against
 * a real deployed program. A mocked connection would agree with whatever the
 * code already believed.
 */
describe("verifyLeagueAnchor", () => {
  const hexOf = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

  it("reads back exactly the hash that was anchored", async () => {
    const leagueId = randomUUID();
    const rulesHash = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
    await initialize(validArgs({ leagueId: [...leagueIdBytes(leagueId)], rulesHash }));

    const client = escrowProgram(provider);
    const onChain = await fetchOnChainLeague(client, leagueId);

    // The conversion is the whole test. A hash that round-trips wrong here is a
    // verifier that always fails, or worse, always passes.
    expect(onChain?.rulesHash).toBe(hexOf(rulesHash));
    expect(onChain?.rulesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("confirms a league anchored with our rules", async () => {
    const leagueId = randomUUID();
    const rulesHash = Array.from({ length: 32 }, (_, i) => (i + 11) % 256);
    await initialize(validArgs({ leagueId: [...leagueIdBytes(leagueId)], rulesHash }));

    const verdict = await verifyLeagueAnchor(
      escrowProgram(provider),
      leagueId,
      hexOf(rulesHash),
    );

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.league.hasPot).toBe(true);
  });

  it("refuses a league anchored with a different rule set", async () => {
    // The case that matters. The account exists at the right address, so a check
    // that only asked "does it exist" would pass — and the member would be
    // consenting to a document the chain does not hold.
    const leagueId = randomUUID();
    const rulesHash = Array.from({ length: 32 }, (_, i) => (i + 11) % 256);
    await initialize(validArgs({ leagueId: [...leagueIdBytes(leagueId)], rulesHash }));

    const different = [...rulesHash];
    different[0] = (different[0]! + 1) % 256;

    const verdict = await verifyLeagueAnchor(
      escrowProgram(provider),
      leagueId,
      hexOf(different),
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok && verdict.reason === "HASH_MISMATCH") {
      expect(verdict.onChain).toBe(hexOf(rulesHash));
      expect(verdict.expected).toBe(hexOf(different));
    } else {
      throw new Error(`expected HASH_MISMATCH, got ${JSON.stringify(verdict)}`);
    }
  });

  it("reports a league that was never anchored", async () => {
    // The ordinary case: created in the database, the commissioner closed the
    // tab before signing. A return value, not a throw.
    const verdict = await verifyLeagueAnchor(
      escrowProgram(provider),
      randomUUID(),
      "a".repeat(64),
    );

    expect(verdict).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await fetchOnChainLeague(escrowProgram(provider), randomUUID())).toBeNull();
  });

  it("is case-insensitive, because the two sides come from different places", async () => {
    const leagueId = randomUUID();
    const rulesHash = Array.from({ length: 32 }, () => 0xab);
    await initialize(validArgs({ leagueId: [...leagueIdBytes(leagueId)], rulesHash }));

    const upper = hexOf(rulesHash).toUpperCase();
    expect((await verifyLeagueAnchor(escrowProgram(provider), leagueId, upper)).ok).toBe(true);
  });

  it("round-trips a stored hex hash through the instruction args", async () => {
    // What the route will do: read char(64) out of Postgres, hand it to the
    // program as bytes, read it back as hex, compare. Every step is a chance to
    // get the shape wrong.
    const leagueId = randomUUID();
    const stored = "3f2b1c4d5e6f4a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d";

    await initialize(
      validArgs({ leagueId: [...leagueIdBytes(leagueId)], rulesHash: [...hexToBytes(stored)] }),
    );

    const verdict = await verifyLeagueAnchor(escrowProgram(provider), leagueId, stored);
    expect(verdict.ok).toBe(true);
  });

  it("names the cluster from the endpoint rather than trusting a caller", () => {
    // A devnet anchor is not an anchor for a mainnet stake, and the PDA is
    // identical on both — so this is what stops the two being confused.
    expect(clusterOf(provider.connection)).toBe("localnet");
  });
});
