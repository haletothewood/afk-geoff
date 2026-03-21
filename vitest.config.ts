import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"]
    }
  },
  resolve: {
    alias: {
      "@afk-geoff/shared": "/workspace/packages/shared/src/index.ts",
      "@afk-geoff/core": "/workspace/packages/core/src/index.ts",
      "@afk-geoff/adapter-sqlite": "/workspace/packages/adapter-sqlite/src/index.ts",
      "@afk-geoff/adapter-local-git": "/workspace/packages/adapter-local-git/src/index.ts",
      "@afk-geoff/adapter-github": "/workspace/packages/adapter-github/src/index.ts",
      "@afk-geoff/runtime-docker": "/workspace/packages/runtime-docker/src/index.ts",
      "@afk-geoff/runner-claude": "/workspace/packages/runner-claude/src/index.ts",
      "@afk-geoff/runner-codex": "/workspace/packages/runner-codex/src/index.ts"
    }
  }
});
