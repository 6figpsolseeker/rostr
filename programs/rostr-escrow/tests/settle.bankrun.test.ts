import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Clock, start, type ProgramTestContext } from "solana-bankrun";
import { beforeAll, describe, expect, it } from "vitest";
import type { EscrowProgram } from "./helpers.js";

/**
 * The payout, actually happening.
 *
 * ## Why this file exists, and why it is not `anchor test`
 *
 * `settle` refuses until seven days after the last week is finalised. That hold
 * is the only thing in the design bounding a settlement oracle that *works and
 * lies* — it is the window in which anyone can compare the posted scores against
 * the providers before the money moves — so it is not something to weaken for a
 * test.
 *
 * It does mean no wall-clock validator can reach the successful payout. For a
 * while the program suite covered every refusal and never once watched a token
 * leave the vault, which for the instruction that pays real people is the wrong
 * thing to be confident about by reasoning.
 *
 * `solana-bankrun` runs the same compiled program in-process and lets the `Clock`
 * sysvar be set directly, so the seven days pass in a line of code and the
 * transfer is observed rather than argued about.
 *
 * **`litesvm` was tried first and does not fit.** Its 1.x line speaks the newer
 * `@solana/kit` dialect, where an address is a string rather than a `PublicKey`
 * — adopting it would mean a second way of building every instruction, beside
 * the Anchor builders the rest of this suite uses. Its 0.x line is web3.js v1
 * but old enough that loading a program built by Solana 4.0 aborts the process.
 * `solana-bankrun` is v1 throughout, so the instruction builders below are the
 * same ones the validator tests use.
 *
 * ## It only runs on Linux, and that is fine
 *
 * The native binding publishes no win32 build. This file lives under
 * `programs/` and runs through `vitest.bankrun.config.ts` — `pnpm test:bankrun`,
 * after `anchor build`. It is deliberately **not** part of `anchor test`: it
 * needs no validator, and beside a running one it competes for the machine.
 *
 * ## The league is deliberately tiny
 *
 * Two teams, a two-week season and a one-week final: the smallest shape that
 * still produces a champion, a runner-up and a separate best-record holder. The
 * kernels are pinned against the TypeScript by the corpora, so nothing here is
 * trying to test the derivation again — this tests that the money follows it.
 */

const IDL_PATH = join(process.cwd(), "target", "idl", "rostr_escrow.json");

const BUY_IN = 5_555_555;
const FEE_BPS = 100;
const DAY = 24 * 60 * 60;

let programId: anchor.web3.PublicKey;
let program: EscrowProgram;

beforeAll(() => {
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as anchor.Idl;
  programId = new anchor.web3.PublicKey(idl.address);
  // A provider with no connection: every call below builds an instruction and
  // none of them talks to a node. Anchor never touches the wallet on that path.
  program = new anchor.Program(idl, {
    connection: null as never,
    publicKey: anchor.web3.PublicKey.default,
  } as never);
});

const uuidBytes = (n: number): number[] => {
  const bytes = new Array<number>(16).fill(0);
  bytes[15] = n;
  return bytes;
};

function pda(seeds: (Buffer | Uint8Array)[]): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** Sign and send, failing loudly with the program's own error. */
async function send(
  ctx: ProgramTestContext,
  ixs: anchor.web3.TransactionInstruction[],
  payer: anchor.web3.Keypair,
  extra: anchor.web3.Keypair[] = [],
): Promise<void> {
  const tx = new anchor.web3.Transaction();
  tx.add(...ixs);
  // A fresh blockhash each time. Reusing one makes every transaction after the
  // first a duplicate, which reads as a program failure and is not one.
  // Non-null rather than a guard, and the shape matters: binding the result to a
  // local that outlives this line deadlocks the banks client after a few sends.
  // It is a native object, and holding it alive appears to hold something Rust
  // side — the guarded version passed four sends and then hung for the full
  // three-minute timeout, every run. Destructure and drop, as this always did.
  // A null here throws a TypeError on the next line, which is what it did before.
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...extra);
  await ctx.banksClient.processTransaction(tx);
}

/**
 * Move the wall clock, which is the entire reason this file is not an
 * `anchor test`.
 *
 * The slot is carried forward with it so the two do not disagree — a clock
 * whose timestamp has jumped a week while its slot has not is a state no real
 * chain produces, and the program reads both.
 */
async function setUnixTimestamp(ctx: ProgramTestContext, seconds: bigint): Promise<void> {
  const current = await ctx.banksClient.getClock();
  ctx.setClock(
    new Clock(
      current.slot,
      current.epochStartTimestamp,
      current.epoch,
      current.leaderScheduleEpoch,
      seconds,
    ),
  );
}

