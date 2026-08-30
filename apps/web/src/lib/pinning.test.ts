/**
 * Publishing a league's rule document.
 *
 * The property under test is not "pinning works" — `packages/pinning` covers
 * that. It is that **nothing here can cost a league**, which is forced rather
 * than chosen: `league_rules` refuses its own DELETE and holds the `leagues`
 * row via ON DELETE RESTRICT, so by the time this runs the league is permanent.
 * Every failure mode therefore has to end with the league intact and unpinned.
 */

import { describe, expect, it, vi } from "vitest";
import { buildNflPprRules, hashLeagueRules } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createLeague, seedSport } from "@rostr/db";
import { createTestDatabase } from "@rostr/db/testing";
import type { PGliteClient } from "@rostr/db/testing";
import { NFL } from "@rostr/core";
import { InMemoryPinningService, PinningError } from "@rostr/pinning";
import type { PinningService, PinResult } from "@rostr/pinning";
import { publishLeagueRules } from "./pinning";

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

const rules = (overrides: Partial<LeagueRules> = {}): LeagueRules =>
  ({ ...buildNflPprRules({ seasonYear: 2026, draft: DRAFT }), ...overrides }) as LeagueRules;

async function setup(): Promise<{
  client: PGliteClient;
  leagueId: string;
  ruleSet: LeagueRules;
}> {
  const client = await createTestDatabase();
  await seedSport(client, NFL);
  const [user] = await client.query<{ id: string }>(
    "INSERT INTO users (email, display_name) VALUES ('c@example.com', 'C') RETURNING id",
  );
  const ruleSet = rules();
  const league = await createLeague(client, NFL, {
    name: "L",
    commissionerId: user!.id,
    rules: ruleSet,
  });
  return { client, leagueId: league.id, ruleSet };
}

const storedUri = async (client: PGliteClient, leagueId: string) => {
  const [row] = await client.query<{ rules_uri: string | null }>(
    "SELECT rules_uri FROM leagues WHERE id = $1",
    [leagueId],
  );
  return row!.rules_uri;
};

/** A service that fails the way a real one does, at a chosen point. */
const failing = (at: "pin" | "fetch", error: Error): PinningService => {
  const inner = new InMemoryPinningService();
  return {
    pin: (content, name) => (at === "pin" ? Promise.reject(error) : inner.pin(content, name)),
    fetch: (uri) => (at === "fetch" ? Promise.reject(error) : inner.fetch(uri)),
  };
};

