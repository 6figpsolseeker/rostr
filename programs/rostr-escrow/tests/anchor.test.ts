import * as anchor from "@coral-xyz/anchor";
import { beforeAll, describe, expect, it } from "vitest";
import {
  anchorTermMismatches,
  clusterOf,
  escrowProgram,
  expectedTermsFromRules,
  hexToBytes,
  initializeFreeLeagueIx,
  initializeLeagueIx,
  payoutArray,
  verifyLeagueAnchor,
} from "@rostr/escrow";
import {
  createLeague,
  createUser,
  getChainState,
  joinLeague,
  JoinError,
  linkWallet,
  recordChainAnchor,
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
import { createPotMint, getProgram, getProvider } from "./helpers";

/**
 * Create → anchor → join, across both halves at once.
 *
 * Every other suite tests one side against a stand-in for the other: the
 * database tests anchor a league by calling `recordChainAnchor` with a made-up
 * signature, and the program tests hash rules that no league ever had. Both
 * pass whether or not the two agree.
 *
 * They have to agree on exactly one thing — the 32 bytes. Postgres stores them
 * as hex, the program stores them as raw bytes, and if that conversion is wrong
 * the only symptom is that `verifyLeagueAnchor` reports a mismatch on a league
 * that is in fact correctly anchored. Nobody could join, and nothing else in
 * the repo would fail.
 *
 * So this drives the real `createLeague`, sends the real instruction to a real
 * validator, verifies it the way the route does, and then joins. What it does
 * not cover is the HTTP layer and the wallet popup; everything between is real.
 */

let program: anchor.Program;
let provider: anchor.AnchorProvider;
let mint: anchor.web3.PublicKey;
let db: PGliteClient;

/**
 * Anchored to now, because this fixture has to satisfy two clocks at once.
 *
 * The rule set requires the refund unlock to fall after the season it describes
 * could have settled — derived from `scheduledAt`, no wall clock. The *program*
 * separately requires it to be in the future. A draft hard-coded in the past
 * satisfies the first and fails the second, and drifts further out of reach every
 * day the repo ages.
 */
const DRAFT = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
} as const;

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  // Six decimals, because that is what makes the $50 cap mean fifty dollars —
  // the program refuses anything else for a pot league.
  mint = await createPotMint(provider);

  db = await createTestDatabase();
  await seedSport(db, NFL);
});

/**
 * A league in Postgres, rules hashed and frozen, not yet anchored.
 *
 * The pot terms name the mint we just created, so the instruction this league
 * produces is one the program will actually accept.
 */
async function createPotLeague(name: string) {
  const commissioner = await createUser(db, `${name}@example.com`, "Commish");
  const rules = buildNflPprRules({
    seasonYear: 2026,
    draft: DRAFT,
    pot: {
      tokenMint: mint.toBase58(),
      // Deliberately not a round number and not either bound — the range is
      // the rule, and a test that only ever uses $50 would not notice a
      // program that had quietly become a fixed price.
      buyInBaseUnits: "23500000",
      payout: NFL_DEFAULT_PAYOUT,
      // Relative to the draft, not to the wall clock. Measuring from `Date.now()`
      // against a draft hard-coded in the past drifted further out every day, so
      // it would eventually have failed the refund-unlock window on a date
      // nobody chose — the exact rot the bound is derived rather than timed to
      // avoid. 200 days clears the season and stays inside the year-long cap.
      refundUnlockAt: DRAFT.scheduledAt + 200 * 24 * 3600,
      feeBps: NFL_DEFAULT_FEE_BPS,
      feeRecipient: anchor.web3.Keypair.generate().publicKey.toBase58(),
    },
  });

  return {
    league: await createLeague(db, NFL, {
      name,
      commissionerId: commissioner.id,
      rules,
    }),
    rules,
  };
}

/** What `AnchorPanel` builds and sends, minus the wallet popup. */
async function anchorOnChain(
  leagueId: string,
  rulesHash: string,
  rules: ReturnType<typeof buildNflPprRules>,
): Promise<string> {
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

  return provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [], {
    commitment: "confirmed",
  });
}

