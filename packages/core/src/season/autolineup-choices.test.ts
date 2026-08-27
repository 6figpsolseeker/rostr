import { describe, expect, it } from "vitest";
import { buildRosterShape } from "../draft/roster.js";
import { NFL } from "../sports/nfl.js";
import { NFL_PPR_ROSTER } from "../rules/nfl-ppr.js";
import { autolineup, autolineupChoices } from "./autolineup.js";
import type { AutolineupCandidate, AutolineupChoice } from "./autolineup.js";

const SHAPE = buildRosterShape(NFL_PPR_ROSTER, NFL);
const SUNDAY = 1_757_782_800;

function candidate(
  playerId: string,
  positions: string[],
  averageMilliPoints: number | null,
  extra: { unavailable?: boolean } = {},
): AutolineupCandidate {
  return {
    playerId,
    positions,
    averageMilliPoints,
    kickoffAt: SUNDAY,
    ...(extra.unavailable !== undefined ? { unavailable: extra.unavailable } : {}),
  };
}

const ROSTER: AutolineupCandidate[] = [
  candidate("qb-good", ["QB"], 22_000),
  candidate("qb-bad", ["QB"], 14_000),
  candidate("rb1", ["RB"], 18_000),
  candidate("rb2", ["RB"], 16_000),
  candidate("rb3", ["RB"], 9_000),
  candidate("wr1", ["WR"], 17_000),
  candidate("wr2", ["WR"], 15_000),
  candidate("wr3", ["WR"], 8_000),
  candidate("te1", ["TE"], 11_000),
  candidate("k1", ["K"], 7_000),
  candidate("dst1", ["DST"], 6_000),
];

function choiceFor(choices: readonly AutolineupChoice[], slot: string): AutolineupChoice {
  const [slotType, index] = slot.split("#");
  const found = choices.find((c) => c.slotType === slotType && c.slotIndex === Number(index));
  if (found === undefined) throw new Error(`no choice for slot ${slot}`);
  return found;
}

describe("autolineupChoices", () => {
  it("fills exactly as autolineup does", () => {
    // The property that makes a preview safe to show: the screen and the
    // Sunday-morning write cannot name different players, because one is a
    // projection of the other rather than a second implementation.
    const choices = autolineupChoices({ shape: SHAPE, roster: ROSTER });
    const lineup = autolineup({ shape: SHAPE, roster: ROSTER });

    expect(
      choices.map(({ slotType, slotIndex, playerId }) => ({ slotType, slotIndex, playerId })),
    ).toEqual(lineup);
  });

  it("names the runner-up it passed over", () => {
    const choices = autolineupChoices({ shape: SHAPE, roster: ROSTER });
    const qb = choiceFor(choices, "QB#0");

    expect(qb.playerId).toBe("qb-good");
    expect(qb.runnerUpId).toBe("qb-bad");
  });

  it("says the runner-up was ranked lower when that is the reason", () => {
    const choices = autolineupChoices({ shape: SHAPE, roster: ROSTER });
    expect(choiceFor(choices, "QB#0")).toMatchObject({ runnerUpReason: "LOWER_RANKED" });
  });

  it("says unavailable ahead of lower-ranked, because that is the actionable fact", () => {
    // A backup on a bye is not a judgement the manager can second-guess. Saying
    // "projected lower" here is true and useless.
    const roster = ROSTER.map((player) =>
      player.playerId === "qb-bad" ? { ...player, unavailable: true } : player,
    );
    expect(choiceFor(autolineupChoices({ shape: SHAPE, roster }), "QB#0")).toMatchObject({
      runnerUpId: "qb-bad",
      runnerUpReason: "UNAVAILABLE",
    });
  });

  it("does not blame unavailability when the winner is unavailable too", () => {
    // Both on a bye: the choice really was made on the ranking, and claiming
    // otherwise would tell a manager to go and find a replacement who is no
    // better off than the starter.
    const roster = ROSTER.map((player) =>
      player.positions[0] === "QB" ? { ...player, unavailable: true } : player,
    );
    expect(choiceFor(autolineupChoices({ shape: SHAPE, roster }), "QB#0")).toMatchObject({
      runnerUpReason: "LOWER_RANKED",
    });
  });

  it("says NO_DATA rather than lower-ranked for an unranked runner-up", () => {
    // A null ranking sorts last by construction, so "projected lower" implies a
    // comparison that never took place.
    const roster = ROSTER.map((player) =>
      player.playerId === "qb-bad" ? { ...player, averageMilliPoints: null } : player,
    );
    expect(choiceFor(autolineupChoices({ shape: SHAPE, roster }), "QB#0")).toMatchObject({
      runnerUpId: "qb-bad",
      runnerUpReason: "NO_DATA",
    });
  });

  it("reports no runner-up when the slot had only one candidate", () => {
    const roster = ROSTER.filter((player) => player.playerId !== "qb-bad");
    expect(choiceFor(autolineupChoices({ shape: SHAPE, roster }), "QB#0")).toMatchObject({
      playerId: "qb-good",
      runnerUpId: null,
      runnerUpReason: null,
    });
  });

  it("never offers a player another slot already took", () => {
    // The reason the runner-up is computed inside the fill loop. Scarcest slot
    // first means TE takes the only tight end before FLEX is considered, so
    // naming him as FLEX's alternative would describe a choice nobody can make.
    const choices = autolineupChoices({ shape: SHAPE, roster: ROSTER });
    const taken = new Set(choices.map((c) => c.playerId).filter(Boolean));

    for (const choice of choices) {
      if (choice.runnerUpId === null) continue;
      expect(taken.has(choice.runnerUpId)).toBe(false);
    }
  });

  it("never names a player who starts in another slot", () => {
    // The flaw that produced the second pass. Computed inside the fill loop,
    // RB#0's runner-up is rb2 — who RB#1 then starts. The screen would have
    // offered the manager somebody already in their own lineup, described as an
    // alternative to it.
    const choices = autolineupChoices({ shape: SHAPE, roster: ROSTER });
    const rb0 = choiceFor(choices, "RB#0");
    const rb1 = choiceFor(choices, "RB#1");

    expect(rb0.playerId).toBe("rb1");
    expect(rb1.playerId).toBe("rb2");
    expect(rb0.runnerUpId).not.toBe("rb2");
  });

  it("reports nothing for a locked slot", () => {
    // A locked slot was not chosen by the autofill — its player is a fact about
    // a game that has already started, and there was no alternative to weigh.
    const choices = autolineupChoices({
      shape: SHAPE,
      roster: ROSTER,
      locked: [{ slotType: "QB", slotIndex: 0, playerId: "qb-bad" }],
    });
    expect(choiceFor(choices, "QB#0")).toMatchObject({
      playerId: "qb-bad",
      runnerUpId: null,
      runnerUpReason: null,
    });
  });
});
