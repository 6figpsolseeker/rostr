/**
 * Reading a league's `Scores` account back, and checking it against the rules
 * members signed.
 *
 * ## Why this exists
 *
 * The account carries four things the derivation needs and the score poster must
 * not be free to choose — the tiebreaker chain, the playoff week window, the
 * first-round bye count, and whether third place is played. Pick the tiebreakers
 * and you pick the best-regular-season-record prize holder, which is the same
 * defect as posting a standing outright.
 *
 * **The program cannot check them.** A rules hash is 32 opaque bytes to it, so
 * it has no way to know whether the terms in the account are the terms in the
 * document. That is exactly the position `initialize_league` is in, and the
 * answer is the same one: compare off-chain, and gate something on the result.
 *
 * What it is gated on is **the draw**. `drawDraftOrder` already refuses until
 * the chain says the season started; it now also refuses a `Scores` account that
 * disagrees with the signed rules. A league that never draws has no order, no
 * roster, no schedule and nothing to score — so this is a gate rather than a
 * courtesy, the same way `joinLeague` refusing an unanchored league is what
 * makes `anchorTermMismatches` load-bearing rather than advisory.
 *
 * ## The oracle key is compared too, since schemaVersion 8
 *
 * It was not, for as long as it took to move the schema. Until then the
 * commissioner who created the account chose freely who could post their
 * league's scores, which is the whole of the attack `docs/SETTLEMENT.md` §6
 * describes: name your own key, post the scores that make you champion, and
 * every other check in the system passes.
 */

import type { Program } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

import { scoresPda } from "./program.js";
import type { RostrEscrow } from "./types.js";

/**
 * The wire value of each tiebreaker, mirroring `Tiebreaker` in `derive.rs`.
 *
 * **Written out rather than derived from the union's declaration order**, which
 * is the lesson `PRIZE_ORDER` paid for: the two agree today and nothing makes
 * them, so a reordered union would silently renumber the chain and change who is
 * seed 1. There is a test pinning these.
 */
export const TIEBREAKER_DISCRIMINANTS: Readonly<Record<string, number>> = {
  WIN_PCT: 0,
  POINTS_FOR: 1,
  HEAD_TO_HEAD: 2,
  POINTS_AGAINST: 3,
  LOWEST_TEAM_ID: 4,
};

export interface OnChainRosterEntry {
  /** Lower-case hex without dashes. Compare with `uuidToHex`. */
  readonly teamIdHex: string;
  /** Base58. */
  readonly wallet: string;
}

export interface OnChainScores {
  readonly address: PublicKey;
  readonly league: string;
  readonly oracle: string;
  readonly roster: readonly OnChainRosterEntry[];
  readonly tiebreakers: readonly number[];
  readonly playoffWeeks: readonly number[];
  readonly regularSeasonWeeks: number;
  readonly playoffTeams: number;
  readonly firstRoundByes: number;
  readonly thirdPlace: boolean;
  /** Set once the prizes have been paid. */
  readonly settled: boolean;
  /** Bit `w` set means week `w + 1` is frozen. */
  readonly finalizedWeeks: number;
  /**
   * Unix seconds, as a decimal string, or `"0"` while nothing is finalised.
   *
   * A string for the same reason `refundUnlockAt` is one: it is an `i64`, and
   * `BN.toNumber()` throws above 2^53 rather than letting a comparison run.
   */
  readonly lastFinalizedAt: string;
}

/** A Postgres uuid as the 32 lower-case hex characters the program stores. */
export function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

/**
 * Read a league's `Scores` account, or `null` when it does not exist.
 *
 * Missing is the ordinary case for every league before its commissioner creates
 * one, so it is a return value rather than a throw.
 */
export async function fetchOnChainScores(
  program: Program<RostrEscrow>,
  leagueId: string,
): Promise<OnChainScores | null> {
  const address = scoresPda(leagueId);
  const account = await program.account["scores"]?.fetchNullable(address);
  if (!account) return null;

  const raw = account as {
    league: PublicKey;
    oracle: PublicKey;
    roster: { teamId: number[]; wallet: PublicKey }[];
    tiebreakers: ArrayLike<number>;
    playoffWeeks: ArrayLike<number>;
    regularSeasonWeeks: number;
    playoffTeams: number;
    firstRoundByes: number;
    thirdPlace: boolean;
    settled: boolean;
    finalizedWeeks: number;
    lastFinalizedAt: { toString(): string };
  };

  return {
    address,
    league: raw.league.toBase58(),
    oracle: raw.oracle.toBase58(),
    roster: raw.roster.map((entry) => ({
      teamIdHex: Array.from(entry.teamId)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      wallet: entry.wallet.toBase58(),
    })),
    tiebreakers: Array.from(raw.tiebreakers),
    playoffWeeks: Array.from(raw.playoffWeeks),
    regularSeasonWeeks: raw.regularSeasonWeeks,
    playoffTeams: raw.playoffTeams,
    firstRoundByes: raw.firstRoundByes,
    thirdPlace: raw.thirdPlace,
    settled: raw.settled,
    finalizedWeeks: raw.finalizedWeeks,
    lastFinalizedAt: raw.lastFinalizedAt.toString(),
  };
}

/** The subset of a rule set this comparison reads. */
export interface ScoreTermRules {
  /** `null` for a free league, which has no settlement and no oracle. */
  readonly pot: { readonly settlementOracle: string } | null;
  readonly schedule: {
    readonly regularSeasonWeeks: number;
    readonly playoffWeeks: readonly number[];
    readonly playoffTeams: number;
    readonly byeSeeds: number;
    readonly tiebreakers: readonly string[];
  };
}

