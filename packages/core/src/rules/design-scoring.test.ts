import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NFL_PPR_SCORING } from "./nfl-ppr.js";
import type { ScoringRule } from "./types.js";

/**
 * The design handoff prints the scoring table. This checks it still says what
 * the rule set says.
 *
 * ## Why a test rather than a note
 *
 * `docs/design/screens/Rostr Create League.dc.html` has a "freeze" screen that
 * renders the full rule set for a member to read before signing. It restates
 * every scoring value as literal text — which the handoff's own README warns
 * against, in a section explaining that **nine of the twelve defects found while
 * designing these screens were the same fact authored twice**.
 *
 * It went stale within a day. The design was drawn before the ESPN alignment on
 * 2026-08-16, so it showed a shutout worth 10 when the rules had moved it to 5,
 * field goals stopping at 50+, no penalty for a miss, and no yards-allowed
 * ladder at all. Anybody implementing that screen from the design would have
 * copied numbers that were already wrong.
 *
 * ## What failure means
 *
 * Not "the design is wrong". It means the two have diverged and somebody has to
 * decide which is right:
 *
 *   - **The rules changed** — update the design file to match, as was done on
 *     2026-08-16, and record it in `docs/design/STATUS.md`.
 *   - **A new design drop landed** carrying the old table — same fix, and worth
 *     telling the designer, because the drop was authored against stale values.
 *
 * ## This does not make the screen safe to build from
 *
 * When the freeze screen is implemented it must render from `NFL_PPR_SCORING`,
 * the way `/scoring` already does — "a scoring explainer typed out by hand
 * drifts and then quietly lies to users about how they are being scored". This
 * test guards the *reference*, not the implementation.
 */

const DESIGN = fileURLToPath(
  new URL("../../../../docs/design/screens/Rostr Create League.dc.html", import.meta.url),
);

const tiersOf = (
  statKey: string,
): readonly { min: number; max: number | null; pts: number }[] => {
  const rule = NFL_PPR_SCORING.find((r: ScoringRule) => r.statKey === statKey);
  if (rule?.kind !== "TIERED") throw new Error(`${statKey} is not tiered`);
  return rule.tiers.map((t) => ({ min: t.min, max: t.max, pts: t.milliPoints / 1000 }));
};

const linear = (statKey: string): number => {
  const rule = NFL_PPR_SCORING.find((r: ScoringRule) => r.statKey === statKey);
  if (rule?.kind !== "LINEAR") throw new Error(`${statKey} is not linear`);
  return rule.milliPointsPerUnit / 1000;
};

/** The design writes negatives as U+2212, not a hyphen. */
const show = (n: number): string => (n < 0 ? `−${Math.abs(n)}` : String(n));

describe("the design handoff's scoring table matches the rule set", () => {
  const design = existsSync(DESIGN) ? readFileSync(DESIGN, "utf8") : null;

  it("finds the design file", () => {
    // If this fails the handoff moved or was removed. Do not delete this suite
    // to make it pass — either fix the path, or delete both together and say so.
    expect(design, `expected the create-league design at ${DESIGN}`).not.toBeNull();
  });

  it("prints the field goal ladder the rules define", () => {
    const values = ["fg_0_39", "fg_40_49", "fg_50_59", "fg_60_plus"].map(linear).join(" / ");
    expect(design).toContain(values);
  });

  it("prints the penalty for a missed field goal", () => {
    expect(design).toContain(show(linear("fg_missed")));
    expect(design?.includes("Field goal missed")).toBe(true);
  });

  it("prints every points-allowed tier value in order", () => {
    const tiers = tiersOf("def_pts_allowed").map((t) => show(t.pts));
    // Two rows of four in the design, so check each half as a contiguous run.
    expect(design).toContain(tiers.slice(0, 4).join(" / "));
    expect(design).toContain(tiers.slice(4).join(" / "));
  });

  it("prints the yards-allowed ladder, which the rules added", () => {
    const tiers = tiersOf("def_yds_allowed").map((t) => show(t.pts));
    expect(design).toContain(tiers.slice(0, 3).join(" / "));
    expect(design).toContain(tiers.slice(3, 6).join(" / "));
    expect(design).toContain(tiers.slice(6).join(" / "));
  });

  it("prints the offensive values", () => {
    for (const key of ["pass_td", "rush_td", "rec", "two_pt", "ret_td"]) {
      expect(design, `${key} missing from the design`).toContain(show(linear(key)));
    }
    expect(design).toContain(show(linear("pass_int")));
  });
});
