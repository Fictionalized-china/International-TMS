import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "production/**/*.test.mjs", "scripts/**/*.test.mjs"],
    passWithNoTests: false,
  },
});
