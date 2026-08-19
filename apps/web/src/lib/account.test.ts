import { describe, expect, it } from "vitest";
import {
  accountComplete,
  accountGapMessage,
  accountGaps,
  completionPath,
  type AccountGap,
} from "./account.js";

describe("accountGaps", () => {
  it("finds nothing wrong with a finished account", () => {
    expect(accountGaps({ username: "route66", verifiedWallets: 1 })).toEqual([]);
    expect(accountComplete({ username: "route66", verifiedWallets: 1 })).toBe(true);
  });

  it("asks for a username before a wallet", () => {
    // Username first because it costs a keystroke and no popup, and because
    // somebody who stops after picking one is still reachable — a commissioner
    // can invite them and the invitation waits.
    expect(accountGaps({ username: null, verifiedWallets: 0 })).toEqual(["USERNAME", "WALLET"]);
  });

  it("asks only for what is missing", () => {
    expect(accountGaps({ username: null, verifiedWallets: 2 })).toEqual(["USERNAME"]);
    expect(accountGaps({ username: "route66", verifiedWallets: 0 })).toEqual(["WALLET"]);
  });

  it("treats a blank username as no username", () => {
    // The column is nullable and the CHECK refuses whitespace, but a row written
    // before either existed must not read as complete.
    expect(accountGaps({ username: "   ", verifiedWallets: 1 })).toEqual(["USERNAME"]);
  });
});

describe("accountGapMessage", () => {
  it("names the next action rather than the state", () => {
    for (const gap of ["USERNAME", "WALLET"] as AccountGap[]) {
      expect(accountGapMessage(gap).length).toBeGreaterThan(0);
    }
    expect(accountGapMessage("USERNAME")).not.toBe(accountGapMessage("WALLET"));
  });
});

describe("completionPath", () => {
  it("says nothing for a finished account", () => {
    expect(completionPath({ username: "route66", verifiedWallets: 1 })).toBeNull();
  });

  it("sends an unfinished account to welcome", () => {
    expect(completionPath({ username: null, verifiedWallets: 0 })).toBe("/welcome");
  });

  it("carries where they were going", () => {
    expect(completionPath({ username: null, verifiedWallets: 0 }, "/leagues/abc")).toBe(
      "/welcome?next=%2Fleagues%2Fabc",
    );
  });

  it("encodes the destination rather than splicing it in raw", () => {
    // An unencoded `next` carrying its own query string would truncate at the
    // first `&`, landing somebody somewhere other than where they were headed.
    expect(completionPath({ username: null, verifiedWallets: 0 }, "/x?a=1&b=2")).toBe(
      "/welcome?next=%2Fx%3Fa%3D1%26b%3D2",
    );
  });
});
