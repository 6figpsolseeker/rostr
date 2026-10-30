import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonBody } from "./json-body";

const post = (body: string) => new Request("http://x", { method: "POST", body });

describe("jsonBody", () => {
  it("answers {} for a body that is not an object", async () => {
    expect(await jsonBody(post("{not json"))).toEqual({});
    expect(await jsonBody(post("null"))).toEqual({});
    expect(await jsonBody(post("5"))).toEqual({});
    expect(await jsonBody(post(""))).toEqual({});
  });

  it("passes an object through", async () => {
    expect(await jsonBody(post('{"a":1}'))).toEqual({ a: 1 });
  });
});

/**
 * Every route reads its body through `jsonBody` (#367).
 *
 * A bare `request.json()` throws on a malformed body, and even with a catch a
 * body of `null` throws on the first field read; both answered 500 for the
 * caller's mistake. Like `league-read.test.ts`, this proves the text is there,
 * not the behaviour.
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
  it("are read through jsonBody, never request.json()", () => {
    const direct = routes(API).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /request\.json\(/.test(line) ? [`${relative(API, file)}:${i + 1}`] : [],
        ),
    );
    expect(direct).toEqual([]);
  });
});
