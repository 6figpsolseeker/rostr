import { describe, expect, it } from "vitest";
import type { MatchupResult } from "./standings.js";
import { buildBracket, BracketError, thirdPlaceWinner } from "./bracket.js";

/** The default shape: six teams, seeds 1–2 on a bye, weeks 15–17. */
const FIELD = ["s1", "s2", "s3", "s4", "s5", "s6"];
const WEEKS = [15, 16, 17];

function result(
  week: number,
  home: string,
  away: string,
  homePoints: number,
  awayPoints: number,
): MatchupResult {
  return {
    week,
    homeTeamId: home,
    awayTeamId: away,
    homeMilliPoints: homePoints,
    awayMilliPoints: awayPoints,
  };
}

function build(results: readonly MatchupResult[], thirdPlace = false) {
  return buildBracket({
    field: FIELD,
    weeks: WEEKS,
    firstRoundByes: 2,
    results,
    thirdPlace,
  });
}

describe("the first round", () => {
  it("pairs 3v6 and 4v5", () => {
    // The shape docs/RULES.md §5 names. Best surviving seed against the worst,
    // which is what makes seeding first worth having.
    const bracket = build([]);
    const round = bracket.rounds[0]!;

    expect(round.games.map((g) => [g.homeTeamId, g.awayTeamId])).toEqual([
      ["s3", "s6"],
      ["s4", "s5"],
    ]);
  });

  it("sits the top two seeds out", () => {
    const bracket = build([]);
    expect(bracket.rounds[0]?.byes.map((b) => b.teamId)).toEqual(["s1", "s2"]);
  });

  it("plays in the first playoff week", () => {
    expect(build([]).rounds[0]?.week).toBe(15);
  });

  it("is called the quarterfinal", () => {
    expect(build([]).rounds[0]?.label).toBe("Quarterfinal");
  });

  it("puts the higher seed at home", () => {
    const bracket = build([]);
    for (const game of bracket.rounds[0]!.games) {
      const home = FIELD.indexOf(game.homeTeamId);
      const away = FIELD.indexOf(game.awayTeamId);
      expect(home).toBeLessThan(away);
    }
  });
});

describe("advancing", () => {
  const QUARTERS = [
    result(15, "s3", "s6", 101_000, 99_000),
    result(15, "s4", "s5", 88_000, 120_000),
  ];

  it("stops at the first unscored round", () => {
    // A bracket that invented next week's fixtures would be claiming to know
    // something it does not.
    expect(build([]).rounds).toHaveLength(1);
  });

  it("builds the next round once every game is scored", () => {
    const bracket = build(QUARTERS);
    expect(bracket.rounds).toHaveLength(2);
    expect(bracket.rounds[1]?.week).toBe(16);
    expect(bracket.rounds[1]?.label).toBe("Semifinal");
  });

  it("reseeds rather than following a fixed ladder", () => {
    // Seeds 3 and 5 survive. The top seed takes the lower survivor — 5, not 3 —
    // which is the whole reason a bracket cannot be drawn in advance.
    const bracket = build(QUARTERS);

    expect(bracket.rounds[1]?.games.map((g) => [g.homeTeamId, g.awayTeamId])).toEqual([
      ["s1", "s5"],
      ["s2", "s3"],
    ]);
  });

  it("does not build a round while one game is still unscored", () => {
    const bracket = build([QUARTERS[0]!]);
    expect(bracket.rounds).toHaveLength(1);
    expect(bracket.rounds[0]?.survivors).toBeNull();
  });

  it("carries bye teams straight through", () => {
    const bracket = build(QUARTERS);
    const survivors = bracket.rounds[0]?.survivors?.map((s) => s.teamId);
    expect(survivors).toEqual(["s1", "s2", "s3", "s5"]);
  });

  it("keeps a team's original seed for the whole bracket", () => {
    // Seed 5 does not become seed 4 by winning. Reseeding reorders the pairings,
    // it does not renumber anyone.
    const bracket = build(QUARTERS);
    const five = bracket.rounds[1]?.entrants.find((e) => e.teamId === "s5");
    expect(five?.seed).toBe(5);
  });
});

