import { describe, expect, it } from "vitest";
import {
  buildOpsView,
  buildRunBanner,
  ingestSentence,
  statusOf,
  toneOf,
  windowHoursFor,
  type IngestState,
  type ProblemRow,
} from "./ops.js";

/**
 * What the operator view decides.
 *
 * Two judgements, on two axes that used to be one. **What we hold** — no box
 * score, stale numbers, or a discrepancy — decides the tone and the grouping.
 * **Whether the week can still be corrected** decides a separate chip.
 *
 * Getting the second wrong in the permissive direction is the failure that has
 * always mattered here: telling somebody a fix is possible, watching them apply
 * it, and having it write a revision no finalised matchup will ever read.
 *
 * Getting the *first* wrong is what issue #233 was. Both a game whose every read
 * failed and a field-goal count disagreeing with itself rendered identically,
 * under a page-level sentence asserting that every row had been ingested and
 * scored. The severe one drew in the calmest tone on the page, because colour
 * keyed on the window axis and its provider had not called it final yet.
 */

const NOW = new Date("2026-11-10T12:00:00Z");
const hoursBefore = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);
const hoursAfter = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

const game = (over: Partial<Parameters<typeof buildOpsView>[0]["games"][number]> = {}) => ({
  gameRef: "g1",
  season: 2026,
  week: 5,
  ingest: "DISCREPANCY" as IngestState,
  problem: "fgMade disagrees with the parsed plays",
  finalAt: hoursBefore(6),
  syncedAt: hoursBefore(6),
  isFinal: true,
  weekLastKickoff: hoursBefore(6),
  ...over,
});

const row = (over: Partial<ProblemRow> = {}): ProblemRow => ({
  gameRef: "g1",
  season: 2026,
  week: 5,
  ingest: "DISCREPANCY",
  problem: "something",
  status: "OPEN",
  hoursSinceWeekEnd: 6,
  windowHours: 48,
  isFinal: true,
  ...over,
});

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
  it("measures from the week's last kickoff, not from the game's own final", () => {
    /*
      Issue #233, finding 8, and the single most consequential line in this file.

      `finalizationHold` clears a week at `max(kickoff_at) + hours`, across the
      whole week. This used to measure from the individual game's `final_at` —
      a different clock, not a different latency — so an early Sunday game read
      CLOSED roughly 28 hours before its week actually settled. The screen told
      an operator a correction was pointless while it would still have landed,
      and that slot holds 123 of the 256 synced fixtures.
    */
    const weekEnd = hoursBefore(20);

    expect(statusOf(weekEnd, 5, NOW)).toEqual({ status: "OPEN", hoursSinceWeekEnd: 20 });
  });

  it("reports a week whose clock has not started", () => {
    // A flagged game that has been played, in a week where another fixture has
    // yet to kick off. Renamed from NOT_FINAL, which asked about *this game*
    // from inside a union meaning "can this week be corrected" — and which drew
    // the calmest chip on the page for a game that might have no stats at all.
    expect(statusOf(hoursAfter(30), 5, NOW)).toEqual({
      status: "WEEK_IN_PLAY",
      hoursSinceWeekEnd: null,
    });
  });

  it("closes the window at exactly the boundary", () => {
    // Inclusive: at 48 hours the sweep may already have settled the week, so the
    // safe reading is closed. Early costs a warning that says "probably too
    // late"; late tells somebody a correction landed when it did not.
    expect(statusOf(hoursBefore(48), 5, NOW).status).toBe("CLOSED");
    expect(statusOf(hoursBefore(47), 5, NOW).status).toBe("OPEN");
  });

  it("keeps a paying week open past the ordinary boundary", () => {
    expect(statusOf(hoursBefore(100), 14, NOW).status).toBe("OPEN");
    expect(statusOf(hoursBefore(100), 13, NOW).status).toBe("CLOSED");
  });
});

describe("toneOf", () => {
  it("keys the tone on what we hold, not on whether it can be fixed", () => {
    /*
      The presentation half of #233. Colour used to come from the window status,
      so a game whose every read had failed — no stats at all, every player on
      zero — rendered in the lowest-contrast tone available, because its provider
      had not yet called it final. The most severe state wore the calmest chip,
      by default, every Sunday.
    */
    expect(toneOf("NO_STATS")).toBe("critical");
    expect(toneOf("STALE")).toBe("warning");
    expect(toneOf("DISCREPANCY")).toBe("neutral");
  });
});

