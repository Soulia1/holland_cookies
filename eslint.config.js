import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Lint.
 *
 * Correctness, not style: the rules here are the ones that catch a bug — an
 * undefined name, an unused import left behind by a refactor, a hook called
 * conditionally. Formatting is not linted; the codebase has its own house style
 * and a formatter fight is not a release gate.
 *
 * TypeScript already checks types (`npm run typecheck`), so the TS block adds
 * only what the compiler does not.
 */
export default defineConfig([
  globalIgnores([
    "dist/**", "dist-dashboard/**", "node_modules/**", "test-results/**", "playwright-report/**",
    "data/**", "docs/**", "tools/**", "Menu_images/**", "public/**", "**/*.d.mts",
  ]),
  {
    files: ["backend/**/*.js", "scripts/**/*.mjs", "shared/**/*.mjs", "tests/**/*.js", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    // Shared by the browser bundles and the server.
    files: ["shared/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["src/**/*.{ts,tsx}", "dashboard-src/src/**/*.{ts,tsx}", "e2e/**/*.ts", "*.config.ts", "dashboard-src/*.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // The dashboard's API adapter and the e2e suite read loosely typed JSON on
      // purpose; `any` there is a decision, not an accident.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);
