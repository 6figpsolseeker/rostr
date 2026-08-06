import { describe, expect, it } from "vitest";
import { indexScoringRules } from "../scoring/engine.js";
import type { StatLine } from "../scoring/engine.js";
import { NFL_PPR_ROSTER, NFL_PPR_SCORING } from "../rules/nfl-ppr.js";
import { computeStandings } from "./standings.js";
import { generateSchedule } from "./schedule.js";
import type { LineupAssignment } from "./lineup.js";
import {
  BENCH_SLOT,
  ResultsError,
  resolveMatchups,
  resolveWeek,
  scoreTeamLineup,
  scoreWeek,
  winnerOf,
} from "./results.js";
import type { StatsByPlayer, TeamLineup } from "./results.js";

const RULES = indexScoringRules(NFL_PPR_SCORING);
const ROSTER = NFL_PPR_ROSTER;

const stat = (statKey: string, value: number): StatLine => ({ statKey, value });

/** 300 passing yards, 3 TD, 1 pick → 12.00 + 12.00 − 2.00 = 22.00 */
const QB_LINE = [stat("pass_yd", 300), stat("pass_td", 3), stat("pass_int", 1)];
/** 100 rushing yards, 1 TD, 4 catches for 30 → 10 + 6 + 4 + 3 = 23.00 */
const RB_LINE = [stat("rush_yd", 100), stat("rush_td", 1), stat("rec", 4), stat("rec_yd", 30)];
/** 8 catches for 120 and a score → 8 + 12 + 6 = 26.00 */
const WR_LINE = [stat("rec", 8), stat("rec_yd", 120), stat("rec_td", 1)];

const QB_POINTS = 22_000;
const RB_POINTS = 23_000;
const WR_POINTS = 26_000;

function lineup(teamId: string, players: (string | null)[], bench?: string[]): TeamLineup {
  const slots: [string, number][] = [
    ["QB", 0],
    ["RB", 0],
    ["RB", 1],
    ["WR", 0],
    ["WR", 1],
    ["TE", 0],
    ["FLEX", 0],
    ["K", 0],
    ["DEF", 0],
  ];

  const assignments: LineupAssignment[] = slots.map(([slotType, slotIndex], i) => ({
    slotType,
    slotIndex,
    playerId: players[i] ?? null,
  }));

  return bench ? { teamId, assignments, bench } : { teamId, assignments };
}

describe("scoreTeamLineup", () => {
  it("totals the starters", () => {
    const stats: StatsByPlayer = new Map([
      ["qb", QB_LINE],
      ["rb", RB_LINE],
      ["wr", WR_LINE],
    ]);

    const score = scoreTeamLineup(
      lineup("t1", ["qb", "rb", null, "wr", null, null, null, null, null]),
      stats,
      RULES,
      ROSTER,
    );

    expect(score.milliPoints).toBe(QB_POINTS + RB_POINTS + WR_POINTS);
  });

  it("scores an empty slot as nothing rather than failing", () => {
    // A manager who left a slot empty scores zero for it. That is the rule, not
    // a fault — and it must not take the whole week's scoring down with it.
    const score = scoreTeamLineup(
      lineup("t1", [null, null, null, null, null, null, null, null, null]),
      new Map(),
      RULES,
      ROSTER,
    );

    expect(score.milliPoints).toBe(0);
    expect(score.players).toEqual([]);
  });

  it("scores a player with no stat line as zero", () => {
    // Inactive, on a bye, or his game has not been ingested yet. None of those
    // are errors, and all three look identical here.
    const score = scoreTeamLineup(
      lineup("t1", ["ghost", null, null, null, null, null, null, null, null]),
      new Map(),
      RULES,
      ROSTER,
    );

    expect(score.milliPoints).toBe(0);
    expect(score.players).toEqual([
      { playerId: "ghost", slotType: "QB", milliPoints: 0, counted: true },
    ]);
  });

  it("scores the bench but keeps it out of the total", () => {
    const stats: StatsByPlayer = new Map([
      ["qb", QB_LINE],
      ["benched", WR_LINE],
    ]);

    const score = scoreTeamLineup(
      lineup("t1", ["qb", null, null, null, null, null, null, null, null], ["benched"]),
      stats,
      RULES,
      ROSTER,
    );

    expect(score.milliPoints).toBe(QB_POINTS);

    const bench = score.players.find((p) => p.playerId === "benched");
    expect(bench).toEqual({
      playerId: "benched",
      slotType: BENCH_SLOT,
      milliPoints: WR_POINTS,
      counted: false,
    });
  });

  it("refuses a player started in two slots", () => {
    // Doubling a player's points decides a matchup and therefore a payout.
    // validateLineup rejects this on submission; this is the last place it can
    // be caught before money moves.
    expect(() =>
      scoreTeamLineup(
        lineup("t1", [null, "rb", "rb", null, null, null, null, null, null]),
        new Map([["rb", RB_LINE]]),
        RULES,
        ROSTER,
      ),
    ).toThrow(ResultsError);
  });

  it("refuses a player who is both starting and on the bench", () => {
    expect(() =>
      scoreTeamLineup(
        lineup("t1", ["qb", null, null, null, null, null, null, null, null], ["qb"]),
        new Map([["qb", QB_LINE]]),
        RULES,
        ROSTER,
      ),
    ).toThrow(/both/);
  });
});

