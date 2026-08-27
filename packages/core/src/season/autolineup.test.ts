import { describe, expect, it } from "vitest";
import { buildRosterShape } from "../draft/roster.js";
import { NFL } from "../sports/nfl.js";
import { NFL_PPR_ROSTER } from "../rules/nfl-ppr.js";
import { autolineup, seasonAverage } from "./autolineup.js";
import type { AutolineupCandidate } from "./autolineup.js";
import { validateLineup } from "./lineup.js";
import type { KickoffTimes } from "./lineup.js";

const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);
const SUNDAY = 1_757_782_800;

/**
 * Kickoffs for a candidate roster, and a moment before all of them.
 *
 * `ValidateLineupInput.kickoffs` is required, and `lineup.ts` says why: "an
 * optional filter that defaults to permissive is the shape that produced the
 * `loadProjections` defect". Both calls below omitted it and compiled anyway,
 * because no test under `packages/` was typechecked — #257. Deriving it from
 * the roster the lineup was built from keeps the two from drifting apart, and
 * passing `now` is what makes these assertions about the path a manager's own
 * edit takes rather than the preview path.
 */
const kickoffsOf = (roster: readonly AutolineupCandidate[]): KickoffTimes =>
  new Map(roster.map((player) => [player.playerId, player.kickoffAt]));

const BEFORE_KICKOFF = SUNDAY - 3_600;

function candidate(
  playerId: string,
  positions: string[],
  averageMilliPoints: number | null,
  extra: { unavailable?: boolean; kickoffAt?: number | null } = {},
): AutolineupCandidate {
  return {
    playerId,
    positions,
    averageMilliPoints,
    kickoffAt: extra.kickoffAt === undefined ? SUNDAY : extra.kickoffAt,
    ...(extra.unavailable !== undefined ? { unavailable: extra.unavailable } : {}),
  };
}

/** A full 14-man roster with a clear best at each position. */
const ROSTER: AutolineupCandidate[] = [
  candidate("qb-good", ["QB"], 22_000),
  candidate("qb-bad", ["QB"], 14_000),
  candidate("rb-a", ["RB"], 18_000),
  candidate("rb-b", ["RB"], 15_000),
  candidate("rb-c", ["RB"], 11_000),
  candidate("wr-a", ["WR"], 19_000),
  candidate("wr-b", ["WR"], 16_000),
  candidate("wr-c", ["WR"], 13_000),
  candidate("wr-d", ["WR"], 9_000),
  candidate("te-a", ["TE"], 12_000),
  candidate("te-b", ["TE"], 6_000),
  candidate("k-a", ["K"], 8_000),
  candidate("def-a", ["DEF"], 7_000),
  candidate("def-b", ["DEF"], 5_000),
];

const at = (
  lineup: readonly { slotType: string; slotIndex: number; playerId: string | null }[],
  slotType: string,
  slotIndex = 0,
) =>
  lineup.find((entry) => entry.slotType === slotType && entry.slotIndex === slotIndex)
    ?.playerId;

describe("autolineup", () => {
  it("fills every starting slot", () => {
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });

    expect(lineup).toHaveLength(9);
    expect(lineup.every((entry) => entry.playerId !== null)).toBe(true);
  });

  it("produces a legal lineup", () => {
    // The same validator a manager's own edit goes through. If these two ever
    // disagreed, a team could be auto-set into a lineup it was not allowed to
    // choose for itself.
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });
    const roster = new Map(ROSTER.map((player) => [player.playerId, player]));

    expect(
      validateLineup({
        assignments: lineup,
        shape: SHAPE,
        roster,
        kickoffs: kickoffsOf(ROSTER),
        now: BEFORE_KICKOFF,
        requireFull: true,
      }),
    ).toEqual([]);
  });

  it("starts the best player at each position", () => {
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });

    expect(at(lineup, "QB")).toBe("qb-good");
    expect(at(lineup, "K")).toBe("k-a");
    expect(at(lineup, "DEF")).toBe("def-a");
  });

  it("starts both running backs in order", () => {
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });

    expect([at(lineup, "RB", 0), at(lineup, "RB", 1)].sort()).toEqual(["rb-a", "rb-b"]);
  });

  it("never starts a player twice", () => {
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });
    const filled = lineup.map((entry) => entry.playerId).filter(Boolean);

    expect(new Set(filled).size).toBe(filled.length);
  });

  it("fills the flex from whoever is left", () => {
    // rb-c, wr-c, wr-d and te-b are the leftovers; wr-c is the best of them.
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });

    expect(at(lineup, "FLEX")).toBe("wr-c");
  });

  it("does not let the flex steal the tight end", () => {
    // The ordering bug this exists to prevent: with one tight end on the roster,
    // filling FLEX first takes him and leaves TE empty.
    const thin = ROSTER.filter((player) => player.playerId !== "te-b");
    const lineup = autolineup({ shape: SHAPE, roster: thin });

    expect(at(lineup, "TE")).toBe("te-a");
    expect(at(lineup, "FLEX")).not.toBe("te-a");
  });

  it("leaves a slot empty when nobody can fill it", () => {
    const noKicker = ROSTER.filter((player) => !player.positions.includes("K"));
    const lineup = autolineup({ shape: SHAPE, roster: noKicker });

    expect(at(lineup, "K")).toBeNull();
    // And the rest of the lineup is still set.
    expect(at(lineup, "QB")).toBe("qb-good");
  });

  it("returns slots in roster order, not fill order", () => {
    // Filling runs scarcest-first; a human reads QB, RB, RB, WR…
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });

    expect(lineup.map((entry) => entry.slotType)).toEqual([
      "QB",
      "RB",
      "RB",
      "WR",
      "WR",
      "TE",
      "FLEX",
      "K",
      "DEF",
    ]);
  });
});

