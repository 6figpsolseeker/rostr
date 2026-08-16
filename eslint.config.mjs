import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // The web app is typechecked and linted by Next's own toolchain; this config
    // is type-aware over the packages and would need a separate project setup.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/target/**",
      "apps/web/**",
      // The design handoff. `support.js` is a prototyping runtime that ships
      // with the `.dc.html` references and is deliberately never imported by
      // anything — linting a generated artifact nothing runs is noise, and it
      // would have to be re-fixed on every drop. See docs/design/STATUS.md.
      "docs/design/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": "warn",
    },
  },
  {
    // A CLI's output is its interface.
    files: ["**/cli.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Build scripts run under Node directly, not through the bundler, so they
    // have Node's globals. Declared explicitly rather than pulling in a globals
    // package for three names — `URL` is here because resolving a path relative
    // to the script is how these find the repo, and `import.meta.url` needs it.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    // Same reasoning as a CLI: the output is how the script reports what it did.
    rules: { "no-console": "off" },
  },
);
