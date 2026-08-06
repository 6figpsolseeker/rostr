import { describe, expect, it } from "vitest";
import { buildRosterShape } from "../draft/roster.js";
import { NFL } from "../sports/nfl.js";
import { NFL_PPR_ROSTER } from "../rules/nfl-ppr.js";
import {
  lineupIsFullyLocked,
  lockedAssignments,
  slotLocksAt,
  startingSlots,
  validateLineup,
} from "./lineup.js";
import type { LineupAssignment, LineupPlayer } from "./lineup.js";

const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);

const THURSDAY = 1_757_462_400; // Thu 9 Sep 2026, 20:15 ET
const SUNDAY = 1_757_782_800; // Sun 13:00 ET
const SUNDAY_LATE = 1_757_794_800; // Sun 16:25 ET

function player(
  id: string,
  positions: string[],
  kickoffAt: number | null = SUNDAY,
): LineupPlayer {
  return { playerId: id, positions, kickoffAt };
}

/** A roster deep enough to fill every slot, with one spare at each position. */
const ROSTER = new Map<string, LineupPlayer>(
  [
    player("qb1", ["QB"]),
    player("qb2", ["QB"]),
    player("rb1", ["RB"]),
    player("rb2", ["RB"]),
    player("rb3", ["RB"]),
    player("wr1", ["WR"]),
    player("wr2", ["WR"]),
    player("wr3", ["WR"]),
    player("te1", ["TE"]),
    player("k1", ["K"]),
    player("def1", ["DEF"]),
  ].map((p) => [p.playerId, p]),
);

/** A legal starting nine. */
const LEGAL: LineupAssignment[] = [
  { slotType: "QB", slotIndex: 0, playerId: "qb1" },
  { slotType: "RB", slotIndex: 0, playerId: "rb1" },
  { slotType: "RB", slotIndex: 1, playerId: "rb2" },
  { slotType: "WR", slotIndex: 0, playerId: "wr1" },
  { slotType: "WR", slotIndex: 1, playerId: "wr2" },
  { slotType: "TE", slotIndex: 0, playerId: "te1" },
  { slotType: "FLEX", slotIndex: 0, playerId: "wr3" },
  { slotType: "K", slotIndex: 0, playerId: "k1" },
  { slotType: "DEF", slotIndex: 0, playerId: "def1" },
];

const codes = (problems: readonly { code: string }[]): string[] => problems.map((p) => p.code);

describe("startingSlots", () => {
  it("numbers repeated slots from zero", () => {
    // A manager thinks RB1 and RB2; the database keys on (slot type, index).
    // A flat list of starters would make them slots 1 and 2 of the whole roster.
    const slots = startingSlots(SHAPE);
    const backs = slots.filter((slot) => slot.slotType === "RB");

    expect(backs.map((slot) => slot.slotIndex)).toEqual([0, 1]);
  });

  it("covers the whole starting lineup", () => {
    expect(startingSlots(SHAPE)).toHaveLength(9);
  });

  it("carries eligibility from the registry", () => {
    const flex = startingSlots(SHAPE).find((slot) => slot.slotType === "FLEX");

    expect(flex?.eligiblePositions).toEqual(expect.arrayContaining(["RB", "WR", "TE"]));
    expect(flex?.eligiblePositions).not.toContain("QB");
  });
});

