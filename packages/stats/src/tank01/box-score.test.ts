import { describe, expect, it } from "vitest";
import { indexScoringRules, NFL_PPR_SCORING, scorePlayer } from "@rostr/core";
import type { StatLine } from "@rostr/core";
import { translateBoxScore } from "./box-score.js";
import rawBoxScore from "./__fixtures__/box-score.json" with { type: "json" };

/**
 * Tests run against a **real captured box score** — Cowboys at Eagles, the 2025
 * season opener. Every expected value below was read off the actual game, not
 * invented, so these catch mapping mistakes that hand-written fixtures cannot.
 */
const box = translateBoxScore(rawBoxScore);
const RULES = indexScoringRules(NFL_PPR_SCORING);

/** Tank01 player IDs, from the fixture. */
const HURTS = "4040715";
const BARKLEY = "3929630";
const AUBREY = "3953687";
const GOEDERT = "3121023";
const SANDERS = "4045163";

const statsFor = (playerID: string): Map<string, number> =>
  new Map((box.players.get(playerID) ?? []).map((line) => [line.statKey, line.value]));

describe("translateBoxScore", () => {
  it("identifies the game", () => {
    expect(box.gameRef).toBe("20250904_DAL@PHI");
  });

  it("translates every player who recorded a stat", () => {
    expect(box.players.size).toBeGreaterThan(50);
  });

  it("reconciles cleanly — no warnings on a real game", () => {
    // The field goal cross-check lives here. Any mismatch between parsed
    // distances and Kicking.fgMade surfaces as a warning.
    expect(box.warnings).toEqual([]);
  });
});

describe("offensive stats", () => {
  it("reads Jalen Hurts' real line", () => {
    // Verified against the box score: 152 passing yards, 0 passing TD,
    // 2 rushing TD, 62 rushing yards.
    const hurts = statsFor(HURTS);
    expect(hurts.get("pass_yd")).toBe(152);
    expect(hurts.get("rush_td")).toBe(2);
    expect(hurts.get("pass_td")).toBeUndefined();
  });

  it("reads Saquon Barkley's rushing touchdown", () => {
    expect(statsFor(BARKLEY).get("rush_td")).toBe(1);
  });

  it("reads Dallas Goedert's receptions", () => {
    // 7 receptions, 44 yards — full PPR makes receptions load-bearing.
    const goedert = statsFor(GOEDERT);
    expect(goedert.get("rec")).toBe(7);
    expect(goedert.get("rec_yd")).toBe(44);
  });

  it("finds a lost fumble under Defense, where Tank01 puts it", () => {
    // Miles Sanders is an offensive player. His lost fumble lives in the
    // Defense category — the single most counter-intuitive thing in this API.
    expect(statsFor(SANDERS).get("fum_lost")).toBe(1);
  });
});

describe("kicking", () => {
  it("buckets Brandon Aubrey's field goals by real distance", () => {
    // He kicked 41 and 53 yards. Counts alone would have scored both as
    // sub-40, which is exactly the bug distance parsing exists to prevent.
    const aubrey = statsFor(AUBREY);
    expect(aubrey.get("fg_40_49")).toBe(1);
    expect(aubrey.get("fg_50_plus")).toBe(1);
    expect(aubrey.get("fg_0_39")).toBeUndefined();
  });

  it("reads extra points from the direct field", () => {
    expect(statsFor(AUBREY).get("xp_made")).toBe(2);
  });

  it("scores Aubrey correctly end to end", () => {
    // 1 x 40-49 FG (4) + 1 x 50+ FG (5) + 2 XP (2) = 11.00 points
    const lines = box.players.get(AUBREY) as StatLine[];
    expect(scorePlayer(lines, RULES)).toBe(11_000);
  });
});

describe("team defense", () => {
  it("emits both units", () => {
    expect([...box.teamDefense.keys()].sort()).toEqual(["DAL", "PHI"]);
  });

  it("reads points allowed from the DST block", () => {
    // DAL allowed 24, PHI allowed 20 — the final score, inverted.
    const dal = new Map((box.teamDefense.get("DAL") ?? []).map((l) => [l.statKey, l.value]));
    const phi = new Map((box.teamDefense.get("PHI") ?? []).map((l) => [l.statKey, l.value]));

    expect(dal.get("def_pts_allowed")).toBe(24);
    expect(phi.get("def_pts_allowed")).toBe(20);
  });

  it("always emits points allowed, even at zero", () => {
    // Absent means "did not play" to the scoring engine, so a shutout would
    // silently forfeit its 10-point bonus.
    for (const lines of box.teamDefense.values()) {
      expect(lines.map((l) => l.statKey)).toContain("def_pts_allowed");
    }
  });

  it("scores the Philadelphia defense end to end", () => {
    // PHI allowed 20 points (the 14-20 tier = 1.00) and recovered 1 fumble (2.00).
    const lines = box.teamDefense.get("PHI") as StatLine[];
    expect(scorePlayer(lines, RULES)).toBe(3000);
  });

  it("scores the Dallas defense end to end", () => {
    // DAL allowed 24 (the 21-27 tier = 0.00) with 1 sack (1.00).
    const lines = box.teamDefense.get("DAL") as StatLine[];
    expect(scorePlayer(lines, RULES)).toBe(1000);
  });
});

describe("no phantom stats", () => {
  it("never emits a stat key the sport does not define", () => {
    const known = new Set(NFL_PPR_SCORING.map((rule) => rule.statKey));

    for (const [playerID, lines] of box.players) {
      for (const line of lines) {
        expect(known, `${playerID} produced unknown key ${line.statKey}`).toContain(
          line.statKey,
        );
      }
    }
  });

  it("emits only integers", () => {
    // The scoring engine rejects non-integers by design; catching it here
    // gives a better error than catching it at score time.
    for (const lines of box.players.values()) {
      for (const line of lines) {
        expect(Number.isSafeInteger(line.value), `${line.statKey} = ${line.value}`).toBe(true);
      }
    }
  });

  it("scores every player without throwing", () => {
    for (const lines of box.players.values()) {
      expect(() => scorePlayer(lines, RULES)).not.toThrow();
    }
  });
});
