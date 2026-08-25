import { describe, expect, it } from "vitest";
import { NFL } from "../sports/nfl.js";
import { NFL_PPR_ROSTER } from "../rules/nfl-ppr.js";
import type { DraftRules } from "../rules/types.js";
import { fullDraftSequence, generateDraftOrder, pickPosition, totalPicks } from "./order.js";
import {
  buildRosterShape,
  canDraft,
  defaultPositionCaps,
  startersFilled,
  unfilledStarterSlots,
  wouldStrandStarters,
} from "./roster.js";
import type { DraftablePlayer } from "./roster.js";
import { autoPick, pruneQueue } from "./autopick.js";
import {
  createDraft,
  currentTeam,
  DraftError,
  isComplete,
  isPickExpired,
  makeAutoPick,
  makePick,
  pickDeadline,
  picksRemainingAfter,
  pickWouldStrandStarters,
  rosterFor,
  secondsRemaining,
} from "./state.js";

const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);
const TEAMS = Array.from({ length: 12 }, (_, i) => `team-${i + 1}`);

/** One round per roster slot — 9 starters plus 5 bench. */
const ROUNDS = SHAPE.totalSlots;

/**
 * A pool shaped like a real ADP board.
 *
 * Ranking order matters to every best-available test, so positions are
 * interleaved rather than blocked. Skill positions dominate the early rounds and
 * kickers and defenses sit at the very back — on the live 2026 board, the first
 * kicker goes around pick 187.
 *
 * A pool that ranked all 60 running backs first would make "best available" look
 * indistinguishable from "take every RB", which is exactly the confusion this
 * pool exists to avoid.
 */
function buildPool(): Map<string, DraftablePlayer> {
  const byPosition = new Map<string, string[]>();
  const make = (position: string, count: number): void => {
    byPosition.set(
      position,
      Array.from({ length: count }, (_, i) => `${position.toLowerCase()}-${i + 1}`),
    );
  };

  make("RB", 60);
  make("WR", 70);
  make("QB", 24);
  make("TE", 24);
  make("K", 16);
  make("DEF", 16);

  // Roughly the shape of a real board: receivers and backs throughout, a
  // quarterback or tight end sprinkled in, kickers and defenses last.
  const cadence = ["WR", "RB", "WR", "RB", "TE", "WR", "RB", "QB"];
  const pool = new Map<string, DraftablePlayer>();
  let rank = 1;
  let exhausted = false;

  while (!exhausted) {
    exhausted = true;
    for (const position of cadence) {
      const id = byPosition.get(position)?.shift();
      if (!id) continue;
      exhausted = false;
      pool.set(id, { playerId: id, positions: [position], rank: rank++ });
    }
  }

  for (const position of ["K", "DEF"]) {
    for (const id of byPosition.get(position) ?? []) {
      pool.set(id, { playerId: id, positions: [position], rank: rank++ });
    }
  }

  return pool;
}

const player = (id: string, positions: string[], rank = 1): DraftablePlayer => ({
  playerId: id,
  positions,
  rank,
});

/**
 * Assert a synchronous call throws a DraftError with a given code.
 *
 * `expect(fn).toSatisfy(...)` inspects the function itself, not what it throws —
 * so it passes for any predicate that happens to be falsy on a function value.
 */
function expectDraftError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  expect(thrown, "expected the call to throw").toBeInstanceOf(DraftError);
  expect((thrown as DraftError).code).toBe(code);
}

describe("generateDraftOrder", () => {
  it("is deterministic for a given seed", () => {
    const a = generateDraftOrder(TEAMS, "seed-abc");
    const b = generateDraftOrder(TEAMS, "seed-abc");
    expect(a).toEqual(b);
  });

  it("produces different orders for different seeds", () => {
    const a = generateDraftOrder(TEAMS, "seed-abc");
    const b = generateDraftOrder(TEAMS, "seed-xyz");
    expect(a).not.toEqual(b);
  });

  it("is a permutation — every team appears exactly once", () => {
    const order = generateDraftOrder(TEAMS, "seed");
    expect([...order].sort()).toEqual([...TEAMS].sort());
  });

  it("actually shuffles", () => {
    // A seed that returned the input unchanged would pass every test above.
    const orders = ["a", "b", "c", "d", "e"].map((s) => generateDraftOrder(TEAMS, s));
    expect(orders.some((order) => order.join() !== TEAMS.join())).toBe(true);
  });

  it("handles a two-team league", () => {
    expect([...generateDraftOrder(["a", "b"], "seed")].sort()).toEqual(["a", "b"]);
  });
});

