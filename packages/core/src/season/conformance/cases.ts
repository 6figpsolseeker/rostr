/**
 * The conformance corpus — the shared spec for two implementations of seeding.
 *
 * `computeStandings` decides who is seed 1, and seed 1 takes the regular-season
 * prize. Issue #28 needs the same answer derivable on-chain, which means a
 * second implementation in Rust. **Two implementations of the same rule is the
 * one failure mode in this whole area that pays the wrong person while every
 * test is green**: a wrong score is detectable by anyone holding a box score, but
 * a Rust tiebreaker that splits a two-way tie the other way is silent.
 *
 * So neither implementation is the authority — this corpus is, and both consume
 * it. TypeScript is the *spec*: the expectations below are **computed by running
 * `computeStandings`**, never written down by hand. A transcribed expectation is
 * a third implementation with no tests of its own, and it drifts.
 *
 * The cases are chosen for the places a plausible reimplementation goes wrong
 * rather than for coverage of the happy path, which one fixture would give.
 */

import type { Tiebreaker } from "../../rules/types.js";
import type { MatchupResult } from "../standings.js";

/**
 * Team ids are **canonical lowercase-hex UUIDs**, and that is load-bearing.
 *
 * `LOWEST_TEAM_ID` sorts with `localeCompare` on the string. A Rust kernel
 * holding a team as 16 raw bytes compares bytes. Those two orders agree for
 * lowercase hex and disagree the moment a capital letter appears — `"a"` sorts
 * *after* `"Z"` under `localeCompare` and before it by byte. Production ids come
 * from Postgres `gen_random_uuid()`, so the property holds there; the corpus
 * uses the same shape so it holds here, and `corpus.test.ts` asserts it rather
 * than trusting it.
 */
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const TEAM = Array.from({ length: 8 }, (_, i) => id(i + 1));

const DEFAULT_CHAIN: readonly Tiebreaker[] = [
  "WIN_PCT",
  "POINTS_FOR",
  "HEAD_TO_HEAD",
  "POINTS_AGAINST",
  "LOWEST_TEAM_ID",
];

export interface CorpusCase {
  readonly name: string;
  /** Why this case exists — carried into the JSON so the Rust side reads it too. */
  readonly why: string;
  readonly teamIds: readonly string[];
  readonly results: readonly MatchupResult[];
  readonly tiebreakers: readonly Tiebreaker[];
}

/** A completed game. Points are milli-points, as everywhere else. */
const game = (
  week: number,
  home: string,
  away: string,
  homeMilliPoints: number,
  awayMilliPoints: number,
): MatchupResult => ({
  week,
  homeTeamId: home,
  awayTeamId: away,
  homeMilliPoints,
  awayMilliPoints,
});

/** A bye. Scores nothing, counts nothing, and must not touch `games`. */
const bye = (week: number, home: string): MatchupResult => ({
  week,
  homeTeamId: home,
  awayTeamId: null,
  homeMilliPoints: 0,
  awayMilliPoints: 0,
});

