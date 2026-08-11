import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every league-scoped route and page is gated, and this is what says so.
 *
 * `visibility` went unenforced for months not because anyone decided reads were
 * open, but because nothing ever asked the question — a route was added, it
 * loaded a league by id, and no step in review was obliged to notice. So the
 * check is mechanical: a new file under `api/leagues/[id]/` or `leagues/[id]/`
 * fails this test until it either gates or is named below with a reason.
 *
 * **This proves a call exists, not that it runs on every path.** It is a
 * tripwire against the omission, not a substitute for reading the handler — the
 * behaviour is tested in `visibility.test.ts`. Its value is that omission is the
 * failure mode that actually happened.
 */

const APP = fileURLToPath(new URL("../app/", import.meta.url));

/**
 * Any one of these means the file **refuses** somebody.
 *
 * Membership and commissionership are *stronger* than the visibility gate — a
 * handler that already turns non-members away turns away every stranger a
 * private league would have — so they satisfy this too. `leagueReadAccess` is
 * the loosest of the four and the only one PUBLIC leagues pass.
 *
 * **These match the refusal, not the identifier**, and the difference is the
 * whole point. Three routes mention `context.myTeamId` merely to label the
 * response with which team is yours, and matching the bare name marked them
 * gated when they were not — a check that looks like it asks who is asking and
 * then does nothing with the answer, which is precisely the defect this file
 * exists to catch. A test with that hole in it would have been worse than none:
 * it would have certified the exact shape of bug it is named after.
 */
const GATES = [
  /leagueReadForbidden\(/,
  /leagueReadAccess\(/,
  /if \(!\w+\.myTeamId\)/,
  /if \(!\w+\.isCommissioner\)/,
  // Derive-then-refuse: the money routes get the caller's wallet from their own
  // membership row and 403 when there isn't one. The call and the refusal are
  // matched together on purpose — `memberWallet(` alone would pass a route that
  // asked and then ignored the answer, which is the same hole `myTeamId` had.
  /memberWallet\([^)]*\);\s*if \(!\w+\)/,
];

/**
 * Deliberately open, each for a reason that is in `RULES.md` rather than in
 * somebody's head.
 *
 * Both are the *entrance*. `CLAUDE.md` and `RULES.md` require the full rule set
 * to be shown before anyone joins, and an invitee is by definition not yet a
 * member — gating these would make "shown before you join" unsatisfiable for
 * exactly the private leagues that invite links exist for.
 */
const OPEN: Record<string, string> = {
  "api/leagues/[id]/join/route.ts":
    "the join flow itself; rules must be readable before joining",
  "leagues/[id]/page.tsx": "the league page renders the rules a prospective member signs",
};

function filesUnder(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, name));
    else if (entry === name) found.push(path);
  }
  return found;
}

const leagueScoped = [
  ...filesUnder(join(APP, "api/leagues/[id]"), "route.ts"),
  ...filesUnder(join(APP, "leagues/[id]"), "page.tsx"),
].map((path) => relative(APP, path).replaceAll("\\", "/"));

describe("league-scoped routes and pages are gated", () => {
  it("finds the files at all", () => {
    // Without this, a moved directory turns the sweep below into zero
    // assertions that pass. The count is a floor, not an exact match, so adding
    // a route does not fail here — it fails in the sweep, which is the useful
    // message.
    expect(leagueScoped.length).toBeGreaterThanOrEqual(20);
  });

  it.each(leagueScoped)("%s", (path) => {
    if (path in OPEN) return;

    const source = readFileSync(join(APP, path), "utf8");
    const gate = GATES.find((g) => g.test(source));

    expect(
      gate,
      `${path} reads a league by id and asks nobody who is looking. Call ` +
        `leagueReadForbidden (routes) or leagueReadAccess (pages), or require ` +
        `membership — or add it to OPEN with a reason.`,
    ).toBeDefined();
  });

  it("has a reason recorded for every open file, and no stale entries", () => {
    // A file deleted or renamed must not leave a permanent hole behind that the
    // next file at that path silently inherits.
    for (const [path, reason] of Object.entries(OPEN)) {
      expect(leagueScoped, `${path} is in OPEN but does not exist`).toContain(path);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