describe("pickPosition — the snake", () => {
  it("runs round 1 forward", () => {
    expect(pickPosition(1, 12).orderIndex).toBe(0);
    expect(pickPosition(12, 12).orderIndex).toBe(11);
  });

  it("runs round 2 backward", () => {
    expect(pickPosition(13, 12).orderIndex).toBe(11);
    expect(pickPosition(24, 12).orderIndex).toBe(0);
  });

  it("runs round 3 forward again", () => {
    expect(pickPosition(25, 12).orderIndex).toBe(0);
  });

  it("gives the first and last picker consecutive picks at the turn", () => {
    // The defining property of a snake: pick 12 and 13 are the same team.
    expect(pickPosition(12, 12).orderIndex).toBe(pickPosition(13, 12).orderIndex);
  });

  it("reports rounds and positions", () => {
    expect(pickPosition(1, 12)).toEqual({ round: 1, pickInRound: 1, orderIndex: 0 });
    expect(pickPosition(14, 12)).toEqual({ round: 2, pickInRound: 2, orderIndex: 10 });
  });

  it("rejects nonsense input", () => {
    expect(() => pickPosition(0, 12)).toThrow(RangeError);
    expect(() => pickPosition(1, 0)).toThrow(RangeError);
  });

  it("gives every team the same number of picks", () => {
    const sequence = fullDraftSequence(TEAMS, ROUNDS);
    expect(sequence).toHaveLength(totalPicks(12, ROUNDS));

    const counts = new Map<string, number>();
    for (const team of sequence) counts.set(team, (counts.get(team) ?? 0) + 1);
    expect([...counts.values()]).toEqual(Array<number>(12).fill(ROUNDS));
  });
});

describe("roster legality", () => {
  it("counts a FLEX-eligible surplus as filling FLEX", () => {
    // Naive per-position counting says the third WR is surplus. It is not.
    const roster = [
      player("rb1", ["RB"]),
      player("wr1", ["WR"]),
      player("wr2", ["WR"]),
      player("wr3", ["WR"]),
    ];
    // RB, RB, WR, WR, FLEX, FLEX are all reachable: 1 RB + 3 WR fills
    // RB, WR, WR, FLEX = 4 slots.
    expect(startersFilled(roster, SHAPE)).toBe(4);
  });

  it("does not let a surplus fill a slot it is ineligible for", () => {
    const roster = [player("qb1", ["QB"]), player("qb2", ["QB"]), player("qb3", ["QB"])];
    // Only one QB slot, and QB is not FLEX-eligible.
    expect(startersFilled(roster, SHAPE)).toBe(1);
  });

  it("reports unfilled slots in roster order", () => {
    const unfilled = unfilledStarterSlots([player("qb1", ["QB"])], SHAPE);
    expect(unfilled[0]?.slotType).toBe("RB");
    expect(unfilled).toHaveLength(SHAPE.starters.length - 1);
  });

  it("permits a legal pick", () => {
    expect(canDraft([], player("rb1", ["RB"]), SHAPE).legal).toBe(true);
  });

  it("refuses a player already rostered", () => {
    const rb = player("rb1", ["RB"]);
    expect(canDraft([rb], rb, SHAPE).reason).toBe("ALREADY_ROSTERED");
  });

  it("refuses when the roster is full", () => {
    const full = Array.from({ length: SHAPE.totalSlots }, (_, i) => player(`p${i}`, ["WR"], i));
    expect(canDraft(full, player("new", ["WR"]), SHAPE).reason).toBe("ROSTER_FULL");
  });

  it("permits a deliberately terrible draft", () => {
    // Nothing but wide receivers is a decision, not an error. The manager owns
    // it, the same as on ESPN and Sleeper.
    const allWr = Array.from({ length: 10 }, (_, i) => player(`wr${i}`, ["WR"], i));
    expect(canDraft(allWr, player("wr-more", ["WR"]), SHAPE).legal).toBe(true);
  });
});