describe("ties", () => {
  it("sends the higher seed through", () => {
    // docs/RULES.md §5. The regular season keeps a tie as a tie; a bracket
    // cannot, because somebody has to play next week.
    const bracket = build([
      result(15, "s3", "s6", 100_000, 100_000),
      result(15, "s4", "s5", 90_000, 80_000),
    ]);

    expect(bracket.rounds[0]?.games[0]?.winnerTeamId).toBe("s3");
  });

  it("says so, rather than looking like an ordinary win", () => {
    const bracket = build([
      result(15, "s3", "s6", 100_000, 100_000),
      result(15, "s4", "s5", 90_000, 80_000),
    ]);

    expect(bracket.rounds[0]?.games[0]?.decidedBySeed).toBe(true);
    expect(bracket.rounds[0]?.games[1]?.decidedBySeed).toBe(false);
  });

  it("decides the championship on seed too", () => {
    const bracket = build([
      result(15, "s3", "s6", 101_000, 99_000),
      result(15, "s4", "s5", 88_000, 120_000),
      result(16, "s1", "s5", 110_000, 100_000),
      result(16, "s2", "s3", 100_000, 110_000),
      result(17, "s1", "s3", 105_000, 105_000),
    ]);

    expect(bracket.champion).toBe("s1");
    expect(bracket.runnerUp).toBe("s3");
  });
});

describe("a finished bracket", () => {
  const FULL = [
    result(15, "s3", "s6", 101_000, 99_000),
    result(15, "s4", "s5", 88_000, 120_000),
    result(16, "s1", "s5", 110_000, 100_000),
    result(16, "s2", "s3", 100_000, 110_000),
    result(17, "s1", "s3", 130_000, 120_000),
  ];

  it("names a champion and a runner-up", () => {
    const bracket = build(FULL);
    expect(bracket.champion).toBe("s1");
    expect(bracket.runnerUp).toBe("s3");
  });

  it("names nobody until the final is scored", () => {
    const bracket = build(FULL.slice(0, 4));
    expect(bracket.champion).toBeNull();
    expect(bracket.runnerUp).toBeNull();
  });

  it("reads a result written the other way round", () => {
    // Which team a stored row calls "home" is the database's business. A bracket
    // that only matched one orientation would silently lose a game.
    const flipped = [
      result(15, "s6", "s3", 99_000, 101_000),
      result(15, "s5", "s4", 120_000, 88_000),
    ];

    expect(build(flipped).rounds[0]?.survivors?.map((s) => s.teamId)).toEqual([
      "s1",
      "s2",
      "s3",
      "s5",
    ]);
  });

  it("reshapes itself when an earlier result changes", () => {
    // The point of rebuilding from scores rather than storing who advanced: a
    // stat correction that flips Week 15 must reach Week 16, with nothing left
    // over disagreeing with it.
    const before = build(FULL).rounds[1]!.games.map((g) => g.awayTeamId);

    const corrected = [result(15, "s3", "s6", 99_000, 101_000), ...FULL.slice(1)];
    const after = build(corrected).rounds[1]!.games.map((g) => g.awayTeamId);

    expect(before).toEqual(["s5", "s3"]);
    expect(after).toEqual(["s6", "s5"]);
  });
});