export const CASES: readonly CorpusCase[] = [
  {
    name: "win percentage separates before anything else",
    why: "The base case. If this fails nothing below is meaningful.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!, TEAM[3]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      game(1, TEAM[0]!, TEAM[1]!, 120_000, 100_000),
      game(1, TEAM[2]!, TEAM[3]!, 110_000, 90_000),
      game(2, TEAM[0]!, TEAM[2]!, 130_000, 95_000),
      game(2, TEAM[1]!, TEAM[3]!, 105_000, 99_000),
    ],
  },
  {
    name: "a tie counts as half a win",
    why: "`winPercentageBasisPoints` weights a tie 0.5. A port that ignores ties ranks these two apart when they are level.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!, TEAM[3]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      game(1, TEAM[0]!, TEAM[1]!, 100_000, 100_000),
      game(1, TEAM[2]!, TEAM[3]!, 120_000, 80_000),
      game(2, TEAM[0]!, TEAM[2]!, 90_000, 110_000),
      game(2, TEAM[1]!, TEAM[3]!, 95_000, 85_000),
    ],
  },
  {
    name: "win percentage rounds half up",
    why:
      "A 0-2-1 record over three games is 1 * 10000 / 6 = 1666.67 basis points. `Math.round` gives " +
      "1667; integer division truncating gives 1666. The difference does not move a seed at any " +
      "league size anyone plays — every win percentage is a multiple of 5000/games, so two teams " +
      "cannot straddle a half — which is exactly why the corpus records the number itself rather " +
      "than trusting the order to expose it.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!, TEAM[3]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      // Team 0 finishes 0-2-1: the boundary record.
      game(1, TEAM[0]!, TEAM[1]!, 100_000, 100_000),
      game(1, TEAM[2]!, TEAM[3]!, 120_000, 80_000),
      game(2, TEAM[0]!, TEAM[2]!, 90_000, 110_000),
      game(2, TEAM[1]!, TEAM[3]!, 105_000, 95_000),
      game(3, TEAM[0]!, TEAM[3]!, 90_000, 110_000),
      game(3, TEAM[1]!, TEAM[2]!, 100_000, 100_000),
    ],
  },
  {
    name: "a bye is not a game",
    why: "A bye must contribute no record, no points and no games played — otherwise win percentage is computed over a different denominator for the team that had one.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      game(1, TEAM[0]!, TEAM[1]!, 120_000, 100_000),
      bye(1, TEAM[2]!),
      game(2, TEAM[1]!, TEAM[2]!, 100_000, 130_000),
      bye(2, TEAM[0]!),
    ],
  },
  {
    name: "points for breaks a win-percentage tie",
    why: "Second link in the chain, and the first that reads an accumulator rather than a record.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!, TEAM[3]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      game(1, TEAM[0]!, TEAM[1]!, 150_000, 100_000),
      game(1, TEAM[2]!, TEAM[3]!, 120_000, 110_000),
      game(2, TEAM[1]!, TEAM[3]!, 100_000, 90_000),
      game(2, TEAM[0]!, TEAM[2]!, 80_000, 140_000),
    ],
  },
  {
    name: "fewer points against is better",
    why: "`POINTS_AGAINST` is negated so that higher is better for every tiebreaker. Getting the sign backwards inverts a seed and nothing else complains.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!, TEAM[3]!],
    tiebreakers: ["WIN_PCT", "POINTS_AGAINST", "LOWEST_TEAM_ID"],
    results: [
      // Both win one and lose one, with identical points for, so the only thing
      // left is what they conceded.
      game(1, TEAM[0]!, TEAM[2]!, 100_000, 60_000),
      game(1, TEAM[1]!, TEAM[3]!, 100_000, 90_000),
      game(2, TEAM[2]!, TEAM[0]!, 100_000, 100_000 - 1),
      game(2, TEAM[3]!, TEAM[1]!, 100_000, 100_000 - 1),
    ],
  },
  {
    name: "head to head decides a group that all met once",
    why: "Third link, and the only one that reads the schedule rather than a tally.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!],
    tiebreakers: ["WIN_PCT", "HEAD_TO_HEAD", "LOWEST_TEAM_ID"],
    results: [
      // Each beats one and loses to one, so win percentage ties all three; the
      // internal games are then the whole story.
      game(1, TEAM[0]!, TEAM[1]!, 120_000, 100_000),
      game(2, TEAM[1]!, TEAM[2]!, 120_000, 100_000),
      game(3, TEAM[2]!, TEAM[0]!, 120_000, 100_000),
    ],
  },
  {
    name: "a head-to-head cycle resolves without a pairwise comparator",
    why: "a beats b, b beats c, c beats a. A pairwise comparator is not a total order here and sorts differently depending on input order; scoring the group and partitioning does not.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!],
    tiebreakers: ["WIN_PCT", "HEAD_TO_HEAD", "POINTS_FOR", "LOWEST_TEAM_ID"],
    results: [
      game(1, TEAM[0]!, TEAM[1]!, 110_000, 100_000),
      game(2, TEAM[1]!, TEAM[2]!, 110_000, 100_000),
      game(3, TEAM[2]!, TEAM[0]!, 110_000, 100_000),
    ],
  },
  {
    name: "head to head is skipped when the group did not meet evenly",
    why: "Comparing records against each other compares different schedules when the pairs met a different number of times. The tiebreaker must be skipped whole, not applied unevenly — and the chain must then fall through to the next link.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!],
    tiebreakers: ["WIN_PCT", "HEAD_TO_HEAD", "POINTS_FOR", "LOWEST_TEAM_ID"],
    results: [
      // 0 and 1 meet twice; 2 meets each of them once. Every pair has met, but
      // not equally often.
      game(1, TEAM[0]!, TEAM[1]!, 110_000, 100_000),
      game(2, TEAM[1]!, TEAM[0]!, 110_000, 100_000),
      game(3, TEAM[0]!, TEAM[2]!, 100_000, 110_000),
      game(4, TEAM[1]!, TEAM[2]!, 110_000, 100_000),
    ],
  },
  {
    name: "head to head is skipped when a pair never met",
    why: "The other half of the evenness rule: every pair must have met at all, not merely met the same number of times.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!],
    tiebreakers: ["WIN_PCT", "HEAD_TO_HEAD", "POINTS_FOR", "LOWEST_TEAM_ID"],
    results: [
      game(1, TEAM[0]!, TEAM[1]!, 110_000, 100_000),
      game(2, TEAM[1]!, TEAM[0]!, 110_000, 100_000),
      game(3, TEAM[2]!, TEAM[0]!, 105_000, 105_000),
      game(4, TEAM[2]!, TEAM[1]!, 105_000, 105_000),
    ],
  },
  {
    name: "the chain is re-applied within each tied group, not once globally",
    why: "The subtlest property. After a link splits the field, the *remaining* links apply inside each group separately — a global sort by the whole chain gives a different order.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!, TEAM[3]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      // 0 and 1 finish 1-1 with high points; 2 and 3 finish 1-1 with low points.
      game(1, TEAM[0]!, TEAM[2]!, 150_000, 60_000),
      game(1, TEAM[1]!, TEAM[3]!, 140_000, 70_000),
      game(2, TEAM[2]!, TEAM[0]!, 100_000, 90_000),
      game(2, TEAM[3]!, TEAM[1]!, 100_000, 90_000),
    ],
  },
  {
    name: "the chain shortens as it descends",
    why:
      "`orderGroup` recurses on `tiebreakers.slice(i + 1)`, so a link cannot run again below itself. " +
      "That is only observable through head-to-head, because it is the one link whose *applicability* " +
      "depends on the group: skipped here for the four (they did not all meet), it would apply inside " +
      "a pair. Every team is 1-1; points-for splits them 2-2; and within the top pair head-to-head " +
      "would order them one way while the remaining chain orders them the other. A port that restarts " +
      "the chain per subgroup seeds the wrong team first.",
    teamIds: [TEAM[0]!, TEAM[1]!, TEAM[2]!, TEAM[3]!],
    tiebreakers: ["WIN_PCT", "HEAD_TO_HEAD", "POINTS_FOR", "LOWEST_TEAM_ID"],
    results: [
      // A ring: each team beats the next. Four of the six pairs ever meet, so
      // head-to-head cannot be applied to the group as a whole.
      game(1, TEAM[0]!, TEAM[1]!, 100_000, 120_000),
      game(2, TEAM[1]!, TEAM[2]!, 90_000, 100_000),
      game(3, TEAM[2]!, TEAM[3]!, 80_000, 90_000),
      game(4, TEAM[3]!, TEAM[0]!, 90_000, 110_000),
    ],
  },
  {
    name: "lowest team id is the terminal backstop",
    why: "Every real criterion has come up equal. The result must still be total and reproducible by anyone holding the published standings.",
    teamIds: [TEAM[2]!, TEAM[0]!, TEAM[1]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      // Perfectly symmetric: all three drawn, identical points both ways.
      game(1, TEAM[0]!, TEAM[1]!, 100_000, 100_000),
      game(2, TEAM[1]!, TEAM[2]!, 100_000, 100_000),
      game(3, TEAM[2]!, TEAM[0]!, 100_000, 100_000),
    ],
  },
  {
    name: "input order does not decide a seed",
    why: "The same league with the team list shuffled must seed identically. This is what makes the standings reproducible from published data rather than from whatever order Postgres returned.",
    teamIds: [TEAM[1]!, TEAM[2]!, TEAM[0]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [
      game(1, TEAM[0]!, TEAM[1]!, 100_000, 100_000),
      game(2, TEAM[1]!, TEAM[2]!, 100_000, 100_000),
      game(3, TEAM[2]!, TEAM[0]!, 100_000, 100_000),
    ],
  },
  {
    name: "an exhausted chain is an error, not an order",
    why: "The highest-value assertion here. Falling through to input order would make a seed depend on row order, silently. Rust has no exceptions, so this must come back as a refusal rather than a plausible answer.",
    teamIds: [TEAM[0]!, TEAM[1]!],
    tiebreakers: ["WIN_PCT"],
    results: [game(1, TEAM[0]!, TEAM[1]!, 100_000, 100_000)],
  },
  {
    name: "no tiebreakers at all is an error",
    why: "An empty chain cannot seed anything, and returning input order would be the same silent failure as above.",
    teamIds: [TEAM[0]!, TEAM[1]!],
    tiebreakers: [],
    results: [game(1, TEAM[0]!, TEAM[1]!, 100_000, 100_000)],
  },
  {
    name: "a matchup naming an unknown team is an error",
    why: "The result set and the team list must agree. Silently ignoring the row would drop real games from the record.",
    teamIds: [TEAM[0]!, TEAM[1]!],
    tiebreakers: DEFAULT_CHAIN,
    results: [game(1, TEAM[0]!, TEAM[7]!, 100_000, 90_000)],
  },
];