describe("wouldStrandStarters", () => {
  // One pick left, and both a K and a DEF still needed.
  const nearlyDone = [
    player("qb1", ["QB"]),
    player("rb1", ["RB"]),
    player("rb2", ["RB"]),
    player("wr1", ["WR"]),
    player("wr2", ["WR"]),
    player("te1", ["TE"]),
    player("fx1", ["WR"]),
    player("k1", ["K"]),
  ];

  it("flags a pick that makes a legal lineup impossible", () => {
    expect(wouldStrandStarters(nearlyDone, player("wr9", ["WR"]), SHAPE, 0)).toBe(true);
  });

  it("does not flag the pick that fills the gap", () => {
    expect(wouldStrandStarters(nearlyDone, player("def1", ["DEF"]), SHAPE, 0)).toBe(false);
  });

  it("does not flag luxury picks while there is still time", () => {
    expect(wouldStrandStarters([player("qb1", ["QB"])], player("qb2", ["QB"]), SHAPE, 12)).toBe(
      false,
    );
  });
});

describe("autoPick", () => {
  const available = [
    player("wr1", ["WR"], 1),
    player("rb1", ["RB"], 2),
    player("qb1", ["QB"], 3),
    player("k1", ["K"], 90),
    player("def1", ["DEF"], 95),
  ];

  it("takes the top queued player", () => {
    const result = autoPick({
      available,
      roster: [],
      queue: ["qb1"],
      shape: SHAPE,
      picksRemainingAfter: 14,
    });
    expect(result?.player.playerId).toBe("qb1");
    expect(result?.source).toBe("QUEUE");
  });

  it("skips queued players already taken", () => {
    const result = autoPick({
      available: available.filter((p) => p.playerId !== "qb1"),
      roster: [],
      queue: ["qb1", "rb1"],
      shape: SHAPE,
      picksRemainingAfter: 14,
    });
    expect(result?.player.playerId).toBe("rb1");
    expect(result?.source).toBe("QUEUE");
  });

  it("takes the best player available when the queue is exhausted", () => {
    // Not the first unfilled roster slot. An earlier version filled slots in
    // order, so every bot opened with a quarterback — twelve teams taking a QB
    // in round one, which is nothing like a real draft.
    const result = autoPick({
      available,
      roster: [],
      queue: [],
      shape: SHAPE,
      picksRemainingAfter: 13,
    });
    expect(result?.source).toBe("BEST_AVAILABLE");
    expect(result?.player.playerId).toBe("wr1");
  });

  it("will not hoard a position past its cap", () => {
    // Best-available alone would take receivers all day. Caps are what stop it.
    const caps = defaultPositionCaps(SHAPE);
    const wrCap = caps.get("WR")!;
    const roster = Array.from({ length: wrCap }, (_, i) => player(`wr0${i}`, ["WR"], i));

    const result = autoPick({
      available,
      roster,
      queue: [],
      shape: SHAPE,
      picksRemainingAfter: 8,
    });
    expect(result?.player.positions).not.toContain("WR");
  });

  it("fills a required slot late, once best-available is exhausted", () => {
    // The endgame: one pick left and a defense still needed. ADP would never
    // reach a defense on merit, so the need path has to take over.
    const roster = [
      player("qb1", ["QB"]),
      player("rb1", ["RB"]),
      player("rb2", ["RB"]),
      player("wr01", ["WR"]),
      player("wr02", ["WR"]),
      player("te1", ["TE"]),
      player("fx1", ["WR"]),
      player("k1", ["K"]),
    ];

    const result = autoPick({
      available,
      roster,
      queue: [],
      shape: SHAPE,
      picksRemainingAfter: 0,
    });
    expect(result?.player.playerId).toBe("def1");
  });

  it("takes best available once every starting slot is covered", () => {
    const roster = [
      player("qb0", ["QB"]),
      player("rb01", ["RB"]),
      player("rb02", ["RB"]),
      player("wr01", ["WR"]),
      player("wr02", ["WR"]),
      player("te0", ["TE"]),
      player("fx1", ["RB"]),
      player("fx2", ["WR"]),
      player("k0", ["K"]),
      player("def0", ["DEF"]),
    ];
    const result = autoPick({
      available,
      roster,
      queue: [],
      shape: SHAPE,
      picksRemainingAfter: 4,
    });
    expect(result?.source).toBe("BEST_AVAILABLE");
    expect(result?.player.playerId).toBe("wr1");
  });

  it("never returns an illegal pick", () => {
    const full = Array.from({ length: SHAPE.totalSlots }, (_, i) => player(`p${i}`, ["WR"], i));
    expect(
      autoPick({ available, roster: full, queue: [], shape: SHAPE, picksRemainingAfter: 0 }),
    ).toBeNull();
  });

  it("skips a queued player who would strand the lineup", () => {
    // The queue was written before the board looked like this. Auto-pick must
    // not strand a lineup on the manager's behalf — they were not there to
    // choose it, and an unfillable slot scores nothing until they trade or sign
    // their way out of it.
    //
    // The reason here used to be "the penalty is a forfeited stake", which was
    // the abandonment rule removed in schema 4. #129 corrected the two
    // docstrings and missed this one — the test that pins the behaviour, and so
    // the copy a maintainer reads before changing it.
    const roster = [
      player("qb1", ["QB"]),
      player("rb1", ["RB"]),
      player("rb2", ["RB"]),
      player("wr1", ["WR"]),
      player("wr2", ["WR"]),
      player("te1", ["TE"]),
      player("fx1", ["WR"]),
      player("k1", ["K"]),
    ];
    const result = autoPick({
      available,
      roster,
      queue: ["wr1"],
      shape: SHAPE,
      picksRemainingAfter: 0,
    });
    expect(result?.player.playerId).toBe("def1");
  });

  it("still picks when a manager already stranded their own lineup", () => {
    // Manual picks may strand starters. Auto-pick cannot undo that, and must
    // not stall the draft over it — it takes the best legal player.
    const stranded = [
      player("wr01", ["WR"]),
      player("wr02", ["WR"]),
      player("wr03", ["WR"]),
      player("wr04", ["WR"]),
      player("wr05", ["WR"]),
      player("wr06", ["WR"]),
      player("wr07", ["WR"]),
      player("wr08", ["WR"]),
    ];
    const result = autoPick({
      available,
      roster: stranded,
      queue: [],
      shape: SHAPE,
      picksRemainingAfter: 0,
    });
    expect(result).not.toBeNull();
  });
});

