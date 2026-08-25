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

describe("retrying a request — #97", () => {
  /*
    The client threw on the first 429 and on any non-OK response. No retry, no
    backoff, no pacing — while randomness.ts has given the Solana beacon three
    attempts with a doubling backoff since it was written, for the same exposure.

    It did not matter while every sync was operator-run and infrequent.
    syncBoxScores is the first caller to make bursts of sequential calls on a
    schedule, one per game, at the top of a ten-minute tick.

    And since #140 a dropped game is no longer merely missing: a FINAL game with
    no box score holds the whole week from finalising until the correction window
    runs out, so one unretried 429 on a Sunday costs either a week that will not
    settle or one that settles with those players at zero permanently.
  */

  /** Fails the first `failures` calls with `status`, then succeeds. */
  function flaky(failures: number, status: number) {
    let calls = 0;
    const impl = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls <= failures) {
        return Promise.resolve({
          ok: false,
          status,
          text: () => Promise.resolve(""),
          json: () => Promise.resolve({}),
          headers: new Headers({}),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({ statusCode: 200, body: ["ok"] }),
        headers: new Headers({}),
      } as Response);
    });
    return impl;
  }

  /** No wall-clock cost, and it records the waits so the shape can be asserted. */
  /** A 429 carrying the headers RapidAPI sends when the window is spent. */
  function spentQuota(resetSeconds: string) {
    return vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({
          "x-ratelimit-requests-limit": "1000",
          "x-ratelimit-requests-remaining": "0",
          "x-ratelimit-requests-reset": resetSeconds,
        }),
        json: () => Promise.resolve({}),
      } as unknown as Response),
    );
  }

  function recordingSleep() {
    const waits: number[] = [];
    return {
      waits,
      sleepImpl: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    };
  }

  it("succeeds after a transient 429", async () => {
    const fetchImpl = flaky(1, 429);
    const { sleepImpl } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.get("getNFLBoxScore")).resolves.toEqual(["ok"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off by doubling, rather than hammering", async () => {
    // Matches randomness.ts: 200ms then 400ms. Asserted rather than assumed,
    // because a retry with no wait is a way to meet a burst limit faster.
    const fetchImpl = flaky(2, 429);
    const { waits, sleepImpl } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await client.get("getNFLBoxScore");
    expect(waits).toEqual([200, 400]);
  });

  it("gives up after the third attempt and reports the real reason", async () => {
    const fetchImpl = flaky(99, 429);
    const { sleepImpl } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.get("getNFLBoxScore")).rejects.toThrow(/HTTP 429/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a 5xx", async () => {
    const fetchImpl = flaky(1, 503);
    const { sleepImpl } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.get("getNFLBoxScore")).resolves.toEqual(["ok"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected key", async () => {
    /*
      The narrowness that keeps a clear failure from becoming a slow one. A 401
      answers identically however many times it is asked, and three attempts
      with backoff would delay the one error an operator can actually act on.
    */
    const fetchImpl = flaky(99, 401);
    const { sleepImpl } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.get("getNFLBoxScore")).rejects.toThrow(/rejected the API key/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 404", async () => {
    const fetchImpl = flaky(99, 404);
    const { sleepImpl } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.get("getNFLBoxScore")).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown transport error", async () => {
    // A socket reset mid-Sunday is exactly the transient this exists for, and it
    // never reaches a status code at all.
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({ statusCode: 200, body: ["ok"] }),
        headers: new Headers({}),
      } as Response);
    });
    const { sleepImpl } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.get("getNFLBoxScore")).resolves.toEqual(["ok"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("waits for real when nothing injects a clock", async () => {
    /*
      **The production backoff, which every other test here replaces.**

      All the retry cases inject `sleepImpl`, so they assert that the client
      *computes* 200 and 400 and hands them to something — not that anything
      waits. Defaulting the sleep to `() => Promise.resolve()` passed all
      nineteen of them, and a retry with no wait is a way to meet a burst limit
      three times faster, which is the failure the retry exists to avoid.

      Measured loosely: the assertion is that time passed at all, not how much.
      A tighter bound would be a timing flake on a busy machine, and zero versus
      six hundred milliseconds is the distinction worth having.
    */
    const fetchImpl = flaky(1, 429);
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    const started = Date.now();
    await client.get("getNFLBoxScore", { gameID: "g" });

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("does not retry a 429 whose window is hours away", async () => {
    /*
      A burst limit and a spent quota both arrive as 429 and need opposite
      answers — the throw site says so in as many words, and then retried both.

      With `remaining: 0` and a reset measured in hours, two more calls at 200ms
      and 400ms cannot succeed. They are spent on the allowance that just
      refused, at the moment it has none left, and the next tick will ask again
      in ten minutes regardless.
    */
    const fetchImpl = spentQuota("54213");
    const client = new Tank01Client({ apiKey: "k", fetchImpl });

    await expect(client.get("getNFLBoxScore", { gameID: "g" })).rejects.toThrow(/429/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still retries a 429 whose window rolls in seconds", async () => {
    // The other side of the same header. A burst limit is exactly what the
    // retry is for, and refusing to retry it would be the fix overshooting.
    const fetchImpl = spentQuota("3");
    const client = new Tank01Client({ apiKey: "k", fetchImpl, ...recordingSleep() });

    await expect(client.get("getNFLBoxScore", { gameID: "g" })).rejects.toThrow(/429/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries every 5xx, not only the one a test happened to stage", async () => {
    /*
      The predicate was a regex over the message — `/HTTP 5[0-9][0-9]/` — and 503
      was the only status any test staged, so narrowing it to `/HTTP 503/` was
      green. 500, 502 and 504 are the ordinary gateway failures and would have
      silently stopped retrying, with a test still named "retries a 5xx".
    */
    for (const status of [500, 502, 504]) {
      const fetchImpl = flaky(1, status);
      const client = new Tank01Client({ apiKey: "k", fetchImpl, ...recordingSleep() });

      await expect(client.get("getNFLBoxScore", { gameID: "g" })).resolves.toBeDefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("retries a connection lost while the body is arriving", async () => {
    /*
      **The half of "a socket reset mid-Sunday" that was not covered.**

      `fetch` resolves at the headers and streams the rest, so a reset partway
      through rejects at `response.json()` rather than at the call — and a box
      score is the largest response this client asks for, tens of kilobytes over
      many packets, which is precisely where it happens. The parse sat outside
      every `try`, so it arrived as a bare `TypeError`, failed the
      `instanceof ProviderError` check, and was thrown on attempt one.

      The existing transport test resets at connection time, which is the shape
      that was already handled.
    */
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({}),
        json: () =>
          calls === 1
            ? Promise.reject(new TypeError("terminated"))
            : Promise.resolve({ statusCode: 200, body: { ok: true } }),
      } as unknown as Response);
    });

    const client = new Tank01Client({ apiKey: "k", fetchImpl, ...recordingSleep() });

    await expect(client.get("getNFLBoxScore", { gameID: "g" })).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error Tank01 states in a 200 body", async () => {
    /*
      The predicate used to substring-match the message for "failed", and this
      site interpolates provider text into it — so a Tank01 error string
      containing that word decided our retry policy. Its comment claimed the
      message was "composed in one place below", which this line disproves.

      Deterministic errors about the request answer the same however often they
      are asked.
    */
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({}),
        json: () => Promise.resolve({ statusCode: 200, error: "Request failed: bad gameID" }),
      } as unknown as Response),
    );

    const client = new Tank01Client({ apiKey: "k", fetchImpl, ...recordingSleep() });

    await expect(client.get("getNFLBoxScore", { gameID: "g" })).rejects.toThrow(/bad gameID/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit declared inside a 200 body", async () => {
    /*
      The narrowing `randomness.ts` was rewritten to add, and CLAUDE.md records
      the cost of not having: some providers answer a rate limit as HTTP 200
      with the limit in the error body, "where the HTTP-status retry never sees
      it" — so the retry never fires for the case it was added for.

      `statusCode` has been on this envelope since it was written and was read
      nowhere. Whether Tank01 uses it this way is unverified; handling it costs
      nothing and not handling it costs the whole point.
    */
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({}),
        json: () =>
          Promise.resolve(
            calls === 1
              ? { statusCode: 429, error: "Too many requests" }
              : { statusCode: 200, body: { ok: true } },
          ),
      } as unknown as Response);
    });

    const client = new Tank01Client({ apiKey: "k", fetchImpl, ...recordingSleep() });

    await expect(client.get("getNFLBoxScore", { gameID: "g" })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a nonsense attempt count as the default rather than throwing nothing", async () => {
    // `options.attempts ?? REQUEST_ATTEMPTS` let 0 and NaN through, the loop ran
    // zero times, and `throw lastError` threw `undefined` — no HTTP call, and
    // recorded downstream as the literal string "undefined".
    const fetchImpl = flaky(1, 429);
    const client = new Tank01Client({
      apiKey: "k",
      fetchImpl,
      attempts: 0,
      ...recordingSleep(),
    });

    // Clamped to one attempt, not zero: it makes a real call and throws a real
    // error. Before, it made none and threw `undefined`.
    await expect(client.get("getNFLBoxScore", { gameID: "g" })).rejects.toThrow(/429/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("doubles the wait rather than adding to it", async () => {
    // Two waits cannot tell 200·2^n from 200·n — they are 200 and 400 either
    // way. A fourth attempt separates them, which is what the injectable
    // `attempts` was added for and what no test used.
    const { sleepImpl, waits } = recordingSleep();
    const client = new Tank01Client({
      apiKey: "k",
      fetchImpl: flaky(99, 429),
      attempts: 4,
      sleepImpl,
    });

    await expect(client.get("getNFLBoxScore", { gameID: "g" })).rejects.toThrow(/429/);
    expect(waits).toEqual([200, 400, 800]);
  });
});
