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
    draw: null,
    ...overrides,
  };
}

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
