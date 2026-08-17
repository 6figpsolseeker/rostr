import { describe, expect, it } from "vitest";
import { indexScoringRules, NFL_PPR_SCORING, scorePlayer } from "@rostr/core";
import type { StatLine } from "@rostr/core";
import { translateBoxScore } from "./box-score.js";
import rawBoxScore from "./__fixtures__/box-score.json" with { type: "json" };
import rawReturnGame from "./__fixtures__/box-score-return-td.json" with { type: "json" };
import rawBlockedFgGame from "./__fixtures__/box-score-blocked-fg.json" with { type: "json" };
import rawSafetyGame from "./__fixtures__/box-score-safety.json" with { type: "json" };
import rawBlockedPuntTdGame from "./__fixtures__/box-score-blocked-punt-td.json" with { type: "json" };
import rawOverlapGame from "./__fixtures__/box-score-def-st-overlap.json" with { type: "json" };

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

describe("the D/ST unit is paid for a special teams return touchdown", () => {
  /**
   * Same play as the `ret_td` case above, from the other side.
   *
   * `RULES.md` pays the returner 6 for the return *and* the unit 6 for a
   * "defensive or special teams touchdown" — deliberately, because they are
   * different roster spots. We paid only the returner: `def_td` came solely
   * from `DST.defTD`, which counts defensive scores, and Tank01 reports it as
   * **0** for Seattle in this game despite the punt return.
   */
  const seaDst = new Map(
    (returnGame.teamDefense.get("SEA") ?? []).map((line) => [line.statKey, line.value]),
  );
  const larDst = new Map(
    (returnGame.teamDefense.get("LAR") ?? []).map((line) => [line.statKey, line.value]),
  );

  it("credits the returning unit, which the DST block reports as zero", () => {
    expect(rawReturnGame.DST.home.defTD).toBe("0");
    expect(seaDst.get("def_td")).toBe(1);
  });

  it("does not credit the opponent", () => {
    expect(larDst.get("def_td")).toBeUndefined();
  });

  it("still pays the returner his own six", () => {
    // Both halves of the same play. Losing either is six points.
    expect(returnStats(SHAHEED).get("ret_td")).toBe(1);
  });

  it("leaves a game with no return touchdown alone", () => {
    // The Cowboys-Eagles fixture has none, so neither unit may gain one.
    for (const lines of box.teamDefense.values()) {
      expect(lines.find((l) => l.statKey === "def_td")).toBeUndefined();
    }
  });
});

/**
 * Two-point conversions, and the two ways they used to pay nobody.
 *
 * Both defects come from one root cause: attribution was decided inside each
 * player's own loop, over his own `scoringPlays`, gated on the play's
 * `playerIDs` naming him. A conversion is described in the parenthetical of
 * somebody *else's* touchdown, so neither condition is reliable.
 */
