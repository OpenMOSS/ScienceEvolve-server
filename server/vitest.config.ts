import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    environment: "node",
    // Match the bounded Web suite scheduling on local and CI machines.
    maxWorkers: 2,
    include: ["tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.runtime/**",
      "**/dist/**",
    ],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
