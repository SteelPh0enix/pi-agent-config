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
    include: ["*.test.ts"],
    // Short timeout since most tests are mocked; longer for integration tests
    testTimeout: 30_000,
    hookTimeout: 15_000,
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["**/extensions/fetch-page/**/*.ts"],
      exclude: [],
      reporter: ["text", "json", "html"],
    },
  },
});
