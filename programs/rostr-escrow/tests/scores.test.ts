import * as anchor from "@coral-xyz/anchor";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPotMint,
  fundedMember,
  getProgram,
  getProvider,
  leaguePda,
  membershipPda,
  startSeason,
  validArgs,
  validFreeArgs,
  vaultPda,
  type InitArgs,
} from "./helpers";

/**
 * G7 — the scores account, its roster, and posting.
 *
 * The roster is the only thing on-chain that connects a team to a wallet, so it
 * is what settlement will pay. Everything here is about the two properties that
 * makes it safe to write months before the money moves: **the wallet is derived
 * from a funded `Membership` rather than supplied**, and **the account is
 * written once, before the season is declared started**, which is the window in
 * which every member can check their own row and withhold `start_season` if it
 * is wrong.
 *
 * None of these instructions moves a token. `settlement.test.ts` asserts the
 * mainnet deposit gate is still shut with all three present.
 */

const BUY_IN = 10_000_000;
const TEAM_A = Array.from({ length: 16 }, (_, i) => i + 1);
const TEAM_B = Array.from({ length: 16 }, (_, i) => 100 + i);

let program: anchor.Program;
let provider: anchor.AnchorProvider;
let mint: anchor.web3.PublicKey;

beforeAll(async () => {
  provider = getProvider();
  program = getProgram(provider);
  mint = await createPotMint(provider);
});

const scoresPda = (league: anchor.web3.PublicKey): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("scores"), league.toBuffer()],
    program.programId,
  )[0];

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