describe("determinism", () => {
  // An abandoned team plays out the season, and its results move other people's
  // playoff seeds — which in a pot league decides who gets paid. "The computer
  // picked" has to be something anyone can recompute.
  it("is reproducible", () => {
    const first = autolineup({ shape: SHAPE, roster: ROSTER });
    const second = autolineup({ shape: SHAPE, roster: ROSTER });

    expect(first).toEqual(second);
  });

  it("does not depend on roster order", () => {
    // Otherwise the lineup would move with however the database returned rows.
    const forwards = autolineup({ shape: SHAPE, roster: ROSTER });
    const backwards = autolineup({ shape: SHAPE, roster: [...ROSTER].reverse() });

    expect(forwards).toEqual(backwards);
  });

  it("breaks exact ties on player ID", () => {
    const tied: AutolineupCandidate[] = [
      candidate("zzz", ["QB"], 10_000),
      candidate("aaa", ["QB"], 10_000),
    ];

    expect(at(autolineup({ shape: SHAPE, roster: tied }), "QB")).toBe("aaa");
  });
});

describe("availability", () => {
  it("prefers a worse available player to a better unavailable one", () => {
    // A player on a bye scores nothing at all, so he loses to anyone playing.
    const roster = [
      candidate("star-on-bye", ["QB"], 25_000, { unavailable: true, kickoffAt: null }),
      candidate("backup", ["QB"], 9_000),
    ];

    expect(at(autolineup({ shape: SHAPE, roster }), "QB")).toBe("backup");
  });

  it("still starts an unavailable player rather than nobody", () => {
    // A team with no other quarterback has to field someone. An empty slot and
    // an inactive player both score nothing, but only one keeps the lineup
    // legal.
    const roster = [candidate("only-qb", ["QB"], 25_000, { unavailable: true })];

    expect(at(autolineup({ shape: SHAPE, roster }), "QB")).toBe("only-qb");
  });

  it("prefers a player with a record to one without", () => {
    const roster = [candidate("rookie", ["QB"], null), candidate("veteran", ["QB"], 4_000)];

    expect(at(autolineup({ shape: SHAPE, roster }), "QB")).toBe("veteran");
  });

  it("still starts an unplayed player over nobody", () => {
    const roster = [candidate("rookie", ["QB"], null)];

    expect(at(autolineup({ shape: SHAPE, roster }), "QB")).toBe("rookie");
  });
});

describe("locked slots", () => {
  it("preserves them exactly", () => {
    // An autolineup running on Sunday afternoon cannot move a Thursday player.
    const lineup = autolineup({
      shape: SHAPE,
      roster: ROSTER,
      locked: [{ slotType: "QB", slotIndex: 0, playerId: "qb-bad" }],
    });

    expect(at(lineup, "QB")).toBe("qb-bad");
  });

  it("does not reuse a locked player elsewhere", () => {
    const lineup = autolineup({
      shape: SHAPE,
      roster: ROSTER,
      locked: [{ slotType: "FLEX", slotIndex: 0, playerId: "rb-a" }],
    });

    expect([at(lineup, "RB", 0), at(lineup, "RB", 1)]).not.toContain("rb-a");
    expect(at(lineup, "FLEX")).toBe("rb-a");
  });

  it("preserves a locked empty slot", () => {
    const lineup = autolineup({
      shape: SHAPE,
      roster: ROSTER,
      locked: [{ slotType: "K", slotIndex: 0, playerId: null }],
    });

    expect(at(lineup, "K")).toBeNull();
  });
});

describe("seasonAverage", () => {
  it("averages the weeks played", () => {
    expect(seasonAverage([10_000, 20_000, 30_000])).toBe(20_000);
  });

  it("is null for a player who has not played", () => {
    expect(seasonAverage([])).toBeNull();
  });

  it("floors rather than rounding", () => {
    // Integer division. Averages feed a comparison and never a score, so the
    // lost fraction cannot reach anybody's points total.
    expect(seasonAverage([10_000, 10_001])).toBe(10_000);
  });

  it("handles a negative week", () => {
    // Three interceptions and a lost fumble is a real scoreline.
    expect(seasonAverage([-4_000, 12_000])).toBe(4_000);
  });
});