describe("third place", () => {
  const THROUGH_SEMIS = [
    result(15, "s3", "s6", 101_000, 99_000),
    result(15, "s4", "s5", 88_000, 120_000),
    result(16, "s1", "s5", 110_000, 100_000),
    result(16, "s2", "s3", 100_000, 110_000),
  ];

  it("is not scheduled when the league does not pay it", () => {
    expect(build(THROUGH_SEMIS, false).thirdPlaceGame).toBeNull();
  });

  it("pairs the losing semifinalists in the championship week", () => {
    const game = build(THROUGH_SEMIS, true).thirdPlaceGame;

    expect(game?.week).toBe(17);
    expect(game?.homeTeamId).toBe("s2");
    expect(game?.awayTeamId).toBe("s5");
    expect(game?.label).toBe("Third place");
  });

  it("puts the better-seeded loser at home whichever semifinal they lost", () => {
    // Seed 1 loses their semifinal and seed 3 wins theirs, so the losers are
    // seeds 1 and 2 — from different games, in the opposite order to the games
    // themselves. Reading the game order rather than the seeds would put the
    // wrong team at home.
    const upset = [
      result(15, "s3", "s6", 101_000, 99_000),
      result(15, "s4", "s5", 88_000, 120_000),
      result(16, "s1", "s5", 90_000, 130_000),
      result(16, "s2", "s3", 90_000, 130_000),
    ];

    const game = build(upset, true).thirdPlaceGame;
    expect(game?.homeTeamId).toBe("s1");
    expect(game?.awayTeamId).toBe("s2");
  });

  it("is unscheduled until both semifinals are done", () => {
    expect(build(THROUGH_SEMIS.slice(0, 3), true).thirdPlaceGame).toBeNull();
  });

  it("names a winner once it is scored", () => {
    const bracket = build([...THROUGH_SEMIS, result(17, "s2", "s5", 100_000, 120_000)], true);

    expect(thirdPlaceWinner(bracket)).toBe("s5");
  });

  it("gives a tied third-place game to the higher seed", () => {
    const bracket = build([...THROUGH_SEMIS, result(17, "s2", "s5", 100_000, 100_000)], true);

    expect(thirdPlaceWinner(bracket)).toBe("s2");
    expect(bracket.thirdPlaceGame?.decidedBySeed).toBe(true);
  });

  it("does not let the third-place game decide the championship", () => {
    // Both are in Week 17. A lookup that matched on week alone would confuse
    // them, and the losers' game would crown a champion.
    const bracket = build(
      [
        ...THROUGH_SEMIS,
        result(17, "s2", "s5", 200_000, 100_000),
        result(17, "s1", "s3", 100_000, 110_000),
      ],
      true,
    );

    expect(bracket.champion).toBe("s3");
    expect(thirdPlaceWinner(bracket)).toBe("s2");
  });
});

describe("other bracket shapes", () => {
  it("plays a four-team bracket with no byes", () => {
    const bracket = buildBracket({
      field: ["a", "b", "c", "d"],
      weeks: [16, 17],
      firstRoundByes: 0,
      results: [],
      thirdPlace: false,
    });

    expect(bracket.rounds[0]?.games.map((g) => [g.homeTeamId, g.awayTeamId])).toEqual([
      ["a", "d"],
      ["b", "c"],
    ]);
    expect(bracket.rounds[0]?.label).toBe("Semifinal");
  });

  it("finishes in the last available week, not the first", () => {
    // A four-team consolation bracket inside a three-week window plays weeks 16
    // and 17. Starting in week 15 would finish in 16 — a week before the payout
    // settles, with a week of nothing after it.
    const bracket = buildBracket({
      field: ["a", "b", "c", "d"],
      weeks: [15, 16, 17],
      firstRoundByes: 0,
      results: [],
      thirdPlace: false,
    });

    expect(bracket.rounds[0]?.week).toBe(16);
  });

  it("plays a two-team bracket as a single final", () => {
    const bracket = buildBracket({
      field: ["a", "b"],
      weeks: [17],
      firstRoundByes: 0,
      results: [result(17, "a", "b", 90_000, 100_000)],
      thirdPlace: false,
    });

    expect(bracket.rounds).toHaveLength(1);
    expect(bracket.champion).toBe("b");
    expect(bracket.runnerUp).toBe("a");
  });

  it("plays an eight-team bracket over three rounds", () => {
    const field = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const bracket = buildBracket({
      field,
      weeks: [15, 16, 17],
      firstRoundByes: 0,
      results: [],
      thirdPlace: false,
    });

    expect(bracket.rounds[0]?.games).toHaveLength(4);
    expect(bracket.rounds[0]?.label).toBe("Quarterfinal");
    expect(bracket.rounds[0]?.games.map((g) => [g.homeTeamId, g.awayTeamId])).toEqual([
      ["a", "h"],
      ["b", "g"],
      ["c", "f"],
      ["d", "e"],
    ]);
  });

  it("handles a five-team bracket, where three seeds get byes", () => {
    const bracket = buildBracket({
      field: ["a", "b", "c", "d", "e"],
      weeks: [15, 16, 17],
      firstRoundByes: 3,
      results: [result(15, "d", "e", 100_000, 90_000)],
      thirdPlace: false,
    });

    expect(bracket.rounds[0]?.byes.map((b) => b.teamId)).toEqual(["a", "b", "c"]);
    expect(bracket.rounds[1]?.games.map((g) => [g.homeTeamId, g.awayTeamId])).toEqual([
      ["a", "d"],
      ["b", "c"],
    ]);
  });
});