describe("ingestSentence", () => {
  it("never claims a game with no box score was scored", () => {
    /*
      The deleted page-level prose, pinned where a test can reach it.

      It read "the stat lines were still ingested… so every one of these games
      has been scored", as a standing claim over a heterogeneous list. Every
      clause was false for a game with no box score. This test is what stops it
      coming back in a new location.
    */
    for (const status of ["OPEN", "CLOSED", "WEEK_IN_PLAY"] as const) {
      const sentence = ingestSentence(row({ ingest: "NO_STATS", status }));
      expect(sentence).toMatch(/scores? zero|scored zero/);
      expect(sentence).not.toMatch(/were still ingested|discrepanc/i);
    }
  });

  it("says a stale row is not the final numbers", () => {
    expect(ingestSentence(row({ ingest: "STALE" }))).toMatch(/not the final numbers/);
  });

  it("keeps the original sentence for the state it was true of", () => {
    expect(ingestSentence(row({ ingest: "DISCREPANCY" }))).toMatch(
      /discrepancy, not a failure/,
    );
  });

  it("returns something for a row carrying no provider text", () => {
    // A game selected by the clock rather than by an error has no `stats_error`.
    // Without a sentence the card renders empty, which is how the state this
    // screen was fixed to surface would stay invisible after all of it.
    expect(ingestSentence(row({ ingest: "NO_STATS", problem: null })).length).toBeGreaterThan(
      0,
    );
  });
});

describe("buildOpsView", () => {
  it("groups by what we hold, not by whether it can be fixed", () => {
    const view = buildOpsView(
      {
        total: 3,
        blockingRecent: 1,
        games: [
          game({ gameRef: "blank", ingest: "NO_STATS" }),
          game({ gameRef: "stale", ingest: "STALE" }),
          game({ gameRef: "flag", ingest: "DISCREPANCY" }),
        ],
      },
      NOW,
    );

    expect(view.noStats.map((r) => r.gameRef)).toEqual(["blank"]);
    expect(view.stale.map((r) => r.gameRef)).toEqual(["stale"]);
    expect(view.discrepancies.map((r) => r.gameRef)).toEqual(["flag"]);
  });

  it("puts every row in exactly one group", () => {
    // Exhaustive and disjoint. A state falling through the filters would be
    // silently uncounted, which on this page means invisible.
    const view = buildOpsView(
      {
        total: 3,
        blockingRecent: 0,
        games: [
          game({ gameRef: "a", ingest: "NO_STATS" }),
          game({ gameRef: "b", ingest: "STALE" }),
          game({ gameRef: "c", ingest: "DISCREPANCY" }),
        ],
      },
      NOW,
    );

    expect(view.noStats.length + view.stale.length + view.discrepancies.length).toBe(
      view.shown,
    );
  });

  it("counts only the no-stats rows that can still be acted on", () => {
    /*
      `blockingOpen` must be able to reach zero; `noStats.length` cannot. A game
      past its window stays on the page forever — correctly, as evidence — so a
      banner driven by the raw count would be permanently lit, which is the
      broken-health-signal failure this repo has paid for twice.
    */
    const view = buildOpsView(
      {
        total: 2,
        blockingRecent: 1,
        games: [
          game({ gameRef: "open", ingest: "NO_STATS", weekLastKickoff: hoursBefore(10) }),
          game({ gameRef: "shut", ingest: "NO_STATS", weekLastKickoff: hoursBefore(100) }),
        ],
      },
      NOW,
    );

    expect(view.noStats).toHaveLength(2);
    expect(view.blockingOpen).toBe(1);
  });

  it("carries the alarm count from the query rather than from the rows", () => {
    // The rows are truncated by the LIMIT. A count derived from them and
    // presented as a total is the same lie one layer down.
    const view = buildOpsView({ total: 90, blockingRecent: 7, games: [game()] }, NOW);

    expect(view.blockingRecent).toBe(7);
    expect(view.shown).toBe(1);
    expect(view.total).toBe(90);
  });
});

describe("buildRunBanner", () => {
  it("reports a failing job, which is how a run-level fault reaches this screen", () => {
    /*
      Issue #233, finding 4. The pool check that refuses a run whose player pool
      has a position group at zero throws *before* the game loop, so it writes no
      `stats_error` and produces no row here. Same for a database fault, a
      provider auth failure, and #256's "a slate was under way and nothing was
      selected" alarm. Every one turns `cron:status` red and left this page
      saying "nothing flagged".
    */
    expect(
      buildRunBanner({ lastRanAt: hoursBefore(0.1), lastOutcome: "pool has no K" }, NOW),
    ).toEqual({ state: "FAILING", detail: "pool has no K" });
  });

  it("tells a job that has not run from a job with nothing to do", () => {
    // "Nothing flagged" beside a job that stopped on Thursday is the same false
    // all-clear as the prose this change deletes.
    expect(buildRunBanner({ lastRanAt: hoursBefore(6), lastOutcome: null }, NOW).state).toBe(
      "STALE",
    );
    expect(buildRunBanner(undefined, NOW).state).toBe("NEVER_RAN");
  });

  it("stays quiet on a healthy job", () => {
    // The control. An alarm that cannot go quiet is one nobody reads, and the
    // job runs every ten minutes so a single missed tick is not news.
    expect(buildRunBanner({ lastRanAt: hoursBefore(0.2), lastOutcome: null }, NOW).state).toBe(
      "OK",
    );
  });
});