describe("two-point conversions", () => {
  const twoPtOf = (translated: ReturnType<typeof translateBoxScore>, id: string): number =>
    translated.players.get(id)?.find((line) => line.statKey === "two_pt")?.value ?? 0;

  const player = (playerID: string, longName: string, extra: Record<string, unknown> = {}) => ({
    playerID,
    longName,
    ...extra,
  });

  const game = (playerStats: Record<string, unknown>, scoringPlays: unknown[]) =>
    translateBoxScore({ gameID: "g", playerStats, DST: {}, scoringPlays });

  /**
   * Issue #155, verbatim from 2025 week 1 `20250907_MIA@IND`.
   *
   * Julian Hill caught the conversion. He is not in `playerIDs` — those are the
   * touchdown's two players — and Tank01's entire record for him in that game is
   * an id, a name and snap counts: no `scoringPlays`, no `Receiving`. His own
   * loop ran zero times whatever the gate said, so nothing that iterates a
   * player's own plays could ever have found him. Sleeper credits him.
   */
  it("credits a receiver the provider leaves out of playerIDs entirely", () => {
    const translated = game(
      {
        "4241479": player("4241479", "Tua Tagovailoa"),
        "4429160": player("4429160", "De'Von Achane"),
        "4365395": player("4365395", "Julian Hill"),
      },
      [
        {
          score:
            "De'Von Achane 11 Yd pass from Tua Tagovailoa " +
            "(Tua Tagovailoa Pass to Julian Hill for Two-Point Conversion)",
          scoreType: "TD",
          team: "MIA",
          playerIDs: ["4241479", "4429160"],
        },
      ],
    );

    expect(twoPtOf(translated, "4365395")).toBe(1);
    // And the passer, who our rules pay too.
    expect(twoPtOf(translated, "4241479")).toBe(1);
    // The touchdown scorer took no part in the conversion.
    expect(twoPtOf(translated, "4429160")).toBe(0);
  });

  /**
   * Issue #81's fourth defect. `docs/TANK01.md` records that Tank01 abbreviates
   * names in some plays, and the old exact-substring match scored both of these
   * as zero with no warning.
   */
  it("credits an abbreviated name", () => {
    const translated = game({ p: player("p", "Rhamondre Stevenson") }, [
      { score: "TD (R.Stevenson Run for Two-Point Conversion)", scoreType: "TD" },
    ]);
    expect(twoPtOf(translated, "p")).toBe(1);
  });

  it("credits a name carrying a suffix the play omits", () => {
    const translated = game({ p: player("p", "Rhamondre Stevenson Jr.") }, [
      { score: "TD (Rhamondre Stevenson Run for Two-Point Conversion)", scoreType: "TD" },
    ]);
    expect(twoPtOf(translated, "p")).toBe(1);
  });

  /**
   * `docs/TANK01.md:105` records a play whose *first* parenthetical is a team
   * code. Taking `[0]` and stopping would miss a conversion noted after it.
   */
  it("reads every parenthetical, not the first", () => {
    const translated = game({ p: player("p", "Jordan Davis") }, [
      {
        score:
          "Blocked Kick Recovered by Someone (PHI) (Jordan Davis Run for Two-Point Conversion)",
        scoreType: "TD",
      },
    ]);
    expect(twoPtOf(translated, "p")).toBe(1);
  });

  it("ignores a failed conversion", () => {
    const translated = game({ p: player("p", "Rhamondre Stevenson") }, [
      {
        score: "TD (Rhamondre Stevenson Run for Two-Point Conversion failed)",
        scoreType: "TD",
      },
    ]);
    expect(twoPtOf(translated, "p")).toBe(0);
  });

  /**
   * Crediting the wrong player is worse than crediting none: it takes two points
   * from whoever earned them *and* gives them to somebody who did not, so the
   * error lands twice, in two different teams' totals.
   */
  it("credits nobody when one spelling fits two players, and says so", () => {
    const translated = game(
      {
        a: player("a", "Robert Stevenson"),
        b: player("b", "Rhamondre Stevenson"),
      },
      [{ score: "TD (R.Stevenson Run for Two-Point Conversion)", scoreType: "TD" }],
    );

    expect(twoPtOf(translated, "a")).toBe(0);
    expect(twoPtOf(translated, "b")).toBe(0);
    expect(translated.warnings.join(" ")).toMatch(/neither is credited/);
  });

  it("warns when a conversion names nobody the game recognises", () => {
    // Two points definitely happened — the text says so — and nothing was paid.
    // Silence here is what let issue #155's points vanish with `warnings: []`.
    const translated = game({ p: player("p", "Someone Else") }, [
      { score: "TD (Nobody Known Run for Two-Point Conversion)", scoreType: "TD" },
    ]);
    expect(translated.warnings.join(" ")).toMatch(/names no player this game recognises/);
  });

  /**
   * The trap #155 names explicitly. `passingTwoPointConversion` is read as a
   * *check* and never as a source — a player both named in a parenthetical and
   * carrying the numeric field would otherwise be paid twice, four points for
   * one conversion.
   */
  it("does not double-count a passer who also carries the numeric field", () => {
    const translated = game(
      {
        p: player("p", "Adam Thielen", { Passing: { passingTwoPointConversion: "1" } }),
        r: player("r", "Some Receiver"),
      },
      [
        {
          score: "TD (Adam Thielen Pass to Some Receiver for Two-Point Conversion)",
          scoreType: "TD",
        },
      ],
    );

    expect(twoPtOf(translated, "p")).toBe(1);
    expect(twoPtOf(translated, "r")).toBe(1);
    // Agreeing, so nothing to report.
    expect(translated.warnings.join(" ")).not.toMatch(/two-point/);
  });

  it("warns when the numeric field disagrees with the text", () => {
    // The guard field goals have always had, and conversions never did — which
    // is why #155's two points disappeared with no warning at all.
    const translated = game(
      { p: player("p", "Adam Thielen", { Passing: { passingTwoPointConversion: "2" } }) },
      [{ score: "TD (Adam Thielen Pass to Nobody for Two-Point Conversion)", scoreType: "TD" }],
    );

    expect(translated.warnings.join(" ")).toMatch(/reports 2 two-point conversion/);
  });
});

