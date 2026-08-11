import { describe, expect, it } from "vitest";
import { safeRedirect } from "./session.js";

/**
 * `safeRedirect` had no test until `apps/web` was added to the test run.
 *
 * It is the guard on `?next=` for the emailed sign-in link, so the thing it
 * prevents is a freshly-authenticated user landing on somebody else's site
 * straight from a link in their inbox — the shape of a convincing phish.
 *
 * It has already been wrong once. The first version checked prefixes, and the
 * URL parser strips tabs, newlines and carriage returns *before* parsing, so
 * `/\t/evil.example` passed the checks and then resolved to `//evil.example`.
 * That is the case a prefix blocklist cannot cover and why the loop rejects
 * every control character rather than a list of known-bad starts.
 *
 * A function with that history and no test is the argument for collecting this
 * directory at all.
 */
describe("safeRedirect", () => {
  it("keeps an ordinary same-site path", () => {
    expect(safeRedirect("/leagues/abc")).toBe("/leagues/abc");
    expect(safeRedirect("/")).toBe("/");
  });

  it("keeps a query string and a fragment", () => {
    // These are the reason it returns the path rather than rebuilding it: a
    // sign-in link that drops the user on the right page but loses their filter
    // is a worse experience than the redirect existing at all.
    expect(safeRedirect("/leagues/abc?week=3")).toBe("/leagues/abc?week=3");
    expect(safeRedirect("/players#waivers")).toBe("/players#waivers");
  });

  it("falls back home for nothing at all", () => {
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect("")).toBe("/");
  });

  it("refuses an absolute URL", () => {
    for (const hostile of [
      "https://evil.example",
      "http://evil.example/leagues",
      "javascript:alert(1)",
      "data:text/html,<script>",
    ]) {
      expect(safeRedirect(hostile), hostile).toBe("/");
    }
  });

  it("refuses a protocol-relative URL", () => {
    // `//host` and `/\host` have no scheme but browsers treat them as absolute,
    // so they leave the site while looking like a path.
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("//evil.example/leagues")).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
    expect(safeRedirect("/\\\\evil.example")).toBe("/");
  });

  it("refuses a control character anywhere in the path", () => {
    // The regression. The parser strips these before parsing, so each of these
    // becomes `//evil.example` by the time a browser resolves it — and none of
    // them starts with a prefix a blocklist would catch.
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
      const hostile = `/${String.fromCharCode(code)}/evil.example`;
      expect(safeRedirect(hostile), `U+${code.toString(16).padStart(4, "0")}`).toBe("/");
    }
  });

  it("refuses a backslash even mid-path", () => {
    // Backslash is a path separator to some parsers and not others, which is
    // exactly the disagreement an attacker wants.
    expect(safeRedirect("/leagues\\@evil.example")).toBe("/");
    expect(safeRedirect("/leagues/\\/evil.example")).toBe("/");
  });

  it("refuses anything not starting with a slash", () => {
    // A bare host is a relative path to us and an absolute one to a browser
    // following a `Location` header.
    expect(safeRedirect("evil.example")).toBe("/");
    expect(safeRedirect("leagues/abc")).toBe("/");
  });
});
