import { describe, expect, it } from "vitest";
import { decidedByLabel } from "./tiebreakers";

describe("decidedByLabel", () => {
  it("labels nothing before a game is played", () => {
    expect(decidedByLabel("LOWEST_TEAM_ID", 0)).toBeNull();
  });

  it("names the tiebreaker once there are results", () => {
    expect(decidedByLabel("POINTS_FOR", 3)).toBe("on points for");
  });

  it("labels nothing for a row no tiebreaker separated", () => {
    expect(decidedByLabel(null, 3)).toBeNull();
  });
});