describe("publishLeagueRules", () => {
  it("pins the rules and records where they went", async () => {
    const { client, leagueId, ruleSet } = await setup();

    const outcome = await publishLeagueRules(
      client,
      leagueId,
      ruleSet,
      new InMemoryPinningService(),
    );

    expect(outcome.published).toBe(true);
    expect(outcome).toHaveProperty("uri");
    expect(await storedUri(client, leagueId)).toBe(
      outcome.published ? outcome.uri : "not published",
    );
  });

  it("records a URI that resolves to the document that was hashed", async () => {
    // The point of the whole feature. A URI pointing at anything else is worse
    // than none, because it looks verified.
    const { client, leagueId, ruleSet } = await setup();
    const service = new InMemoryPinningService();

    await publishLeagueRules(client, leagueId, ruleSet, service);

    const uri = await storedUri(client, leagueId);
    const { sha256Hex } = await import("@rostr/core");
    expect(sha256Hex(await service.fetch(uri!))).toBe(hashLeagueRules(ruleSet));
  });

  it("leaves the league unpinned when nothing is configured", async () => {
    // A fresh clone has no key. League creation must still work.
    const { client, leagueId, ruleSet } = await setup();

    const outcome = await publishLeagueRules(client, leagueId, ruleSet, null);

    expect(outcome.published).toBe(false);
    expect(await storedUri(client, leagueId)).toBeNull();
  });

  it.each([
    ["the upload fails", "pin" as const],
    ["the read-back fails", "fetch" as const],
  ])("survives an outage where %s, leaving the league unpinned", async (_name, at) => {
    const { client, leagueId, ruleSet } = await setup();

    const outcome = await publishLeagueRules(
      client,
      leagueId,
      ruleSet,
      failing(at, new PinningError("upstream is down")),
    );

    expect(outcome.published).toBe(false);
    expect(outcome.published === false && outcome.reason).toContain("upstream is down");
    expect(await storedUri(client, leagueId)).toBeNull();
  });

  it("refuses to record a document that is not the one that was hashed", async () => {
    /*
      The read-back is what catches this, and it is why the URI is recorded only
      after a round trip. A service that stores something other than what it was
      given — a re-serialising endpoint, a truncated upload — would otherwise
      produce a `rules_uri` that resolves to a valid-looking rule set nobody
      signed.
    */
    const { client, leagueId, ruleSet } = await setup();
    const liar: PinningService = {
      pin: (): Promise<PinResult> =>
        Promise.resolve({ cid: "bafyliar", uri: "memory://bafyliar" }),
      fetch: () => Promise.resolve('{"not":"the rules"}'),
    };

    const outcome = await publishLeagueRules(client, leagueId, ruleSet, liar);

    expect(outcome.published).toBe(false);
    expect(await storedUri(client, leagueId)).toBeNull();
  });

  it("answers rather than throwing when a service throws a non-Error", async () => {
    // The caller has already committed a league that nothing can delete, so an
    // escaping throw would turn a successful creation into a 500. A non-Error is
    // the shape that defeats a naive `catch (e) { e.message }`, which is why it
    // is the one pinned here — the title used to claim "whatever the service
    // does", which is more than one case can establish.
    const { client, leagueId, ruleSet } = await setup();
    const hostile: PinningService = {
      pin: () => {
        throw "not even an Error";
      },
      fetch: () => Promise.reject(new Error("unreachable")),
    };

    await expect(publishLeagueRules(client, leagueId, ruleSet, hostile)).resolves.toMatchObject(
      {
        published: false,
      },
    );
    expect(await storedUri(client, leagueId)).toBeNull();
  });

  it("answers even when the thrown thing cannot be turned into a string", async () => {
    /*
      `String(error)` is not total. An object with a null prototype has no
      `toString`, so describing it throws — out of the catch block, from the
      one function whose whole contract is that it never throws. Not reachable
      through the real service; this pins the guard so it is not simplified
      back to `String(error)`.
    */
    const { client, leagueId, ruleSet } = await setup();
    const unspeakable: PinningService = {
      pin: () => {
        throw Object.create(null) as Error;
      },
      fetch: () => Promise.reject(new Error("unreachable")),
    };

    await expect(
      publishLeagueRules(client, leagueId, ruleSet, unspeakable),
    ).resolves.toMatchObject({ published: false });
    expect(await storedUri(client, leagueId)).toBeNull();
  });
  it("reports a hash mixup as a mixup, not as something to retry", async () => {
    /*
      `setRulesUri` refuses when the pinned document is not this league's. That
      is a different failure from an outage and must not be reported as one — a
      blind retry re-pins the same wrong document forever.
    */
    const { client, leagueId } = await setup();

    // Pin a rule set that is not this league's.
    const outcome = await publishLeagueRules(
      client,
      leagueId,
      rules({ seasonYear: 2027 }),
      new InMemoryPinningService(),
    );

    expect(outcome.published).toBe(false);
    expect(outcome.published === false && outcome.reason).toMatch(/mixup, not an outage/);
    expect(await storedUri(client, leagueId)).toBeNull();
  });

  it("is idempotent: publishing twice leaves the same URI", async () => {
    // 0044 makes the column set-once, and `setRulesUri` treats an identical URI
    // as success — so a retry after a lost response must not read as a failure.
    const { client, leagueId, ruleSet } = await setup();
    const service = new InMemoryPinningService();

    const first = await publishLeagueRules(client, leagueId, ruleSet, service);
    const second = await publishLeagueRules(client, leagueId, ruleSet, service);

    expect(first.published).toBe(true);
    expect(second.published).toBe(true);
    expect(first.published && second.published && second.uri).toBe(
      first.published && first.uri,
    );
  });
});

describe("the publish deadline", () => {
  /*
    The first version of this file built `AbortSignal.timeout` inside
    `fetchImpl`, so each round trip got a fresh clock and the real bound was
    twice the advertised one — a per-call timer documented as a whole-publish
    timer.

    The first tests written for that defect did not catch it. One built its own
    service with a hardcoded signal and asserted the signal arrived, which is
    tautological; the other asserted only that an aborted service throws, which
    any failure satisfies. Both passed against the reverted code. It also drove
    the real `globalThis.fetch`, so a regression would have sent a live request
    to Pinata from the unit suite.

    So this drives `publishLeagueRules` — the thing that owns the deadline —
    with `fetch` stubbed, and asserts the property directly: two requests, one
    signal object between them.
  */
  const signalsSeen = async (): Promise<(AbortSignal | null | undefined)[]> => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", (_input: unknown, init?: { signal?: AbortSignal | null }) => {
      seen.push(init?.signal);
      // Enough for `pin` to return, then for the read-back to be attempted.
      return Promise.resolve(
        new Response(JSON.stringify({ IpfsHash: "QmStub" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const { client, leagueId, ruleSet } = await setup();
    const { publishLeagueRules: publish } = await import("./pinning");
    await publish(client, leagueId, ruleSet);
    return seen;
  };

  it("gives both round trips one signal, not one each", async () => {
    vi.stubEnv("PINATA_JWT", "test-token");

    const seen = await signalsSeen();

    // The upload and the read-back.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    // The whole property: one deadline spanning the publish. Two distinct
    // signals here is the defect, and it is what the reverted code produces.
    expect(seen[1]).toBe(seen[0]);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("bounds the publish at all, rather than leaving it open", async () => {
    // `pinningService()` with no signal builds a service on bare `fetch` with
    // no deadline. That is the shape this must never regress to.
    vi.stubEnv("PINATA_JWT", "test-token");

    const seen = await signalsSeen();

    expect(seen[0], "the publish ran with no deadline").toBeDefined();
    expect(seen[0]).not.toBeNull();

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("pinningService", () => {
  it("is null when no key is set, so a fresh clone still creates leagues", async () => {
    vi.stubEnv("PINATA_JWT", "");
    const { pinningService } = await import("./pinning");

    expect(pinningService()).toBeNull();

    vi.unstubAllEnvs();
  });
});