describe("pruneQueue", () => {
  it("drops players who are gone", () => {
    const available = [player("a", ["WR"]), player("c", ["WR"])];
    expect(pruneQueue(["a", "b", "c"], available)).toEqual(["a", "c"]);
  });
});

describe("draft state machine", () => {
  const pool = buildPool();
  const order = generateDraftOrder(TEAMS, "seed");

  it("puts the first team in the order on the clock", () => {
    const state = createDraft(order, ROUNDS);
    expect(currentTeam(state)).toBe(order[0]);
  });

  it("records a legal manual pick", () => {
    const state = createDraft(order, ROUNDS);
    const after = makePick(state, {
      teamId: order[0]!,
      playerId: "rb-1",
      pool,
      shape: SHAPE,
    });

    expect(after.picks).toHaveLength(1);
    expect(after.picks[0]?.source).toBe("MANUAL");
    expect(currentTeam(after)).toBe(order[1]);
  });

  it("does not mutate the previous state", () => {
    const state = createDraft(order, ROUNDS);
    makePick(state, { teamId: order[0]!, playerId: "rb-1", pool, shape: SHAPE });
    expect(state.picks).toHaveLength(0);
  });

  it("refuses a pick from a team not on the clock", () => {
    const state = createDraft(order, ROUNDS);
    expectDraftError(
      () => makePick(state, { teamId: order[5]!, playerId: "rb-1", pool, shape: SHAPE }),
      "NOT_ON_CLOCK",
    );
  });

  it("refuses a player already drafted", () => {
    let state = createDraft(order, ROUNDS);
    state = makePick(state, { teamId: order[0]!, playerId: "rb-1", pool, shape: SHAPE });

    expectDraftError(
      () => makePick(state, { teamId: order[1]!, playerId: "rb-1", pool, shape: SHAPE }),
      "PLAYER_UNAVAILABLE",
    );
  });

  it("refuses an unknown player", () => {
    const state = createDraft(order, ROUNDS);
    expectDraftError(
      () => makePick(state, { teamId: order[0]!, playerId: "nobody", pool, shape: SHAPE }),
      "PLAYER_UNAVAILABLE",
    );
  });

  it("counts a team's remaining picks correctly through the snake", () => {
    const state = createDraft(order, ROUNDS);
    expect(picksRemainingAfter(state, order[0]!)).toBe(ROUNDS - 1);
  });

  it("auto-picks from a queue", () => {
    const state = createDraft(order, ROUNDS);
    const queues = new Map([[order[0]!, ["qb-1"]]]);
    const after = makeAutoPick(state, { pool, shape: SHAPE, queues });

    expect(after.picks[0]?.playerId).toBe("qb-1");
    expect(after.picks[0]?.source).toBe("QUEUE");
  });

  it("auto-picks best available with no queue", () => {
    const state = createDraft(order, ROUNDS);
    const after = makeAutoPick(state, { pool, shape: SHAPE });
    expect(after.picks[0]?.source).toBe("BEST_AVAILABLE");
  });

  it("refuses any pick once complete", () => {
    // A full-length draft, not 1 round. A draft with fewer rounds than starting
    // slots cannot produce a legal roster, and the engine refuses to try.
    let state = createDraft(["a", "b"], ROUNDS);
    while (!isComplete(state)) {
      state = makeAutoPick(state, { pool, shape: SHAPE });
    }

    expect(state.picks).toHaveLength(2 * ROUNDS);
    expectDraftError(() => makeAutoPick(state, { pool, shape: SHAPE }), "DRAFT_COMPLETE");
    expectDraftError(
      () => makePick(state, { teamId: "a", playerId: "qb-1", pool, shape: SHAPE }),
      "DRAFT_COMPLETE",
    );
  });

  it("still picks in a draft too short to fill a lineup", () => {
    // 9 starters cannot be filled in 1 round. Auto-pick takes the best legal
    // player anyway rather than stalling — the shortfall is the league's
    // configuration problem, not something a pick can fix.
    const state = createDraft(["a", "b"], 1);
    const after = makeAutoPick(state, { pool, shape: SHAPE });
    expect(after.picks).toHaveLength(1);
  });

  it("warns before a manual pick that would strand the lineup", () => {
    let state = createDraft(["a"], 2);
    // One pick left after this one, and 9 starting slots to fill.
    const input = { teamId: "a", playerId: "wr-1", pool, shape: SHAPE };

    expect(pickWouldStrandStarters(state, input)).toBe(true);

    // Warned, not blocked — the manager may proceed.
    state = makePick(state, input);
    expect(state.picks).toHaveLength(1);
  });
});

