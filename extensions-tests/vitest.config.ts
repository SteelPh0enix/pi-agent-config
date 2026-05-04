import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["*.test.ts"],
    // Short timeout since most tests are mocked; longer for integration tests
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
