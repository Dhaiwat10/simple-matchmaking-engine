import eslint from "@eslint/js";
import globals from "globals";

import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".vercel/**",
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "public/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
