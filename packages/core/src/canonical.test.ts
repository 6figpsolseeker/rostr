import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalize, CanonicalEncodingError } from "./canonical.js";

describe("canonicalize", () => {
  it("sorts object keys regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("produces identical output for objects built in different orders", () => {
    const one = { sport: "nfl", season: 2026, scoring: [{ key: "rec", pts: 1000 }] };
    const two = { scoring: [{ pts: 1000, key: "rec" }], season: 2026, sport: "nfl" };
    expect(canonicalize(one)).toBe(canonicalize(two));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("emits no whitespace", () => {
    expect(canonicalize({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it("handles the empty cases", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize(null)).toBe("null");
  });

  it("encodes booleans and negative integers", () => {
    expect(canonicalize({ ok: true, bad: false, int: -2000 })).toBe(
      '{"bad":false,"int":-2000,"ok":true}',
    );
  });

  it("normalises -0 to 0 so zero has one encoding", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it("escapes strings via JSON semantics", () => {
    expect(canonicalize({ 'a"b': "c\\d" })).toBe('{"a\\"b":"c\\\\d"}');
    expect(canonicalize("é")).toBe('"é"');
  });
});

describe("canonicalize rejections", () => {
  it("rejects non-integer numbers", () => {
    expect(() => canonicalize(0.04)).toThrow(CanonicalEncodingError);
    expect(() => canonicalize({ perYard: 0.1 })).toThrow(/smallest integer unit/);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalEncodingError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalEncodingError);
  });

  it("rejects integers beyond safe range", () => {
    expect(() => canonicalize(Number.MAX_SAFE_INTEGER + 1)).toThrow(CanonicalEncodingError);
  });

  it("rejects undefined rather than silently dropping it", () => {
    // JSON.stringify({ a: undefined }) === "{}" — a silent mutation of meaning.
    expect(() => canonicalize({ a: undefined } as never)).toThrow(CanonicalEncodingError);
    expect(() => canonicalize([undefined] as never)).toThrow(CanonicalEncodingError);
  });

  it("rejects non-plain objects", () => {
    expect(() => canonicalize(new Date() as never)).toThrow(/Only plain objects/);
    expect(() => canonicalize(new Map() as never)).toThrow(/Only plain objects/);
  });

  it("rejects bigint", () => {
    expect(() => canonicalize(1n as never)).toThrow(CanonicalEncodingError);
  });

  it("reports the path to the offending value", () => {
    expect(() => canonicalize({ scoring: [{ ok: 1 }, { bad: 1.5 }] })).toThrow(
      /scoring\[1\]\.bad/,
    );
  });
});

describe("canonicalHash", () => {
  it("is stable for equivalent objects", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it("changes when any value changes", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it("distinguishes array order", () => {
    expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
  });

  it("returns 64 lowercase hex characters", () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 of the empty object encoding", () => {
    // sha256("{}") — pins the whole pipeline, not just our own round-trip.
    expect(canonicalHash({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });
});
