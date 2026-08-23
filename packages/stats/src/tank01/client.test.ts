import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../provider.js";
import { Tank01Client } from "./client.js";

function mockFetch(
  response: Omit<Partial<Response>, "headers"> & {
    json?: () => Promise<unknown>;
    /** Plain object for convenience; the client reads it through `.get`. */
    headers?: Record<string, string>;
  } = {},
) {
  const { headers, ...rest } = response;
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({ statusCode: 200, body: [] }),
    ...rest,
    // A real `Headers`, because the client calls `.get` on it. A plain object
    // would pass typing here and throw at the one line under test.
    headers: new Headers(headers ?? {}),
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

  it("reports the rate-limit headers rather than a guess at the plan", async () => {
    // It used to assert "the Basic tier allows 1,000 calls/month" on every 429,
    // which sent somebody to check a monthly quota on an upgraded account when
    // the real cause was a burst limit. The headers say which.
    const fetchImpl = mockFetch({
      ok: false,
      status: 429,
      headers: {
        "x-ratelimit-requests-limit": "1000",
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "54213",
      },
    });
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    await expect(client.get("getNFLTeams")).rejects.toThrow(/0 of 1000 requests left/);
  });

  it("says so when a 429 carries no headers, because that is a different problem", async () => {
    // No headers is the shape of a per-second burst limit, which needs a wait of
    // a second rather than a wait for the quota window.
    const fetchImpl = mockFetch({ ok: false, status: 429 });
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    await expect(client.get("getNFLTeams")).rejects.toThrow(/burst limit/);
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

// Stat mapping is covered in stat-map.test.ts, against field names verified
// from a live box score.