describe("scoreWeek", () => {
  it("keys each team's score separately", () => {
    const stats: StatsByPlayer = new Map([
      ["a", QB_LINE],
      ["b", WR_LINE],
    ]);

    const scores = scoreWeek(
      [
        lineup("t1", ["a", null, null, null, null, null, null, null, null]),
        lineup("t2", [null, null, null, "b", null, null, null, null, null]),
      ],
      stats,
      RULES,
      ROSTER,
    );

    expect(scores.get("t1")?.milliPoints).toBe(QB_POINTS);
    expect(scores.get("t2")?.milliPoints).toBe(WR_POINTS);
  });

  it("refuses two lineups for one team in a week", () => {
    expect(() =>
      scoreWeek(
        [
          lineup("t1", [null, null, null, null, null, null, null, null, null]),
          lineup("t1", [null, null, null, null, null, null, null, null, null]),
        ],
        new Map(),
        RULES,
        ROSTER,
      ),
    ).toThrow(ResultsError);
  });
});

describe("resolveMatchups", () => {
  const scores = new Map([
    ["t1", { milliPoints: 100_000, players: [] }],
    ["t2", { milliPoints: 90_000, players: [] }],
  ]);

  it("pairs each team's total against its opponent's", () => {
    const [result] = resolveMatchups([{ week: 3, homeTeamId: "t1", awayTeamId: "t2" }], scores);

    expect(result).toEqual({
      week: 3,
      homeTeamId: "t1",
      awayTeamId: "t2",
      homeMilliPoints: 100_000,
      awayMilliPoints: 90_000,
    });
  });

  it("keeps a bye as a bye", () => {
    // The row has to exist so the week is complete, but computeRecords skips it
    // entirely — the zero is never counted against anyone.
    const [result] = resolveMatchups([{ week: 3, homeTeamId: "t1", awayTeamId: null }], scores);

    expect(result?.awayTeamId).toBeNull();
    expect(result?.awayMilliPoints).toBe(0);
  });

  it("refuses to score a week where a scheduled team has no lineup", () => {
    // Silently scoring zero would hand the opponent a free win off a bug in the
    // caller rather than anything a manager did.
    expect(() =>
      resolveMatchups([{ week: 3, homeTeamId: "t1", awayTeamId: "missing" }], scores),
    ).toThrow(/missing/);
  });
});

describe("winnerOf", () => {
  const base = { week: 1, homeTeamId: "t1", awayTeamId: "t2" as string | null };

  it("names the higher total", () => {
    expect(winnerOf({ ...base, homeMilliPoints: 2, awayMilliPoints: 1 })).toBe("t1");
    expect(winnerOf({ ...base, homeMilliPoints: 1, awayMilliPoints: 2 })).toBe("t2");
  });

  it("returns null on an exact tie", () => {
    expect(winnerOf({ ...base, homeMilliPoints: 1, awayMilliPoints: 1 })).toBeNull();
  });

  it("returns null on a bye", () => {
    expect(
      winnerOf({ ...base, awayTeamId: null, homeMilliPoints: 1, awayMilliPoints: 0 }),
    ).toBeNull();
  });
});

describe("a week, end to end", () => {
  it("carries lineups through scoring into standings", () => {
    // The point of C6 and C8: the scoring engine and the standings table were
    // both finished and had no way to reach each other.
    const teamIds = ["t1", "t2", "t3", "t4"];
    const schedule = generateSchedule(teamIds, 1, "seed");

    const stats: StatsByPlayer = new Map([
      ["big", [stat("rec_yd", 200), stat("rec_td", 2)]], // 20 + 12 = 32.00
      ["small", [stat("rec_yd", 10)]], // 1.00
    ]);

    // Two teams start the big game, two start the small one, so each matchup has
    // a definite winner whichever way the seeded schedule paired them.
    const lineups = teamIds.map((teamId, i) =>
      lineup(teamId, [
        null,
        null,
        null,
        i % 2 === 0 ? "big" : "small",
        null,
        null,
        null,
        null,
        null,
      ]),
    );

    const { results, scores } = resolveWeek(schedule, lineups, stats, RULES, ROSTER);

    expect(results).toHaveLength(2);
    expect(scores.get("t1")?.milliPoints).toBe(32_000);
    expect(scores.get("t2")?.milliPoints).toBe(1_000);

    const standings = computeStandings(teamIds, results, [
      "WIN_PCT",
      "POINTS_FOR",
      "LOWEST_TEAM_ID",
    ]);

    // Everyone played once; the two big-game teams won.
    expect(standings.every((row) => row.games === 1)).toBe(true);
    expect(standings.filter((row) => row.wins === 1)).toHaveLength(2);
    expect(
      standings
        .slice(0, 2)
        .map((row) => row.teamId)
        .sort(),
    ).toEqual(["t1", "t3"]);
    expect(standings[0]?.milliPointsFor).toBe(32_000);
    expect(standings[0]?.milliPointsAgainst).toBe(1_000);
  });

  it("gives a bye team no win, no loss, and no points", () => {
    const teamIds = ["a", "b", "c"];
    const schedule = generateSchedule(teamIds, 1, "seed");

    const lineups = teamIds.map((teamId) =>
      lineup(teamId, ["qb", null, null, null, null, null, null, null, null]),
    );

    const { results } = resolveWeek(
      schedule,
      lineups,
      new Map([["qb", QB_LINE]]),
      RULES,
      ROSTER,
    );

    const bye = results.find((r) => r.awayTeamId === null);
    expect(bye).toBeDefined();

    const standings = computeStandings(teamIds, results, ["WIN_PCT", "LOWEST_TEAM_ID"]);
    const sat = standings.find((row) => row.teamId === bye?.homeTeamId);

    expect(sat).toMatchObject({
      games: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      milliPointsFor: 0,
      milliPointsAgainst: 0,
    });
  });
});
