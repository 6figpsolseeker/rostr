import { describe, expect, it } from "vitest";
import { NFL_DEFAULT_SCHEDULE } from "../rules/nfl-ppr.js";
import {
  byeCountsAreBalanced,
  everyTeamPlaysOncePerWeek,
  generateSchedule,
  matchupsForWeek,
  meetingCounts,
  opponentOf,
} from "./schedule.js";
import {
  computeRecords,
  computeStandings,
  consolationField,
  playoffField,
  winPercentageBasisPoints,
} from "./standings.js";
import type { MatchupResult } from "./standings.js";

const teams = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `team-${String(i + 1).padStart(2, "0")}`);

const SEED = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

describe("generateSchedule", () => {
  it("gives every team exactly one game a week", () => {
    const ids = teams(12);
    const schedule = generateSchedule(ids, 14, SEED);

    expect(everyTeamPlaysOncePerWeek(schedule, ids, 14)).toBe(true);
  });

  it("produces six matchups a week for twelve teams", () => {
    const schedule = generateSchedule(teams(12), 14, SEED);

    for (let week = 1; week <= 14; week++) {
      expect(matchupsForWeek(schedule, week)).toHaveLength(6);
    }
  });

  it("has everyone meet everyone over a full rotation", () => {
    // 12 teams, 11 weeks: exactly one full round robin, so all 66 pairs appear.
    const schedule = generateSchedule(teams(12), 11, SEED);
    const counts = meetingCounts(schedule);

    expect(counts.size).toBe(66);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("spreads repeat matchups rather than clustering them", () => {
    // 14 weeks over an 11-week rotation means three repeats per team. No pair
    // should meet three times while another meets once.
    const counts = [...meetingCounts(generateSchedule(teams(12), 14, SEED)).values()];

    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  });

  it("matches the league's configured season length", () => {
    const schedule = generateSchedule(teams(12), NFL_DEFAULT_SCHEDULE.regularSeasonWeeks, SEED);
    const weeks = new Set(schedule.map((m) => m.week));

    expect(weeks.size).toBe(NFL_DEFAULT_SCHEDULE.regularSeasonWeeks);
  });

  it("is reproducible from the seed", () => {
    const a = generateSchedule(teams(10), 13, SEED);
    const b = generateSchedule(teams(10), 13, SEED);

    expect(a).toEqual(b);
  });

  it("changes when the seed changes", () => {
    const a = generateSchedule(teams(10), 13, SEED);
    const b = generateSchedule(teams(10), 13, `${SEED}x`);

    expect(a).not.toEqual(b);
  });

  it("does not depend on the order teams were passed in", () => {
    // Otherwise whoever controls insertion order controls the schedule.
    const ids = teams(8);
    const forwards = generateSchedule(ids, 13, SEED);
    const backwards = generateSchedule([...ids].reverse(), 13, SEED);

    const key = (
      s: readonly { week: number; homeTeamId: string; awayTeamId: string | null }[],
    ) =>
      s
        .map((m) => `${m.week}:${[m.homeTeamId, m.awayTeamId ?? "bye"].sort().join("|")}`)
        .sort();

    expect(key(forwards)).toEqual(key(backwards));
  });

  it("never pairs a team with itself", () => {
    const schedule = generateSchedule(teams(12), 14, SEED);

    expect(schedule.some((m) => m.homeTeamId === m.awayTeamId)).toBe(false);
  });

  it("splits home and away close to evenly, at every size and seed", () => {
    // Deriving home and away from the rotation geometry gave one team eleven
    // home games out of fourteen, because only the held team keeps a fixed
    // pair index. Assigning each game to whoever is furthest behind holds the
    // spread to two across every size and seed tried — usually to zero.
    for (const size of [5, 7, 8, 10, 11, 12]) {
      for (const salt of ["", "a", "b", "c"]) {
        const ids = teams(size);
        const schedule = generateSchedule(ids, 14, SEED + salt);
        const home = new Map(ids.map((id) => [id, 0]));

        for (const matchup of schedule) {
          if (matchup.awayTeamId)
            home.set(matchup.homeTeamId, home.get(matchup.homeTeamId)! + 1);
        }

        const counts = [...home.values()];
        expect(
          Math.max(...counts) - Math.min(...counts),
          `size ${size}, seed +"${salt}"`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  describe("odd leagues", () => {
    it("gives one team a bye each week", () => {
      const schedule = generateSchedule(teams(11), 14, SEED);

      for (let week = 1; week <= 14; week++) {
        const byes = matchupsForWeek(schedule, week).filter((m) => m.awayTeamId === null);
        expect(byes).toHaveLength(1);
      }
    });

    it("still gives every team exactly one slot a week", () => {
      const ids = teams(7);
      const schedule = generateSchedule(ids, 14, SEED);

      expect(everyTeamPlaysOncePerWeek(schedule, ids, 14)).toBe(true);
    });

    it("spreads byes evenly", () => {
      // A bye is a lost chance at a win. One team sitting three times while
      // another never does would be a schedule advantage nobody agreed to.
      const ids = teams(11);
      const schedule = generateSchedule(ids, 14, SEED);

      expect(byeCountsAreBalanced(schedule, ids)).toBe(true);
    });

    it("handles the two-team minimum", () => {
      const schedule = generateSchedule(teams(2), 14, SEED);

      expect(schedule).toHaveLength(14);
      expect(schedule.every((m) => m.awayTeamId !== null)).toBe(true);
    });
  });

  describe("rejects impossible input", () => {
    it("needs at least two teams", () => {
      expect(() => generateSchedule(["solo"], 14, SEED)).toThrow(/at least 2 teams/);
    });

    it("needs at least one week", () => {
      expect(() => generateSchedule(teams(4), 0, SEED)).toThrow(/at least 1/);
    });

    it("rejects duplicate team IDs", () => {
      expect(() => generateSchedule(["a", "b", "a"], 4, SEED)).toThrow(/unique/);
    });
  });
});

describe("opponentOf", () => {
  it("finds the opponent from either side of the matchup", () => {
    const ids = teams(12);
    const schedule = generateSchedule(ids, 14, SEED);
    const opponent = opponentOf(schedule, ids[0]!, 3);

    expect(opponent).not.toBeNull();
    expect(opponentOf(schedule, opponent!, 3)).toBe(ids[0]);
  });

  it("returns null on a bye", () => {
    const schedule = generateSchedule(teams(5), 5, SEED);
    const bye = schedule.find((m) => m.awayTeamId === null)!;

    expect(opponentOf(schedule, bye.homeTeamId, bye.week)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

const game = (
  week: number,
  home: string,
  away: string | null,
  homePoints: number,
  awayPoints = 0,
): MatchupResult => ({
  week,
  homeTeamId: home,
  awayTeamId: away,
  homeMilliPoints: homePoints,
  awayMilliPoints: awayPoints,
});

const DEFAULT_TIEBREAKERS = NFL_DEFAULT_SCHEDULE.tiebreakers;

describe("computeRecords", () => {
  it("credits the winner and debits the loser", () => {
    const records = computeRecords(["a", "b"], [game(1, "a", "b", 120_000, 100_000)]);

    expect(records.get("a")).toMatchObject({ wins: 1, losses: 0, games: 1 });
    expect(records.get("b")).toMatchObject({ wins: 0, losses: 1, games: 1 });
  });

  it("records points for and against on both sides", () => {
    const records = computeRecords(["a", "b"], [game(1, "a", "b", 120_500, 99_250)]);

    expect(records.get("a")).toMatchObject({
      milliPointsFor: 120_500,
      milliPointsAgainst: 99_250,
    });
    expect(records.get("b")).toMatchObject({
      milliPointsFor: 99_250,
      milliPointsAgainst: 120_500,
    });
  });

  it("gives both teams a tie on an exact draw", () => {
    const records = computeRecords(["a", "b"], [game(1, "a", "b", 100_000, 100_000)]);

    expect(records.get("a")).toMatchObject({ ties: 1, wins: 0, losses: 0 });
    expect(records.get("b")).toMatchObject({ ties: 1, wins: 0, losses: 0 });
  });

  it("ignores a bye entirely", () => {
    // No win, no loss, no points, and crucially no game, so win percentage
    // stays comparable against teams that played.
    const records = computeRecords(["a"], [game(1, "a", null, 130_000)]);

    expect(records.get("a")).toMatchObject({
      wins: 0,
      losses: 0,
      ties: 0,
      games: 0,
      milliPointsFor: 0,
    });
  });

  it("rejects a matchup naming an unknown team", () => {
    expect(() => computeRecords(["a"], [game(1, "a", "ghost", 1, 2)])).toThrow(
      /not in the league/,
    );
  });

  it("starts every team at zero", () => {
    const records = computeRecords(["a", "b", "c"], []);

    expect(records.size).toBe(3);
    expect(records.get("c")).toMatchObject({ wins: 0, games: 0 });
  });
});

describe("winPercentageBasisPoints", () => {
  const record = (wins: number, losses: number, ties: number) => ({
    teamId: "x",
    wins,
    losses,
    ties,
    games: wins + losses + ties,
    milliPointsFor: 0,
    milliPointsAgainst: 0,
  });

  it("counts a tie as half a win", () => {
    expect(winPercentageBasisPoints(record(1, 1, 0))).toBe(5000);
    expect(winPercentageBasisPoints(record(0, 0, 2))).toBe(5000);
  });

  it("is 100% for an unbeaten team", () => {
    expect(winPercentageBasisPoints(record(5, 0, 0))).toBe(10_000);
  });

  it("is zero for a team that has not played", () => {
    expect(winPercentageBasisPoints(record(0, 0, 0))).toBe(0);
  });
});

describe("computeStandings", () => {
  it("seeds by record first", () => {
    const results = [
      game(1, "a", "b", 120_000, 100_000),
      game(2, "a", "c", 120_000, 100_000),
      game(3, "b", "c", 110_000, 100_000),
    ];
    const standings = computeStandings(["a", "b", "c"], results, DEFAULT_TIEBREAKERS);

    expect(standings.map((row) => row.teamId)).toEqual(["a", "b", "c"]);
    expect(standings.map((row) => row.seed)).toEqual([1, 2, 3]);
  });

  it("breaks an equal record on points for", () => {
    // Both 1-1. `a` scored more across the season.
    const results = [game(1, "a", "b", 150_000, 100_000), game(2, "b", "a", 130_000, 90_000)];
    const standings = computeStandings(["a", "b"], results, [
      "WIN_PCT",
      "POINTS_FOR",
      "LOWEST_TEAM_ID",
    ]);

    expect(standings[0]?.teamId).toBe("a");
    expect(standings[0]?.milliPointsFor).toBe(240_000);
    expect(standings[1]?.decidedBy).toBe("POINTS_FOR");
  });

  it("uses head-to-head when the tied teams met", () => {
    // Same record, same points for. `b` beat `a` when they played.
    const results = [game(1, "a", "b", 100_000, 110_000)];
    const standings = computeStandings(["a", "b"], results, ["HEAD_TO_HEAD", "LOWEST_TEAM_ID"]);

    expect(standings[0]?.teamId).toBe("b");
    expect(standings[1]?.decidedBy).toBe("HEAD_TO_HEAD");
  });

  it("skips head-to-head when the tied teams never met", () => {
    // Head-to-head across an uneven group compares different schedules, so it
    // is skipped rather than applied unfairly. Points for decides instead.
    const results = [game(1, "a", "c", 120_000, 100_000), game(1, "b", "d", 110_000, 100_000)];
    const standings = computeStandings(["a", "b", "c", "d"], results, [
      "WIN_PCT",
      "HEAD_TO_HEAD",
      "POINTS_FOR",
      "LOWEST_TEAM_ID",
    ]);

    expect(standings[0]?.teamId).toBe("a");
    expect(standings[1]?.teamId).toBe("b");
    expect(standings[1]?.decidedBy).toBe("POINTS_FOR");
  });

  it("resolves a three-way cycle without an arbitrary order", () => {
    // a beat b, b beat c, c beat a. Every pair met once, so the group's
    // internal records are all 1-1 and head-to-head decides nothing. A pairwise
    // comparator would have produced A > B > C > A and sorted on whatever the
    // sort algorithm happened to visit first.
    const results = [
      game(1, "a", "b", 120_000, 100_000),
      game(2, "b", "c", 120_000, 100_000),
      game(3, "c", "a", 120_000, 100_000),
    ];
    const standings = computeStandings(["a", "b", "c"], results, [
      "WIN_PCT",
      "HEAD_TO_HEAD",
      "POINTS_FOR",
      "LOWEST_TEAM_ID",
    ]);

    expect(standings).toHaveLength(3);
    expect(standings.map((r) => r.seed)).toEqual([1, 2, 3]);
    expect(standings.map((r) => r.milliPointsFor)).toEqual([220_000, 220_000, 220_000]);
    // Fell through to the deterministic backstop, so the order is stable.
    expect(standings.map((r) => r.teamId)).toEqual(["a", "b", "c"]);
  });

  it("prefers the team that allowed fewer points", () => {
    const results = [game(1, "a", "c", 100_000, 90_000), game(1, "b", "d", 100_000, 95_000)];
    const standings = computeStandings(["a", "b", "c", "d"], results, [
      "WIN_PCT",
      "POINTS_AGAINST",
      "LOWEST_TEAM_ID",
    ]);

    expect(standings[0]?.teamId).toBe("a");
    expect(standings[1]?.decidedBy).toBe("POINTS_AGAINST");
  });

  it("always terminates on the deterministic backstop", () => {
    // Four teams, no games at all. Every criterion is equal.
    const standings = computeStandings(["d", "b", "a", "c"], [], DEFAULT_TIEBREAKERS);

    expect(standings.map((row) => row.teamId)).toEqual(["a", "b", "c", "d"]);
    expect(standings.map((row) => row.seed)).toEqual([1, 2, 3, 4]);
  });

  it("does not depend on the order teams were passed in", () => {
    // A seed that moved with database row order would be indefensible.
    const results = [
      game(1, "a", "b", 120_000, 100_000),
      game(1, "c", "d", 120_000, 100_000),
      game(2, "a", "c", 100_000, 100_000),
      game(2, "b", "d", 130_000, 90_000),
    ];
    const forwards = computeStandings(["a", "b", "c", "d"], results, DEFAULT_TIEBREAKERS);
    const backwards = computeStandings(["d", "c", "b", "a"], results, DEFAULT_TIEBREAKERS);

    expect(forwards.map((r) => r.teamId)).toEqual(backwards.map((r) => r.teamId));
  });

  it("marks the top seed as decided by nothing", () => {
    const standings = computeStandings(
      ["a", "b"],
      [game(1, "a", "b", 120_000, 100_000)],
      DEFAULT_TIEBREAKERS,
    );

    expect(standings[0]?.decidedBy).toBeNull();
  });

  it("requires at least one tiebreaker", () => {
    expect(() => computeStandings(["a", "b"], [], [])).toThrow(/at least one tiebreaker/i);
  });

  it("throws rather than guess when the chain cannot separate teams", () => {
    // No deterministic backstop, and two teams equal on everything supplied.
    // Returning input order would make a seed depend on row order.
    expect(() => computeStandings(["a", "b"], [], ["WIN_PCT", "POINTS_FOR"])).toThrow(
      /exhausted/,
    );
  });

  it("seeds a full twelve-team season", () => {
    const ids = teams(12);
    const schedule = generateSchedule(ids, 14, SEED);

    // Deterministic pseudo-scores: no clock, no randomness, but varied enough
    // that records and points differ.
    const score = (teamId: string, week: number): number =>
      80_000 + ((teamId.charCodeAt(6) * 37 + week * 911) % 60_000);

    const results = schedule.map((m) =>
      game(
        m.week,
        m.homeTeamId,
        m.awayTeamId,
        score(m.homeTeamId, m.week),
        m.awayTeamId ? score(m.awayTeamId, m.week) : 0,
      ),
    );

    const standings = computeStandings(ids, results, DEFAULT_TIEBREAKERS);

    expect(standings).toHaveLength(12);
    expect(standings.map((r) => r.seed)).toEqual([...Array(12)].map((_, i) => i + 1));
    // Every team played all 14 weeks.
    expect(standings.every((r) => r.games === 14)).toBe(true);
    // Records are internally consistent.
    for (const row of standings) {
      expect(row.wins + row.losses + row.ties).toBe(row.games);
    }
    // Points for across the league must equal points against, and wins must
    // equal losses. Either failing means results were double-counted.
    expect(standings.reduce((sum, r) => sum + r.milliPointsFor, 0)).toBe(
      standings.reduce((sum, r) => sum + r.milliPointsAgainst, 0),
    );
    expect(standings.reduce((sum, r) => sum + r.wins, 0)).toBe(
      standings.reduce((sum, r) => sum + r.losses, 0),
    );
  });
});

describe("playoff and consolation fields", () => {
  const standings = computeStandings(teams(12), [], DEFAULT_TIEBREAKERS);

  it("takes the top seeds into the playoffs", () => {
    const field = playoffField(standings, NFL_DEFAULT_SCHEDULE.playoffTeams);

    expect(field).toHaveLength(NFL_DEFAULT_SCHEDULE.playoffTeams);
    expect(field[0]?.seed).toBe(1);
  });

  it("puts everyone else in the consolation bracket", () => {
    // The consolation bracket pays out, so who lands in it matters. It is the
    // anti-abandonment mechanism, not a nicety.
    const field = consolationField(standings, NFL_DEFAULT_SCHEDULE.playoffTeams);

    expect(field).toHaveLength(12 - NFL_DEFAULT_SCHEDULE.playoffTeams);
    expect(field[0]?.seed).toBe(NFL_DEFAULT_SCHEDULE.playoffTeams + 1);
  });

  it("accounts for every team between the two", () => {
    const playoffs = playoffField(standings, NFL_DEFAULT_SCHEDULE.playoffTeams);
    const consolation = consolationField(standings, NFL_DEFAULT_SCHEDULE.playoffTeams);

    expect(playoffs.length + consolation.length).toBe(12);
  });
});
