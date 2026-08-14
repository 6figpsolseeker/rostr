import { describe, expect, it } from "vitest";
import { NFL } from "../sports/nfl.js";
import { NFL_DEFAULT_WAIVERS, NFL_PPR_ROSTER } from "../rules/nfl-ppr.js";
import { buildRosterShape } from "../draft/roster.js";
import type { DraftablePlayer } from "../draft/roster.js";
import {
  availabilityAt,
  dropDestination,
  everyoneIsOnWaivers,
  nextProcessingAt,
  nextWeeklyLockAt,
  waiverClearsAt,
} from "./schedule.js";
import { initialWaiverPriority, resolveWaiverClaims } from "./claims.js";
import type { WaiverClaim, WaiverResolution } from "./claims.js";

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

describe("RULES.md §6 — every unrostered player returns to waivers on Tuesday", () => {
  // Week 2 of 2026, EDT throughout. The cycle §6 describes:
  //   Tue 00:00 -> Wed 03:00  waivers, claims only
  //   Wed 03:00 -> Tue 00:00  free agency, first come first served
  const TUE_LOCK = new Date("2026-09-15T04:00:00Z"); // Tue 00:00 EDT
  const WED_RUN = new Date("2026-09-16T07:00:00Z"); // Wed 03:00 EDT

  it("locks the pool from the Tuesday boundary", () => {
    expect(everyoneIsOnWaivers(new Date(TUE_LOCK.getTime() - 1), RULES)).toBe(false);
    expect(everyoneIsOnWaivers(TUE_LOCK, RULES)).toBe(true);
  });

  it("reopens it at the processing run, not after it", () => {
    // Half-open, `[lock, run)`. The run itself must be outside the window:
    // `processWaivers` executes *at* this instant, and its claims resolve
    // against a pool that has already reopened — otherwise the run would be
    // reasoning about a lock it is in the act of lifting.
    expect(everyoneIsOnWaivers(new Date(WED_RUN.getTime() - 1), RULES)).toBe(true);
    expect(everyoneIsOnWaivers(WED_RUN, RULES)).toBe(false);
  });

  it("leaves the rest of the week open", () => {
    // Thursday, Sunday, and the Monday night that makes this rule matter: a
    // breakout is claimed by priority on Wednesday, not taken by whoever is
    // refreshing fastest on Sunday.
    for (const instant of [
      "2026-09-17T18:00:00Z",
      "2026-09-20T20:00:00Z",
      "2026-09-15T02:00:00Z",
    ]) {
      expect(everyoneIsOnWaivers(new Date(instant), RULES)).toBe(false);
    }
  });

  it("follows the timezone rather than a fixed offset", () => {
    // The lock is a weekday and a local hour, so it moves with the November DST
    // change instead of sliding an hour through it. Tue 00:00 EST is 05:00Z.
    const novLock = new Date("2026-11-17T05:00:00Z");
    expect(everyoneIsOnWaivers(new Date(novLock.getTime() - 1), RULES)).toBe(false);
    expect(everyoneIsOnWaivers(novLock, RULES)).toBe(true);
  });
});

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

/** Wednesday 03:00 ET — the processing instant — plus n minutes. */
const AT = (minutes: number): Date => new Date(Date.UTC(2026, 8, 16, 7, minutes));