/** A member who has joined and staked — the only kind the roster accepts. */
async function stakedMember(league: anchor.web3.PublicKey, rulesHash: number[]) {
  const member = await fundedMember(provider, mint, BUY_IN);
  await program.methods
    .joinLeague(rulesHash)
    .accounts({
      league,
      membership: membershipPda(program, league, member.keypair.publicKey),
      member: member.keypair.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([member.keypair])
    .rpc();
  await program.methods
    .deposit()
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
  return member;
}

const defaultScoresArgs = (oracle: anchor.web3.PublicKey, teamIds: number[][]) => ({
  teamIds,
  oracle,
  // WIN_PCT, POINTS_FOR, HEAD_TO_HEAD, POINTS_AGAINST, LOWEST_TEAM_ID.
  tiebreakers: Buffer.from([0, 1, 2, 3, 4]),
  playoffWeeks: Buffer.from([15, 16, 17]),
  regularSeasonWeeks: 14,
  firstRoundByes: 0,
  thirdPlace: false,
});

async function initScores(
  league: anchor.web3.PublicKey,
  members: { keypair: anchor.web3.Keypair }[],
  teamIds: number[][],
  oracle: anchor.web3.PublicKey,
  overrides: Record<string, unknown> = {},
) {
  return program.methods
    .initializeScores({ ...defaultScoresArgs(oracle, teamIds), ...overrides })
    .accounts({
      league,
      scores: scoresPda(league),
      commissioner: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .remainingAccounts(
      members.map((m) => ({
        pubkey: membershipPda(program, league, m.keypair.publicKey),
        isSigner: false,
        isWritable: false,
      })),
    )
    .rpc();
}

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => String(error).includes(code),
    `expected ${code}`,
  );
}

describe("the payee roster", () => {
  it("reads each wallet out of a funded membership rather than being told it", async () => {
    // The property the whole design rests on. A caller with no way to *name* a
    // wallet has no way to name somebody else's — the arguments carry team ids
    // and nothing else, and the payee comes from the `Membership` account.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);
    const oracle = anchor.web3.Keypair.generate().publicKey;

    await initScores(league, [a, b], [TEAM_A, TEAM_B], oracle);

    const scores = await program.account["scores"]!.fetch(scoresPda(league));
    const roster = scores["roster"] as { teamId: number[]; wallet: anchor.web3.PublicKey }[];

    expect(roster).toHaveLength(2);
    expect(roster[0]!.teamId).toEqual(TEAM_A);
    expect(roster[0]!.wallet.toBase58()).toBe(a.keypair.publicKey.toBase58());
    expect(roster[1]!.wallet.toBase58()).toBe(b.keypair.publicKey.toBase58());
    expect((scores["oracle"] as anchor.web3.PublicKey).toBase58()).toBe(oracle.toBase58());
  });

  it("refuses a member who joined and never staked", async () => {
    // `deposited > 0` is the constraint that makes "cannot name a stranger"
    // structural: a wallet on the roster demonstrably has money in this vault.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const funded = await stakedMember(league, args.rulesHash);

    const joinedOnly = await fundedMember(provider, mint, BUY_IN);
    await program.methods
      .joinLeague(args.rulesHash)
      .accounts({
        league,
        membership: membershipPda(program, league, joinedOnly.keypair.publicKey),
        member: joinedOnly.keypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([joinedOnly.keypair])
      .rpc();

    await expectError(
      initScores(
        league,
        [funded, joinedOnly],
        [TEAM_A, TEAM_B],
        anchor.web3.Keypair.generate().publicKey,
      ),
      "NothingDeposited",
    );
  });

  it("refuses an account that is not this program's membership", async () => {
    // Passing the league account itself, which exists and is owned by this
    // program but is not a `Membership`. The discriminator is what catches it.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);

    await expect(
      program.methods
        .initializeScores(
          defaultScoresArgs(anchor.web3.Keypair.generate().publicKey, [TEAM_A, TEAM_B]),
        )
        .accounts({
          league,
          scores: scoresPda(league),
          commissioner: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: membershipPda(program, league, a.keypair.publicKey),
            isSigner: false,
            isWritable: false,
          },
          { pubkey: league, isSigner: false, isWritable: false },
        ])
        .rpc(),
    ).rejects.toThrow();
  });

  it("refuses the same wallet twice", async () => {
    // Two teams sharing a payee would send both prizes to one person and leave
    // a real member unpayable, with no instruction able to correct it.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);

    await expectError(
      initScores(league, [a, a], [TEAM_A, TEAM_B], anchor.web3.Keypair.generate().publicKey),
      "DuplicateRosterEntry",
    );
  });

  it("refuses a membership count that does not match the team ids", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);

    await expectError(
      initScores(league, [a], [TEAM_A, TEAM_B], anchor.web3.Keypair.generate().publicKey),
      "RosterIncomplete",
    );
  });

  it("refuses anyone but the commissioner", async () => {
    // Not the oracle: the oracle key is *content* of this account, so at
    // creation there is nothing stored to check a signer against. Binding to the
    // commissioner is what stops a stranger front-running creation and writing a
    // hostile roster — permanent, since nothing closes this account.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);
    const stranger = await fundedMember(provider, mint, 0);

    await expectError(
      program.methods
        .initializeScores(
          defaultScoresArgs(anchor.web3.Keypair.generate().publicKey, [TEAM_A, TEAM_B]),
        )
        .accounts({
          league,
          scores: scoresPda(league),
          commissioner: stranger.keypair.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts(
          [a, b].map((m) => ({
            pubkey: membershipPda(program, league, m.keypair.publicKey),
            isSigner: false,
            isWritable: false,
          })),
        )
        .signers([stranger.keypair])
        .rpc(),
      "NotCommissioner",
    );
  });

  it("refuses an oracle that is the commissioner", async () => {
    /*
      The commissioner writes this account, so without this check they could
      name themselves and post the scores that decide a pot they hold a stake
      in — `docs/RULES.md` §9's "not permitted, ever: anything that touches a
      roster, a score, a standing, or the pot", in one transaction.

      Off-chain the key comes from server configuration and the draw compares it
      against the signed rules, which is the stronger check. This one binds a
      caller who never touched our service.
    */
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);

    await expectError(
      initScores(league, [a, b], [TEAM_A, TEAM_B], provider.wallet.publicKey),
      "OracleIsCommissioner",
    );
  });

  it("refuses an empty oracle", async () => {
    // The default pubkey cannot sign, so a league naming it could never have a
    // score posted and would fall to the timelock refund with no earlier signal.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);

    await expectError(
      initScores(league, [a, b], [TEAM_A, TEAM_B], anchor.web3.PublicKey.default),
      "OracleMissing",
    );
  });

  it("refuses once the season has started", async () => {
    // The roster has to exist while members can still act on it being wrong.
    // After `start_season` the failed-league refund is shut, so a roster written
    // then could never be answered by withholding anything.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);
    await startSeason(program, league);

    await expectError(
      initScores(league, [a, b], [TEAM_A, TEAM_B], anchor.web3.Keypair.generate().publicKey),
      "AlreadyStarted",
    );
  });

  it("refuses a free league", async () => {
    // No vault, no `Membership`, nothing to settle and no wallet to derive.
    const freeArgs = validFreeArgs();
    const league = leaguePda(program, freeArgs.leagueId);
    await program.methods
      .initializeFreeLeague(freeArgs)
      .accounts({
        league,
        payer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    await expectError(
      initScores(league, [], [], anchor.web3.Keypair.generate().publicKey),
      "LeagueHasNoPot",
    );
  });

  it("cannot be written twice", async () => {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);
    const oracle = anchor.web3.Keypair.generate().publicKey;

    await initScores(league, [a, b], [TEAM_A, TEAM_B], oracle);
    await expect(initScores(league, [a, b], [TEAM_A, TEAM_B], oracle)).rejects.toThrow();
  });

  it("refuses an unknown tiebreaker rather than storing it", async () => {
    // Caught now rather than in December. An unrecognised discriminant written
    // here would make the derivation refuse forever, on an account that can
    // never be rewritten.
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);

    await expectError(
      initScores(league, [a, b], [TEAM_A, TEAM_B], anchor.web3.Keypair.generate().publicKey, {
        tiebreakers: Buffer.from([0, 99]),
      }),
      "UnknownTiebreaker",
    );
  });
});

describe("posting a week", () => {
  async function ready() {
    const args = validArgs({ buyIn: new anchor.BN(BUY_IN) });
    const league = await initialize(args);
    const a = await stakedMember(league, args.rulesHash);
    const b = await stakedMember(league, args.rulesHash);
    const oracle = anchor.web3.Keypair.generate();
    await initScores(league, [a, b], [TEAM_A, TEAM_B], oracle.publicKey);
    return { league, oracle };
  }

  const game = (home: number, away: number, hp: number, ap: number) => ({
    home,
    away,
    homeMilliPoints: hp,
    awayMilliPoints: ap,
  });

  const post = (
    league: anchor.web3.PublicKey,
    oracle: anchor.web3.Keypair,
    week: number,
    games: ReturnType<typeof game>[],
  ) =>
    program.methods
      .postWeek(week, games)
      .accounts({ scores: scoresPda(league), oracle: oracle.publicKey })
      .signers([oracle])
      .rpc();

  it("stores a week, and lets it be rewritten until it is finalised", async () => {
    // The whole reason weeks are not write-once. The program holds no schedule,
    // so it cannot tell a real week 17 from one posted in September — and a
    // single wrong index would otherwise make the derivation refuse forever,
    // with no overwrite and, after the upgrade burn, no fix.
    const { league, oracle } = await ready();

    await post(league, oracle, 3, [game(0, 1, 110_000, 100_000)]);
    let scores = await program.account["scores"]!.fetch(scoresPda(league));
    expect((scores["games"] as unknown[][])[2]).toHaveLength(1);

    await post(league, oracle, 3, [game(1, 0, 90_000, 95_000)]);
    scores = await program.account["scores"]!.fetch(scoresPda(league));
    const corrected = (scores["games"] as { home: number }[][])[2]!;
    expect(corrected[0]!.home).toBe(1);
  });

  it("refuses anyone but the oracle", async () => {
    const { league, oracle } = await ready();
    const impostor = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(impostor.publicKey, 1_000_000_000);

    await expectError(post(league, impostor, 3, [game(0, 1, 1, 2)]), "NotTheOracle");
    // And the real one still works, so the refusal is about the key rather than
    // about the instruction being broken.
    await expect(post(league, oracle, 3, [game(0, 1, 1, 2)])).resolves.toBeTruthy();
  });

  it("refuses a team index outside the roster", async () => {
    const { league, oracle } = await ready();
    await expectError(post(league, oracle, 3, [game(0, 5, 1, 2)]), "UnknownTeam");
  });

  it("refuses a team playing itself", async () => {
    // The derivation would credit both halves of the result to one record.
    const { league, oracle } = await ready();
    await expectError(post(league, oracle, 3, [game(1, 1, 1, 2)]), "MalformedSchedule");
  });

  it("refuses a week outside the season", async () => {
    const { league, oracle } = await ready();
    await expectError(post(league, oracle, 0, []), "UnknownWeek");
    await expectError(post(league, oracle, 19, []), "UnknownWeek");
  });

  it("freezes a week, and the freeze is permanent", async () => {
    const { league, oracle } = await ready();
    await post(league, oracle, 3, [game(0, 1, 110_000, 100_000)]);

    await program.methods
      .finalizeWeek(3)
      .accounts({ scores: scoresPda(league), oracle: oracle.publicKey })
      .signers([oracle])
      .rpc();

    await expectError(post(league, oracle, 3, [game(0, 1, 1, 2)]), "WeekAlreadyFinal");
    await expectError(
      program.methods
        .finalizeWeek(3)
        .accounts({ scores: scoresPda(league), oracle: oracle.publicKey })
        .signers([oracle])
        .rpc(),
      "WeekAlreadyFinal",
    );

    // A different week is untouched by the freeze on this one.
    await expect(post(league, oracle, 4, [game(0, 1, 1, 2)])).resolves.toBeTruthy();
  });

  it("records when a week was finalised, which is what the settlement hold reads", async () => {
    // Payout is illegal until seven days after this instant. It is the only
    // thing in the design that bounds an oracle which works and lies —
    // everything else bounds one that is absent.
    const { league, oracle } = await ready();

    let scores = await program.account["scores"]!.fetch(scoresPda(league));
    expect((scores["lastFinalizedAt"] as anchor.BN).toNumber()).toBe(0);

    const before = Math.floor(Date.now() / 1000);
    await program.methods
      .finalizeWeek(3)
      .accounts({ scores: scoresPda(league), oracle: oracle.publicKey })
      .signers([oracle])
      .rpc();

    scores = await program.account["scores"]!.fetch(scoresPda(league));
    const at = (scores["lastFinalizedAt"] as anchor.BN).toNumber();
    expect(at).toBeGreaterThan(0);
    // Generous, because a local validator's clock drifts from the wall clock —
    // see CLAUDE.md. The assertion is that it was stamped, not when.
    expect(Math.abs(at - before)).toBeLessThan(2 * 60 * 60);
  });
});
