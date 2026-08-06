import { describe, expect, it, vi } from "vitest";
import { Tank01Client } from "./client.js";
import { DST_REF_PREFIX, Tank01Provider } from "./adapter.js";

/**
 * Player records shaped exactly as `getNFLPlayerList` returns them, including
 * the position codes it actually uses — verified against the live endpoint.
 */
const REAL_PLAYERS = [
  { playerID: "4040715", longName: "Jalen Hurts", pos: "QB", team: "PHI" },
  { playerID: "3929630", longName: "Saquon Barkley", pos: "RB", team: "PHI" },
  { playerID: "4362628", longName: "Ja'Marr Chase", pos: "WR", team: "CIN" },
  { playerID: "3121023", longName: "Dallas Goedert", pos: "TE", team: "PHI" },
  // The one that bit: Tank01 says PK, not K.
  { playerID: "3953687", longName: "Brandon Aubrey", pos: "PK", team: "DAL" },
  // Fullbacks are RBs in fantasy; Tank01's own ADP ranks this player "RB90".
  { playerID: "16002", longName: "Kyle Juszczyk", pos: "FB", team: "SF" },
  // Never rosterable — we start a defense as a unit, not individual defenders.
  { playerID: "111", longName: "Some Linebacker", pos: "LB", team: "PHI" },
  { playerID: "222", longName: "Some Punter", pos: "P", team: "PHI" },
  { playerID: "333", longName: "Some Tackle", pos: "OT", team: "PHI" },
  { playerID: "444", longName: "Free Agent Guy", pos: "WR", team: "FA", isFreeAgent: "True" },
];

const REAL_TEAMS = [
  {
    teamAbv: "PHI",
    teamCity: "Philadelphia",
    teamName: "Eagles",
    byeWeeks: { "2026": ["14"] },
  },
  { teamAbv: "DAL", teamCity: "Dallas", teamName: "Cowboys", byeWeeks: { "2026": ["10"] } },
];

function fakeClient(responses: Record<string, unknown>): Tank01Client {
  const fetchImpl = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace(/^\//, "");
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ body: responses[path] ?? [] }),
      text: () => Promise.resolve(""),
    } as unknown as Response;
  });

  return new Tank01Client({ apiKey: "test", fetchImpl: fetchImpl as unknown as typeof fetch });
}

const provider = (responses: Record<string, unknown>): Tank01Provider =>
  new Tank01Provider(fakeClient(responses));

describe("listPlayers position mapping", () => {
  const subject = provider({ getNFLPlayerList: REAL_PLAYERS, getNFLTeams: REAL_TEAMS });

  it("maps PK to K — Tank01 does not use 'K'", async () => {
    // Regression guard. Filtering on "K" silently dropped all 69 kickers, and
    // since every league starts one, no team could field a legal lineup.
    const players = await subject.listPlayers(2026);
    const aubrey = players.find((p) => p.externalRef === "3953687");

    expect(aubrey?.positions).toEqual(["K"]);
  });

  it("maps FB to RB", async () => {
    const players = await subject.listPlayers(2026);
    expect(players.find((p) => p.externalRef === "16002")?.positions).toEqual(["RB"]);
  });

  it("keeps every position a league can start", async () => {
    const players = await subject.listPlayers(2026);
    const positions = new Set(players.flatMap((p) => p.positions));

    for (const required of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
      expect(positions, `no ${required} in the pool`).toContain(required);
    }
  });

  it("drops positions no league rosters", async () => {
    const players = await subject.listPlayers(2026);
    const refs = players.map((p) => p.externalRef);

    expect(refs).not.toContain("111"); // LB
    expect(refs).not.toContain("222"); // P
    expect(refs).not.toContain("333"); // OT
  });

  it("synthesises a team defense per team", async () => {
    // Tank01 has no player record for a D/ST, but leagues roster them.
    const players = await subject.listPlayers(2026);
    const defenses = players.filter((p) => p.positions.includes("DEF"));

    expect(defenses).toHaveLength(2);
    expect(defenses.map((d) => d.externalRef).sort()).toEqual([
      `${DST_REF_PREFIX}DAL`,
      `${DST_REF_PREFIX}PHI`,
    ]);
    expect(defenses.find((d) => d.externalRef.endsWith("PHI"))?.fullName).toBe(
      "Philadelphia Eagles",
    );
  });

  it("marks free agents inactive and clears their team", async () => {
    const players = await subject.listPlayers(2026);
    const freeAgent = players.find((p) => p.externalRef === "444");

    expect(freeAgent?.active).toBe(false);
    expect(freeAgent?.teamRef).toBeNull();
  });
});

