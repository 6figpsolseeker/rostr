import { describe, expect, it, vi } from "vitest";
import { buildNflPprRules, encodeLeagueRules, hashLeagueRules, sha256Hex } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { InMemoryPinningService } from "./memory.js";
import { PinataPinningService } from "./pinata.js";
import { pinLeagueRules, verifyPinnedRules } from "./rules.js";
import { PinningError, PinVerificationError } from "./types.js";
import type { PinningService, PinResult } from "./types.js";

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

const RULES: LeagueRules = buildNflPprRules({ seasonYear: 2026, draft: DRAFT });

describe("InMemoryPinningService", () => {
  it("round-trips content", async () => {
    const service = new InMemoryPinningService();
    const result = await service.pin("hello", "test.txt");
    expect(await service.fetch(result.uri)).toBe("hello");
  });

  it("is content-addressed — identical content pins once", async () => {
    const service = new InMemoryPinningService();
    const a = await service.pin("same", "a.txt");
    const b = await service.pin("same", "b.txt");

    expect(a.cid).toBe(b.cid);
    expect(service.size).toBe(1);
  });

  it("gives different content different CIDs", async () => {
    const service = new InMemoryPinningService();
    const a = await service.pin("one", "a.txt");
    const b = await service.pin("two", "b.txt");
    expect(a.cid).not.toBe(b.cid);
  });

  it("accepts a bare CID as well as a URI", async () => {
    const service = new InMemoryPinningService();
    const { cid, uri } = await service.pin("hello", "t.txt");
    expect(await service.fetch(cid)).toBe(await service.fetch(uri));
  });

  it("rejects a CID that was never pinned", async () => {
    const service = new InMemoryPinningService();
    await expect(service.fetch("memory://nope")).rejects.toThrow(PinningError);
  });
});

