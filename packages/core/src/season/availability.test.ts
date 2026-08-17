import { describe, expect, it } from "vitest";
import { gameAvailability } from "./availability.js";

describe("gameAvailability", () => {
  it("reports a game as scheduled whenever there is a kickoff", () => {
    expect(gameAvailability({ kickoffAt: 1_767_000_000, byeWeek: 7, week: 16 })).toBe("SCHEDULED");
  });

  it("accepts a Date as well as an epoch second", () => {
    expect(gameAvailability({ kickoffAt: new Date("2026-12-27T18:00:00Z"), byeWeek: null, week: 16 })).toBe(
      "SCHEDULED",
    );
  });

  it("still calls it scheduled in the team's own bye week, because the row wins", () => {
    // Contradictory inputs, and the fixture is the fact. A game row in the bye
    // week means the bye moved, not that the game is imaginary.
    expect(gameAvailability({ kickoffAt: 1_767_000_000, byeWeek: 16, week: 16 })).toBe("SCHEDULED");
  });

  it("calls a stored fixture with a provisional kickoff TIME_TBD", () => {
    // The row exists and carries a conservative stand-in. Reporting it as
    // SCHEDULED would let the screen print an hour nobody has announced.
    expect(
      gameAvailability({ kickoffAt: 1_767_000_000, kickoffTbd: true, byeWeek: 11, week: 16 }),
    ).toBe("TIME_TBD");
  });

  it("prefers TIME_TBD over the bye week, because the fixture is the fact", () => {
    expect(
      gameAvailability({ kickoffAt: 1_767_000_000, kickoffTbd: true, byeWeek: 16, week: 16 }),
    ).toBe("TIME_TBD");
  });

  it("treats an absent kickoffTbd as a real kickoff", () => {
    // Callers written before the flag existed keep their answer, rather than
    // every fixture silently downgrading to provisional.
    expect(gameAvailability({ kickoffAt: 1_767_000_000, byeWeek: 11, week: 16 })).toBe(
      "SCHEDULED",
    );
  });

  it("reports a bye when the missing week is the team's bye week", () => {
    expect(gameAvailability({ kickoffAt: null, byeWeek: 7, week: 7 })).toBe("BYE");
  });

  it("reports unscheduled when the team's bye is a different week", () => {
    // The live case: Tampa Bay have no week 16 fixture and their bye was week 11.
    expect(gameAvailability({ kickoffAt: null, byeWeek: 11, week: 16 })).toBe("UNSCHEDULED");
  });

  it("falls back to a bye when the bye week is unknown", () => {
    // Never claim a fixture is coming on the strength of data we do not hold.
    expect(gameAvailability({ kickoffAt: null, byeWeek: null, week: 16 })).toBe("BYE");
  });

  it("treats any non-bye gap as unscheduled, early weeks included", () => {
    // Not only the late-December case. A week 3 hole is a likelier sign of a
    // broken ingest than a fixture the NFL has not dated, and both want saying
    // out loud rather than rendering as a restful afternoon.
    expect(gameAvailability({ kickoffAt: null, byeWeek: 11, week: 3 })).toBe("UNSCHEDULED");
  });
});
