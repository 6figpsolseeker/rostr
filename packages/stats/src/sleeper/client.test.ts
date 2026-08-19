import { describe, expect, it } from "vitest";
import { SleeperClient } from "./client.js";
import { ProviderError } from "../provider.js";

/**
 * The live Sleeper client.
 *
 * Every test injects `fetch`, so this suite makes no network call and runs in
 * `pnpm test` with no credentials — the same absolute constraint the conformance
 * corpus follows, and for the same reason: CI has neither.
 *
 * The behaviour worth pinning is not "it parses JSON". It is that **silence is
 * never mistaken for agreement**. This client feeds a comparison that decides
 * whether a week may finalise, and the dangerous failure is a source that says
 * nothing being read as a source that concurs.
 */

const respond = (body: unknown, ok = true, status = 200): typeof globalThis.fetch =>
  (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof globalThis.fetch;

describe("SleeperClient.weekStats", () => {
  it("returns a week keyed by Sleeper's player id", async () => {
    const client = new SleeperClient({
      fetch: respond({ "4035": { rush_yd: 51, rush_td: 1 } }),
    });

    await expect(client.weekStats(2025, 6)).resolves.toEqual({
      "4035": { rush_yd: 51, rush_td: 1 },
    });
  });

  it("refuses an empty week rather than reporting universal agreement", async () => {
    // **The one that matters.** Sleeper answers `{}` for a week it has not
    // published. Returned as data, a comparison would find no disagreement for
    // any player and conclude the two sources concur — which is the exact
    // failure a second source exists to prevent, arriving through the door
    // marked "success".
    const client = new SleeperClient({ fetch: respond({}) });

    await expect(client.weekStats(2026, 1)).rejects.toBeInstanceOf(ProviderError);
    await expect(client.weekStats(2026, 1)).rejects.toThrow(/not agreement/);
  });

  it("refuses a body that is not a map of players", async () => {
    // An array is what a different endpoint returns, and it would iterate
    // happily into nonsense rather than failing.
    const client = new SleeperClient({ fetch: respond([1, 2, 3]) });
    await expect(client.weekStats(2025, 6)).rejects.toThrow(/not a map/);
  });

  it("reports an HTTP failure as a provider error", async () => {
    const client = new SleeperClient({ fetch: respond(null, false, 503) });
    await expect(client.weekStats(2025, 6)).rejects.toThrow(/HTTP 503/);
  });

  it("keeps the rest of a week when one row is malformed", async () => {
    // One bad row must not cost the comparison every other player in the week.
    const client = new SleeperClient({
      fetch: respond({ "4035": { rec: 5 }, broken: "not an object", "6786": { rec: 2 } }),
    });

    await expect(client.weekStats(2025, 6)).resolves.toEqual({
      "4035": { rec: 5 },
      "6786": { rec: 2 },
    });
  });

  it("accepts a numeric string rather than dropping the stat", async () => {
    // Dropping it would remove a value from one side of a comparison, which
    // reads as a disagreement we invented rather than one the data contains.
    const client = new SleeperClient({ fetch: respond({ "4035": { rec_yd: "88" } }) });
    await expect(client.weekStats(2025, 6)).resolves.toEqual({ "4035": { rec_yd: 88 } });
  });

  it("drops a field that is not a number at all", async () => {
    // `null` and `"DNP"` are not zero and must not become it — absent is not
    // zero is the rule the scoring engine already enforces.
    const client = new SleeperClient({
      fetch: respond({ "4035": { rec: 3, note: "DNP", other: null } }),
    });
    await expect(client.weekStats(2025, 6)).resolves.toEqual({ "4035": { rec: 3 } });
  });

  it("asks for the regular season explicitly", async () => {
    // Sleeper serves "post" too, and asking for the wrong one returns a valid
    // body rather than an error — silence wearing the shape of data.
    let seen = "";
    const client = new SleeperClient({
      fetch: (async (url: string) => {
        seen = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ "1": { rec: 1 } }),
        } as unknown as Response;
      }) as unknown as typeof globalThis.fetch,
    });

    await client.weekStats(2025, 11);
    expect(seen).toContain("/stats/nfl/regular/2025/11");
  });
});