describe("create -> anchor -> join", () => {
  it("refuses to let anyone join before the league is anchored", async () => {
    const { league } = await createPotLeague("unanchored");
    const wallet = testWallet(11);

    const user = await createUser(db, "early@example.com", "Early");
    await linkWallet(db, user.id, wallet.address);

    const message = buildJoinMessage({
      leagueId: league.id,
      leagueName: "unanchored",
      rulesHash: league.rulesHash,
      walletAddress: wallet.address,
      seasonYear: 2026,
    });

    // Asserting the *code*, not just that it threw. The wallet is linked and
    // the signature is genuine precisely so the only thing left to refuse it is
    // the missing anchor — a bare `toThrow` would pass just as happily on a
    // fixture that had gone wrong somewhere else.
    const refused = await joinLeague(db, {
      leagueId: league.id,
      userId: user.id,
      teamName: "Too Early",
      walletAddress: wallet.address,
      signature: wallet.sign(message),
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(JoinError);
    expect((refused as JoinError).code).toBe("LEAGUE_NOT_ANCHORED");
  });

  it("anchors the hash Postgres stored, and admits a member once it has", async () => {
    const { league, rules } = await createPotLeague("anchored");

    // Nothing on-chain yet, and the route's answer to that is "retry", not
    // "this league is fraudulent" — the distinction the 409 branches turn on.
    const before = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.reason).toBe("NOT_FOUND");

    const signature = await anchorOnChain(league.id, league.rulesHash, rules);

    // The whole point: the bytes the program stored are the bytes Postgres
    // hashed. Anything wrong with hex conversion, byte order, or the seed
    // derivation surfaces here and nowhere else.
    const verdict = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.league.rulesHash).toBe(league.rulesHash);
    }

    // And it is a real check rather than one that answers yes to anything.
    const wrong = await verifyLeagueAnchor(program, league.id, "f".repeat(64));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("HASH_MISMATCH");

    // The economic terms agree too, against an account the program really
    // wrote. The unit tests compare hand-built objects, so they cannot catch a
    // field decoded from the wrong type or under the wrong name — this can, and
    // it is the only place that can.
    if (verdict.ok) {
      expect(anchorTermMismatches(verdict.league, expectedTermsFromRules(rules))).toEqual([]);
    }

    await recordChainAnchor(db, league.id, {
      signature,
      cluster: clusterOf(provider.connection),
    });

    const chain = await getChainState(db, league.id);
    expect(chain?.anchoredAt).toBeTruthy();
    expect(chain?.signature).toBe(signature);

    const wallet = testWallet(12);
    const user = await createUser(db, "member@example.com", "Member");
    await linkWallet(db, user.id, wallet.address);

    const message = buildJoinMessage({
      leagueId: league.id,
      leagueName: "anchored",
      rulesHash: league.rulesHash,
      walletAddress: wallet.address,
      seasonYear: 2026,
    });

    const joined = await joinLeague(db, {
      leagueId: league.id,
      userId: user.id,
      teamName: "In Time",
      walletAddress: wallet.address,
      signature: wallet.sign(message),
      // The cluster the anchor was actually recorded on. A devnet anchor is
      // not an anchor for a mainnet stake, and the PDA cannot tell them apart.
      requireCluster: clusterOf(provider.connection),
    });

    expect(joined.teamId).toBeTruthy();
  });

  it("verifies through a provider with no wallet, the way the server does", async () => {
    // `readOnlyEscrow()` builds its provider with `{} as Wallet` — there is
    // deliberately no server keypair, so there is nothing to put there. Anchor
    // wants a wallet it never uses on a read path, and "never uses" is an
    // assumption about a library rather than a fact about our code. If it were
    // wrong, every anchor would fail in production and pass in every test here,
    // because every other test holds a funded wallet.
    const { league, rules } = await createPotLeague("readonly");
    await anchorOnChain(league.id, league.rulesHash, rules);

    const readOnly = new anchor.AnchorProvider(provider.connection, {} as anchor.Wallet, {
      commitment: "confirmed",
    });

    const verdict = await verifyLeagueAnchor(
      escrowProgram(readOnly),
      league.id,
      league.rulesHash,
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses an anchor that carries the signed hash but hostile money terms", async () => {
    // The attack the terms check exists for, run against a real program.
    //
    // The commissioner signs `initialize_league` from their own wallet, so they
    // choose the account's economic terms — and the program cannot check those
    // against `rules_hash`, because to it the hash is 32 opaque bytes. So this
    // anchors the *correct* hash for a league whose signed rules say $23.50,
    // alongside a $50 buy-in and a refund unlock at `i64::MAX`.
    //
    // The hash check passes. It has to: the document really is the one members
    // read. Only the terms check catches this.
    const { league, rules } = await createPotLeague("hostile");
    const pot = rules.pot!;

    const ix = await initializeLeagueIx(program, {
      leagueId: league.id,
      rulesHash: hexToBytes(league.rulesHash), // the honest hash
      mint,
      buyInBaseUnits: "50000000", // rules say 23500000
      refundUnlockAt: "9223372036854775807", // funds frozen forever
      payoutBps: payoutArray(pot.payout),
      feeBps: pot.feeBps,
      feeRecipient: new anchor.web3.PublicKey(pot.feeRecipient),
      maxTeams: rules.league.maxTeams,
      payer: provider.wallet.publicKey,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [], {
      commitment: "confirmed",
    });

    // The hash verifies — which is exactly why this was invisible before.
    const verdict = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    expect(verdict.ok).toBe(true);

    if (verdict.ok) {
      // Decoding i64::MAX must not throw. Reading it as a JS number did, on
      // this input specifically, which turned the worst case into a 500.
      expect(verdict.league.refundUnlockAt).toBe("9223372036854775807");

      const mismatches = anchorTermMismatches(verdict.league, expectedTermsFromRules(rules));
      expect(mismatches.some((m) => /buyIn/.test(m))).toBe(true);
      expect(mismatches.some((m) => /refundUnlockAt/.test(m))).toBe(true);
    }
  });

  it("anchors a free league through the other instruction", async () => {
    // Free leagues take the `initialize_free_league` branch of the panel, and
    // the guarantee they are sold is the same one — so this has to work, or
    // "your rules are fixed and checkable" would hold only where there is
    // money at stake.
    const commissioner = await createUser(db, "free@example.com", "Commish");
    const rules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });
    const league = await createLeague(db, NFL, {
      name: "For Pride",
      commissionerId: commissioner.id,
      rules,
    });

    const ix = await initializeFreeLeagueIx(program, {
      leagueId: league.id,
      rulesHash: hexToBytes(league.rulesHash),
      maxTeams: rules.league.maxTeams,
      payer: provider.wallet.publicKey,
    });
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [], {
      commitment: "confirmed",
    });

    const verdict = await verifyLeagueAnchor(program, league.id, league.rulesHash);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.league.rulesHash).toBe(league.rulesHash);
      // No pot: buy-in zero is what the free instruction writes.
      expect(verdict.league.buyIn).toBe("0");
      expect(verdict.league.hasPot).toBe(false);
    }
  });
});