// ---------------------------------------------------------------------------
// Four defects found by scoring the whole 2025 season against Sleeper and then
// checking every disagreement against the play text and the box score itself.
// Sleeper found them; the evidence below is what decided them. Each fixture is a
// real captured `getNFLBoxScore` response.
// ---------------------------------------------------------------------------

const blockedFgGame = translateBoxScore(rawBlockedFgGame);
const safetyGame = translateBoxScore(rawSafetyGame);
const blockedPuntTdGame = translateBoxScore(rawBlockedPuntTdGame);
const overlapGame = translateBoxScore(rawOverlapGame);

const unitOf = (
  translated: ReturnType<typeof translateBoxScore>,
  teamAbv: string,
): Map<string, number> =>
  new Map((translated.teamDefense.get(teamAbv) ?? []).map((l) => [l.statKey, l.value]));

const playerOf = (
  translated: ReturnType<typeof translateBoxScore>,
  playerID: string,
): Map<string, number> =>
  new Map((translated.players.get(playerID) ?? []).map((l) => [l.statKey, l.value]));

const defenceBlock = (
  raw: { playerStats: Record<string, unknown> },
  playerID: string,
): Record<string, string> =>
  ((raw.playerStats[playerID] as { Defense?: Record<string, string> } | undefined)?.Defense ??
    {}) as Record<string, string>;

/**
 * A quarterback falling on his own fumble is not a defensive play.
 *
 * `TANK01_STAT_MAP` mapped `Defense.fumblesRecovered` for **every** player, and
 * Tank01 files a player recovering his own fumble there. 185 player-weeks of the
 * 2025 season, 384 points, paid to somebody's quarterback, running back or
 * receiver.
 *
 * The whole class went rather than the one field: `NFL_SLOT_TYPES` has no IDP
 * slot, so no per-player defensive stat can reach a roster spot except by being
 * mistaken for the D/ST's.
 */
describe("per-player defensive stats are not scored", () => {
  const BRISSETT = "2578570"; // QB, ARI
  const PICKENS = "4426354"; // WR, DAL
  const JAVONTE = "4361579"; // RB, DAL
  const MARCUS_JONES = "4241720"; // CB, NE

  it("does not pay a quarterback for recovering his own fumble", () => {
    // Verbatim from the fixture: he fumbled once and recovered one, and lost
    // none — so the recovery is his own ball.
    expect(defenceBlock(rawBlockedPuntTdGame, BRISSETT)["fumbles"]).toBe("1");
    expect(defenceBlock(rawBlockedPuntTdGame, BRISSETT)["fumblesRecovered"]).toBe("1");
    expect(defenceBlock(rawBlockedPuntTdGame, BRISSETT)["fumblesLost"]).toBe("0");

    expect(playerOf(blockedPuntTdGame, BRISSETT).get("def_fum_rec")).toBeUndefined();
  });

  it("does not pay a receiver or a running back for the same thing", () => {
    expect(defenceBlock(rawBlockedPuntTdGame, PICKENS)["fumblesRecovered"]).toBe("1");
    expect(defenceBlock(rawBlockedPuntTdGame, JAVONTE)["fumblesRecovered"]).toBe("1");

    expect(playerOf(blockedPuntTdGame, PICKENS).get("def_fum_rec")).toBeUndefined();
    expect(playerOf(blockedPuntTdGame, JAVONTE).get("def_fum_rec")).toBeUndefined();
  });

  it("still charges the fumble that was actually lost", () => {
    // `Defense.fumblesLost` is the one field under `Defense` that belongs to the
    // offensive player, and it stays mapped. Dropping the whole category would
    // have been the mirror-image error, and this is what stops it.
    expect(playerOf(blockedPuntTdGame, JAVONTE).get("fum_lost")).toBe(1);
  });

  it("does not pay an individual defender for a touchdown", () => {
    // Marcus Jones carries `Defense.defTD: "1"` for his punt return, and the old
    // map turned that into a 6-point `def_td` on his own row — the same thing
    // that paid Tyler Lockett, a wide receiver, 6 points for "Tyler Lockett 0 Yd
    // Fumble Recovery" in week 5.
    expect(defenceBlock(rawOverlapGame, MARCUS_JONES)["defTD"]).toBe("1");

    expect(playerOf(overlapGame, MARCUS_JONES).get("def_td")).toBeUndefined();
  });

  it("emits no unit-only stat key on any player row, in any real game", () => {
    // The sweep, so a re-introduced mapping fails here rather than in a payout.
    const unitOnly = ["def_td", "def_sack", "def_int", "def_fum_rec", "def_safety"];
    const games = [box, returnGame, blockedFgGame, safetyGame, blockedPuntTdGame, overlapGame];

    for (const translated of games) {
      for (const [playerID, lines] of translated.players) {
        for (const line of lines) {
          expect(unitOnly, `${playerID} produced ${line.statKey}`).not.toContain(line.statKey);
        }
      }
    }
  });
});

