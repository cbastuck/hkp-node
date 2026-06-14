import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run the TypeScript source tests. vitest 4 no longer excludes
    // dist/ by default, which would otherwise pick up compiled build output.
    include: ["tests/**/*.test.ts"],
  },
});
