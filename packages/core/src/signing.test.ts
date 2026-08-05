import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { buildJoinMessage, isValidWalletAddress, verifyJoinSignature } from "./signing.js";
import type { JoinMessageInput } from "./signing.js";

/** A fixed keypair, so these tests are deterministic. */
const PRIVATE_KEY = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519.getPublicKey(PRIVATE_KEY);
const WALLET = bs58.encode(PUBLIC_KEY);

const INPUT: JoinMessageInput = {
  leagueId: "6f1c9a2e-0000-4000-8000-000000000001",
  leagueName: "The Money League",
  rulesHash: "5afc934db3b3e1b1f5ec7a9e503f61e531aa925a6f966c41ec227118201da36a",
  walletAddress: WALLET,
  seasonYear: 2026,
};

function sign(input: JoinMessageInput, key = PRIVATE_KEY): string {
  const message = new TextEncoder().encode(buildJoinMessage(input));
  return bs58.encode(ed25519.sign(message, key));
}

describe("buildJoinMessage", () => {
  it("is deterministic", () => {
    expect(buildJoinMessage(INPUT)).toBe(buildJoinMessage({ ...INPUT }));
  });

  it("names the rule set being agreed to", () => {
    const message = buildJoinMessage(INPUT);
    expect(message).toContain(INPUT.rulesHash);
    expect(message).toContain(INPUT.leagueId);
    expect(message).toContain(WALLET);
  });

  it("is readable by a person, since a wallet displays it", () => {
    const message = buildJoinMessage(INPUT);
    expect(message).toContain("These rules are final");
    expect(message.split("\n").length).toBeGreaterThan(5);
  });

  it("is namespaced so it cannot be replayed as another app's message", () => {
    expect(buildJoinMessage(INPUT).startsWith("rostr: join league")).toBe(true);
  });

  it("differs when any field differs", () => {
    const base = buildJoinMessage(INPUT);
    expect(buildJoinMessage({ ...INPUT, rulesHash: "b".repeat(64) })).not.toBe(base);
    expect(buildJoinMessage({ ...INPUT, leagueId: "other" })).not.toBe(base);
    expect(buildJoinMessage({ ...INPUT, seasonYear: 2027 })).not.toBe(base);
  });
});

describe("verifyJoinSignature", () => {
  it("accepts a genuine signature", () => {
    expect(verifyJoinSignature(INPUT, sign(INPUT))).toBe(true);
  });

  it("rejects a signature over different rules", () => {
    // The attack that matters: sign a permissive rule set, join a league with a
    // different one.
    const signature = sign({ ...INPUT, rulesHash: "0".repeat(64) });
    expect(verifyJoinSignature(INPUT, signature)).toBe(false);
  });

  it("rejects a signature from a different wallet", () => {
    const otherKey = new Uint8Array(32).fill(9);
    expect(verifyJoinSignature(INPUT, sign(INPUT, otherKey))).toBe(false);
  });

  it("rejects a signature bound to a different league", () => {
    const signature = sign({ ...INPUT, leagueId: "some-other-league" });
    expect(verifyJoinSignature(INPUT, signature)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const good = bs58.decode(sign(INPUT));
    good[0] = (good[0]! ^ 0xff) & 0xff;
    expect(verifyJoinSignature(INPUT, bs58.encode(good))).toBe(false);
  });

  it("returns false rather than throwing on malformed input", () => {
    expect(verifyJoinSignature(INPUT, "not-base58!!")).toBe(false);
    expect(verifyJoinSignature(INPUT, "")).toBe(false);
    expect(verifyJoinSignature({ ...INPUT, walletAddress: "nonsense" }, sign(INPUT))).toBe(
      false,
    );
  });

  it("rejects a signature of the wrong length", () => {
    expect(verifyJoinSignature(INPUT, bs58.encode(new Uint8Array(32)))).toBe(false);
  });
});

describe("isValidWalletAddress", () => {
  it("accepts a base58 ed25519 public key", () => {
    expect(isValidWalletAddress(WALLET)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidWalletAddress("")).toBe(false);
    expect(isValidWalletAddress("0x1234")).toBe(false);
    expect(isValidWalletAddress(bs58.encode(new Uint8Array(31)))).toBe(false);
  });
});
