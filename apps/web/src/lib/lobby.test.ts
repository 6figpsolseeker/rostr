import { describe, expect, it } from "vitest";
import { buildLobbyView, pickLabel, picksForPosition, type LobbyInput } from "./lobby";

const SCHEDULED = new Date("2026-08-22T20:00:00-04:00");

function team(position: number | null, name: string, isBot = false) {
  return { teamId: `team-${name}`, name, isBot, position };
}

function input(overrides: Partial<LobbyInput> = {}): LobbyInput {
  return {
    leagueId: "11111111-1111-4111-8111-111111111111",
    rulesHash: "a".repeat(64),
    minHumans: 2,
    rounds: 14,
    scheduledAt: SCHEDULED,
    now: new Date(SCHEDULED.getTime() - 60_000),
    viewerTeamId: "team-Route 66",
    isCommissioner: true,
    commissionerTeamId: "team-Route 66",
    teams: [
      team(null, "Backfield Ballers"),
      team(null, "Hail Mary Inc."),
      team(null, "Route 66"),
    ],
    hasPot: false,
    unfundedMembers: 0,
    seasonStarted: false,
    draw: null,
    ...overrides,
  };
}

/**
 * A pot league that is ready in every respect except the one under test.
 *
 * Four teams, everyone staked, the draft time passed. Anything left is the
 * season start.
 */
const potReady = {
  teams: evenTeams(),
  hasPot: true,
  unfundedMembers: 0,
  now: new Date(SCHEDULED.getTime() + 1000),
  isCommissioner: true,
};

/** The start window is the draft time plus 48 hours — `START_GRACE_SECONDS`. */
const WINDOW_CLOSES = new Date(SCHEDULED.getTime() + 48 * 3600 * 1000);

/** An even field, so the readiness rules are not tripped incidentally. */
function evenTeams() {
  return [
    team(null, "Backfield Ballers"),
    team(null, "Hail Mary Inc."),
    team(null, "Route 66"),
    team(null, "Fourth Down"),
  ];
}

const drawn = {
  slot: 312_884_109,
  blockhash: "7Yk4mQtR9nDs2",
  seed: "b".repeat(64),
  drawnAt: new Date("2026-08-22T20:00:03-04:00"),
};

describe("pickLabel", () => {
  it("labels the snake by round and pick within it", () => {
    expect(pickLabel(1, 12)).toBe("1.01");
    expect(pickLabel(4, 12)).toBe("1.04");
    // Round 2 runs backwards: pick 21 overall is the fourth position's second.
    expect(pickLabel(21, 12)).toBe("2.09");
  });
});

describe("picksForPosition", () => {
  it("gives a position its own picks, reversing every round", () => {
    expect(picksForPosition(4, 12, 3)).toEqual([4, 21, 28]);
    expect(picksForPosition(1, 12, 2)).toEqual([1, 24]);
    expect(picksForPosition(12, 12, 2)).toEqual([12, 13]);
  });

  it("agrees with the label for every position in a round trip", () => {
    for (let position = 1; position <= 12; position++) {
      const [first] = picksForPosition(position, 12, 2);
      expect(pickLabel(first!, 12)).toBe(`1.${String(position).padStart(2, "0")}`);
    }
  });
});

