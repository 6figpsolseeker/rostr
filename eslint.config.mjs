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
);
