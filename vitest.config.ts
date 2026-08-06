import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source rather than dist. Tests then never
    // depend on build order, and a stale dist cannot produce a passing or
    // failing run that disagrees with the code in front of you.
    alias: {
      "@rostr/core": src("core"),
      "@rostr/db": src("db"),
      "@rostr/pinning": src("pinning"),
      "@rostr/stats": src("stats"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts"],
    },
  },
});