describe("pinLeagueRules", () => {
  it("pins the canonical bytes and returns the matching hash", async () => {
    const service = new InMemoryPinningService();
    const pinned = await pinLeagueRules(service, RULES);

    expect(pinned.hash).toBe(hashLeagueRules(RULES));
    expect(pinned.canonical).toBe(encodeLeagueRules(RULES));
    expect(pinned.uri).toMatch(/^memory:\/\//);
  });

  it("pins bytes that re-hash to the on-chain hash", async () => {
    const service = new InMemoryPinningService();
    const pinned = await pinLeagueRules(service, RULES);

    // What anyone verifying the league would do: fetch the document, hash it,
    // compare to the chain.
    const retrieved = await service.fetch(pinned.uri);
    expect(sha256Hex(retrieved)).toBe(pinned.hash);
  });

  it("pins no whitespace-formatted copy", async () => {
    const service = new InMemoryPinningService();
    const pinned = await pinLeagueRules(service, RULES);
    const retrieved = await service.fetch(pinned.uri);

    expect(retrieved).not.toContain("\n");
    expect(retrieved).not.toContain("  ");
  });

  it("throws if the service returns different bytes than were pinned", async () => {
    // The failure this whole read-back exists to catch: a service that parses
    // and re-serialises, reordering keys or reformatting numbers.
    const corrupting: PinningService = {
      pin: (): Promise<PinResult> =>
        Promise.resolve({ cid: "bafycorrupt", uri: "ipfs://bafycorrupt" }),
      fetch: (): Promise<string> => Promise.resolve('{"reordered": true}'),
    };

    await expect(pinLeagueRules(corrupting, RULES)).rejects.toThrow(PinVerificationError);
  });

  it("reports both hashes when verification fails", async () => {
    const corrupting: PinningService = {
      pin: (): Promise<PinResult> => Promise.resolve({ cid: "c", uri: "ipfs://c" }),
      fetch: (): Promise<string> => Promise.resolve("tampered"),
    };

    await expect(pinLeagueRules(corrupting, RULES)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PinVerificationError &&
        e.expectedHash === hashLeagueRules(RULES) &&
        e.actualHash === sha256Hex("tampered"),
    );
  });

  it("propagates a pinning failure rather than recording a URI", async () => {
    const service = new InMemoryPinningService();
    service.failNextPin = true;
    await expect(pinLeagueRules(service, RULES)).rejects.toThrow(PinningError);
  });
});

describe("verifyPinnedRules", () => {
  it("confirms a good pin", async () => {
    const service = new InMemoryPinningService();
    const pinned = await pinLeagueRules(service, RULES);
    expect(await verifyPinnedRules(service, pinned.uri, pinned.hash)).toBe(true);
  });

  it("accepts an uppercase expected hash", async () => {
    const service = new InMemoryPinningService();
    const pinned = await pinLeagueRules(service, RULES);
    expect(await verifyPinnedRules(service, pinned.uri, pinned.hash.toUpperCase())).toBe(true);
  });

  it("reports false when content has gone missing", async () => {
    const service = new InMemoryPinningService();
    const pinned = await pinLeagueRules(service, RULES);
    service.clear();

    expect(await verifyPinnedRules(service, pinned.uri, pinned.hash)).toBe(false);
  });

  it("reports false when the hash does not match", async () => {
    const service = new InMemoryPinningService();
    const pinned = await pinLeagueRules(service, RULES);
    expect(await verifyPinnedRules(service, pinned.uri, "0".repeat(64))).toBe(false);
  });
});

describe("PinataPinningService", () => {
  function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({ IpfsHash: "bafytest" }),
      ...response,
    } as Response);
  }

  it("requires a JWT", () => {
    expect(() => new PinataPinningService({ jwt: "" })).toThrow(PinningError);
  });

  it("uploads to pinFileToIPFS, never pinJSONToIPFS", async () => {
    // pinJSONToIPFS re-serialises the payload server-side, changing the bytes
    // and therefore the hash. This must never regress.
    const fetchImpl = mockFetch({});
    const service = new PinataPinningService({ jwt: "token", fetchImpl });

    await service.pin('{"a":1}', "rules.json");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.pinata.cloud/pinning/pinFileToIPFS");
    expect(url).not.toContain("pinJSONToIPFS");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("pins at CIDv0, because the URI it produces is written once", async () => {
    /*
      CIDv0 `Qm…` and CIDv1 `bafy…` encode the same multihash, and which one
      comes back is an account setting on Pinata's side rather than a property
      of the bytes. Left to the default, a change nobody here made would give a
      different URI for identical rules.

      Migration 0044 makes `leagues.rules_uri` set-once, and its whole argument
      is that a CID is a function of the bytes — so a different URI means
      different rules and there is no honest reason to repoint. This request is
      what makes that true, and 0044's comment names it. Removing it would not
      fail anything else: the league would simply be unrepointable at the wrong
      address, correctable only by another migration.
    */
    const fetchImpl = mockFetch({});
    const service = new PinataPinningService({ jwt: "token", fetchImpl });

    await service.pin('{"a":1}', "rules.json");

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const options = (init.body as FormData).get("pinataOptions");
    expect(options, "pinataOptions was not sent at all").toBeTypeOf("string");
    expect(JSON.parse(options as string)).toEqual({ cidVersion: 0 });
  });
  it("sends the content byte-for-byte as a file part", async () => {
    const fetchImpl = mockFetch({});
    const service = new PinataPinningService({ jwt: "token", fetchImpl });

    const content = '{"z":1,"a":2}'; // deliberately unsorted
    await service.pin(content, "rules.json");

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const file = (init.body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
    expect(await (file as Blob).text()).toBe(content);
  });

  it("authenticates with a bearer token", async () => {
    const fetchImpl = mockFetch({});
    const service = new PinataPinningService({ jwt: "secret-token", fetchImpl });
    await service.pin("x", "n");

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer secret-token",
    );
  });

  it("returns an ipfs:// URI", async () => {
    const fetchImpl = mockFetch({});
    const service = new PinataPinningService({ jwt: "t", fetchImpl });
    const result = await service.pin("x", "n");

    expect(result).toEqual({ cid: "bafytest", uri: "ipfs://bafytest" });
  });

  it("surfaces a non-OK response", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });
    const service = new PinataPinningService({ jwt: "bad", fetchImpl });

    await expect(service.pin("x", "n")).rejects.toThrow(/401/);
  });

  it("surfaces a response with no IpfsHash", async () => {
    const fetchImpl = mockFetch({ json: () => Promise.resolve({}) });
    const service = new PinataPinningService({ jwt: "t", fetchImpl });

    await expect(service.pin("x", "n")).rejects.toThrow(/no IpfsHash/);
  });

  it("fetches through the gateway, stripping the ipfs:// prefix", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"a":1}'),
    } as Response);

    const service = new PinataPinningService({
      jwt: "t",
      gateway: "https://example-gateway.test/ipfs/",
      fetchImpl,
    });

    expect(await service.fetch("ipfs://bafyabc")).toBe('{"a":1}');
    expect(fetchImpl).toHaveBeenCalledWith("https://example-gateway.test/ipfs/bafyabc");
  });

  it("surfaces a gateway error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    const service = new PinataPinningService({ jwt: "t", fetchImpl });

    await expect(service.fetch("ipfs://missing")).rejects.toThrow(/404/);
  });

  it("wraps a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const service = new PinataPinningService({ jwt: "t", fetchImpl });

    await expect(service.pin("x", "n")).rejects.toThrow(PinningError);
  });
});