describe("WEEKLY_PROJECTION", () => {
  const projected = (
    playerId: string,
    positions: string[],
    averageMilliPoints: number | null,
    projectedMilliPoints: number | null,
  ): AutolineupCandidate => ({
    playerId,
    positions,
    averageMilliPoints,
    projectedMilliPoints,
    kickoffAt: SUNDAY,
  });

  /**
   * The whole reason the mode exists. A season average cannot know that this
   * week's opponent is the worst run defence in the league, or that the usual
   * starter is out and the backup inherits the carries.
   */
  it("starts the better projection over the better average", () => {
    const roster = [
      projected("qb-steady", ["QB"], 22_000, 15_000),
      projected("qb-spot", ["QB"], 9_000, 26_000),
    ];

    const [byProjection] = autolineup({
      shape: SHAPE,
      roster,
      mode: "WEEKLY_PROJECTION",
    }).filter((a) => a.slotType === "QB");
    expect(byProjection?.playerId).toBe("qb-spot");

    // Same roster, same code, other mode — so the difference is the rule and
    // not something incidental about these two players.
    const [byAverage] = autolineup({
      shape: SHAPE,
      roster,
      mode: "SEASON_AVERAGE",
    }).filter((a) => a.slotType === "QB");
    expect(byAverage?.playerId).toBe("qb-steady");
  });

  it("defaults to SEASON_AVERAGE when no mode is given", () => {
    // A caller that has not been taught about projections must not silently
    // start ranking everybody on null.
    const roster = [
      projected("qb-steady", ["QB"], 22_000, 15_000),
      projected("qb-spot", ["QB"], 9_000, 26_000),
    ];
    const [chosen] = autolineup({ shape: SHAPE, roster }).filter((a) => a.slotType === "QB");
    expect(chosen?.playerId).toBe("qb-steady");
  });

  /**
   * Per player, not per league. One rookie the provider does not cover must not
   * decide how the other eight slots get filled.
   */
  it("falls back to the average for a player with no projection", () => {
    const roster = [
      projected("qb-known", ["QB"], 10_000, 12_000),
      projected("qb-rookie", ["QB"], 25_000, null),
    ];

    const [chosen] = autolineup({
      shape: SHAPE,
      roster,
      mode: "WEEKLY_PROJECTION",
    }).filter((a) => a.slotType === "QB");

    // Ranked on 25_000, his average — not dumped below the projected player.
    expect(chosen?.playerId).toBe("qb-rookie");
  });

  it("still puts an available player ahead of a better-projected bye", () => {
    // Availability outranks any number. A player on bye scores nothing at all,
    // whatever the projection says.
    const roster: AutolineupCandidate[] = [
      { ...projected("qb-bye", ["QB"], 30_000, 30_000), unavailable: true },
      projected("qb-playing", ["QB"], 5_000, 5_000),
    ];

    const [chosen] = autolineup({
      shape: SHAPE,
      roster,
      mode: "WEEKLY_PROJECTION",
    }).filter((a) => a.slotType === "QB");
    expect(chosen?.playerId).toBe("qb-playing");
  });

  it("is reproducible, which is the property that matters", () => {
    const roster = ROSTER.map((c) => ({
      ...c,
      projectedMilliPoints: 20_000 - c.playerId.length,
    }));

    const once = autolineup({ shape: SHAPE, roster, mode: "WEEKLY_PROJECTION" });
    const twice = autolineup({
      shape: SHAPE,
      roster: [...roster].reverse(),
      mode: "WEEKLY_PROJECTION",
    });

    // Same inputs in a different order give the same lineup: these results move
    // other people's playoff seeds, so "the computer picked" has to be
    // something anyone can recompute.
    expect(once).toEqual(twice);
  });

  it("produces a legal lineup", () => {
    // The same validator a manager's own edit goes through. If the two ever
    // disagreed, a team could be auto-set into a lineup it was not allowed to
    // choose for itself.
    const candidates = ROSTER.map((c, i) => ({
      ...c,
      projectedMilliPoints: (i % 5) * 4_000,
    }));
    const assignments = autolineup({
      shape: SHAPE,
      roster: candidates,
      mode: "WEEKLY_PROJECTION",
    });
    const roster = new Map(candidates.map((player) => [player.playerId, player]));

    expect(
      validateLineup({
        assignments,
        shape: SHAPE,
        roster,
        kickoffs: kickoffsOf(candidates),
        now: BEFORE_KICKOFF,
        requireFull: true,
      }),
    ).toEqual([]);
  });
});
