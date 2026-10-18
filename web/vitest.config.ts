import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.runtime/**", "**/dist/**"],
    setupFiles: "./src/test/setup.ts",
    css: true,
    // Full-page jsdom suites and the deterministic canvas geometry planner
    // are CPU-heavy. Keep CI scheduling bounded so individual 30 s tests do
    // not time out only because too many workers compete for the same cores.
    maxWorkers: 2,
    // The jsdom suites exercise full page workflows and can exceed the
    // default timeout under normal parallel CI load.
    testTimeout: 30_000
  }
});