describe("validateLineup", () => {
  it("accepts a legal lineup", () => {
    expect(validateLineup({ assignments: LEGAL, shape: SHAPE, roster: ROSTER })).toEqual([]);
  });

  it("rejects a player who cannot play the slot", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: "rb1" }],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(codes(problems)).toEqual(["POSITION_NOT_ELIGIBLE"]);
  });

  it("keeps a quarterback out of the flex", () => {
    // The rule everyone tries first.
    const problems = validateLineup({
      assignments: [{ slotType: "FLEX", slotIndex: 0, playerId: "qb2" }],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(codes(problems)).toEqual(["POSITION_NOT_ELIGIBLE"]);
  });

  it("lets a running back into the flex", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "FLEX", slotIndex: 0, playerId: "rb3" }],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(problems).toEqual([]);
  });

  it("rejects a player who is not on the roster", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: "somebody-elses-qb" }],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(codes(problems)).toEqual(["NOT_ON_ROSTER"]);
  });

  it("rejects the same player in two slots", () => {
    const problems = validateLineup({
      assignments: [
        { slotType: "WR", slotIndex: 0, playerId: "wr1" },
        { slotType: "FLEX", slotIndex: 0, playerId: "wr1" },
      ],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(codes(problems)).toEqual(["PLAYER_TWICE"]);
  });

  it("rejects a slot this league does not have", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "RB", slotIndex: 5, playerId: "rb1" }],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(codes(problems)).toEqual(["UNKNOWN_SLOT"]);
  });

  it("rejects the same slot filled twice", () => {
    const problems = validateLineup({
      assignments: [
        { slotType: "QB", slotIndex: 0, playerId: "qb1" },
        { slotType: "QB", slotIndex: 0, playerId: "qb2" },
      ],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(codes(problems)).toEqual(["DUPLICATE_SLOT"]);
  });

  it("allows an empty slot mid-week", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: null }],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(problems).toEqual([]);
  });

  it("reports every problem at once", () => {
    // A manager rearranging nine slots should see everything wrong in one pass,
    // not discover the next fault after fixing this one.
    const problems = validateLineup({
      assignments: [
        { slotType: "QB", slotIndex: 0, playerId: "rb1" },
        { slotType: "K", slotIndex: 0, playerId: "nobody" },
        { slotType: "TE", slotIndex: 9, playerId: "te1" },
      ],
      shape: SHAPE,
      roster: ROSTER,
    });

    expect(codes(problems).sort()).toEqual([
      "NOT_ON_ROSTER",
      "POSITION_NOT_ELIGIBLE",
      "UNKNOWN_SLOT",
    ]);
  });

  describe("requireFull", () => {
    it("complains about empty starters when asked", () => {
      const problems = validateLineup({
        assignments: LEGAL.slice(0, 5),
        shape: SHAPE,
        roster: ROSTER,
        requireFull: true,
      });

      expect(problems.every((problem) => problem.code === "STARTER_EMPTY")).toBe(true);
      expect(problems).toHaveLength(4);
    });

    it("stays quiet when not asked", () => {
      // Tuesday's half-set lineup does not need telling.
      const problems = validateLineup({
        assignments: LEGAL.slice(0, 5),
        shape: SHAPE,
        roster: ROSTER,
      });

      expect(problems).toEqual([]);
    });

    it("passes on a full lineup", () => {
      const problems = validateLineup({
        assignments: LEGAL,
        shape: SHAPE,
        roster: ROSTER,
        requireFull: true,
      });

      expect(problems).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/** One Thursday player; everyone else plays Sunday. */
const MIXED = new Map<string, LineupPlayer>([
  ...ROSTER,
  ["qb1", player("qb1", ["QB"], THURSDAY)],
  ["wr3", player("wr3", ["WR"], SUNDAY_LATE)],
  ["te1", player("te1", ["TE"], null)], // bye week
]);

const DURING_THURSDAY = THURSDAY + 60;
const BEFORE_SUNDAY = SUNDAY - 3600;

describe("locks", () => {
  it("locks a slot once that player's game starts", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: "qb2" }],
      current: [{ slotType: "QB", slotIndex: 0, playerId: "qb1" }],
      shape: SHAPE,
      roster: MIXED,
      now: DURING_THURSDAY,
    });

    expect(codes(problems)).toEqual(["SLOT_LOCKED"]);
  });

  it("leaves the rest of the lineup editable", () => {
    // The whole point of per-player locks. A Thursday player being locked must
    // not stop a manager reacting to a Sunday-morning injury.
    const problems = validateLineup({
      assignments: [{ slotType: "WR", slotIndex: 0, playerId: "wr2" }],
      current: [{ slotType: "WR", slotIndex: 0, playerId: "wr1" }],
      shape: SHAPE,
      roster: MIXED,
      now: DURING_THURSDAY,
    });

    expect(problems).toEqual([]);
  });

  it("lets a locked slot keep its player", () => {
    // Otherwise submitting a whole lineup on Sunday would fail because of the
    // Thursday slot, which the manager cannot do anything about.
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: "qb1" }],
      current: [{ slotType: "QB", slotIndex: 0, playerId: "qb1" }],
      shape: SHAPE,
      roster: MIXED,
      now: DURING_THURSDAY,
    });

    expect(problems).toEqual([]);
  });

  it("does not lock before kickoff", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: "qb2" }],
      current: [{ slotType: "QB", slotIndex: 0, playerId: "qb1" }],
      shape: SHAPE,
      roster: MIXED,
      now: THURSDAY - 1,
    });

    expect(problems).toEqual([]);
  });

  it("locks exactly at kickoff, not a second later", () => {
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: "qb2" }],
      current: [{ slotType: "QB", slotIndex: 0, playerId: "qb1" }],
      shape: SHAPE,
      roster: MIXED,
      now: THURSDAY,
    });

    expect(codes(problems)).toEqual(["SLOT_LOCKED"]);
  });

  it("never locks an empty slot", () => {
    // A manager who left a slot empty can still fill it on Sunday: nothing has
    // happened in that slot for anyone to react to. Locking empty slots at the
    // week's first kickoff would punish forgetting rather than prevent cheating.
    const problems = validateLineup({
      assignments: [{ slotType: "RB", slotIndex: 0, playerId: "rb1" }],
      current: [{ slotType: "RB", slotIndex: 0, playerId: null }],
      shape: SHAPE,
      roster: MIXED,
      now: SUNDAY_LATE,
    });

    expect(problems).toEqual([]);
  });

  it("never locks a player on a bye", () => {
    // There is no game to have started.
    const problems = validateLineup({
      assignments: [{ slotType: "TE", slotIndex: 0, playerId: null }],
      current: [{ slotType: "TE", slotIndex: 0, playerId: "te1" }],
      shape: SHAPE,
      roster: MIXED,
      now: SUNDAY_LATE,
    });

    expect(problems).toEqual([]);
  });

  it("skips lock checking entirely without a clock", () => {
    // Previews are not submissions.
    const problems = validateLineup({
      assignments: [{ slotType: "QB", slotIndex: 0, playerId: "qb2" }],
      current: [{ slotType: "QB", slotIndex: 0, playerId: "qb1" }],
      shape: SHAPE,
      roster: MIXED,
    });

    expect(problems).toEqual([]);
  });
});

