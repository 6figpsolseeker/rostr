import { describe, expect, it } from "vitest";
import { opponentLabel } from "./opponent";

describe("opponentLabel", () => {
  it("says vs at home", () => {
    expect(opponentLabel({ opponentRef: "NO", isHome: true, availability: "SCHEDULED" })).toBe(
      "vs NO",
    );
  });

  it("says @ away", () => {
    // Two facts in three characters, and the convention every fantasy site
    // already uses — a manager reading "@ KC" knows both who and where.
    expect(
      opponentLabel({ opponentRef: "MIA", isHome: false, availability: "SCHEDULED" }),
    ).toBe("@ MIA");
  });

  it("says BYE on a bye week", () => {
    expect(opponentLabel({ opponentRef: null, isHome: null, availability: "BYE" })).toBe("BYE");
  });

  it("says nothing when the fixture is simply not stored", () => {
    // The mutation this exists to catch. A bye and an un-ingested fixture both
    // arrive with no opponent and are opposite instructions: one says start
    // somebody else, the other says he will play. Rendering "BYE" here would
    // bench a player who is going to take the field.
    expect(
      opponentLabel({ opponentRef: null, isHome: null, availability: "UNSCHEDULED" }),
    ).toBeNull();
  });

  it("still names the opponent when only the kickoff hour is unknown", () => {
    // TIME_TBD is a real fixture whose hour the NFL has not fixed. The opponent
    // is known and worth showing — withholding it would treat "we don't know
    // when" as "we don't know who".
    expect(opponentLabel({ opponentRef: "SEA", isHome: true, availability: "TIME_TBD" })).toBe(
      "vs SEA",
    );
  });

  it("prefers BYE over a stale opponent", () => {
    // Belt and braces: availability decides first, so a leftover fixture row
    // cannot make a bye week look playable.
    expect(opponentLabel({ opponentRef: "NO", isHome: true, availability: "BYE" })).toBe("BYE");
  });
});
