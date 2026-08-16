import { describe, expect, it } from "vitest";
import { indexScoringRules, NFL_PPR_SCORING, scorePlayer } from "@rostr/core";
import type { StatLine } from "@rostr/core";
import { translateBoxScore } from "./box-score.js";
import rawBoxScore from "./__fixtures__/box-score.json" with { type: "json" };
import rawReturnGame from "./__fixtures__/box-score-return-td.json" with { type: "json" };

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
    expect(aubrey.get("fg_50_59")).toBe(1);
    expect(aubrey.get("fg_0_39")).toBeUndefined();
    expect(aubrey.get("fg_60_plus")).toBeUndefined();
  });

  it("reads extra points from the direct field", () => {
    expect(statsFor(AUBREY).get("xp_made")).toBe(2);
  });

  it("scores Aubrey correctly end to end", () => {
    // 1 x 40-49 (4) + 1 x 50-59 (5) + 2 XP (2) = 11.00. He went 2 for 2, so the
    // new miss penalty does not bite — kept as the control case. `fgMissed` is
    // present in the fixture reading "0", so this also pins that a zero count
    // is not emitted as a stat line.
    expect(statsFor(AUBREY).get("fg_missed")).toBeUndefined();

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
    // PHI allowed 20 points (18-27 = 0.00) and 307 yards (300-349 = 0.00), and
    // recovered 1 fumble (2.00). The same game scored 3.00 under the old table,
    // whose ladder paid 1 for 20 points allowed and had no yards rung at all.
    const lines = box.teamDefense.get("PHI") as StatLine[];
    expect(scorePlayer(lines, RULES)).toBe(2000);
  });

  it("scores the Dallas defense end to end", () => {
    // DAL allowed 24 (18-27 = 0.00) and 302 yards (300-349 = 0.00), with 1 sack
    // (1.00). Unchanged at 1.00 — both new ladders happen to pay zero here,
    // which is why this one is worth keeping beside Philadelphia's.
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

describe("a blocked kick is credited to whoever blocked it", () => {
  /**
   * Both play strings below are recorded verbatim in `docs/TANK01.md`, and they
   * put different teams in `play.team` — which is the whole defect. The original
   * code assumed `play.team` was always the *kicking* team and derived the
   * blocker as "the other one", so a block returned for a score credited the two
   * points to the team whose kick was blocked. Two defenses, usually two
   * different rosters: a four-point swing, silently.
   */
  const dst = (home: string, away: string): Record<string, unknown> => ({
    home: { teamAbv: home, ptsAllowed: "20" },
    away: { teamAbv: away, ptsAllowed: "24" },
  });

  const blkOf = (lines: readonly StatLine[] | undefined): number =>
    lines?.find((line) => line.statKey === "def_blk_kick")?.value ?? 0;

  it("credits the returning team when the block is taken back for a score", () => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: dst("PHI", "DAL"),
      scoringPlays: [
        {
          // PHI blocked it, recovered it and scored — so `team` is PHI.
          score: "Blocked Kick Recovered by Jordan Davis (PHI) for a 61 Yd Touchown Return",
          team: "PHI",
        },
      ],
    });

    expect(blkOf(translated.teamDefense.get("PHI"))).toBe(1);
    expect(blkOf(translated.teamDefense.get("DAL"))).toBe(0);
  });

  it("still credits the opponent when the block is noted on the kicking team's own score", () => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: dst("PHI", "DAL"),
      scoringPlays: [
        // DAL scored the touchdown and their PAT was blocked, so `team` is DAL
        // and the blocker is the opponent.
        { score: "Blake Corum 1 Yd Rush (Joshua Karty PAT blocked)", team: "DAL" },
      ],
    });

    expect(blkOf(translated.teamDefense.get("PHI"))).toBe(1);
    expect(blkOf(translated.teamDefense.get("DAL"))).toBe(0);
  });

  /**
   * The two shapes compose, and that is what the first fix missed.
   *
   * A return touchdown whose *own* extra point is blocked contains both — a
   * return in the body and a block in the parenthetical — so deciding on the
   * word "return" anywhere in the text credits the block to the team that got
   * blocked. That is the identical four-point swing, surviving in the one case
   * where both forms appear at once.
   *
   * All three below score for PHI and have PHI's kick blocked by DAL, so a rule
   * that reads the body gets every one of them backwards.
   */
  it.each([
    ["a punt return", "Jahan Dotson 70 Yd punt return (Jake Elliott PAT blocked)"],
    [
      "an interception return",
      "Cooper DeJean 25 Yd interception return (Jake Elliott PAT blocked)",
    ],
    ["a fumble recovery", "Zack Baun 12 Yd fumble recovery (Jake Elliott PAT blocked)"],
  ])("credits the opponent when %s has its own extra point blocked", (_label, score) => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: dst("PHI", "DAL"),
      // PHI scored, so `team` is PHI — but the block in the parenthetical is
      // DAL's, because a parenthetical annotates the conversion on somebody
      // else's score.
      scoringPlays: [{ score, team: "PHI" }],
    });

    expect(blkOf(translated.teamDefense.get("DAL"))).toBe(1);
    expect(blkOf(translated.teamDefense.get("PHI"))).toBe(0);
  });

  it("credits the returning team when a blocked kick is returned and the extra point stands", () => {
    // The control for the case above: same return shape, no second block. If the
    // parenthetical rule ever regressed to "any mention of a block", this would
    // start crediting DAL.
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: dst("PHI", "DAL"),
      scoringPlays: [{ score: "Jordan Davis 61 Yd Return of Blocked Field Goal", team: "PHI" }],
    });

    expect(blkOf(translated.teamDefense.get("PHI"))).toBe(1);
    expect(blkOf(translated.teamDefense.get("DAL"))).toBe(0);
  });
});

