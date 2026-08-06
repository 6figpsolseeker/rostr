import { describe, expect, it } from "vitest";
import { NFL } from "../sports/nfl.js";
import { NFL_DEFAULT_WAIVERS, NFL_PPR_ROSTER } from "../rules/nfl-ppr.js";
import { buildRosterShape } from "../draft/roster.js";
import type { DraftablePlayer } from "../draft/roster.js";
import {
  availabilityAt,
  dropDestination,
  nextProcessingAt,
  nextWeeklyLockAt,
  waiverClearsAt,
} from "./schedule.js";
import { initialWaiverPriority, resolveWaiverClaims } from "./claims.js";
import type { WaiverClaim } from "./claims.js";

const RULES = NFL_DEFAULT_WAIVERS;
const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);

/** Reads an instant back as Eastern wall-clock, for legible assertions. */
const eastern = (date: Date): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    month: "2-digit",
    day: "2-digit",
  }).format(date);

describe("processing schedule", () => {
  it("finds the next Wednesday 03:00 Eastern", () => {
    // Monday 8 Sep 2026, mid-afternoon Eastern.
    const now = new Date("2026-09-07T18:00:00Z");
    expect(eastern(nextProcessingAt(now, RULES))).toContain("Wed");
    expect(eastern(nextProcessingAt(now, RULES))).toContain("03:00");
  });

  it("skips to next week when the run has already passed today", () => {
    // Wednesday 04:00 Eastern — this week's run is gone.
    const justAfter = new Date("2026-09-09T08:00:00Z");
    const next = nextProcessingAt(justAfter, RULES);

    expect(next.getTime() - justAfter.getTime()).toBeGreaterThan(6 * 24 * 3600 * 1000);
  });

  it("finds the weekly lock on Tuesday midnight Eastern", () => {
    const now = new Date("2026-09-07T18:00:00Z");
    expect(eastern(nextWeeklyLockAt(now, RULES))).toContain("Tue");
    expect(eastern(nextWeeklyLockAt(now, RULES))).toContain("00:00");
  });
});

describe("daylight saving", () => {
  // US clocks go back on Sunday 1 November 2026. The NFL season runs straight
  // through it, so a frozen UTC offset would shift every waiver run by an hour
  // right before the trade deadline.
  it("is 07:00 UTC while Eastern is on summer time", () => {
    const october = new Date("2026-10-19T12:00:00Z");
    const run = nextProcessingAt(october, RULES);

    expect(run.toISOString()).toContain("T07:00:00");
    expect(eastern(run)).toContain("03:00");
  });

  it("is 08:00 UTC once Eastern returns to standard time", () => {
    const november = new Date("2026-11-09T12:00:00Z");
    const run = nextProcessingAt(november, RULES);

    expect(run.toISOString()).toContain("T08:00:00");
    expect(eastern(run)).toContain("03:00");
  });

  it("stays at 03:00 local across the transition", () => {
    // The property that matters: managers experience the same local time all
    // season, whatever the UTC instant happens to be.
    let cursor = new Date("2026-09-01T12:00:00Z");

    for (let week = 0; week < 20; week++) {
      const run = nextProcessingAt(cursor, RULES);
      expect(eastern(run), run.toISOString()).toContain("03:00");
      expect(eastern(run), run.toISOString()).toContain("Wed");
      cursor = new Date(run.getTime() + 60_000);
    }
  });
});

describe("dropDestination", () => {
  it("sends a long-held player to waivers", () => {
    const acquired = new Date("2026-09-01T12:00:00Z");
    const dropped = new Date("2026-09-05T12:00:00Z");
    expect(dropDestination(acquired, dropped, RULES)).toBe("WAIVERS");
  });

  it("sends a briefly-held player straight to free agency", () => {
    // ESPN's rule. It stops a manager adding a player, cutting him hours later,
    // and re-adding him to dodge the claim queue.
    const acquired = new Date("2026-09-05T12:00:00Z");
    const dropped = new Date("2026-09-05T20:00:00Z");
    expect(dropDestination(acquired, dropped, RULES)).toBe("FREE_AGENT");
  });

  it("treats exactly 24 hours as long enough for waivers", () => {
    const acquired = new Date("2026-09-05T12:00:00Z");
    const dropped = new Date("2026-09-06T12:00:00Z");
    expect(dropDestination(acquired, dropped, RULES)).toBe("WAIVERS");
  });
});

describe("waiverClearsAt", () => {
  it("does not clear at a run less than the waiver period away", () => {
    // Dropped Tuesday evening: Wednesday's run is only hours later, so he waits
    // for the following week. Otherwise the dropping manager's league-mates get
    // no meaningful chance to claim.
    const dropped = new Date("2026-09-09T02:00:00Z"); // Tue 22:00 ET
    const clears = waiverClearsAt(dropped, RULES);

    expect(clears.getTime() - dropped.getTime()).toBeGreaterThan(24 * 3600 * 1000);
    expect(eastern(clears)).toContain("Wed");
  });

  it("clears at the first run a full period later", () => {
    // Dropped Wednesday morning, just after the run: a full day passes well
    // before the next Wednesday, so he clears then.
    const dropped = new Date("2026-09-09T12:00:00Z");
    const clears = waiverClearsAt(dropped, RULES);

    expect(eastern(clears)).toContain("Wed");
    expect(clears.getTime() - dropped.getTime()).toBeLessThan(8 * 24 * 3600 * 1000);
  });
});