export interface ExpectedScoreTerms {
  /** Base58, or `null` for a free league. */
  readonly oracle: string | null;
  readonly tiebreakers: readonly number[];
  readonly playoffWeeks: readonly number[];
  readonly regularSeasonWeeks: number;
  readonly playoffTeams: number;
  readonly firstRoundByes: number;
  readonly thirdPlace: boolean;
  readonly teamCount: number;
}

/**
 * What a league's `Scores` account must say, given its signed rules and the size
 * of the field that actually formed.
 *
 * **`firstRoundByes` depends on both**, which is why `teamCount` is a parameter
 * rather than something read out of the rules. The frozen `byeSeeds` applies
 * only when the playoff field is the size it was frozen for; a smaller league
 * takes whatever byes its own size needs to form a valid round. `playoffState`
 * in `@rostr/db` makes the same choice for the same reason, and the two must not
 * disagree — a wrong bye count changes who plays whom in a bracket that decides
 * the pot.
 */
export function expectedScoreTerms(
  rules: ScoreTermRules,
  teamCount: number,
): ExpectedScoreTerms {
  const field = Math.min(rules.schedule.playoffTeams, teamCount);

  return {
    oracle: rules.pot?.settlementOracle ?? null,
    tiebreakers: rules.schedule.tiebreakers.map((name) => {
      const value = TIEBREAKER_DISCRIMINANTS[name];
      // Refused rather than defaulted: a tiebreaker nobody recognises must not
      // quietly become "win percentage", which is what index 0 would do.
      if (value === undefined) throw new Error(`unknown tiebreaker: ${name}`);
      return value;
    }),
    playoffWeeks: [...rules.schedule.playoffWeeks],
    regularSeasonWeeks: rules.schedule.regularSeasonWeeks,
    // The signed seat count, not the field that formed. `settle` caps it by the
    // roster itself, so a league that never filled still brackets correctly —
    // but the *stored* value has to be the one members agreed to, or a caller
    // could shrink the bracket by writing a smaller number.
    playoffTeams: rules.schedule.playoffTeams,
    firstRoundByes:
      field === rules.schedule.playoffTeams ? rules.schedule.byeSeeds : byesFor(field),
    // Always played, paid or not — `playsThirdPlace` in `@rostr/db`. A constant
    // rather than a rule field today; if it ever becomes one, this follows it.
    thirdPlace: true,
    teamCount,
  };
}

/** Byes needed to bring a field up to a power of two. Mirrors `byesFor`. */
function byesFor(field: number): number {
  let power = 1;
  while (power < field) power *= 2;
  return power - field;
}

/**
 * Everything the on-chain account says that the signed rules do not.
 *
 * Empty means it agrees. **Every mismatch is reported rather than the first**,
 * because they are frozen together and the account can never be rewritten — so
 * whoever has to recreate the league needs the whole list, not one item per
 * attempt. Same shape and same reasoning as `anchorTermMismatches`.
 */
export function scoresTermMismatches(
  onChain: OnChainScores,
  expected: ExpectedScoreTerms,
): string[] {
  const out: string[] = [];
  const same = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  /*
    The oracle first, because it is the one that decides everything else.

    Whoever holds this key posts the scores the champion is derived from, so a
    key nobody signed is a league whose result was decided by a stranger — and
    every other check here would pass while that was true. It is compared
    against the signed document rather than against our own configuration for
    the same reason `anchorTermMismatches` compares the fee recipient that way:
    what matters is that members agreed to it, not that we recognise it.
  */
  if (expected.oracle !== null && onChain.oracle !== expected.oracle) {
    out.push(`settlementOracle: chain has ${onChain.oracle}, rules say ${expected.oracle}`);
  }

  if (!same(onChain.tiebreakers, expected.tiebreakers)) {
    out.push(
      `tiebreakers: chain has [${onChain.tiebreakers.join(", ")}], ` +
        `rules say [${expected.tiebreakers.join(", ")}]`,
    );
  }
  if (!same(onChain.playoffWeeks, expected.playoffWeeks)) {
    out.push(
      `playoffWeeks: chain has [${onChain.playoffWeeks.join(", ")}], ` +
        `rules say [${expected.playoffWeeks.join(", ")}]`,
    );
  }
  if (onChain.playoffTeams !== expected.playoffTeams) {
    out.push(
      `playoffTeams: chain has ${onChain.playoffTeams}, rules say ${expected.playoffTeams}`,
    );
  }
  if (onChain.regularSeasonWeeks !== expected.regularSeasonWeeks) {
    out.push(
      `regularSeasonWeeks: chain has ${onChain.regularSeasonWeeks}, ` +
        `rules say ${expected.regularSeasonWeeks}`,
    );
  }
  if (onChain.firstRoundByes !== expected.firstRoundByes) {
    out.push(
      `firstRoundByes: chain has ${onChain.firstRoundByes}, ` +
        `rules say ${expected.firstRoundByes}`,
    );
  }
  if (onChain.thirdPlace !== expected.thirdPlace) {
    out.push(`thirdPlace: chain has ${onChain.thirdPlace}, rules say ${expected.thirdPlace}`);
  }
  // A roster short of the field cannot pay everyone; one longer names somebody
  // who is not in the league. Both are unrecoverable once the season starts and
  // both are cheap to catch here.
  if (onChain.roster.length !== expected.teamCount) {
    out.push(
      `roster: chain has ${onChain.roster.length} teams, the league has ${expected.teamCount}`,
    );
  }

  return out;
}