describe("a defense that cannot be read says so", () => {
  /**
   * `translateTeamDefense` was the only translator not given the `warnings`
   * array, so a missing or unparseable field vanished in silence. That matters
   * most for `def_pts_allowed`: it is the only tiered rule in the sport, absent
   * is not zero, and a unit that still emits a sack looks like it played and
   * scored 2 rather than 12.
   */
  it("warns when points allowed is absent", () => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: { home: { teamAbv: "PHI", sacks: "2" }, away: { teamAbv: "DAL", ptsAllowed: "24" } },
      scoringPlays: [],
    });

    expect(translated.warnings.join(" ")).toContain("def_pts_allowed");
    expect(translated.warnings.join(" ")).toContain("PHI");
  });

  it("warns when points allowed is present but unreadable", () => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20-0" },
        away: { teamAbv: "DAL", ptsAllowed: "24" },
      },
      scoringPlays: [],
    });

    expect(translated.warnings.join(" ")).toContain("PHI");
  });
});

describe("a warning is not a reason to discard the game", () => {
  it("keeps every other player when one line does not reconcile", () => {
    // The clean fixture produces no warnings and no fatal, which is what makes
    // the distinction observable rather than theoretical.
    expect(box.warnings).toEqual([]);
    expect(box.fatal).toEqual([]);
    expect(box.players.size).toBeGreaterThan(50);
  });

  it("marks a response with no player stats as fatal", () => {
    const translated = translateBoxScore({ gameID: "g", playerStats: {}, DST: {} });

    expect(translated.fatal.join(" ")).toContain("playerStats");
  });

  it("marks a response with no game id as fatal", () => {
    const translated = translateBoxScore({ playerStats: { a: { playerID: "1" } }, DST: {} });

    expect(translated.fatal.join(" ")).toContain("gameID");
  });
});