/**
 * Blocked kicks, from the numbers rather than from the prose.
 *
 * The text path can only ever see a block that led to a score. **27 of the 44
 * blocked kicks in 2025 did not**, which is 54 points nobody was paid.
 */
describe("blocked kicks come from teamStats", () => {
  it("credits a block no scoring play mentions", () => {
    // 2025 week 1, `20250907_ARI@NO`. New Orleans blocked an Arizona field goal,
    // it went nowhere, and the scoring summary is silent about it.
    expect(rawBlockedFgGame.scoringPlays.filter((p) => /block/i.test(p.score))).toEqual([]);

    expect(unitOf(blockedFgGame, "NO").get("def_blk_kick")).toBe(1);
  });

  it("credits the team that made the block, not the team that got blocked", () => {
    // The fact that had to be established before these fields could be used at
    // all — the mirror of the trap `blockingTeamOf` exists for. Arizona's kick
    // was blocked; Arizona's own counter reads 0 and New Orleans' reads 1.
    expect(rawBlockedFgGame.teamStats.home.teamAbv).toBe("NO");
    expect(rawBlockedFgGame.teamStats.home.blockedFG).toBe("1");
    expect(rawBlockedFgGame.teamStats.away.blockedFG).toBe("0");

    expect(unitOf(blockedFgGame, "ARI").get("def_blk_kick")).toBeUndefined();
  });

  it("counts a block that also scored exactly once", () => {
    // The reason the two sources are combined with `max` and not `+`. Marshawn
    // Kneeland recovered a blocked punt in the end zone for a touchdown, so the
    // numeric counter and the scoring text both see it; adding them would pay
    // Dallas twice for one block.
    expect(rawBlockedPuntTdGame.teamStats.home.blockedPunt).toBe("1");

    expect(unitOf(blockedPuntTdGame, "DAL").get("def_blk_kick")).toBe(1);
  });

  it("falls back to the scoring text when teamStats is absent, and says nothing", () => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20" },
        away: { teamAbv: "DAL", ptsAllowed: "24" },
      },
      scoringPlays: [
        { score: "Blake Corum 1 Yd Rush (Joshua Karty PAT blocked)", team: "DAL" },
      ],
    });

    expect(unitOf(translated, "PHI").get("def_blk_kick")).toBe(1);
    expect(translated.warnings.join(" ")).not.toMatch(/blocked kick/);
  });

  it("keeps the larger count and warns when the text sees a block the numbers do not", () => {
    // The only direction worth reporting. The reverse is the ordinary case, 27
    // times a season, and warning about it would drown the signal.
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20" },
        away: { teamAbv: "DAL", ptsAllowed: "24" },
      },
      teamStats: {
        home: { teamAbv: "PHI", blockedFG: "0", blockedPunt: "0", blockedXP: "0" },
        away: { teamAbv: "DAL", blockedFG: "0", blockedPunt: "0", blockedXP: "0" },
      },
      scoringPlays: [
        { score: "Blake Corum 1 Yd Rush (Joshua Karty PAT blocked)", team: "DAL" },
      ],
    });

    expect(unitOf(translated, "PHI").get("def_blk_kick")).toBe(1);
    expect(translated.warnings.join(" ")).toMatch(/PHI: teamStats reports 0 blocked kick/);
  });
});