describe("listByeWeeks", () => {
  it("reads the season's bye from the per-season map", async () => {
    const subject = provider({ getNFLTeams: REAL_TEAMS });
    const byes = await subject.listByeWeeks(2026);

    expect(byes.get("PHI")).toBe(14);
    expect(byes.get("DAL")).toBe(10);
  });

  it("omits teams with no bye recorded for that season", async () => {
    const subject = provider({ getNFLTeams: REAL_TEAMS });
    expect((await subject.listByeWeeks(2030)).size).toBe(0);
  });
});

describe("listAdp", () => {
  it("scales ADP to integer milli-units", async () => {
    // "3.2" -> 3200. Integers everywhere, same reason as scoring.
    const subject = provider({
      getNFLADP: {
        adpDate: "20260805",
        adpType: "PPR",
        adpList: [
          { playerID: "1", longName: "Jahmyr Gibbs", overallADP: "3.2", posADP: "RB1" },
        ],
      },
    });

    const board = await subject.listAdp();
    expect(board.entries[0]?.overallMilli).toBe(3200);
    expect(board.entries[0]?.positionRank).toBe("RB1");
  });

  it("formats the provider's YYYYMMDD date", async () => {
    const subject = provider({
      getNFLADP: { adpDate: "20260805", adpType: "PPR", adpList: [] },
    });
    expect((await subject.listAdp()).asOf).toBe("2026-08-05");
  });

  it("drops entries with no usable ADP", async () => {
    const subject = provider({
      getNFLADP: {
        adpDate: "20260805",
        adpList: [
          { playerID: "1", overallADP: "3.2" },
          { playerID: "2", overallADP: "" },
          { playerID: "3", overallADP: "0" },
          { overallADP: "5.0" },
        ],
      },
    });
    expect((await subject.listAdp()).entries).toHaveLength(1);
  });
});

describe("listGames", () => {
  it("parses the week number out of Tank01's wording", async () => {
    const subject = provider({
      getNFLGamesForWeek: [
        {
          gameID: "20250904_DAL@PHI",
          gameWeek: "Week 1",
          home: "PHI",
          away: "DAL",
          gameTime_epoch: "1757031600.0",
          gameStatus: "Final",
        },
      ],
    });

    const [game] = await subject.listGames(2025, 1);
    expect(game).toMatchObject({
      externalRef: "20250904_DAL@PHI",
      week: 1,
      homeTeamRef: "PHI",
      awayTeamRef: "DAL",
      kickoffAt: 1_757_031_600,
      status: "FINAL",
    });
  });

  it("maps game statuses we act on", async () => {
    const statuses = [
      ["Final", "FINAL"],
      ["Live - In Progress", "IN_PROGRESS"],
      ["Postponed", "POSTPONED"],
      ["Scheduled", "SCHEDULED"],
    ] as const;

    for (const [raw, expected] of statuses) {
      const subject = provider({
        getNFLGamesForWeek: [
          {
            gameID: "g",
            gameWeek: "Week 1",
            home: "A",
            away: "B",
            gameTime_epoch: "1757031600.0",
            gameStatus: raw,
          },
        ],
      });
      const [game] = await subject.listGames(2025, 1);
      expect(game?.status, `${raw} should map to ${expected}`).toBe(expected);
    }
  });
});