describe("pick clock", () => {
  const fast: DraftRules = {
    type: "SNAKE",
    mode: "FAST",
    pickSeconds: 90,
    scheduledAt: 1_756_400_000,
  };
  const slow: DraftRules = { ...fast, mode: "SLOW", pickSeconds: 86_400 };

  it("computes a fast deadline", () => {
    expect(pickDeadline(1000, fast)).toBe(1090);
  });

  it("computes a slow deadline with the same function", () => {
    // Slow drafts need no separate machinery — only a bigger number.
    expect(pickDeadline(1000, slow)).toBe(87_400);
  });

  it("expires exactly at the deadline", () => {
    expect(isPickExpired(1090, 1089)).toBe(false);
    expect(isPickExpired(1090, 1090)).toBe(true);
  });

  it("floors remaining time at zero", () => {
    expect(secondsRemaining(1090, 1000)).toBe(90);
    expect(secondsRemaining(1090, 5000)).toBe(0);
  });
});

describe("full draft simulation", () => {
  const pool = buildPool();

  function runDraft(
    seed: string,
    humanQueues: Map<string, string[]>,
  ): ReturnType<typeof createDraft> {
    const order = generateDraftOrder(TEAMS, seed);
    let state = createDraft(order, ROUNDS);

    while (!isComplete(state)) {
      state = makeAutoPick(state, { pool, shape: SHAPE, queues: humanQueues });
    }
    return state;
  }

  it("completes and produces a legal roster for every team", () => {
    const state = runDraft("sim-1", new Map());

    expect(state.picks).toHaveLength(totalPicks(12, ROUNDS));

    for (const teamId of TEAMS) {
      const roster = rosterFor(state, teamId, pool);
      expect(roster).toHaveLength(ROUNDS);
      // The property that matters: every team can field a legal lineup.
      expect(startersFilled(roster, SHAPE)).toBe(SHAPE.starters.length);
    }
  });

  it("never drafts a player twice", () => {
    const state = runDraft("sim-2", new Map());
    const ids = state.picks.map((pick) => pick.playerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("honours queues where they exist and falls back where they do not", () => {
    // Deliberately a kicker: nobody takes one early on merit, so it is certain
    // to still be there — and it proves a queue overrides best-available rather
    // than merely agreeing with it.
    const queues = new Map([[TEAMS[0]!, ["k-1"]]]);
    const state = runDraft("sim-3", queues);

    const queued = state.picks.filter((pick) => pick.source === "QUEUE");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.playerId).toBe("k-1");
    expect(queued[0]?.teamId).toBe(TEAMS[0]);

    // Everyone without a queue still drafts normally.
    expect(state.picks.some((pick) => pick.source === "BEST_AVAILABLE")).toBe(true);
  });

  it("does not open every team with the same position", () => {
    // The symptom that prompted this design: filling roster slots in order made
    // all twelve teams take a quarterback with the first pick.
    const state = runDraft("sim-variety", new Map());
    const firstRound = state.picks.filter((pick) => pick.round === 1);
    const positions = firstRound.map((pick) => pool.get(pick.playerId)?.positions[0] ?? "?");

    expect(new Set(positions).size).toBeGreaterThan(1);
  });

  it("gives every team a kicker and a defense", () => {
    // Neither is ever the best player available — ADP puts kickers past pick
    // 180 — so they are only ever drafted because the endgame requires them.
    const state = runDraft("sim-required", new Map());

    for (const teamId of TEAMS) {
      const roster = rosterFor(state, teamId, pool);
      const positions = roster.flatMap((player) => player.positions);

      expect(positions, `${teamId} has no kicker`).toContain("K");
      expect(positions, `${teamId} has no defense`).toContain("DEF");
    }
  });

  it("survives many drafts across different orders", () => {
    // Different seeds exercise different orders, and therefore different
    // sequences of scarcity near the end where legality gets tight.
    for (let i = 0; i < 60; i++) {
      const state = runDraft(`sim-bulk-${i}`, new Map());

      for (const teamId of TEAMS) {
        const roster = rosterFor(state, teamId, pool);
        expect(roster).toHaveLength(ROUNDS);
        expect(startersFilled(roster, SHAPE)).toBe(SHAPE.starters.length);
      }
    }
  });

  it("is reproducible from its seed", () => {
    const a = runDraft("repeat", new Map());
    const b = runDraft("repeat", new Map());
    expect(a.picks).toEqual(b.picks);
  });
});