describe("lockedAssignments", () => {
  it("lists only the slots that have started", () => {
    const locked = lockedAssignments(LEGAL, MIXED, DURING_THURSDAY);

    expect(locked.map((a) => a.slotType)).toEqual(["QB"]);
  });

  it("grows as the day goes on", () => {
    expect(lockedAssignments(LEGAL, MIXED, BEFORE_SUNDAY)).toHaveLength(1);
    expect(lockedAssignments(LEGAL, MIXED, SUNDAY).length).toBeGreaterThan(1);
  });

  it("is empty before anything kicks off", () => {
    expect(lockedAssignments(LEGAL, MIXED, THURSDAY - 1)).toEqual([]);
  });
});

describe("slotLocksAt", () => {
  it("reports the kickoff a manager is racing", () => {
    expect(slotLocksAt({ slotType: "QB", slotIndex: 0, playerId: "qb1" }, MIXED)).toBe(
      THURSDAY,
    );
  });

  it("is null for an empty slot", () => {
    expect(slotLocksAt({ slotType: "QB", slotIndex: 0, playerId: null }, MIXED)).toBeNull();
  });

  it("is null on a bye", () => {
    expect(slotLocksAt({ slotType: "TE", slotIndex: 0, playerId: "te1" }, MIXED)).toBeNull();
  });
});

describe("lineupIsFullyLocked", () => {
  /** Every player in a game this week — nobody on a bye. */
  const PLAYING = LEGAL.filter((a) => a.slotType !== "TE");

  it("is false while anything can still move", () => {
    expect(lineupIsFullyLocked(PLAYING, MIXED, SUNDAY)).toBe(false);
  });

  it("is true once the last game has started", () => {
    expect(lineupIsFullyLocked(PLAYING, MIXED, SUNDAY_LATE + 1)).toBe(true);
  });

  it("stays false while a bye slot is still fillable", () => {
    // A slot holding a player on a bye never locks, because no game of his has
    // started — so the manager can still put a Monday-night player in it. The
    // lineup is genuinely not settled, and saying otherwise would be a lie the
    // UI would repeat.
    expect(lineupIsFullyLocked(LEGAL, MIXED, SUNDAY_LATE + 1)).toBe(false);
  });

  it("is false for an empty lineup", () => {
    // Nothing is locked because nothing is set — not the same as "settled".
    const empty = LEGAL.map((a) => ({ ...a, playerId: null }));

    expect(lineupIsFullyLocked(empty, MIXED, SUNDAY_LATE + 1)).toBe(false);
  });
});
