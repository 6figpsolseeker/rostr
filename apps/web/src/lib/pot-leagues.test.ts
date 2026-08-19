import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POT_LEAGUES_COMING_SOON, potLeagueGate } from "@rostr/escrow";

/**
 * The create route refuses a pot, and the screen is not the only thing stopping
 * one.
 *
 * Same tripwire shape as `league-read.test.ts`, and for the same reason: the
 * behaviour that matters lives in a route handler this app cannot execute in a
 * test — both vitest projects are node-environment with no jsdom, and the
 * handler wants a Next request and a database. So what is checked mechanically
 * is that the guard is *there*, because the failure that actually happens is
 * somebody disabling the control on the form and calling it done.
 *
 * `POST /api/leagues` is reachable with curl. A disabled radio button is not a
 * refusal.
 */

const ROUTE = fileURLToPath(new URL("../app/api/leagues/route.ts", import.meta.url));
const FORM = fileURLToPath(new URL("../components/CreateLeagueForm.tsx", import.meta.url));

describe("pot leagues are closed at the server, not only on the screen", () => {
  it("has the create route consult the gate", () => {
    expect(readFileSync(ROUTE, "utf8")).toMatch(/potLeagueGate\(\)/);
  });

  it("refuses before it reaches createLeague", () => {
    /*
      Order matters here in a way the gate alone cannot express. `createLeague`
      validates, hashes, freezes and writes in one transaction — there is no
      state in which a league exists with rules that were never checked, and no
      way to amend one afterwards. A guard placed after it would refuse a league
      that already existed.
    */
    const source = readFileSync(ROUTE, "utf8");
    expect(source.indexOf("potLeagueGate()")).toBeGreaterThan(-1);
    expect(source.indexOf("potLeagueGate()")).toBeLessThan(
      source.indexOf("await createLeague("),
    );
  });

  it("answers with the same sentence the form shows", () => {
    // A creator who is told "coming soon" by the screen and something else by
    // the API has been told the feature is broken. Both read the constant.
    expect(readFileSync(ROUTE, "utf8")).toMatch(/POT_LEAGUES_COMING_SOON/);
    expect(readFileSync(FORM, "utf8")).toMatch(/POT_LEAGUES_COMING_SOON/);
    expect(potLeagueGate().open).toBe(false);
    expect(POT_LEAGUES_COMING_SOON.length).toBeGreaterThan(20);
  });

  it("still builds no pot terms even if the control were bypassed", () => {
    // The form closes the outcome as well as the route — a stale `withPot`
    // cannot reach a previewed hash. Closing the door and closing the outcome
    // are different jobs; this pins the second.
    expect(readFileSync(FORM, "utf8")).toMatch(/if \(!POT_LEAGUES_OPEN\) return null;/);
  });
});
