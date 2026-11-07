import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // DB integration tests share one test database.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