/**
 * One touchdown pays the unit once.
 *
 * Both halves below are load-bearing and pull in opposite directions: removing
 * the special-teams term outright would have cost more points than the
 * double-count it fixes.
 */
describe("the D/ST is paid once per defensive or special teams touchdown", () => {
  it("does not pay twice when the returner is a defensive player", () => {
    // 2025 week 4, `20250928_CAR@NE`. There is exactly one defensive or special
    // teams touchdown in the whole game — Marcus Jones's 87-yard punt return —
    // and New England scored 2 for it, because Jones is a cornerback and ESPN
    // files his return under `defensiveTouchdowns` as well.
    expect(rawOverlapGame.DST.home.defTD).toBe("1");
    expect(rawOverlapGame.scoringPlays.filter((p) => /Return/i.test(p.score)).length).toBe(1);

    expect(unitOf(overlapGame, "NE").get("def_td")).toBe(1);
    expect(unitOf(overlapGame, "CAR").get("def_td")).toBeUndefined();
  });

  it("still pays the returner his own six on that same play", () => {
    // The pair that is *not* a double-count: different roster spots, usually
    // different managers. Losing this half would be the larger bug.
    expect(playerOf(overlapGame, "4241720").get("ret_td")).toBe(1);
  });

  it("still pays the unit when the returner is not a defensive player", () => {
    // `20251218_LAR@SEA`: Rashid Shaheed is a receiver, so Seattle's `DST.defTD`
    // reads "0" and the scoring text is the only evidence the unit scored at all.
    expect(rawReturnGame.DST.home.defTD).toBe("0");

    expect(unitOf(returnGame, "SEA").get("def_td")).toBe(1);
  });

  it("pays a blocked punt recovered in the end zone", () => {
    // `20251103_ARI@DAL`, verbatim: "Marshawn Kneeland Blocked Punt Recovery in
    // End Zone". No "return" anywhere in it, so the old pattern read nothing —
    // and Dallas's `DST.defTD` is "0", so no other path made it up. Refs #158.
    expect(rawBlockedPuntTdGame.DST.home.defTD).toBe("0");

    expect(unitOf(blockedPuntTdGame, "DAL").get("def_td")).toBe(1);
    expect(unitOf(blockedPuntTdGame, "ARI").get("def_td")).toBeUndefined();
  });

  /**
   * The negative case, and the reason the pattern is anchored on "blocked".
   *
   * Every fumble-return touchdown in the 2025 season is worded "Fumble
   * Recovery", not "Fumble Return", so a bare `recover` alternative in the
   * special-teams pattern looks equivalent to anchoring on "blocked" and is not.
   * What it would cost is a `ret_td` on a player *and* a second `def_td` on the
   * unit — one play paid three times across two roster spots.
   *
   * **Corrected 2026-08-17: the figure of "14 defensive touchdowns" that used to
   * sit here is wrong.** `isDefensiveReturnTouchdown` is consulted first and now
   * matches a recovery as well as a return, so all 19 of the season's fumble
   * touchdowns are excluded before the special-teams pattern is reached; over all
   * 2,339 scoring plays of 2025 the loose variant gains exactly one play, George
   * Holani's. The assertion below is unchanged — it is what makes that true.
   */
  it("does not read a fumble recovery touchdown as a special teams score", () => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: { p: { playerID: "p", longName: "Zack Baun", team: "PHI" } },
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20", defTD: "1" },
        away: { teamAbv: "DAL", ptsAllowed: "24" },
      },
      scoringPlays: [
        {
          score: "Zack Baun 12 Yd Fumble Recovery (Jake Elliott Kick)",
          scoreType: "TD",
          team: "PHI",
          playerIDs: ["p"],
        },
      ],
    });

    // One touchdown, one credit — the one `DST.defTD` already reports.
    expect(unitOf(translated, "PHI").get("def_td")).toBe(1);
    expect(playerOf(translated, "p").get("ret_td")).toBeUndefined();
  });

  it("warns when Tank01's own count disagrees with the plays we recognised", () => {
    // `defensiveOrSpecialTeamsTds` minus `DST.defTD` is Tank01's independent
    // count of the special-teams half. This is the check that would have found
    // the Kneeland wording without a season-long sweep. Refs #157, #158.
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20", defTD: "0" },
        away: { teamAbv: "DAL", ptsAllowed: "24" },
      },
      teamStats: {
        home: { teamAbv: "PHI", defensiveOrSpecialTeamsTds: "1" },
        away: { teamAbv: "DAL", defensiveOrSpecialTeamsTds: "0" },
      },
      scoringPlays: [],
    });

    expect(translated.warnings.join(" ")).toMatch(
      /PHI: teamStats implies 1 special teams touchdown/,
    );
  });

  /**
   * The check cried wolf on correctly scored games, which is the one thing a
   * check must not do.
   *
   * ESPN classifies a blocked-kick touchdown as a **defensive** score — stat id
   * 93, "Def. blocked kick for TD" — rather than as a return, so
   * `defensiveOrSpecialTeamsTds` holds it once where it holds an ordinary return
   * by a defensive player twice. Measured on 2025: Marcus Jones's punt return
   * reads `2, 1` and Jordan Davis's blocked kick reads `1, 1`, so the subtraction
   * gives 0 against a scoring text that legitimately sees 1. Four of the season's
   * five blocked-kick touchdowns fired it. Refs #158.
   */
  it("does not warn on a blocked kick ESPN files as a defensive touchdown", () => {
    const play = {
      score: "Blocked Kick Recovered by Jordan Davis (PHI) Jordan Davis 61 Yd Touchown Return",
      scoreType: "TD",
      team: "PHI",
      playerIDs: ["p"],
    };

    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {
        p: {
          playerID: "p",
          longName: "Jordan Davis",
          team: "PHI",
          Defense: { defTD: "1" },
          // Tank01 repeats a player's own scoring plays under him, and that is
          // the only place `ret_td` is read from.
          scoringPlays: [play],
        },
      },
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20", defTD: "1" },
        away: { teamAbv: "DAL", ptsAllowed: "24", defTD: "0" },
      },
      teamStats: {
        home: { teamAbv: "PHI", defensiveOrSpecialTeamsTds: "1" },
        away: { teamAbv: "DAL", defensiveOrSpecialTeamsTds: "0" },
      },
      scoringPlays: [play],
    });

    expect(translated.warnings.join(" ")).not.toMatch(/special teams touchdown/);

    // Nothing about the scoring moves. Six for the unit — from `DST.defTD`,
    // which already holds it — and six for the scorer, which is what ESPN pays
    // and what all four 2025 blocked-kick touchdowns reconcile against.
    expect(unitOf(translated, "PHI").get("def_td")).toBe(1);
    expect(playerOf(translated, "p").get("ret_td")).toBe(1);
  });

  it("still compares a blocked kick the provider did not already count", () => {
    // The fifth of the five, and the reason only the blocked kicks *already
    // inside* `DST.defTD` are excluded rather than all of them. `20251103_ARI@DAL`
    // reads `1, 0` — Tank01 carries no `Defense` block for Marshawn Kneeland at
    // all — so the subtraction already agrees with the text. Excluding every
    // blocked kick would have moved this game to a warning while quieting the
    // other four, which is the same defect with the sign flipped.
    expect(rawBlockedPuntTdGame.teamStats.home.defensiveOrSpecialTeamsTds).toBe("1");
    expect(rawBlockedPuntTdGame.DST.home.defTD).toBe("0");

    expect(blockedPuntTdGame.warnings.join(" ")).not.toMatch(/special teams touchdown/);
  });

  it("says how many blocked kicks it excluded when it does warn", () => {
    // Narrowed, not deleted. A team carrying two special-teams touchdowns Tank01
    // knows about and one blocked kick we recognised still disagrees, and the
    // warning has to be readable by someone who does not already know about stat
    // id 93 — otherwise the excluded play looks like a play nobody counted.
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {
        p: {
          playerID: "p",
          longName: "Jordan Davis",
          team: "PHI",
          Defense: { defTD: "1" },
        },
      },
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20", defTD: "1" },
        away: { teamAbv: "DAL", ptsAllowed: "24", defTD: "0" },
      },
      teamStats: {
        home: { teamAbv: "PHI", defensiveOrSpecialTeamsTds: "3" },
        away: { teamAbv: "DAL", defensiveOrSpecialTeamsTds: "0" },
      },
      scoringPlays: [
        {
          score:
            "Blocked Kick Recovered by Jordan Davis (PHI) Jordan Davis 61 Yd Touchown Return",
          scoreType: "TD",
          team: "PHI",
          playerIDs: ["p"],
        },
      ],
    });

    expect(translated.warnings.join(" ")).toMatch(
      /PHI: teamStats implies 2 special teams touchdown\(s\) .* but 0 were read from the scoring text, excluding 1 blocked-kick touchdown\(s\) ESPN files as defensive/,
    );
  });
});

