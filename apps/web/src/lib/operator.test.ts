import { describe, expect, it } from "vitest";
import { isOperator, operatorEmails } from "./operator.js";

/**
 * The operator gate.
 *
 * Worth testing carefully despite being twenty lines, because it is the only
 * "who is asking" check in a codebase whose stated design is not to have one.
 * The risk is not that it is wrong today — it is that it becomes the thing a
 * future league feature reuses. These tests pin the shape that makes that
 * awkward: a boolean about the signed-in user, an allowlist that is empty until
 * somebody sets it, and no caller-supplied identity anywhere.
 */

describe("operatorEmails", () => {
  it("is empty when unset, which means nobody", () => {
    // Not "everyone" and not "open in development". An unset deployment shows a
    // blank page; the alternative is a stranger reading ingest health.
    expect(operatorEmails(undefined)).toEqual([]);
    expect(operatorEmails("")).toEqual([]);
  });

  it("reads a comma-separated list, trimmed and lower-cased", () => {
    // It is typed into a deployment console by hand, so tolerate the spacing
    // and capitalisation a human produces.
    expect(operatorEmails(" Brian@Example.com , ops@rostr.gg ")).toEqual([
      "brian@example.com",
      "ops@rostr.gg",
    ]);
  });

  it("drops empty entries rather than admitting one", () => {
    // A trailing comma is the ordinary typo. An empty string in the list would
    // otherwise match an empty email, and `isOperator` guards that too — belt
    // and braces, because only one of the two has to survive a refactor.
    expect(operatorEmails("a@b.c,,")).toEqual(["a@b.c"]);
  });
});

describe("isOperator", () => {
  const ALLOW = ["brian@example.com"];

  it("admits an exact match", () => {
    expect(isOperator("brian@example.com", ALLOW)).toBe(true);
  });

  it("admits regardless of case or surrounding space", () => {
    expect(isOperator("  Brian@Example.COM ", ALLOW)).toBe(true);
  });

  it("refuses anyone not named", () => {
    expect(isOperator("someone@else.com", ALLOW)).toBe(false);
  });

  it("refuses a signed-out visitor", () => {
    // The case most likely to be got wrong, so it is asserted rather than left
    // to fall out of the comparison.
    expect(isOperator(null, ALLOW)).toBe(false);
    expect(isOperator(undefined, ALLOW)).toBe(false);
  });

  it("refuses an empty or whitespace email against an empty allowlist", () => {
    // The pairing that would otherwise let "" match "".
    expect(isOperator("", [])).toBe(false);
    expect(isOperator("   ", [])).toBe(false);
    expect(isOperator("", [""])).toBe(false);
  });

  it("refuses everybody when the allowlist is empty", () => {
    // The unset-deployment case, stated as behaviour rather than inferred from
    // `operatorEmails` returning [].
    expect(isOperator("brian@example.com", [])).toBe(false);
  });
});
