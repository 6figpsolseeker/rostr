import { describe, expect, it } from "vitest";
import { buildOpsView, statusOf, windowHoursFor } from "./ops.js";

/**
 * What the operator view decides.
 *
 * The only judgement on this screen is whether a flagged game can still be
 * corrected, and getting it wrong in the permissive direction is the failure
 * that matters: telling somebody a fix is possible, watching them apply it, and
 * having it write a revision no finalised matchup will ever read. They would
 * believe a matchup was repaired when it was not.
 */

const NOW = new Date("2026-11-10T12:00:00Z");
const hoursBefore = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

describe("windowHoursFor", () => {
  it("gives an ordinary week 48 hours", () => {
    expect(windowHoursFor(3)).toBe(48);
    expect(windowHoursFor(13)).toBe(48);
  });

  it("gives the paying weeks seven days", () => {
    // RULES.md §7: weeks 14 and 17 decide money, and official NFL stat
    // corrections arrive for up to seven days.
    expect(windowHoursFor(14)).toBe(168);
    expect(windowHoursFor(17)).toBe(168);
  });

  it("does not extend the weeks either side of them", () => {
    // The mutation guard. A `>= 14` reading of the rule would quietly give
    // weeks 15 and 16 a window they do not have.
    expect(windowHoursFor(15)).toBe(48);
    expect(windowHoursFor(16)).toBe(48);
  });
});

describe("statusOf", () => {
  it("reports a game that has not finished", () => {
    expect(statusOf(null, 5, NOW)).toEqual({ status: "NOT_FINAL", hoursSinceFinal: null });
  });

  it("reports an open window with the hours elapsed", () => {
    expect(statusOf(hoursBefore(6), 5, NOW)).toEqual({ status: "OPEN", hoursSinceFinal: 6 });
  });

  it("closes exactly at the window, not after it", () => {
    // The boundary, and the direction is deliberate: at exactly 48 hours the
    // sweep may already have settled the week. Being early costs a needless
    // "too late"; being late reports a correction that never landed.
    expect(statusOf(hoursBefore(47), 5, NOW).status).toBe("OPEN");
    expect(statusOf(hoursBefore(48), 5, NOW).status).toBe("CLOSED");
  });

  it("keeps a paying week open past the ordinary window", () => {
    // The case a single hardcoded 48 would get wrong, on the two weeks where
    // being wrong costs money.
    expect(statusOf(hoursBefore(100), 14, NOW).status).toBe("OPEN");
    expect(statusOf(hoursBefore(100), 13, NOW).status).toBe("CLOSED");
    expect(statusOf(hoursBefore(168), 17, NOW).status).toBe("CLOSED");
  });

  it("treats a final_at in the future as not final", () => {
    // A clock problem rather than a very fresh game. Answering "-3 hours ago"
    // would be worse than saying it has not happened.
    const future = new Date(NOW.getTime() + 3_600_000);
    expect(statusOf(future, 5, NOW)).toEqual({ status: "NOT_FINAL", hoursSinceFinal: null });
  });
});

describe("buildOpsView", () => {
  const game = (gameRef: string, week: number, finalAt: Date | null) => ({
    gameRef,
    season: 2026,
    week,
    problem: `${gameRef}: something disagreed with itself`,
    finalAt,
  });

  it("splits what can still be fixed from what cannot", () => {
    const view = buildOpsView(
      {
        total: 3,
        games: [
          game("20261108_KC@BUF", 10, hoursBefore(2)), // open
          game("20261101_DAL@PHI", 9, hoursBefore(200)), // closed
          game("20261115_SF@LAR", 11, null), // not final
        ],
      },
      NOW,
    );

    expect(view.actionable.map((r) => r.gameRef)).toEqual([
      "20261108_KC@BUF",
      "20261115_SF@LAR",
    ]);
    expect(view.expired.map((r) => r.gameRef)).toEqual(["20261101_DAL@PHI"]);
  });

  it("counts everything, not only what it shows", () => {
    // `unresolvedStatsProblems` takes a limit, so the list is a page and the
    // total is not. A screen reporting `shown` as the whole truth would say a
    // backlog of two hundred was twenty.
    const view = buildOpsView({ total: 214, games: [game("a", 3, null)] }, NOW);
    expect(view.total).toBe(214);
    expect(view.shown).toBe(1);
  });

  it("keeps an unfinished game actionable rather than filing it as expired", () => {
    // NOT_FINAL is not CLOSED. A game still being played will become
    // correctable, and dropping it into the dead pile would hide the one class
    // of problem an operator can still get ahead of.
    const view = buildOpsView({ total: 1, games: [game("live", 5, null)] }, NOW);
    expect(view.actionable).toHaveLength(1);
    expect(view.expired).toHaveLength(0);
  });

  it("carries the window on every row so the screen can say why", () => {
    const view = buildOpsView(
      { total: 2, games: [game("a", 14, hoursBefore(1)), game("b", 5, hoursBefore(1))] },
      NOW,
    );
    expect(view.actionable.map((r) => r.windowHours)).toEqual([168, 48]);
  });

  it("handles an empty pipeline without inventing a problem", () => {
    const view = buildOpsView({ total: 0, games: [] }, NOW);
    expect(view).toEqual({ total: 0, shown: 0, actionable: [], expired: [] });
  });
});
