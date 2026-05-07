import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    pool: "forks",
    teardownTimeout: 5000
  }
});
