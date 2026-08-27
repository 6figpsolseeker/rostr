import { describe, expect, it } from "vitest";
import { previewHeading, whyNot } from "./autofill";

describe("whyNot", () => {
  it("names the ranking the league actually froze", () => {
    // "Projected lower" and "averaging lower" are different claims, and a
    // SEASON_AVERAGE league making the first one would be describing a number
    // its autofill does not consult.
    expect(whyNot("LOWER_RANKED", "WEEKLY_PROJECTION")).toBe("projected lower");
    expect(whyNot("LOWER_RANKED", "SEASON_AVERAGE")).toBe("averaging lower");
  });

  it("says unavailable without reference to the ranking", () => {
    // A player on a bye did not lose on points, and saying so would invite a
    // manager to argue with a comparison that never happened.
    expect(whyNot("UNAVAILABLE", "WEEKLY_PROJECTION")).toBe("on a bye or out this week");
    expect(whyNot("UNAVAILABLE", "SEASON_AVERAGE")).toBe("on a bye or out this week");
  });

  it("admits when there is nothing to rank on", () => {
    expect(whyNot("NO_DATA", "WEEKLY_PROJECTION")).toBe("has no projection this week");
    expect(whyNot("NO_DATA", "SEASON_AVERAGE")).toBe("has not played yet this season");
  });
});

describe("previewHeading", () => {
  it("says nothing when the lineup is complete", () => {
    expect(previewHeading({ enabled: true, emptySlots: 0 })).toBeNull();
    expect(previewHeading({ enabled: false, emptySlots: 0 })).toBeNull();
  });

  it("describes what will happen when autofill is on", () => {
    expect(previewHeading({ enabled: true, emptySlots: 2 })).toBe(
      "2 empty slots, and what autofill would do with them:",
    );
  });

  it("does not promise every empty slot gets filled", () => {
    /*
      It used to say "Autofill will fill 2 empty slots at kickoff". Both halves
      were wrong once the autofill stopped starting players whose games had
      kicked off: the list below can now say a slot stays empty, and the fill
      does not run at kickoff — it runs on the scoring passes through the week.
      A heading that contradicts the list under it is worse than a vague one.
    */
    const heading = previewHeading({ enabled: true, emptySlots: 2 });
    expect(heading).not.toContain("will fill");
    expect(heading).not.toContain("at kickoff");
  });

  it("warns rather than predicts when autofill is off", () => {
    // The mutation this exists to catch. Describing what the autofill "would"
    // do on a team that has it switched off is describing something that is not
    // going to happen — and the slot scores zero instead.
    const heading = previewHeading({ enabled: false, emptySlots: 2 });
    expect(heading).toBe("2 slots are empty and will score nothing — autofill is off.");
    expect(heading).not.toContain("will fill");
  });

  it("counts one slot in the singular, both ways round", () => {
    expect(previewHeading({ enabled: true, emptySlots: 1 })).toContain("1 empty slot,");
    expect(previewHeading({ enabled: false, emptySlots: 1 })).toContain("1 slot is empty");
  });
});