describe("availabilityAt", () => {
  const landed = new Date("2026-09-09T12:00:00Z");

  it("is on waivers before the clearing run", () => {
    expect(availabilityAt(landed, new Date("2026-09-10T12:00:00Z"), RULES)).toBe("ON_WAIVERS");
  });

  it("is a free agent after clearing", () => {
    expect(availabilityAt(landed, new Date("2026-09-20T12:00:00Z"), RULES)).toBe("FREE_AGENT");
  });

  it("treats a player who never hit waivers as a free agent", () => {
    expect(availabilityAt(null, new Date("2026-09-10T12:00:00Z"), RULES)).toBe("FREE_AGENT");
  });
});

// ---------------------------------------------------------------------------
// Claim resolution
// ---------------------------------------------------------------------------

const player = (id: string, positions: string[] = ["WR"]): DraftablePlayer => ({
  playerId: id,
  positions,
  rank: 1,
});

const claim = (
  claimId: string,
  teamId: string,
  addPlayerId: string,
  dropPlayerId: string | null = null,
): WaiverClaim => ({ claimId, teamId, addPlayerId, dropPlayerId });

const POOL = new Map(["star", "other", "third"].map((id) => [id, player(id)] as const));

describe("resolveWaiverClaims", () => {
  const priority = ["team-a", "team-b", "team-c"];
  const emptyRosters = new Map(priority.map((id) => [id, [] as DraftablePlayer[]]));

  it("awards a contested player to the best priority", () => {
    const result = resolveWaiverClaims({
      claims: [claim("c2", "team-b", "star"), claim("c1", "team-a", "star")],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    const winner = result.outcomes.find((o) => o.awarded);
    expect(winner?.teamId).toBe("team-a");
  });

  it("tells the loser why", () => {
    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star"), claim("c2", "team-b", "star")],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    const loser = result.outcomes.find((o) => o.teamId === "team-b");
    expect(loser?.awarded).toBe(false);
    expect(loser?.reason).toBe("PLAYER_TAKEN");
  });

  it("sends a winner to the back of the order", () => {
    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star")],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.priorityAfter).toEqual(["team-b", "team-c", "team-a"]);
  });

  it("leaves a losing team's priority untouched", () => {
    // A failed claim costs nothing, so there is no reason to hoard claims.
    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star"), claim("c2", "team-b", "star")],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.priorityAfter.indexOf("team-b")).toBe(0);
  });

  it("moves a team once however many claims it wins", () => {
    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star"), claim("c2", "team-a", "other")],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.outcomes.filter((o) => o.awarded)).toHaveLength(2);
    expect(result.priorityAfter).toEqual(["team-b", "team-c", "team-a"]);
  });

  it("orders multiple winners by the priority they had", () => {
    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star"), claim("c2", "team-b", "other")],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.priorityAfter).toEqual(["team-c", "team-a", "team-b"]);
  });

  it("applies the drop before checking room", () => {
    const full = Array.from({ length: SHAPE.totalSlots }, (_, i) => player(`p${i}`));
    const rosters = new Map([["team-a", full]]);

    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star", "p0")],
      priority: ["team-a"],
      rosters,
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.outcomes[0]?.awarded).toBe(true);
  });

  it("rejects a full roster with no drop", () => {
    const full = Array.from({ length: SHAPE.totalSlots }, (_, i) => player(`p${i}`));

    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star")],
      priority: ["team-a"],
      rosters: new Map([["team-a", full]]),
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.outcomes[0]).toMatchObject({ awarded: false, reason: "ROSTER_FULL" });
  });

  it("rejects dropping someone not on the roster", () => {
    const result = resolveWaiverClaims({
      claims: [claim("c1", "team-a", "star", "not-mine")],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.outcomes[0]).toMatchObject({
      awarded: false,
      reason: "DROP_NOT_ON_ROSTER",
    });
  });

  it("is independent of the order claims were submitted in", () => {
    // Blind claims must not reward being early. Same claims, shuffled input,
    // identical result.
    const claims = [
      claim("c1", "team-c", "star"),
      claim("c2", "team-a", "star"),
      claim("c3", "team-b", "other"),
    ];
    const args = { priority, rosters: emptyRosters, pool: POOL, shape: SHAPE };

    const forwards = resolveWaiverClaims({ ...args, claims });
    const backwards = resolveWaiverClaims({ ...args, claims: [...claims].reverse() });

    expect(
      forwards.outcomes
        .filter((o) => o.awarded)
        .map((o) => o.teamId)
        .sort(),
    ).toEqual(
      backwards.outcomes
        .filter((o) => o.awarded)
        .map((o) => o.teamId)
        .sort(),
    );
    expect(forwards.priorityAfter).toEqual(backwards.priorityAfter);
  });

  it("resolves nothing when there are no claims", () => {
    const result = resolveWaiverClaims({
      claims: [],
      priority,
      rosters: emptyRosters,
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.outcomes).toEqual([]);
    expect(result.priorityAfter).toEqual(priority);
  });
});

describe("initialWaiverPriority", () => {
  it("reverses the draft order", () => {
    // Whoever picked last claims first — the same balancing instinct the snake
    // applies within a round.
    expect(initialWaiverPriority(["a", "b", "c"])).toEqual(["c", "b", "a"]);
  });
});
