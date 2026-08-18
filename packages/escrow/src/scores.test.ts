import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  expectedScoreTerms,
  scoresTermMismatches,
  TIEBREAKER_DISCRIMINANTS,
  uuidToHex,
  type OnChainScores,
  type ScoreTermRules,
} from "./scores.js";

/**
 * The comparison that binds a `Scores` account to the rules members signed.
 *
 * It is the only enforcement that account gets — the program stores the
 * tiebreaker chain and the payee roster and cannot check either against a rules
 * hash it sees as 32 opaque bytes. So these tests are the ones standing between
 * a hostile settlement account and a drawn season.
 */

const ORACLE = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";

const RULES: ScoreTermRules = {
  pot: { settlementOracle: ORACLE },
  schedule: {
    regularSeasonWeeks: 14,
    playoffWeeks: [15, 16, 17],
    playoffTeams: 6,
    byeSeeds: 2,
    tiebreakers: ["WIN_PCT", "POINTS_FOR", "HEAD_TO_HEAD", "POINTS_AGAINST", "LOWEST_TEAM_ID"],
  },
};

const onChain = (overrides: Partial<OnChainScores> = {}): OnChainScores => ({
  address: PublicKey.default,
  league: PublicKey.default.toBase58(),
  oracle: ORACLE,
  roster: Array.from({ length: 12 }, (_, i) => ({
    teamIdHex: String(i).padStart(32, "0"),
    wallet: PublicKey.default.toBase58(),
  })),
  tiebreakers: [0, 1, 2, 3, 4],
  playoffWeeks: [15, 16, 17],
  regularSeasonWeeks: 14,
  firstRoundByes: 2,
  thirdPlace: true,
  finalizedWeeks: 0,
  lastFinalizedAt: "0",
  ...overrides,
});

describe("TIEBREAKER_DISCRIMINANTS", () => {
  it("matches the wire values in derive.rs", () => {
    // Pinned, because the two sides are numbers and nothing else connects them.
    // `derive.rs` reads these off an account and `Tiebreaker::from_u8` refuses
    // anything else — so a renumbering here does not fail loudly, it seeds the
    // league by a different chain and hands the regular-season prize to somebody
    // else. Same class of bug as `PRIZE_ORDER`, and the same fix: write it out.
    expect(TIEBREAKER_DISCRIMINANTS).toEqual({
      WIN_PCT: 0,
      POINTS_FOR: 1,
      HEAD_TO_HEAD: 2,
      POINTS_AGAINST: 3,
      LOWEST_TEAM_ID: 4,
    });
  });
});

describe("expectedScoreTerms", () => {
  it("maps the signed chain to discriminants in order", () => {
    expect(expectedScoreTerms(RULES, 12).tiebreakers).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses a tiebreaker it does not recognise rather than defaulting", () => {
    // Index 0 is WIN_PCT, so a silent default would seed the whole league by win
    // percentage alone and look entirely plausible.
    const bad: ScoreTermRules = {
      schedule: { ...RULES.schedule, tiebreakers: ["WIN_PCT", "COIN_FLIP"] },
    };
    expect(() => expectedScoreTerms(bad, 12)).toThrow(/COIN_FLIP/);
  });

  it("keeps the frozen bye count when the playoff field is the size it was frozen for", () => {
    // Twelve teams, six playoff seats: the field is exactly `playoffTeams`, so
    // the signed `byeSeeds` applies.
    expect(expectedScoreTerms(RULES, 12).firstRoundByes).toBe(2);
    expect(expectedScoreTerms(RULES, 6).firstRoundByes).toBe(2);
  });

  it("derives the bye count for a league that never filled", () => {
    /*
      Five friends in a twelve-seat league play a five-team bracket, and applying
      a bye count sized for six fails in two ways — the quieter one being worse.
      Five teams with two byes leaves three to pair, which throws. Four teams
      with two byes does not throw at all: it plays a bracket nobody agreed to,
      with seed 1 idle twice and one game all postseason.

      This must agree with `playoffState` in `@rostr/db`, which makes the same
      choice. A disagreement would refuse a correctly-written account.
    */
    expect(expectedScoreTerms(RULES, 5).firstRoundByes).toBe(3);
    expect(expectedScoreTerms(RULES, 4).firstRoundByes).toBe(0);
    expect(expectedScoreTerms(RULES, 3).firstRoundByes).toBe(1);
    expect(expectedScoreTerms(RULES, 2).firstRoundByes).toBe(0);
  });

  it("plays third place whether or not it pays", () => {
    // A constant rather than a rule field today — `playsThirdPlace`. Pinned so
    // that if it ever becomes a rule, this comparison is forced to follow it
    // rather than quietly expecting `true` forever.
    expect(expectedScoreTerms(RULES, 12).thirdPlace).toBe(true);
  });
});