describe("buildLobbyView", () => {
  it("is BEFORE_DRAW with no verification and no pick labels until the draw", () => {
    const view = buildLobbyView(input());

    expect(view.phase).toBe("BEFORE_DRAW");
    expect(view.verification).toBeNull();
    expect(view.yourPicks).toEqual([]);
    // The absence is the point: a seat carrying a pick number before the draw
    // would be the screen inventing the very thing it says cannot be known.
    expect(view.seats.every((seat) => seat.picks.length === 0)).toBe(true);
    expect(view.seats.every((seat) => seat.position === null)).toBe(true);
  });

  it("refuses the draw before the scheduled instant, and permits it after", () => {
    expect(buildLobbyView(input()).drawBlocker).toEqual({
      code: "TOO_EARLY",
      scheduledAt: SCHEDULED,
    });

    // An even field, because this is about the clock: the default fixture has
    // three teams, and an odd league is refused whatever the time says.
    const after = buildLobbyView(
      input({ now: new Date(SCHEDULED.getTime() + 1000), teams: evenTeams() }),
    );
    expect(after.drawBlocker).toBeNull();
  });

  it("refuses below minHumans, counting humans rather than seats", () => {
    const view = buildLobbyView(
      input({
        now: new Date(SCHEDULED.getTime() + 1000),
        minHumans: 3,
        teams: [team(null, "Route 66"), team(null, "Hail Mary Inc."), team(null, "Bot", true)],
      }),
    );

    expect(view.humans).toBe(2);
    expect(view.drawBlocker).toEqual({ code: "BELOW_MIN_HUMANS", humans: 2, required: 3 });
  });

  it("refuses a non-commissioner before it consults the clock", () => {
    // Order matters: a member looking at a league whose time has not come must
    // be told it is not their button, not that it is too early — the second
    // reads as "wait and it will work".
    const view = buildLobbyView(input({ isCommissioner: false }));
    expect(view.drawBlocker).toEqual({ code: "NOT_COMMISSIONER" });
  });

  it("reports ALREADY_DRAWN to the commissioner rather than a live button", () => {
    const view = buildLobbyView(
      input({ now: new Date(SCHEDULED.getTime() + 1000), draw: drawn }),
    );
    expect(view.drawBlocker).toEqual({ code: "ALREADY_DRAWN" });
  });

  it("derives the order, the pick labels and the verification from the draw", () => {
    const teams = [
      team(1, "Backfield Ballers"),
      team(2, "Hail Mary Inc."),
      team(3, "Pylon Co."),
      team(4, "Route 66"),
    ];
    const view = buildLobbyView(
      input({ teams, draw: drawn, now: new Date(SCHEDULED.getTime() + 4000), rounds: 14 }),
    );

    expect(view.phase).toBe("DRAWN");
    // Four teams, so round 2 runs 04 back to 01: position 1 picks 1st and 8th
    // overall, position 4 picks 4th and 5th — back to back on the turn.
    expect(view.seats[0]?.picks).toEqual(["1.01", "2.04"]);
    expect(view.seats[3]?.picks).toEqual(["1.04", "2.01"]);
    expect(view.yourPicks).toEqual([4, 5]);

    expect(view.verification?.slot).toBe(drawn.slot);
    expect(view.verification?.blockhash).toBe(drawn.blockhash);
    // Verbatim from @rostr/core, so the screen cannot drift from the recipe the
    // seed is actually derived by.
    expect(view.verification?.explanation).toContain(String(drawn.slot));
    expect(view.verification?.explanation).toContain("rostr:draft-order:v1");
  });

  it("marks the viewer's own seat and the commissioner's", () => {
    const view = buildLobbyView(input());
    const you = view.seats.find((seat) => seat.isYou);

    expect(you?.name).toBe("Route 66");
    expect(you?.isCommissioner).toBe(true);
    expect(view.seats.filter((seat) => seat.isYou)).toHaveLength(1);
  });

  it("has no viewer seat for someone who is not a member", () => {
    const view = buildLobbyView(input({ viewerTeamId: null, isCommissioner: false }));
    expect(view.seats.some((seat) => seat.isYou)).toBe(false);
    expect(view.yourPicks).toEqual([]);
  });
});

/**
 * The warning that has to arrive before the deadline.
 *
 * `drawBlocker` answers "why is the button dead", first reason wins, and before
 * the draft time it always answers `TOO_EARLY` — so on its own it would tell a
 * commissioner looking a week ahead at a five-team league nothing at all about
 * the thing that will stop them.
 *
 * That matters more here than it would anywhere else: migration `0028` locks the
 * field at `scheduledAt` on INSERT *and* DELETE, so once the draft time passes
 * nobody can join, nobody can leave, and no bot can square the field. The draw
 * can only refuse, and the league then fails and refunds everyone. This list is
 * the only thing that can prevent that.
 */
describe("readiness", () => {
  it("reports an odd field a week before the draft, when the blocker still says TOO_EARLY", () => {
    const view = buildLobbyView(input());

    expect(view.drawBlocker).toMatchObject({ code: "TOO_EARLY" });
    expect(view.readiness).toContainEqual({ code: "ODD_FIELD", teams: 3, canUseBot: true });
  });

  it("is empty for a league that is ready", () => {
    expect(buildLobbyView(input({ teams: evenTeams() })).readiness).toEqual([]);
  });

  it("reports every problem at once, not the first", () => {
    // They all have to be fixed by the same deadline, and finding out about the
    // second after solving the first may be finding out too late.
    const view = buildLobbyView(
      input({
        teams: [team(null, "Alone")],
        minHumans: 2,
        hasPot: true,
        unfundedMembers: 1,
      }),
    );

    expect(view.readiness.map((p) => p.code)).toEqual([
      "BELOW_MIN_HUMANS",
      "ODD_FIELD",
      "POT_NOT_FUNDED",
    ]);
  });

  it("says a bot can square a free league and cannot square a pot league", () => {
    // Completely different remedies — press a button, or find a person — so the
    // screen has to know which one it is asking for.
    const free = buildLobbyView(input({ hasPot: false })).readiness;
    expect(free).toContainEqual({ code: "ODD_FIELD", teams: 3, canUseBot: true });

    const pot = buildLobbyView(input({ hasPot: true })).readiness;
    expect(pot).toContainEqual({ code: "ODD_FIELD", teams: 3, canUseBot: false });
  });

  it("never asks a free league for stakes", () => {
    const view = buildLobbyView(
      input({ teams: evenTeams(), hasPot: false, unfundedMembers: 3 }),
    );
    expect(view.readiness).toEqual([]);
  });

  it("counts unfunded members of a pot league", () => {
    const view = buildLobbyView(
      input({ teams: evenTeams(), hasPot: true, unfundedMembers: 2 }),
    );
    expect(view.readiness).toEqual([{ code: "POT_NOT_FUNDED", unfunded: 2 }]);
  });
});

