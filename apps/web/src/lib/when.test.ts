import { describe, expect, it } from "vitest";
import { withZone } from "./when.js";

/**
 * The checklist's draft deadline, formatted.
 *
 * This file exists because the formatter shipped inside a `.tsx` component and
 * threw on every single call — `dateStyle`/`timeStyle` combined with
 * `timeZoneName` is a `TypeError` by specification. It typechecked, passed the
 * whole suite, and produced a 500 the first time a commissioner opened their
 * own league page, because `apps/web` has no jsdom and nothing in a component
 * can be exercised by a test.
 *
 * The first assertion below is the one that matters: it simply calls the thing.
 */

const AT = new Date("2026-08-25T18:00:00Z");

describe("withZone", () => {
  it("does not throw", () => {
    // The whole bug. `dateStyle` + `timeZoneName` threw here on every render,
    // in every runtime, and no gate in this repo could see it.
    expect(() => withZone(AT)).not.toThrow();
  });

  it("names the zone, because the reader's clock is not the server's", () => {
    // Without this the commissioner sees a bare wall-clock time formatted in
    // Node's locale — UTC on Vercel — and reads it as their own.
    expect(withZone(AT)).toMatch(/\b(UTC|GMT|[A-Z]{2,5}T|[A-Z]{3,4})\b/);
  });

  it("carries the date and the time", () => {
    const formatted = withZone(AT);
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/\d{1,2}:\d{2}/);
  });

  it("survives every hour of the day, including midnight and noon", () => {
    // `hour: "numeric"` with a 12-hour locale renders midnight as 12 AM; a
    // formatter that throws or blanks on an edge hour would only be found by
    // someone scheduling a draft at exactly that time.
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(Date.UTC(2026, 7, 25, hour, 0, 0));
      expect(() => withZone(at)).not.toThrow();
      expect(withZone(at).length).toBeGreaterThan(10);
    }
  });

  it("survives a date either side of a daylight-saving change", () => {
    // US DST ends 1 November 2026. The zone abbreviation differs on each side,
    // which is the point of printing it at all.
    expect(() => withZone(new Date("2026-10-31T18:00:00Z"))).not.toThrow();
    expect(() => withZone(new Date("2026-11-02T18:00:00Z"))).not.toThrow();
  });
});
