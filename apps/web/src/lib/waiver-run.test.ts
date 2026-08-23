import { describe, expect, it } from "vitest";
import { runSummary, whyClaimFailed } from "./waiver-run";

describe("whyClaimFailed", () => {
  it("distinguishes losing a contest from making a mistake", () => {
    // The whole argument for storing the reason. One is the rules working, the
    // other is something the manager will repeat next Wednesday unless told.
    expect(whyClaimFailed("PLAYER_TAKEN")).toContain("better priority");
    expect(whyClaimFailed("ROSTER_FULL")).toContain("roster was full");
    expect(whyClaimFailed("PLAYER_TAKEN")).not.toBe(whyClaimFailed("ROSTER_FULL"));
  });

  it("explains a stale drop", () => {
    expect(whyClaimFailed("DROP_NOT_ON_ROSTER")).toContain("no longer on your roster");
  });

  it("explains a player who was never available", () => {
    expect(whyClaimFailed("ALREADY_ROSTERED")).toContain("already held him");
  });

  it("admits an unrecorded reason rather than inventing one", () => {
    // A claim settled before `0039`. Making up a cause would be the silent
    // restatement this project exists to prevent.
    expect(whyClaimFailed(null)).toContain("did not record why");
  });

  it("never shows a raw code to a manager", () => {
    // `failure_reason` is free text on purpose, so a new mode needs no
    // migration — which means this must survive one it has never seen.
    const sentence = whyClaimFailed("SOME_FUTURE_CODE");
    expect(sentence).not.toContain("SOME_FUTURE_CODE");
    expect(sentence).toContain("did not succeed");
  });
});

describe("runSummary", () => {
  it("gives both numbers, so losing is legible", () => {
    // "1 awarded" alone hides how contested the run was, and how contested it
    // was is what makes a loss make sense.
    expect(runSummary({ total: 3, awarded: 1 })).toBe("3 claims · 1 awarded");
  });

  it("counts one claim in the singular", () => {
    expect(runSummary({ total: 1, awarded: 1 })).toBe("1 claim · 1 awarded");
  });

  it("reports a run in which nobody won", () => {
    expect(runSummary({ total: 2, awarded: 0 })).toBe("2 claims · 0 awarded");
  });
});
