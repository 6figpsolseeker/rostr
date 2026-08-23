import { describe, expect, it } from "vitest";
import { leagueSubtitle } from "./chrome";

describe("leagueSubtitle", () => {
  it("reads as a sentence about the league", () => {
    expect(leagueSubtitle({ season: 2026, taken: 5, maxTeams: 12, state: "FORMING" })).toBe(
      "2026 season · 5/12 teams · forming",
    );
  });

  it("replaces every underscore, not only the first", () => {
    // `replace` without a global flag takes the first occurrence only. No state
    // in the enum has two today, so this pins the behaviour before one does —
    // the league home's inline version used single `replace` and would not.
    expect(leagueSubtitle({ season: 2026, taken: 12, maxTeams: 12, state: "A_B_C" })).toContain(
      "a b c",
    );
  });

  it("renders IN_SEASON as words rather than an enum", () => {
    expect(leagueSubtitle({ season: 2026, taken: 12, maxTeams: 12, state: "IN_SEASON" })).toBe(
      "2026 season · 12/12 teams · in season",
    );
  });

  it("says a full league is full rather than hiding the count", () => {
    expect(
      leagueSubtitle({ season: 2026, taken: 12, maxTeams: 12, state: "DRAFTING" }),
    ).toContain("12/12 teams");
  });

  it("says zero rather than omitting an empty league's count", () => {
    // A league with no teams is the commissioner's own first view of it.
    expect(
      leagueSubtitle({ season: 2026, taken: 0, maxTeams: 10, state: "FORMING" }),
    ).toContain("0/10 teams");
  });
});
