import { describe, expect, it } from "vitest";
import { scoreWeekNotes, type LeagueRow } from "./score-week";

/*
  What `score-week` writes into `cron_runs.last_outcome`.

  These are the first tests this rule has ever had. It lived in the route body,
  and `route.test.ts` is `describe.skipIf(!DATABASE_URL)` — so it runs for
  whoever has that variable set locally and **never in CI**, which has no
  Postgres service. The rule was therefore verified only by being run in
  production, and it was wrong in production for about a hundred days a year.
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
    // `NO_SCHEDULE` is a real `WeekError` code. An earlier draft invented
    // `SCHEDULE_MISSING`, which belongs to nothing — a fixture that cannot
    // occur proves the rule handles a case that will never arrive.
    expect(scoreWeekNotes([{ skipped: "NO_SCHEDULE" }])).toMatch(
      /1 of 1 leagues had a problem/,
    );
  });

  it("still reports every bracket refusal, whatever the code", () => {
    /*
      The gate in `route.ts` stops `advancePlayoffs` being called at all while a
      league's regular season is unfinished, so a refusal that still arrives is
      real. Six codes can reach the field and every one of them counts —
      asserted so that nobody "finishes" this fix by suppressing a code, which
      was the first design considered and the one that throws the alarm away.

      Two of these are **permanently true** once they fire, because frozen rules
      cannot be amended, so such a league pins the job red for its whole season.
      That residual is named in `score-week.ts` and deliberately not papered
      over here — a league that can never build a bracket is a real problem, and
      the fix for "real but permanent" is a channel that reports without
      reddening, not a filter.
    */
    for (const code of [
      "INVARIANT: bad pairing",
      "FIELD_TOO_SMALL: 1 team",
      "NOT_ENOUGH_WEEKS: needs 4 rounds in 1 week",
      "LEAGUE_NOT_FOUND",
      "NO_PLAYOFF_WEEKS",
      "REGULAR_SEASON_UNFINISHED",
      "UNEXPECTED: tiebreakers exhausted",
    ]) {
      expect(scoreWeekNotes([{ bracketProblem: code }]), code).toMatch(/had a problem/);
    }
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
          holdCode: "NO_GAMES_INGESTED",
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
          holdCode: "NO_GAMES_INGESTED",
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

  it("says nothing about a week that settled on the clock — the week records that itself", () => {
    /*
      **#323's answer, asserted from this side.**

      This used to emit a note, and a note turns the job red — `cronJobState`
      reads any non-null outcome as FAILING before it checks staleness. So the
      alarm for "a paying week was decided on data we never fetched" was also
      the thing that stopped `score-week` ever reporting STALE.

      Worse, it could not be regenerated. The sweep selects weeks where nothing
      is finalised, so a settled week is never revisited — the note lived for one
      ten-minute tick and was then overwritten by the next upsert.

      It is now on the week, in `matchups.finalized_on_fallback` (migration
      `0049`), for as long as the league exists. See `week.test.ts`.
    */
    const note = scoreWeekNotes([
      {
        weeks: [{ week: 14, finalized: true, finalizedWithUnfinishedGames: "3 games unread" }],
      },
    ]);

    expect(note).toBeNull();
  });

  it("does not let one healthy league mask another's failure, or vice versa", () => {
    const note = scoreWeekNotes([healthy, { skipped: "NO_SCHEDULE" }]);

    // 1 of 2, not 2 of 2 — the healthy league must not be swept in.
    expect(note).toMatch(/1 of 2 leagues had a problem/);
  });

  it("counts one wedged week once, however many leagues are stuck on it", () => {
    /*
      The number and the list are built from the same deduplicated set. They were
      not: the count flat-mapped occurrences while the list deduped, so two
      leagues wedged on week 3 read "2 week(s) … week 3" — a sentence that
      contradicts itself in the space of eight words, in the one note whose job
      is to send somebody to look at something.
    */
    const wedged = (week: number): LeagueRow => ({
      weeks: [{ week, finalized: false, holdCode: "NO_GAMES_INGESTED" }],
    });

    expect(scoreWeekNotes([wedged(3), wedged(3)])).toMatch(/^1 week can never/);
    expect(scoreWeekNotes([wedged(3), wedged(3)])).toMatch(/week 3$/);
    expect(scoreWeekNotes([wedged(3), wedged(5)])).toMatch(/^2 weeks can never/);
    expect(scoreWeekNotes([wedged(3), wedged(5)])).toMatch(/week 3, 5$/);
  });

  it("says nothing about a failed prefill, which is optimistic work", () => {
    /*
      Filling next week's lineups early is a convenience: `ensureLineups` runs
      again before the week is scored, so a failure here costs nothing and
      nobody needs to act on it. It reported anyway, and every report is an
      alarm.

      It stays in the response body, where it informs without reddening the one
      row that has to be believed when scoring actually breaks.
    */
    expect(scoreWeekNotes([{ prefillProblem: "boom" }])).toBeNull();
    expect(scoreWeekNotes([{ prefillProblem: "" }])).toBeNull();
  });

  it("says nothing for a run over no leagues at all", () => {
    // A run over zero leagues is a healthy run, which `cron-runs.ts` and the
    // `injuries` route both already argue. An empty-array note would make the
    // whole offseason red.
    expect(scoreWeekNotes([])).toBeNull();
  });
});
