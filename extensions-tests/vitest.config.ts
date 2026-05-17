import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../extensions/fetch-page"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["extensions-tests/*.test.ts"],
    // Short timeout since most tests are mocked; longer for integration tests
    testTimeout: 30_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: [
        "**/extensions/fetch-page/**/*.ts",
        "**/extensions/web-search/**/*.ts",
        "**/extensions/llm-monitor/**/*.ts",
      ],
      exclude: ["**/index.ts"],
      reporter: ["text", "text-summary", "json", "html"],
      thresholds: {
        lines: 100,
        branches: 95,
        functions: 100,
        statements: 95,
      },
    },
  },
});
