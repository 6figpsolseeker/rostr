import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../provider.js";
import { Tank01Client } from "./client.js";
import { bucketFieldGoal, TANK01_STAT_MAP } from "./stat-map.js";

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({ statusCode: 200, body: [] }),
    ...response,
  } as Response);
}

describe("Tank01Client", () => {
  it("requires an API key", () => {
    expect(() => new Tank01Client({ apiKey: "" })).toThrow(ProviderError);
  });

  it("sends the RapidAPI headers", async () => {
    const fetchImpl = mockFetch({});
    const client = new Tank01Client({ apiKey: "test-key", fetchImpl });
    await client.get("getNFLTeams");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toContain("tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com");
    expect(headers["X-RapidAPI-Key"]).toBe("test-key");
    expect(headers["X-RapidAPI-Host"]).toContain("rapidapi.com");
  });

  it("passes query parameters", async () => {
    const fetchImpl = mockFetch({});
    const client = new Tank01Client({ apiKey: "k", fetchImpl });
    await client.get("getNFLGamesForWeek", { week: "3", season: "2026" });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("week=3");
    expect(url).toContain("season=2026");
  });

  it("unwraps the body envelope", async () => {
    const fetchImpl = mockFetch({
      json: () => Promise.resolve({ statusCode: 200, body: [{ teamAbv: "PHI" }] }),
    });
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    expect(await client.get("getNFLTeams")).toEqual([{ teamAbv: "PHI" }]);
  });

  it("explains an auth failure in terms of what to fix", async () => {
    // The most likely first-run mistake is subscribing to the wrong Tank01
    // sport, so the error says so rather than just reporting 403.
    const fetchImpl = mockFetch({ ok: false, status: 403 });
    const client = new Tank01Client({ apiKey: "bad", fetchImpl });

    await expect(client.get("getNFLTeams")).rejects.toThrow(/own subscription/);
  });

  it("names the free-tier ceiling when rate limited", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429 });
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    await expect(client.get("getNFLTeams")).rejects.toThrow(/1,000 calls\/month/);
  });

  it("surfaces an error inside a 200 response", async () => {
    const fetchImpl = mockFetch({
      json: () => Promise.resolve({ statusCode: 200, error: "Invalid gameID" }),
    });
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    await expect(client.get("getNFLBoxScore")).rejects.toThrow(/Invalid gameID/);
  });

  it("wraps a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    await expect(client.get("getNFLTeams")).rejects.toThrow(ProviderError);
  });
});

describe("healthCheck", () => {
  it("reports success with a team count", async () => {
    const fetchImpl = mockFetch({
      json: () => Promise.resolve({ body: Array.from({ length: 32 }, () => ({})) }),
    });
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    const health = await client.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("32");
  });

  it("reports failure without throwing", async () => {
    // A health check that threw would be a worse diagnostic than one that
    // reports what went wrong.
    const fetchImpl = mockFetch({ ok: false, status: 403 });
    const client = new Tank01Client({ apiKey: "bad", fetchImpl });

    const health = await client.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("key");
  });

  it("flags an empty team list as not ok", async () => {
    const fetchImpl = mockFetch({ json: () => Promise.resolve({ body: [] }) });
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    expect((await client.healthCheck()).ok).toBe(false);
  });
});

describe("stat mapping", () => {
  it("buckets field goals at the right boundaries", () => {
    expect(bucketFieldGoal(0)).toBe("fg_0_39");
    expect(bucketFieldGoal(39)).toBe("fg_0_39");
    expect(bucketFieldGoal(40)).toBe("fg_40_49");
    expect(bucketFieldGoal(49)).toBe("fg_40_49");
    expect(bucketFieldGoal(50)).toBe("fg_50_plus");
    expect(bucketFieldGoal(66)).toBe("fg_50_plus");
  });

  it("maps only to registry stat keys", () => {
    // Guards the abstraction: a provider field name leaking through as a stat
    // key would put Tank01's vocabulary into the scoring engine.
    const known = new Set([
      "pass_yd",
      "pass_td",
      "pass_int",
      "rush_yd",
      "rush_td",
      "rec",
      "rec_yd",
      "rec_td",
      "def_td",
      "def_sack",
      "def_int",
      "def_fum_rec",
    ]);

    for (const statKey of Object.values(TANK01_STAT_MAP)) {
      expect(known, `unexpected stat key: ${statKey}`).toContain(statKey);
    }
  });
});
