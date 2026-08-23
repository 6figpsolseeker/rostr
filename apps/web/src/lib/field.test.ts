import { describe, expect, it } from "vitest";
import { fieldVerdict } from "./field";

describe("fieldVerdict", () => {
  it("says nothing about an even field", () => {
    expect(fieldVerdict({ humans: 12, hasBot: false, maxBots: 1 })).toEqual({ kind: "SQUARE" });
  });

  it("offers the bot when the field is odd and the rules permit one", () => {
    expect(fieldVerdict({ humans: 5, hasBot: false, maxBots: 1 })).toEqual({
      kind: "ODD_ADD_BOT",
      humans: 5,
    });
  });

  it("asks for a person when no bot is possible", () => {
    // A pot league. `maxBots` is zero because a bot has no wallet, so the only
    // way to square the field is a twelfth manager.
    expect(fieldVerdict({ humans: 5, hasBot: false, maxBots: 0 })).toEqual({
      kind: "ODD_NEEDS_HUMAN",
      humans: 5,
    });
  });

  it("asks for the bot to go when the field is odd and it is already seated", () => {
    // Five plus a bot, then a sixth manager joins: seven humans, bot still
    // seated. Adding another would be refused by BOT_LIMIT, so the offer has to
    // be the opposite one.
    expect(fieldVerdict({ humans: 7, hasBot: true, maxBots: 1 })).toEqual({
      kind: "ODD_REMOVE_BOT",
      humans: 7,
    });
  });

  it("counts humans, not rows: five managers and a bot is still odd", () => {
    // The mutation this file exists to catch. Six rows read as even and the
    // league is told it can draft; `drawDraftOrder` then refuses ODD_FIELD.
    expect(fieldVerdict({ humans: 5, hasBot: true, maxBots: 1 }).kind).not.toBe("SQUARE");
  });

  it("leaves an even field alone even when a bot is seated", () => {
    // Five managers plus a bot is the *intended* end state. Nothing to report.
    expect(fieldVerdict({ humans: 6, hasBot: true, maxBots: 1 })).toEqual({ kind: "SQUARE" });
  });

  it("says nothing about an empty league", () => {
    expect(fieldVerdict({ humans: 0, hasBot: false, maxBots: 1 })).toEqual({ kind: "SQUARE" });
  });
});
