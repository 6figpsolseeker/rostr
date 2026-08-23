import { describe, expect, it } from "vitest";
import { hubView } from "./hub";

describe("hubView", () => {
  it("gives a signed-in manager with leagues the populated page", () => {
    expect(hubView({ signedIn: true, leagueCount: 2, invitationCount: 0 })).toBe("POPULATED");
  });

  it("gives a signed-in account with nothing the empty page", () => {
    expect(hubView({ signedIn: true, leagueCount: 0, invitationCount: 0 })).toBe("EMPTY");
  });

  it("treats an invitation as something, not nothing", () => {
    // The empty state asks "been invited to one?" — a question this account can
    // already see answered on the same screen.
    expect(hubView({ signedIn: true, leagueCount: 0, invitationCount: 1 })).toBe("POPULATED");
  });

  it("never calls a signed-out visitor empty", () => {
    // The mutation this file exists to catch. A signed-out visitor has zero of
    // both, so a bare count test tells them "you are not in a league yet" — a
    // claim about a person we have not identified, who may have eleven.
    expect(hubView({ signedIn: false, leagueCount: 0, invitationCount: 0 })).toBe("ANONYMOUS");
  });

  it("stays anonymous even if counts somehow arrive non-zero", () => {
    // Defensive: identity decides first. Counts belonging to nobody must never
    // promote a stranger into somebody's page.
    expect(hubView({ signedIn: false, leagueCount: 3, invitationCount: 2 })).toBe("ANONYMOUS");
  });
});