describe("refusals", () => {
  it("refuses a field of one", () => {
    expect(() =>
      buildBracket({
        field: ["a"],
        weeks: WEEKS,
        firstRoundByes: 0,
        results: [],
        thirdPlace: false,
      }),
    ).toThrow(BracketError);
  });

  it("refuses more byes than teams", () => {
    expect(() =>
      buildBracket({
        field: FIELD,
        weeks: WEEKS,
        firstRoundByes: 6,
        results: [],
        thirdPlace: false,
      }),
    ).toThrow(BracketError);
  });

  it("refuses a bracket that cannot fit its weeks", () => {
    // Eight teams need three rounds. Two weeks cannot hold them, and quietly
    // dropping a round would drop a team's season.
    expect(() =>
      buildBracket({
        field: ["a", "b", "c", "d", "e", "f", "g", "h"],
        weeks: [16, 17],
        firstRoundByes: 0,
        results: [],
        thirdPlace: false,
      }),
    ).toThrow(/needs 3 rounds/);
  });

  it("refuses a first round that cannot pair up", () => {
    expect(() =>
      buildBracket({
        field: ["a", "b", "c", "d", "e"],
        weeks: WEEKS,
        firstRoundByes: 0,
        results: [],
        thirdPlace: false,
      }),
    ).toThrow(BracketError);
  });

  /**
   * The code says whose problem it is, and the scoring cron reports it.
   *
   * A league whose own frozen rules cannot seat a bracket gets none, and every
   * other league carries on scoring. `INVARIANT` means the fault is ours, in the
   * ladder that decides who is paid — it must never read as "that league's
   * problem" in an operator's logs. The default is `INVARIANT` on purpose: a new
   * throw site is our bug until someone says otherwise.
   */
  const codeOf = (build: () => unknown): string => {
    try {
      build();
    } catch (error) {
      if (error instanceof BracketError) return error.code;
      throw error;
    }
    throw new Error("expected a BracketError");
  };

  it("blames the field when the field is too small", () => {
    expect(
      codeOf(() =>
        buildBracket({
          field: ["a"],
          weeks: WEEKS,
          firstRoundByes: 0,
          results: [],
          thirdPlace: false,
        }),
      ),
    ).toBe("FIELD_TOO_SMALL");
  });

  it("blames the field when the byes do not fit it", () => {
    expect(
      codeOf(() =>
        buildBracket({
          field: FIELD,
          weeks: WEEKS,
          firstRoundByes: 6,
          results: [],
          thirdPlace: false,
        }),
      ),
    ).toBe("FIELD_TOO_SMALL");
  });

  it("blames the weeks when there are too few of them", () => {
    expect(
      codeOf(() =>
        buildBracket({
          field: ["a", "b", "c", "d", "e", "f", "g", "h"],
          weeks: [16, 17],
          firstRoundByes: 0,
          results: [],
          thirdPlace: false,
        }),
      ),
    ).toBe("NOT_ENOUGH_WEEKS");
  });

  it("blames itself for an unpairable round, which callers must not file under bad input", () => {
    // Reachable only if the bye count and the field disagree in a way the caller
    // was supposed to prevent, so it is our bug rather than the league's.
    expect(
      codeOf(() =>
        buildBracket({
          field: ["a", "b", "c", "d", "e"],
          weeks: WEEKS,
          firstRoundByes: 0,
          results: [],
          thirdPlace: false,
        }),
      ),
    ).toBe("INVARIANT");
  });
});
