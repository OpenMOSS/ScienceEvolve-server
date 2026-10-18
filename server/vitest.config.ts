import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    environment: "node",
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
