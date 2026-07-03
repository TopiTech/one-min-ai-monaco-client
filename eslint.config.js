import js from "@eslint/js";
import globals from "globals";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // Global ignores for generated/vendor files and templates/meta files
  {
    ignores: [
      "public/vs/**",
      "public/vendor/**",
      "coverage/**",
      "node_modules/**",
      ".github/**",
      ".mimocode/**",
      ".commandcode/**",
      "docs/**",
    ],
  },
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: {...globals.browser, ...globals.node} } },
  // Test files: add Jest globals so describe/test/expect/beforeEach/afterEach are recognized
  {
    files: ["tests/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
  // Public browser JS files that use AMD-loaded monaco and module-scope toast/state globals
  {
    files: ["public/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        monaco: "readonly",
        toast: "readonly",
        state: "readonly",
        require: "readonly",
      },
    },
  },
  {
    files: ["**/*.md"],
    plugins: { markdown },
    language: "markdown/commonmark",
    extends: ["markdown/recommended"],
    rules: {
      "markdown/no-missing-label-refs": "off",
    },
  },
  {
    files: ["**/*.css"],
    plugins: { css },
    language: "css/css",
    extends: ["css/recommended"],
    rules: {
      "css/no-important": "off",
      "css/use-baseline": "off",
      "css/no-invalid-properties": "off",
    },
  },
]);

