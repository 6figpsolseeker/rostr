import { describe, expect, it } from "vitest";
import { START_GRACE_SECONDS, seasonStartState, startDeadlineFor } from "./start.js";

/** An arbitrary draft time. Only the arithmetic around it matters. */
const DRAFT = 1_787_000_000;
const DEADLINE = DRAFT + START_GRACE_SECONDS;

describe("startDeadlineFor", () => {
  it("is the draft time plus 48 hours", () => {
    expect(startDeadlineFor(DRAFT)).toBe(DRAFT + 48 * 60 * 60);
  });

  it("is what the anchor route and the lobby both derive from", () => {
    // Stated as a property rather than a number: the account's
    // `start_deadline` is compared against this on anchoring, so a change here
    // that was not a deliberate protocol change would refuse every league
    // anchored under the old value — permanently, since there is no re-anchor.
    expect(startDeadlineFor(DRAFT)).toBe(DEADLINE);
  });
});

describe("seasonStartState", () => {
  const state = (over: Partial<Parameters<typeof seasonStartState>[0]> = {}) =>
    seasonStartState({
      hasPot: true,
      started: false,
      startDeadline: DEADLINE,
      now: DRAFT + 60,
      ...over,
    });

  it("is NOT_REQUIRED for a free league", () => {
    // `start_season` requires `has_pot`, so there is no instruction to send and
    // no vault for it to protect. Asking for a wallet approval here would be a
    // popup that changes nothing.
    expect(state({ hasPot: false })).toBe("NOT_REQUIRED");
  });

  it("is NOT_REQUIRED for a free league even past its deadline", () => {
    // A free league carries `start_deadline: 0` on-chain, so every instant is
    // "past" it. Reading that as MISSED would tell a perfectly healthy free
    // league it could never draft.
    expect(state({ hasPot: false, startDeadline: 0, now: DRAFT })).toBe("NOT_REQUIRED");
  });

  it("is OPEN before the deadline", () => {
    expect(state({ now: DEADLINE - 1 })).toBe("OPEN");
  });

  it("is MISSED from the deadline itself", () => {
    // The program requires `now < league.start_deadline`, so at the deadline the
    // transaction is already refused. A UI still offering the button here would
    // send one the chain rejects.
    expect(state({ now: DEADLINE })).toBe("MISSED");
    expect(state({ now: DEADLINE + 1 })).toBe("MISSED");
  });

  it("is STARTED regardless of the clock", () => {
    // Nothing unsets `started`. A state that flipped to MISSED at the deadline
    // would tell a live season its stakes were refundable, which is the exact
    // claim the failed-league refund must never make about a running league.
    expect(state({ started: true, now: DEADLINE + 10_000 })).toBe("STARTED");
    expect(state({ started: true, now: DRAFT - 10_000 })).toBe("STARTED");
  });

  it("never reports a free league as started", () => {
    // `initialize_free_league` writes `started: false` and there is no
    // instruction that could change it, so a `true` here would be a decoding
    // bug rather than a fact — and "not required" is the honest answer either
    // way.
    expect(state({ hasPot: false, started: true })).toBe("NOT_REQUIRED");
  });
});