// `submittedAt` defaults to one shared instant, so every test that does not care
// about filing order ties there and falls through to `claimId` exactly as it did
// before that term existed.
const claim = (
  claimId: string,
  teamId: string,
  addPlayerId: string,
  dropPlayerId: string | null = null,
  submittedAt: Date = AT(0),
): WaiverClaim => ({ claimId, teamId, addPlayerId, dropPlayerId, submittedAt });

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

  it("tries a team's own claims in the order the team filed them", () => {
    // One open spot, two claims. The claim ids are chosen so `c9` sorts *after*
    // `c1`: an id-only tiebreak awards "other" and fails "star", so this fails
    // deterministically rather than half the time.
    const nearlyFull = Array.from({ length: SHAPE.totalSlots - 1 }, (_, i) => player(`p${i}`));

    const result = resolveWaiverClaims({
      claims: [
        claim("c9", "team-a", "star", null, AT(1)),
        claim("c1", "team-a", "other", null, AT(2)),
      ],
      priority,
      rosters: new Map([["team-a", nearlyFull]]),
      pool: POOL,
      shape: SHAPE,
    });

    expect(result.outcomes.filter((o) => o.awarded).map((o) => o.addPlayerId)).toEqual(["star"]);
    expect(result.outcomes.find((o) => o.addPlayerId === "other")).toMatchObject({
      awarded: false,
      reason: "ROSTER_FULL",
    });
  });

  it("does not let one team's filing order decide a rival's claim by chance", () => {
    // The reason this is a defect and not a preference. team-a outranks team-b
    // and has one spot; it filed for "star" first, so "other" must still be on
    // the board when team-b's claim is tried. Order team-a's own claims the
    // other way and team-b is awarded nothing — a coin flip deciding the
    // outcome of a team that is not party to it.
    const nearlyFull = Array.from({ length: SHAPE.totalSlots - 1 }, (_, i) => player(`p${i}`));

    const result = resolveWaiverClaims({
      claims: [
        claim("c9", "team-a", "star", null, AT(1)),
        claim("c1", "team-a", "other", null, AT(2)),
        claim("c5", "team-b", "other", null, AT(3)),
      ],
      priority,
      rosters: new Map([...emptyRosters, ["team-a", nearlyFull]]),
      pool: POOL,
      shape: SHAPE,
    });

    const awarded = new Map(
      result.outcomes.filter((o) => o.awarded).map((o) => [o.addPlayerId, o.teamId]),
    );
    expect(awarded.get("star")).toBe("team-a");
    expect(awarded.get("other")).toBe("team-b");
  });

  it("is independent of the order the claims are passed in", () => {
    // Not the order they were *submitted* in — a team's own claims are tried in
    // filing order, so submission time is an input and it decides things. What
    // must never matter is the order the array happens to arrive in, which is
    // database row order: a resolution that moved with it would not be
    // replayable. team-a files twice deliberately — the version of this test
    // that predated intra-team ordering used one claim per team and compared
    // only the awarded team ids, so it could not have caught the bug it was
    // named after.
    const claims = [
      claim("c1", "team-c", "star", null, AT(3)),
      claim("c2", "team-a", "star", null, AT(2)),
      claim("c3", "team-a", "other", null, AT(1)),
      claim("c4", "team-b", "third", null, AT(4)),
    ];
    const args = { priority, rosters: emptyRosters, pool: POOL, shape: SHAPE };

    const forwards = resolveWaiverClaims({ ...args, claims });
    const backwards = resolveWaiverClaims({ ...args, claims: [...claims].reverse() });

    const key = (r: WaiverResolution): string =>
      JSON.stringify([...r.outcomes].sort((x, y) => x.claimId.localeCompare(y.claimId)));

    expect(key(forwards)).toEqual(key(backwards));
    expect(forwards.priorityAfter).toEqual(backwards.priorityAfter);
  });

  it("falls back to the claim id when a team files twice in the same instant", () => {
    // The residue, pinned rather than hoped about: two claims that tie on time
    // still order totally, so the result cannot ride on `sort` stability.
    const nearlyFull = Array.from({ length: SHAPE.totalSlots - 1 }, (_, i) => player(`p${i}`));
    const same = AT(7);
    const claims = [
      claim("c9", "team-a", "star", null, same),
      claim("c1", "team-a", "other", null, same),
    ];
    const args = { priority, rosters: new Map([["team-a", nearlyFull]]), pool: POOL, shape: SHAPE };

    const forwards = resolveWaiverClaims({ ...args, claims });
    const backwards = resolveWaiverClaims({ ...args, claims: [...claims].reverse() });

    const won = (r: WaiverResolution): string | undefined =>
      r.outcomes.find((o) => o.awarded)?.claimId;

    expect(won(forwards)).toBe("c1");
    expect(won(backwards)).toBe("c1");
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