/**
 * Safeties.
 *
 * A safety always scores, so it always reaches `scoringPlays` — which makes the
 * play list an independent second reading of a category worth 2 points and
 * reported about a dozen times a season.
 */
describe("safeties", () => {
  it("reads a safety, and does not count it twice", () => {
    // 2025 week 3, `20250921_ARI@SF`. The away score moves 13 -> 15 on
    // "Defensive Holding in Endzone for Safety" with `team: "ARI"`, which is what
    // proves `play.team` on an `SF` play names the defense that scored it rather
    // than the offense that conceded it.
    const safety = rawSafetyGame.scoringPlays.find((p) => p.scoreType === "SF");
    expect(safety?.team).toBe("ARI");
    expect(safety?.score).toBe("Defensive Holding in Endzone for Safety");
    expect(safety?.awayScore).toBe("15");

    expect(unitOf(safetyGame, "ARI").get("def_safety")).toBe(1);
    expect(unitOf(safetyGame, "SF").get("def_safety")).toBeUndefined();
  });

  it("agrees with the DST block on that game, and says nothing", () => {
    // Recorded because a full-season sweep reported `DST.safeties` as "0" for
    // this exact game. It is "1". The two sources agree here, so neither is
    // discarded and no warning is raised. See docs/TANK01.md.
    expect(rawSafetyGame.DST.away.safeties).toBe("1");

    expect(safetyGame.warnings.join(" ")).not.toMatch(/safety/);
  });

  it("credits a safety the DST block does not report, and warns", () => {
    const translated = translateBoxScore({
      gameID: "g",
      playerStats: {},
      DST: {
        home: { teamAbv: "PHI", ptsAllowed: "20", safeties: "0" },
        away: { teamAbv: "DAL", ptsAllowed: "24", safeties: "0" },
      },
      scoringPlays: [
        { score: "Defensive Holding in Endzone for Safety", scoreType: "SF", team: "PHI" },
      ],
    });

    expect(unitOf(translated, "PHI").get("def_safety")).toBe(1);
    expect(translated.warnings.join(" ")).toMatch(/PHI: DST.safeties is 0 but 1 safety/);
  });
});

describe("the newly captured games reconcile", () => {
  it.each([
    ["20250907_ARI@NO", () => blockedFgGame],
    ["20250921_ARI@SF", () => safetyGame],
    ["20251103_ARI@DAL", () => blockedPuntTdGame],
    ["20250928_CAR@NE", () => overlapGame],
  ])("%s reads cleanly", (gameRef, get) => {
    const translated = get();

    expect(translated.gameRef).toBe(gameRef);
    expect(translated.fatal).toEqual([]);
    // Zero warnings is the claim worth making: every cross-check added here
    // agrees with the provider on four independently captured responses.
    expect(translated.warnings).toEqual([]);
    expect(translated.players.size).toBeGreaterThan(50);
  });

  it("scores every player and every unit in them without throwing", () => {
    for (const translated of [blockedFgGame, safetyGame, blockedPuntTdGame, overlapGame]) {
      for (const lines of translated.players.values()) {
        expect(() => scorePlayer(lines, RULES)).not.toThrow();
      }
      for (const lines of translated.teamDefense.values()) {
        expect(() => scorePlayer(lines, RULES)).not.toThrow();
      }
    }
  });
});
