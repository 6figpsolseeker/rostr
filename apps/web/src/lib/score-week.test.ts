import { describe, expect, it } from "vitest";
import { scoreWeekNotes, type LeagueRow } from "./score-week";

/*
  What `score-week` writes into `cron_runs.last_outcome`.

  These are the first tests this rule has ever had. It lived in the route body,
  and `route.test.ts` is `describe.skipIf(!DATABASE_URL)` — so it ran on nobody's
  machine and never in CI, and the rule was verified only by being run in
  production. It was wrong in production for about a hundred days a year.
*/

/** A league mid-season: scored, week held inside its correction window. */
const healthy: LeagueRow = {
  weeks: [{ week: 2, finalized: false, holdReason: "15 of 16 games are still in progress" }],
};

describe("scoreWeekNotes", () => {
  it("says nothing about a healthy mid-season league", () => {
    /*
      **The headline case, and the one observed failing in production on
      2026-09-19.** A league in week 2 whose games have not finished is the
      ordinary state of every league for fourteen weeks. A note here pins the job
      red for the whole regular season.

      `null` is what lets `cron:status` report OK — and therefore the only thing
      that lets it ever report STALE, because `cronJobState` checks the outcome
      before it checks staleness.
    */
    expect(scoreWeekNotes([healthy])).toBeNull();
  });

  it("still reports a league that could not be scored", () => {
    expect(scoreWeekNotes([{ skipped: "SCHEDULE_MISSING" }])).toMatch(
      /1 of 1 leagues had a problem/,
    );
  });

  it("still reports a bracket refusal, because after the gate they are all real", () => {
    /*
      The gate in `route.ts` stops `advancePlayoffs` being called at all while a
      league's regular season is unfinished, so a refusal that still arrives is
      one of: a league already in `PLAYOFFS` whose regular season came apart
      underneath it (the #319 duplicate-row shape), our own `INVARIANT` from the
      ladder that decides the pot, or an unrecognised class.

      Asserted here so that nobody "finishes" this fix by also suppressing the
      code — which was the first design considered and is the one that would
      throw the alarm away.
    */
    expect(scoreWeekNotes([{ bracketProblem: "INVARIANT: bad pairing" }])).toMatch(
      /had a problem/,
    );
    expect(scoreWeekNotes([{ bracketProblem: "REGULAR_SEASON_UNFINISHED" }])).toMatch(
      /had a problem/,
    );
  });

  it("counts a sweep that ran out of room, which it did not before", () => {
    // `SWEEP_LIMIT` leaves weeks unexamined. That is the same "did not get
    // scored" the counter is named for, and it reached only the response body.
    expect(scoreWeekNotes([{ deferredWeeks: [3, 4, 5] }])).toMatch(
      /1 of 1 leagues had a problem/,
    );
  });

  it("names a week that can never finalise", () => {
    /*
      The wedge, and the reason the gate alone was not enough.

      A week with no `games` rows holds forever — no kickoff, so no window, so
      §10's fallback never runs. It does not throw, so it is not in
      `failedWeeks`; later weeks finalise, so the sweep never defers it. Before
      this it was reported only by the bracket refusal it caused, and that
      refusal fired for healthy leagues too — so it named a real problem with a
      sentence that was true of everybody.
    */
    const wedged: LeagueRow = {
      weeks: [
        {
          week: 3,
          finalized: false,
          holdReason: "no games are scheduled",
          holdCode: "NO_SCHEDULE",
        },
      ],
    };

    expect(scoreWeekNotes([wedged])).toMatch(/week 3/);
    expect(scoreWeekNotes([wedged])).toMatch(/can never finalise/);
  });

  it("matches the wedge on the code, never on the sentence", () => {
    // The sentence is operator-facing prose and will be reworded. If this rule
    // read it, the rewording would silently disable the alarm behind it.
    const reworded: LeagueRow = {
      weeks: [
        {
          week: 3,
          finalized: false,
          holdReason: "totally different wording",
          holdCode: "NO_SCHEDULE",
        },
      ],
    };
    const prose: LeagueRow = {
      weeks: [
        { week: 3, finalized: false, holdReason: "no games are scheduled for this week yet" },
      ],
    };

    expect(scoreWeekNotes([reworded])).toMatch(/week 3/);
    expect(scoreWeekNotes([prose])).toBeNull();
  });

  it("keeps a permanent settlement out of the failure count but still says it", () => {
    /*
      A fallback settlement is not "did not get scored" — it is the opposite, the
      league was scored, once, for good, and no retry reaches it. Counting them
      together would invite a retry-shaped response to something no retry can
      touch.
    */
    const note = scoreWeekNotes([
      {
        weeks: [{ week: 14, finalized: true, finalizedWithUnfinishedGames: "3 games unread" }],
      },
    ]);

    expect(note).toMatch(/permanent/);
    expect(note).not.toMatch(/had a problem/);
  });

  it("does not let one healthy league mask another's failure, or vice versa", () => {
    const note = scoreWeekNotes([healthy, { skipped: "SCHEDULE_MISSING" }]);

    // 1 of 2, not 2 of 2 — the healthy league must not be swept in.
    expect(note).toMatch(/1 of 2 leagues had a problem/);
  });

  it("says nothing for a run over no leagues at all", () => {
    // A run over zero leagues is a healthy run, which `cron-runs.ts` and the
    // `injuries` route both already argue. An empty-array note would make the
    // whole offseason red.
    expect(scoreWeekNotes([])).toBeNull();
  });
});
