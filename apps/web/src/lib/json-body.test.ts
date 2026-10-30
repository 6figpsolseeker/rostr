import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every route reads its body as `request.json().catch(() => ({}))` (#367).
 *
 * A bare `request.json()` throws on a malformed body, and the route answers 500
 * for what is the caller's mistake. Caught, the body is `{}` and the handler's
 * own required-field check answers 400 — so the guard adds no validation, it
 * routes bad input to the validation that already exists.
 *
 * Like `league-read.test.ts`, this proves the text is there, not the behaviour.
 */

const API = fileURLToPath(new URL("../app/api/", import.meta.url));

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routes(path);
    return name === "route.ts" ? [path] : [];
  });
}

describe("route bodies", () => {
  it("never read JSON without a catch", () => {
    const unguarded = routes(API).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /request\.json\(\)(?!\.catch)/.test(line) ? [`${relative(API, file)}:${i + 1}`] : [],
        ),
    );
    expect(unguarded).toEqual([]);
  });
});
