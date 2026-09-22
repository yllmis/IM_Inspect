import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "eval/**/*.test.ts",
      "eval/**/*.spec.ts",
    ],
  },
});
