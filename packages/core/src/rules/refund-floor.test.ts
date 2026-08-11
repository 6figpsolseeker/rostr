import { describe, expect, it } from "vitest";
import { earliestRefundUnlock } from "./validate.js";
import { NFL_DEFAULT_SCHEDULE, NFL_DEFAULT_SETTLEMENT } from "./nfl-ppr.js";

/**
 * The floor itself, separately from the validation that consumes it.
 *
 * `CreateLeagueForm` seeds its refund-date field from this same function, which
 * is the only reason the form cannot suggest a date the server will refuse. It
 * previously hardcoded `"2027-03-01T00:00"` under a comment claiming "two weeks
 * after the championship" — wrong by six weeks, and sitting next to a draft date
 * the commissioner can move.
 */

const nfl = (draftScheduledAt: number) =>
  earliestRefundUnlock({
    draftScheduledAt,
    regularSeasonWeeks: NFL_DEFAULT_SCHEDULE.regularSeasonWeeks,
    playoffWeeks: NFL_DEFAULT_SCHEDULE.playoffWeeks,
    payingFinalizationHours: NFL_DEFAULT_SETTLEMENT.payingFinalizationHours,
  });

const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

describe("earliestRefundUnlock", () => {
  it("lands well clear of the real settlement date for the 2026 season", () => {
    // The season this was designed against: draft Aug 22 2026, championship
    // Jan 3 2027, final payouts Jan 10 after the 168h window. The floor has to
    // sit comfortably past that last date, because refund and payout drawing on
    // the same vault at the same time is the failure it exists to prevent.
    const floor = nfl(at("2026-08-22T14:00:00Z"));

    expect(day(floor)).toBe("2027-02-24");
    expect(floor).toBeGreaterThan(at("2027-01-10T00:00:00Z"));
  });

  it("keeps at least a month of clearance past settlement", () => {
    // The margin is the point, not the exact date. The estimate is knowingly
    // early — the rules do not record the gap between the draft and kickoff —
    // so this asserts the buffer actually survives that, rather than that the
    // arithmetic produces some particular day.
    const settlement = at("2027-01-10T00:00:00Z");
    const floor = nfl(at("2026-08-22T14:00:00Z"));

    expect((floor - settlement) / 86_400).toBeGreaterThan(30);
  });

  it("moves with the draft, so a later draft cannot outrun it", () => {
    // The bug the form had: a constant refund date beside a movable draft date.
    // Push the draft back and a fixed date silently becomes illegal.
    const early = nfl(at("2026-07-01T09:00:00Z"));
    const late = nfl(at("2026-09-05T14:00:00Z"));

    expect(late - early).toBe(at("2026-09-05T14:00:00Z") - at("2026-07-01T09:00:00Z"));
  });

  it("uses the last week, not the count of playoff weeks", () => {
    // Playoff weeks need not follow the regular season immediately, and adding
    // up lengths would finish early for a league that leaves a gap.
    const contiguous = earliestRefundUnlock({
      draftScheduledAt: 0,
      regularSeasonWeeks: 14,
      playoffWeeks: [15, 16, 17],
      payingFinalizationHours: 168,
    });
    const gapped = earliestRefundUnlock({
      draftScheduledAt: 0,
      regularSeasonWeeks: 14,
      playoffWeeks: [18, 19, 20],
      payingFinalizationHours: 168,
    });

    expect(gapped - contiguous).toBe(3 * 7 * 86_400);
  });

  it("falls back to the regular season when there are no playoff weeks", () => {
    // `Math.max(...[])` is -Infinity, which would make the floor NaN and every
    // comparison against it false — a validation rule that silently stops
    // validating. The seed guards it.
    const floor = earliestRefundUnlock({
      draftScheduledAt: 0,
      regularSeasonWeeks: 14,
      playoffWeeks: [],
      payingFinalizationHours: 168,
    });

    expect(Number.isFinite(floor)).toBe(true);
    expect(floor).toBe(14 * 7 * 86_400 + 168 * 3600 + 60 * 86_400);
  });
});