/**
 * And the button's own reasons, which must stay in the server's order.
 *
 * `drawDraftOrder` refuses in the order NO_TEAMS, BELOW_MIN_HUMANS, ODD_FIELD,
 * POT_NOT_FUNDED. A screen that named a different reason first than the server
 * would is the two-sources problem this repo keeps paying for.
 */
describe("drawBlocker, once the draft time has passed", () => {
  const atDrawTime = { now: new Date(SCHEDULED.getTime() + 1000), isCommissioner: true };

  it("blocks an odd field", () => {
    const view = buildLobbyView(input(atDrawTime));
    expect(view.drawBlocker).toEqual({ code: "ODD_FIELD", teams: 3 });
  });

  it("blocks a pot league that is not fully staked", () => {
    const view = buildLobbyView(
      input({ ...atDrawTime, teams: evenTeams(), hasPot: true, unfundedMembers: 1 }),
    );
    expect(view.drawBlocker).toEqual({ code: "POT_NOT_FUNDED", unfunded: 1 });
  });

  it("puts a short field ahead of a lopsided one, as the server does", () => {
    const view = buildLobbyView(
      input({ ...atDrawTime, teams: [team(null, "Alone")], minHumans: 2 }),
    );
    expect(view.drawBlocker).toMatchObject({ code: "BELOW_MIN_HUMANS" });
  });

  it("lets a ready league draw", () => {
    expect(buildLobbyView(input({ ...atDrawTime, teams: evenTeams() })).drawBlocker).toBeNull();
  });
});

/**
 * Declaring the season started, which is what shuts the escrow's failed-league
 * refund.
 *
 * `refund_stake` opens two ways and `League.started` is the only thing between
 * them, so a pot league that draws without it plays the whole season with an
 * escape hatch open: a member could withdraw their stake in week 3 and keep
 * playing for the pot. The draw refuses until it lands, and this is the screen's
 * copy of that rule.
 */
describe("seasonStart", () => {
  it("is NOT_REQUIRED for a free league, whatever else is true", () => {
    // A free league has no vault. Asking its commissioner for a wallet approval
    // that protects nothing would be a popup for its own sake.
    expect(buildLobbyView(input({ teams: evenTeams() })).seasonStart).toEqual({
      state: "NOT_REQUIRED",
    });
  });

  it("is OPEN and unblocked for a pot league that is ready", () => {
    const view = buildLobbyView(input(potReady));
    expect(view.seasonStart).toEqual({
      state: "OPEN",
      closesAt: WINDOW_CLOSES,
      blockedBy: [],
    });
  });

  it("closes 48 hours after the draft time, not after the draw", () => {
    // The deadline is `startDeadlineFor(scheduledAt)` — the same value the
    // anchor route compares the on-chain account against, so the screen and the
    // chain cannot mean different instants.
    const view = buildLobbyView(input(potReady));
    expect(view.seasonStart).toMatchObject({ closesAt: WINDOW_CLOSES });
  });

  it("is STARTED once the chain has been told", () => {
    const view = buildLobbyView(input({ ...potReady, seasonStarted: true }));
    expect(view.seasonStart).toEqual({ state: "STARTED" });
  });

  it("is MISSED from the deadline itself, matching the program's `<`", () => {
    // `start_season` requires `now < start_deadline`, so a button offered *at*
    // the deadline sends a transaction the chain rejects.
    const at = buildLobbyView(input({ ...potReady, now: WINDOW_CLOSES }));
    expect(at.seasonStart).toEqual({ state: "MISSED", closedAt: WINDOW_CLOSES });

    const justBefore = buildLobbyView(
      input({ ...potReady, now: new Date(WINDOW_CLOSES.getTime() - 1000) }),
    );
    expect(justBefore.seasonStart).toMatchObject({ state: "OPEN" });
  });

  it("stays STARTED past the deadline", () => {
    // Nothing unsets `started`, so the window closing does not un-start a season
    // that began. A view that flipped to MISSED here would tell a live league
    // its money was refundable.
    const view = buildLobbyView(
      input({ ...potReady, seasonStarted: true, now: WINDOW_CLOSES }),
    );
    expect(view.seasonStart).toEqual({ state: "STARTED" });
  });
});

