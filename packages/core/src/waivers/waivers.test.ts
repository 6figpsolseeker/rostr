import { describe, expect, it } from "vitest";
import { NFL } from "../sports/nfl.js";
import { NFL_DEFAULT_WAIVERS, NFL_PPR_ROSTER } from "../rules/nfl-ppr.js";
import { buildRosterShape } from "../draft/roster.js";
import type { DraftablePlayer, RosterShape } from "../draft/roster.js";
import {
  availabilityAt,
  dropDestination,
  everyoneIsOnWaivers,
  latestWeekly,
  nextProcessingAt,
  nextWeeklyLockAt,
  waiverClearsAt,
} from "./schedule.js";
import { initialWaiverPriority, resolveWaiverClaims } from "./claims.js";
import type { WaiverClaim, WaiverResolution } from "./claims.js";

/** No stashed players. Every case here is about priority and capacity, not IR. */
const NO_IR: ReadonlySet<string> = new Set();

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

describe("the week before a weekly lock is not always 168 hours", () => {
  // US clocks go back on Sunday 1 November 2026, so the Tuesday locks either
  // side of it are 169 hours apart:
  //   2026-10-27T04:00Z (Tue 00:00 EDT) -> 2026-11-03T05:00Z (Tue 00:00 EST)
  // Both callers used to find "the most recent lock" by asking `nextWeekly` from
  // exactly `now - 7 * 24h`. That lands *on* the earlier lock, and `nextWeekly`
  // is strictly-after, so it skipped it and answered with a lock in the future.
  const OCT_LOCK = new Date("2026-10-27T04:00:00Z");
  const NOV_LOCK = new Date("2026-11-03T05:00:00Z");

  it("has a 169-hour gap across the fall-back", () => {
    expect(nextWeeklyLockAt(new Date("2026-10-26T12:00:00Z"), RULES)).toEqual(OCT_LOCK);
    expect(nextWeeklyLockAt(new Date("2026-11-02T12:00:00Z"), RULES)).toEqual(NOV_LOCK);
    expect(NOV_LOCK.getTime() - OCT_LOCK.getTime()).toBe(169 * 3600 * 1000);
  });

  it("still names the October lock in the hour a 168-hour lookback loses", () => {
    // Monday 2 November, 23:00-23:59 ET. Across that whole hour `now - 168h`
    // lands at or after OCT_LOCK, so a strictly-after search from there skips
    // the lock it was supposed to find and returns the November one instead.
    for (const iso of [
      "2026-11-03T04:00:00Z",
      "2026-11-03T04:30:00Z",
      "2026-11-03T04:59:59Z",
    ]) {
      const now = new Date(iso);
      expect(now.getTime() - 7 * 24 * 3600 * 1000, iso).toBeGreaterThanOrEqual(
        OCT_LOCK.getTime(),
      );

      expect(latestWeekly(now, RULES.weeklyLock, RULES.timezone), iso).toEqual(OCT_LOCK);
    }
  });

  it("keeps free agency open until the lock actually arrives", () => {
    // The consequence, and the reason this is a rule and not a rounding error:
    // §6 opens free agency from Wednesday 03:00 to Tuesday 00:00, and Monday
    // night is when Monday Night Football is being played.
    for (const iso of [
      "2026-11-03T03:59:59Z", // Mon 22:59 ET
      "2026-11-03T04:00:00Z", // Mon 23:00 ET — was reported ON_WAIVERS
      "2026-11-03T04:59:59Z", // Mon 23:59 ET
    ]) {
      expect(everyoneIsOnWaivers(new Date(iso), RULES), iso).toBe(false);
    }

    expect(everyoneIsOnWaivers(NOV_LOCK, RULES)).toBe(true);
  });

  it("returns the moment itself when now is exactly on it", () => {
    // "At or before", not "strictly before" — the lock instant belongs to the
    // cycle it opens.
    expect(latestWeekly(NOV_LOCK, RULES.weeklyLock, RULES.timezone)).toEqual(NOV_LOCK);
    expect(
      latestWeekly(new Date(NOV_LOCK.getTime() - 1), RULES.weeklyLock, RULES.timezone),
    ).toEqual(OCT_LOCK);
  });

  it("holds across the spring-forward, where the gap is 167 hours", () => {
    // The other direction, in case anyone is tempted to hardcode 169.
    const before = new Date("2027-03-09T05:00:00Z"); // Tue 00:00 EST
    const after = new Date("2027-03-16T04:00:00Z"); // Tue 00:00 EDT

    expect(after.getTime() - before.getTime()).toBe(167 * 3600 * 1000);
    expect(
      latestWeekly(new Date(after.getTime() - 1), RULES.weeklyLock, RULES.timezone),
    ).toEqual(before);

    // And the mirror of the November hole, which the 168-hour lookback also had
    // and in the other direction: half an hour *into* the new lock, `now - 168h`
    // falls before the previous one, so the old trick answered with the stale
    // cycle and left the pool open while it should have been shut.
    const justInside = new Date(after.getTime() + 30 * 60 * 1000);
    expect(latestWeekly(justInside, RULES.weeklyLock, RULES.timezone)).toEqual(after);
    expect(everyoneIsOnWaivers(justInside, RULES)).toBe(true);
  });

  it("never answers with a moment in the future", () => {
    // The whole class of bug rather than the two instants that expose it, swept
    // hourly across both transitions — the only places the property can break.
    // Deliberately not swept across the whole season: `schedule.ts` builds a
    // fresh `Intl.DateTimeFormat` per probe, so a season-long fine grid costs
    // minutes for coverage of weeks where every gap is exactly 168 hours.
    for (const [from, days] of [
      ["2026-10-27T00:00:00Z", 10], // fall-back, 1 Nov 2026
      ["2027-03-07T00:00:00Z", 11], // spring-forward, 14 Mar 2027
    ] as const) {
      const start = new Date(from).getTime();

      for (let hour = 0; hour < 24 * days; hour++) {
        const now = new Date(start + hour * 3600 * 1000);
        const lock = latestWeekly(now, RULES.weeklyLock, RULES.timezone);

        expect(lock.getTime(), now.toISOString()).toBeLessThanOrEqual(now.getTime());
        // And it is the *most recent* one: the next is genuinely after `now`.
        expect(nextWeeklyLockAt(lock, RULES).getTime(), now.toISOString()).toBeGreaterThan(
          now.getTime(),
        );
      }
    }
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
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
      irExempt: NO_IR,
    });

    expect(result.outcomes.filter((o) => o.awarded).map((o) => o.addPlayerId)).toEqual([
      "star",
    ]);
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
      irExempt: NO_IR,
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
    const args = { priority, rosters: emptyRosters, pool: POOL, shape: SHAPE, irExempt: NO_IR };

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
    const args = {
      priority,
      rosters: new Map([["team-a", nearlyFull]]),
      pool: POOL,
      shape: SHAPE,
      irExempt: NO_IR,
    };

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
      irExempt: NO_IR,
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

describe("injured reserve and the roster limit — #237", () => {
  /*
    `addFreeAgent` subtracted genuinely-stashed players from the capacity
    comparison and this resolver did not, so a signed `irSlots` allowance bought
    room in the first-come market and none in the priority-allocated one — the
    market `RULES.md` §6 exists to make fair.

    The shape below is the one the fix turns on: the exemption is counted
    against the roster the drop would leave, never decided in advance.
  */

  /** `n` players, ids `p0…`, all WR so nothing about matching is in play. */
  const held = (n: number): DraftablePlayer[] =>
    Array.from({ length: n }, (_, i) => ({
      playerId: `p${i}`,
      positions: ["WR"],
      rank: i + 1,
    }));

  const shapeOf = (totalSlots: number, irSlots: number): RosterShape => ({
    starters: [],
    benchSlots: totalSlots,
    irSlots,
    totalSlots,
  });

  function run(
    roster: DraftablePlayer[],
    irExempt: ReadonlySet<string>,
    shape: RosterShape,
    dropPlayerId: string | null = null,
  ) {
    const target: DraftablePlayer = { playerId: "wanted", positions: ["WR"], rank: 99 };
    return resolveWaiverClaims({
      claims: [
        {
          claimId: "c1",
          teamId: "team-a",
          addPlayerId: "wanted",
          dropPlayerId,
          submittedAt: new Date("2026-09-15T12:00:00Z"),
        },
      ],
      priority: ["team-a"],
      rosters: new Map([["team-a", roster]]),
      pool: new Map([...roster, target].map((p) => [p.playerId, p])),
      shape,
      irExempt,
    }).outcomes[0];
  }

  it("awards a claim to a team whose only spare room is an IR exemption", () => {
    /*
      The defect, at its smallest. Fourteen rows, one genuinely stashed, so the
      team counts thirteen of fourteen — `addFreeAgent` allows the pickup and
      this refused the claim.
    */
    const outcome = run(held(14), new Set(["p0"]), shapeOf(14, 2));

    expect(outcome?.awarded).toBe(true);
  });

  it("still refuses a team that is genuinely full", () => {
    // No stash, no exemption, no change. The fix must not widen the limit.
    const outcome = run(held(14), new Set(), shapeOf(14, 2));

    expect(outcome).toMatchObject({ awarded: false, reason: "ROSTER_FULL" });
  });

  it("counts the exemption against the roster the drop would leave", () => {
    /*
      **The case a precomputed count gets backwards.**

      Sixteen rows: fourteen counted plus two stashed, which is the maximal legal
      roster. The claim drops one of the stashed pair. Deciding the exemption
      before the drop leaves it at two, so fifteen minus two reads thirteen and
      the claim is awarded — putting a fifteenth counted player into fourteen
      slots.

      Dropping a stashed player frees an IR slot, not a roster slot. Recomputing
      after the drop gives one exemption, fifteen minus one is fourteen, and the
      claim is correctly refused.
    */
    const outcome = run(held(16), new Set(["p0", "p1"]), shapeOf(14, 2), "p0");

    expect(outcome?.awarded).toBe(false);
  });

  it("says so when the drop was the stashed player", () => {
    // The mistake the fix makes likely: once claims start working, "drop the
    // injured one" is the natural move and the one that frees nothing.
    const outcome = run(held(16), new Set(["p0", "p1"]), shapeOf(14, 2), "p0");

    expect(outcome?.reason).toBe("DROP_ON_IR");
  });

  it("awards the same claim when the drop is a counted player", () => {
    // The other half of the pair: dropping somebody who was occupying a counted
    // slot does free one.
    const outcome = run(held(16), new Set(["p0", "p1"]), shapeOf(14, 2), "p5");

    expect(outcome?.awarded).toBe(true);
  });

  it("caps the exemption at the slots the rules grant", () => {
    /*
      Three stashed against two slots. Being injured is a condition of occupying
      a slot, not a way to conjure more of them — so the team counts fifteen of
      fourteen and is refused, rather than counting thirteen.
    */
    // Sixteen rows, three stashed against two slots. Capped: two exempt, so
    // fourteen counted and the claim is refused. Uncapped: three exempt reads
    // thirteen and it is awarded. Seventeen rows would refuse either way, which
    // is why the numbers here are what they are.
    const outcome = run(held(16), new Set(["p0", "p1", "p2"]), shapeOf(14, 2));

    expect(outcome?.awarded).toBe(false);
  });

  it("exempts nobody for a player who is not on the roster it is counting", () => {
    /*
      The set is league-wide and the count intersects it with the array being
      counted. A stashed player who is missing from that array — absent from the
      draft board, say — must not be subtracted, or an unrelated gap conjures a
      roster slot.
    */
    const outcome = run(held(14), new Set(["somebody-else"]), shapeOf(14, 2));

    expect(outcome).toMatchObject({ awarded: false, reason: "ROSTER_FULL" });
  });

  it("changes nothing for a league whose rules grant no IR", () => {
    // `irSlots: 0` must be byte-identical to the behaviour before the fix, even
    // if somebody is flagged.
    const outcome = run(held(14), new Set(["p0"]), shapeOf(14, 0));

    expect(outcome).toMatchObject({ awarded: false, reason: "ROSTER_FULL" });
  });
});