describe("scoresTermMismatches", () => {
  const expected = expectedScoreTerms(RULES, 12);

  it("is empty when the account agrees with the signed rules", () => {
    expect(scoresTermMismatches(onChain(), expected)).toEqual([]);
  });

  it("catches an oracle nobody signed", () => {
    /*
      The one that decides everything else. Whoever holds this key posts the
      scores the champion is derived from, so an account naming a different key
      is a league whose result will be decided by somebody members never agreed
      to — and every other check here would pass while that was true.

      It is the attack `docs/SETTLEMENT.md` §6 describes: the commissioner writes
      the settlement account, so without this they name their own key and post
      the scores that make themselves champion.
    */
    const stranger = PublicKey.default.toBase58();
    const [first] = scoresTermMismatches(onChain({ oracle: stranger }), expected);
    expect(first).toMatch(/settlementOracle/);
  });

  it("does not check an oracle for a free league, which has none", () => {
    const free = expectedScoreTerms({ ...RULES, pot: null }, 12);
    expect(free.oracle).toBeNull();
    expect(
      scoresTermMismatches(onChain({ oracle: PublicKey.default.toBase58() }), free),
    ).toEqual([]);
  });

  it("catches a reordered tiebreaker chain", () => {
    // The attack this whole comparison exists for: the last link decides seed 1,
    // and seed 1 takes the regular-season prize. Swapping two links produces a
    // different champion of the regular season and nothing else looks wrong.
    const [first] = scoresTermMismatches(onChain({ tiebreakers: [0, 2, 1, 3, 4] }), expected);
    expect(first).toMatch(/tiebreakers/);
  });

  it("catches a truncated tiebreaker chain", () => {
    expect(scoresTermMismatches(onChain({ tiebreakers: [0] }), expected)[0]).toMatch(
      /tiebreakers/,
    );
  });

  it("catches a moved playoff window, a wrong season length, and a wrong bye count", () => {
    expect(scoresTermMismatches(onChain({ playoffWeeks: [16, 17] }), expected)[0]).toMatch(
      /playoffWeeks/,
    );
    expect(scoresTermMismatches(onChain({ regularSeasonWeeks: 13 }), expected)[0]).toMatch(
      /regularSeasonWeeks/,
    );
    expect(scoresTermMismatches(onChain({ firstRoundByes: 0 }), expected)[0]).toMatch(
      /firstRoundByes/,
    );
  });

  it("catches a roster that is not the size of the league", () => {
    // Short cannot pay everyone; long names somebody who is not in the league.
    // Both are unrecoverable once the season starts.
    expect(scoresTermMismatches(onChain({ roster: [] }), expected)[0]).toMatch(/roster/);
  });

  it("reports every mismatch, not the first", () => {
    // The account is write-once, so whoever has to recreate the league needs the
    // whole list rather than one item per attempt.
    const problems = scoresTermMismatches(
      onChain({ tiebreakers: [0], playoffWeeks: [17], regularSeasonWeeks: 1, roster: [] }),
      expected,
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("uuidToHex", () => {
  it("strips dashes and lower-cases, matching the bytes the program stores", () => {
    // `LOWEST_TEAM_ID` compares these bytes, and the corpus asserts that string
    // order and byte order agree only for canonical lowercase hex.
    expect(uuidToHex("A1B2C3D4-0000-4000-8000-00000000000F")).toBe(
      "a1b2c3d400004000800000000000000f",
    );
  });
});
