// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Base: ignore build artifacts
  { ignores: ["node_modules/", "coverage/", "*.js"] },

  // All TypeScript source and test files
  {
    extends: [eslint.configs.recommended],
    files: ["*.test.ts", "../extensions/**/*.ts"],
  },

  // TypeScript strict type-aware rules
  ...tseslint.configs.strictTypeChecked.map((c) => ({
    ...c,
    files: ["*.test.ts", "../extensions/**/*.ts"],
  })),

  // Project-level shared settings
  {
    files: ["*.test.ts", "../extensions/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Prettier handles formatting
      ...prettier.rules,

      // Strict rules beyond the type-checked base
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/no-non-null-assertion": "warn",

      // General strictness
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      curly: ["error", "multi-line"],
      "default-case-last": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-return-await": "error",
      "require-await": "error",
    },
  },

  // Test files: relax rules that conflict with vitest/mock patterns
  {
    files: ["*.test.ts"],
    rules: {
      // Numbers in template literals (like `${results.length}`) are fine in tests
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Mock patterns often require any/unsafe operations
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // itLive: returning void is intentional for early-return pattern
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreVoidReturningFunctions: true }],
    },
  },

  // Source files: stricter rules (excludes test files)
  {
    files: ["../extensions/**/*.ts"],
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