describe("settle pays the prizes", () => {
  // Generous, because every transaction here crosses the 9p mount into the
  // Windows filesystem, which CLAUDE.md notes is slow for small-file I/O.
  it(
    "moves the pot to the three derived winners and the fee recipient",
    { timeout: 180_000 },
    async () => {
      const ctx = await start([{ name: "rostr_escrow", programId }], []);

      const commissioner = anchor.web3.Keypair.generate();
      const oracle = anchor.web3.Keypair.generate();
      const alice = anchor.web3.Keypair.generate();
      const bob = anchor.web3.Keypair.generate();
      const feeOwner = anchor.web3.Keypair.generate();
      const mintKp = anchor.web3.Keypair.generate();

      for (const kp of [commissioner, oracle, alice, bob, feeOwner]) {
        ctx.setAccount(kp.publicKey, {
          lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        });
      }

      // A start point far enough from zero that subtracting days stays positive.
      const t0 = BigInt(1_800_000_000);
      await setUnixTimestamp(ctx, t0);

      // --- the pot token ---------------------------------------------------
      const mint = mintKp.publicKey;
      await send(
        ctx,
        [
          anchor.web3.SystemProgram.createAccount({
            fromPubkey: commissioner.publicKey,
            newAccountPubkey: mint,
            space: MINT_SIZE,
            lamports: Number(
              (await ctx.banksClient.getRent()).minimumBalance(BigInt(MINT_SIZE)),
            ),
            programId: TOKEN_PROGRAM_ID,
          }),
          // Six decimals, which the program requires so that its buy-in bounds
          // mean dollars rather than "fifty million of something".
          createInitializeMint2Instruction(mint, 6, commissioner.publicKey, null),
        ],
        commissioner,
        [mintKp],
      );

      const ata = (owner: anchor.web3.PublicKey) => getAssociatedTokenAddressSync(mint, owner);
      for (const owner of [alice, bob, feeOwner]) {
        await send(
          ctx,
          [
            createAssociatedTokenAccountInstruction(
              commissioner.publicKey,
              ata(owner.publicKey),
              owner.publicKey,
              mint,
            ),
          ],
          commissioner,
        );
      }
      for (const member of [alice, bob]) {
        await send(
          ctx,
          [
            createMintToInstruction(
              mint,
              ata(member.publicKey),
              commissioner.publicKey,
              BUY_IN,
            ),
          ],
          commissioner,
        );
      }

      // --- the league ------------------------------------------------------
      const leagueId = uuidBytes(9);
      const league = pda([Buffer.from("league"), Buffer.from(leagueId)]);
      const vault = pda([Buffer.from("vault"), league.toBuffer()]);
      const scores = pda([Buffer.from("scores"), league.toBuffer()]);
      const membership = (m: anchor.web3.PublicKey) =>
        pda([Buffer.from("membership"), league.toBuffer(), m.toBuffer()]);

      const draftAt = t0 + BigInt(7 * DAY);
      await send(
        ctx,
        [
          await program.methods
            .initializeLeague({
              leagueId,
              rulesHash: Array.from({ length: 32 }, (_, i) => (i + 1) % 256),
              buyIn: new anchor.BN(BUY_IN),
              refundUnlockAt: new anchor.BN((t0 + BigInt(300 * DAY)).toString()),
              startDeadline: new anchor.BN((draftAt + BigInt(2 * DAY)).toString()),
              payoutBps: [7000, 2000, 1000, 0, 0],
              feeBps: FEE_BPS,
              feeRecipient: feeOwner.publicKey,
              maxTeams: 2,
            })
            .accountsPartial({
              league,
              mint,
              vault,
              payer: commissioner.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        commissioner,
      );

      const rulesHash = Array.from({ length: 32 }, (_, i) => (i + 1) % 256);
      for (const member of [alice, bob]) {
        await send(
          ctx,
          [
            await program.methods
              .joinLeague(rulesHash)
              .accountsPartial({
                league,
                membership: membership(member.publicKey),
                member: member.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
              })
              .instruction(),
            await program.methods
              .deposit()
              .accountsPartial({
                league,
                membership: membership(member.publicKey),
                vault,
                memberTokenAccount: ata(member.publicKey),
                member: member.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .instruction(),
          ],
          member,
        );
      }

      expect(Number((await getAccount(asConnection(ctx), vault)).amount)).toBe(2 * BUY_IN);

      // --- the settlement account -----------------------------------------
      // Alice is team 0, Bob is team 1. The order here is what every posted game
      // indexes into afterwards.
      await send(
        ctx,
        [
          await program.methods
            .initializeScores({
              teamIds: [uuidBytes(1), uuidBytes(2)],
              oracle: oracle.publicKey,
              tiebreakers: Buffer.from([0, 1, 4]),
              playoffWeeks: Buffer.from([3]),
              regularSeasonWeeks: 2,
              playoffTeams: 2,
              firstRoundByes: 0,
              thirdPlace: false,
            })
            .accountsPartial({
              league,
              scores,
              commissioner: commissioner.publicKey,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .remainingAccounts(
              [alice, bob].map((m) => ({
                pubkey: membership(m.publicKey),
                isSigner: false,
                isWritable: false,
              })),
            )
            .instruction(),
        ],
        commissioner,
      );

      await send(
        ctx,
        [
          await program.methods
            .startSeason()
            .accountsPartial({ league, commissioner: commissioner.publicKey })
            .instruction(),
        ],
        commissioner,
      );

      // --- the season ------------------------------------------------------
      // Alice (team 0) wins both regular-season games, so she is seed 1 and takes
      // the best-record prize. Bob (team 1) wins the final, so he is champion.
      // **They must come out different**, or the test would pass on an
      // implementation that confused the two questions.
      const game = (home: number, away: number, hp: number, ap: number) => ({
        home,
        away,
        homeMilliPoints: hp,
        awayMilliPoints: ap,
      });

      const weeks: [number, ReturnType<typeof game>[]][] = [
        [1, [game(0, 1, 120_000, 100_000)]],
        [2, [game(1, 0, 90_000, 110_000)]],
        [3, [game(0, 1, 95_000, 130_000)]],
      ];
      for (const [week, games] of weeks) {
        await send(
          ctx,
          [
            await program.methods
              .postWeek(week, games)
              .accountsPartial({ scores, oracle: oracle.publicKey })
              .instruction(),
            await program.methods
              .finalizeWeek(week)
              .accountsPartial({ scores, oracle: oracle.publicKey })
              .instruction(),
          ],
          oracle,
        );
      }

      const settleIx = async () =>
        program.methods
          .settle()
          .accountsPartial({
            league,
            scores,
            oracle: oracle.publicKey,
            vault,
            championTokens: ata(bob.publicKey),
            runnerUpTokens: ata(alice.publicKey),
            regularSeasonTokens: ata(alice.publicKey),
            feeTokens: ata(feeOwner.publicKey),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

      // --- the hold --------------------------------------------------------
      // Immediately after the last week is frozen, settlement is refused. This is
      // the assertion the wall-clock suite could already make; the next one is the
      // one it never could.
      const held = await settleIx();
      await expect(send(ctx, [held], oracle)).rejects.toThrow();

      // Seven days and a minute later it is allowed. The whole reason this file
      // exists: the clock moves and the transfer is observed rather than reasoned
      // about.
      await setUnixTimestamp(ctx, t0 + BigInt(7 * DAY) + BigInt(60));
      await send(ctx, [await settleIx()], oracle);

      // --- the money -------------------------------------------------------
      const conn = asConnection(ctx);
      const pot = 2 * BUY_IN;
      const fee = Math.floor((pot * FEE_BPS) / 10_000);
      const distributable = pot - fee;
      const runnerUp = Math.floor((distributable * 2000) / 10_000);
      const regular = Math.floor((distributable * 1000) / 10_000);
      const champion = distributable - runnerUp - regular;

      // Bob is champion. Alice is both runner-up and best record, so she receives
      // two shares into one account.
      expect(Number((await getAccount(conn, ata(bob.publicKey))).amount)).toBe(champion);
      expect(Number((await getAccount(conn, ata(alice.publicKey))).amount)).toBe(
        runnerUp + regular,
      );
      expect(Number((await getAccount(conn, ata(feeOwner.publicKey))).amount)).toBe(fee);

      // Nothing stranded: the vault is emptied of exactly the pot, and every base
      // unit of it landed somewhere. The champion absorbs the rounding remainder,
      // which is why this adds up rather than leaving dust nobody can ever claim.
      expect(champion + runnerUp + regular + fee).toBe(pot);
      expect(Number((await getAccount(conn, vault)).amount)).toBe(0);

      // And it cannot happen twice.
      const again = await settleIx();
      await expect(send(ctx, [again], oracle)).rejects.toThrow();
    },
  );
});

/**
 * `getAccount` from `@solana/spl-token` wants a `Connection`; a bankrun context
 * is not one. Only `getAccountInfo` is ever reached, so this adapts that single
 * method rather than decoding token accounts a second way here — a second
 * decoder could disagree with the one the rest of the suite trusts.
 */
function asConnection(ctx: ProgramTestContext): never {
  return {
    getAccountInfo: async (address: anchor.web3.PublicKey) => {
      const account = await ctx.banksClient.getAccount(address);
      if (!account) return null;
      return {
        data: Buffer.from(account.data),
        owner: account.owner,
        lamports: Number(account.lamports),
        executable: account.executable,
        rentEpoch: Number(account.rentEpoch ?? 0),
      };
    },
  } as never;
}
