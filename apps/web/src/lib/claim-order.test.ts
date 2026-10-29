import { describe, expect, it } from "vitest";
import { MAX_REORDER, moveClaim, parseClaimIds } from "./claim-order";

describe("moveClaim", () => {
  it("moves a claim down and up, landing where the target was", () => {
    expect(moveClaim(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveClaim(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveClaim(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
  });

  it("leaves the order alone for a drop onto itself", () => {
    const ids = ["a", "b", "c"];
    expect(moveClaim(ids, "b", "b")).toBe(ids);
  });

  it("leaves the order alone when either claim is gone — processed mid-drag", () => {
    const ids = ["a", "b", "c"];
    expect(moveClaim(ids, "x", "a")).toBe(ids);
    expect(moveClaim(ids, "a", "x")).toBe(ids);
  });

  it("never edits the list it was handed", () => {
    const ids = Object.freeze(["a", "b", "c"]);
    expect(() => moveClaim(ids, "a", "c")).not.toThrow();
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("parseClaimIds", () => {
  it("accepts a list of strings, including an empty one", () => {
    expect(parseClaimIds(["a", "b"])).toEqual(["a", "b"]);
    expect(parseClaimIds([])).toEqual([]);
  });

  it("refuses anything that is not a bounded list of strings", () => {
    expect(parseClaimIds(undefined)).toBeNull();
    expect(parseClaimIds("a")).toBeNull();
    expect(parseClaimIds({ 0: "a", length: 1 })).toBeNull();
    expect(parseClaimIds(["a", 1])).toBeNull();
    expect(parseClaimIds(["a", null])).toBeNull();
    expect(parseClaimIds(Array.from({ length: MAX_REORDER + 1 }, (_, i) => `${i}`))).toBeNull();
    expect(parseClaimIds(Array.from({ length: MAX_REORDER }, (_, i) => `${i}`))).not.toBeNull();
  });
});
