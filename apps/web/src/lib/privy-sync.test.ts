import { describe, expect, it } from "vitest";
import { canSkipExchange, parseExchangeMemo, privySyncKey } from "./privy-sync";
import type { PrivySyncUser } from "./privy-sync";

const email = { type: "email", address: "alice@example.com" };
const wallet = { type: "wallet", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" };
const x = { type: "twitter_oauth", subject: "12345", username: "alice" };

const user = (linkedAccounts: PrivySyncUser["linkedAccounts"], id = "did:privy:alice") => ({
  id,
  linkedAccounts,
});

describe("privySyncKey", () => {
  it("does not change when nothing linked changed", () => {
    expect(privySyncKey(user([email, wallet]))).toBe(privySyncKey(user([wallet, email])));
  });

  it("changes when the wallet appears after login", () => {
    expect(privySyncKey(user([email, wallet]))).not.toBe(privySyncKey(user([email])));
  });

  it("changes when X is linked, and when its handle is renamed", () => {
    const linked = privySyncKey(user([email, x]));
    expect(linked).not.toBe(privySyncKey(user([email])));
    expect(privySyncKey(user([email, { ...x, username: "alice_2" }]))).not.toBe(linked);
  });

  it("changes when a different person signs in", () => {
    expect(privySyncKey(user([email], "did:privy:bob"))).not.toBe(privySyncKey(user([email])));
  });
});

describe("canSkipExchange", () => {
  const memo = { key: "k1", userId: "u1" };

  it("skips only when the key and the live session both match", () => {
    expect(canSkipExchange(memo, "k1", "u1")).toBe(true);
  });

  it("posts when the linked accounts changed", () => {
    expect(canSkipExchange(memo, "k2", "u1")).toBe(false);
  });

  it("posts when rostr has no session, or a different account's", () => {
    expect(canSkipExchange(memo, "k1", null)).toBe(false);
    expect(canSkipExchange(memo, "k1", "u2")).toBe(false);
  });

  it("posts when this tab has never exchanged", () => {
    expect(canSkipExchange(null, "k1", "u1")).toBe(false);
  });
});

describe("parseExchangeMemo", () => {
  it("reads a stored memo and treats anything else as absent", () => {
    expect(parseExchangeMemo(JSON.stringify({ key: "k", userId: "u" }))).toEqual({
      key: "k",
      userId: "u",
    });
    expect(parseExchangeMemo(null)).toBeNull();
    expect(parseExchangeMemo("not json")).toBeNull();
    expect(parseExchangeMemo(JSON.stringify({ key: "k" }))).toBeNull();
  });
});