/**
 * And it is refused while anything else is outstanding, which is not a
 * courtesy: marking a league started closes the failed-league refund
 * permanently, so doing it to a league that then cannot draw converts a
 * two-day wait into a wait of months on money nobody will ever play for.
 */
describe("seasonStart.blockedBy", () => {
  it("waits for the field to lock", () => {
    // Before the draft time somebody can still join and not stake, so "ready" is
    // not yet a settled fact about this league.
    const view = buildLobbyView(input({ ...potReady, now: new Date(SCHEDULED.getTime() - 1) }));
    expect(view.seasonStart).toMatchObject({ blockedBy: ["TOO_EARLY"] });
  });

  it("waits for every member to stake", () => {
    const view = buildLobbyView(input({ ...potReady, unfundedMembers: 2 }));
    expect(view.seasonStart).toMatchObject({ blockedBy: ["POT_NOT_FUNDED"] });
  });

  it("reports every outstanding condition, not the first", () => {
    // They all have to hold and the button cannot be un-pressed, so learning
    // about the second one after fixing the first may be learning too late.
    const view = buildLobbyView(
      input({
        ...potReady,
        teams: [team(null, "Alone")],
        unfundedMembers: 1,
        now: new Date(SCHEDULED.getTime() - 1),
      }),
    );
    expect(view.seasonStart).toMatchObject({
      blockedBy: ["TOO_EARLY", "BELOW_MIN_HUMANS", "ODD_FIELD", "POT_NOT_FUNDED"],
    });
  });
});

/**
 * The draw's own view of the same fact, which has to stay in the server's
 * order — `drawDraftOrder` checks the season start **last**, after the field
 * and the funding.
 */
describe("drawBlocker and the season start", () => {
  it("blocks a ready pot league that has not started its season", () => {
    const view = buildLobbyView(input(potReady));
    expect(view.drawBlocker).toEqual({
      code: "SEASON_NOT_STARTED",
      closesAt: WINDOW_CLOSES,
    });
  });

  it("lets a started pot league draw", () => {
    const view = buildLobbyView(input({ ...potReady, seasonStarted: true }));
    expect(view.drawBlocker).toBeNull();
  });

  it("never asks a free league to start a season", () => {
    expect(buildLobbyView(input({ ...potReady, hasPot: false })).drawBlocker).toBeNull();
  });

  it("names the unpaid member ahead of the season start, as the server does", () => {
    // The more useful fact, and the one that has to be fixed first — pressing
    // start on this league would freeze the stakes that *were* paid.
    const view = buildLobbyView(input({ ...potReady, unfundedMembers: 1 }));
    expect(view.drawBlocker).toEqual({ code: "POT_NOT_FUNDED", unfunded: 1 });
  });

  it("reports a missed window as its own reason, not as 'not started'", () => {
    // One is "press this next" and the other is "this league is over". A single
    // code would leave the screen inviting a transaction the chain refuses.
    const view = buildLobbyView(input({ ...potReady, now: WINDOW_CLOSES }));
    expect(view.drawBlocker).toEqual({
      code: "START_WINDOW_MISSED",
      closedAt: WINDOW_CLOSES,
    });
  });
});

describe("readiness and a missed start window", () => {
  it("tells everybody, not only the commissioner", () => {
    // `DrawControl` renders nothing at all for a member, so without this a
    // member's only signal that their money is sitting refundable in a league
    // that will never play would be a draft that silently never happens.
    const view = buildLobbyView(input({ ...potReady, now: WINDOW_CLOSES }));
    expect(view.readiness).toEqual([{ code: "START_WINDOW_MISSED", closedAt: WINDOW_CLOSES }]);
  });

  it("puts it first, ahead of problems that no longer matter", () => {
    const view = buildLobbyView(
      input({ ...potReady, teams: [team(null, "Alone")], now: WINDOW_CLOSES }),
    );
    expect(view.readiness[0]).toMatchObject({ code: "START_WINDOW_MISSED" });
  });

  it("says nothing while the window is still open", () => {
    // A pot league that simply has not pressed the button yet is not a league in
    // trouble, and an amber panel on every lobby would train people to ignore it.
    expect(buildLobbyView(input(potReady)).readiness).toEqual([]);
  });
});