/**
 * Return touchdowns, against a second real game.
 *
 * Rams at Seahawks, 2025 week 16. Captured because of one play:
 *
 *     Rashid Shaheed 58 Yd Punt Return
 *       (Sam Darnold Pass to Cooper Kupp for Two-Point Conversion)
 *     playerIDs: [Darnold, Shaheed, Kupp]
 *
 * The old rule credited `playerIDs[0]`, under a comment asserting the returner
 * is named first. That held for 26 of the season's 27 return touchdowns and
 * failed here, because a successful two-point conversion puts its passer first.
 * A quarterback was paid 6 points for a punt return and the wide receiver who
 * scored it got nothing — 12 points, both halves wrong, no warning raised.
 *
 * The fixture is a whole real response rather than a trimmed one, like
 * `box-score.json`, so it also has to keep reconciling as a game.
 */
const returnGame = translateBoxScore(rawReturnGame);

const SHAHEED = "4032473";
const DARNOLD = "3912547";
const KUPP = "2977187";
const SAUBERT = "2975863";
// Charbonnet is the *second* id on the play he converted and Barner the third,
// while the text names Barner first. These two were written the other way round
// when this file was drafted, by reading the ids in `playerIDs` order and
// assuming it matched the sentence — the very assumption the fix below removes.
// The real response caught it.
const CHARBONNET = "4426385";
const BARNER = "4576297";

const returnStats = (playerID: string): Map<string, number> =>
  new Map((returnGame.players.get(playerID) ?? []).map((line) => [line.statKey, line.value]));

describe("return touchdowns are credited from the main clause", () => {
  it("identifies the game and reconciles", () => {
    expect(returnGame.gameRef).toBe("20251218_LAR@SEA");
    expect(returnGame.fatal).toEqual([]);
  });

  it("credits the returner named before the parenthetical", () => {
    expect(returnStats(SHAHEED).get("ret_td")).toBe(1);
  });

  it("does not credit the conversion passer, who is first in playerIDs", () => {
    // The whole defect in one assertion. Darnold is `playerIDs[0]` on this play.
    expect(returnStats(DARNOLD).get("ret_td")).toBeUndefined();
  });

  it("does not credit the conversion receiver either", () => {
    expect(returnStats(KUPP).get("ret_td")).toBeUndefined();
  });

  it("still credits the conversions, and counts a repeat passer twice", () => {
    // The fix must not cost the conversion its own credit: the parenthetical
    // names Darnold and Kupp, and our rules pay a conversion pass and catch.
    //
    // Darnold is **2**, and that is right rather than a double-count — this
    // 38-37 overtime game had three conversions and he threw two of them, to
    // Kupp and to Saubert. This assertion said 1 when it was written, from the
    // one play the fixture was captured for; the real response corrected it.
    expect(returnStats(DARNOLD).get("two_pt")).toBe(2);
    expect(returnStats(KUPP).get("two_pt")).toBe(1);
    expect(returnStats(SAUBERT).get("two_pt")).toBe(1);
  });

  it("credits a conversion run to the runner", () => {
    // "(Zach Charbonnet Run for Two-Point Conversion)" — the third conversion,
    // and the only one in either fixture that is a rush rather than a pass.
    expect(returnStats(CHARBONNET).get("two_pt")).toBe(1);
  });

  it("does not credit the touchdown scorer of a play whose conversion was someone else's", () => {
    // AJ Barner caught the touchdown on the play Charbonnet converted. He is in
    // `playerIDs` and must not pick up the conversion by being on the play.
    expect(returnStats(BARNER).get("two_pt")).toBeUndefined();
  });

  it("gives the returner six points and the quarterback none for it", () => {
    // Stated in points rather than counts, because the count is not the harm.
    const ret = NFL_PPR_SCORING.find((rule) => rule.statKey === "ret_td");
    expect(ret?.milliPointsPerUnit).toBe(6000);

    const shaheed = returnGame.players.get(SHAHEED) ?? [];
    expect(scorePlayer(shaheed, RULES)).toBeGreaterThanOrEqual(6000);
  });
});
