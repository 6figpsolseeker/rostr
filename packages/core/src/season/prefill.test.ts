import { describe, expect, it } from "vitest";
import { buildNflPprRules } from "../rules/nfl-ppr.js";
import { lastPlayedWeek, weekToPrefill } from "./prefill.js";
import type { PrefillInput } from "./prefill.js";

const RULES = buildNflPprRules({
  seasonYear: 2026,
  draft: { type: "SNAKE", mode: "SLOW", pickSeconds: 14_400, scheduledAt: 1_756_400_000 },
});

/** Eastern time, the default the waiver cycle is expressed in. */
const WEDNESDAY_0400_ET = new Date("2026-12-16T09:00:00Z");
const TUESDAY_1200_ET = new Date("2026-12-15T17:00:00Z");
/** The Wednesday of the fall-back week, after the clocks went back on 1 Nov 2026. */
const FALLBACK_WEDNESDAY_ET = new Date("2026-11-04T09:00:00Z");

function input(overrides: Partial<PrefillInput> = {}): PrefillInput {
  return {
    ahead: 15,
    lagging: 14,
    lastPlayedWeek: lastPlayedWeek(RULES.schedule),
    now: WEDNESDAY_0400_ET,
    waivers: RULES.waivers,
    ...overrides,
  };
}

describe("weekToPrefill", () => {
  it("names the coming week once this cycle's waivers have run", () => {
    expect(weekToPrefill(input())).toBe(15);
  });

  it("waits until waiver processing, so a claim is not granted onto the bench", () => {
    // Tuesday: the weekly lock has passed, Wednesday 03:00 processing has not.
    // The autofill keeps what is already stored, so filling now would freeze a
    // pre-waiver roster no later pass upgrades.
    expect(weekToPrefill(input({ now: TUESDAY_1200_ET }))).toBeNull();
  });

  it("still names the week on the Wednesday after the clocks go back", () => {
    expect(weekToPrefill(input({ now: FALLBACK_WEDNESDAY_ET, ahead: 10, lagging: 9 }))).toBe(
      10,
    );
  });

  it("names nothing after the last week the league plays", () => {
    // `transactionWeek` answers the NFL's week 18 once week 17's games are past.
    // No league has fixtures there, and nothing moves a finished league out of
    // IN_SEASON, so this would otherwise fill week 18 every ten minutes forever.
    expect(weekToPrefill(input({ ahead: 18, lagging: 17 }))).toBeNull();
  });

  it("names nothing while the coming week is the week being scored", () => {
    expect(weekToPrefill(input({ ahead: 14, lagging: 14 }))).toBeNull();
    expect(weekToPrefill(input({ ahead: 13, lagging: 14 }))).toBeNull();
  });

  it("names nothing when no game is ahead", () => {
    expect(weekToPrefill(input({ ahead: null }))).toBeNull();
  });

  it("names the first week before a league has scored anything", () => {
    expect(weekToPrefill(input({ ahead: 1, lagging: null }))).toBe(1);
  });
});

describe("lastPlayedWeek", () => {
  it("is the final playoff week under the default rules", () => {
    expect(lastPlayedWeek(RULES.schedule)).toBe(17);
    expect(RULES.schedule.playoffWeeks).toEqual([15, 16, 17]);
  });

  it("is the regular season when a league plays no playoffs", () => {
    expect(lastPlayedWeek({ regularSeasonWeeks: 14, playoffWeeks: [] })).toBe(14);
  });
});
