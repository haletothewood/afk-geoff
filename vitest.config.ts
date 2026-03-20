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
      "@afk-geoff/shared": "/Users/davidneil/Development/Personal/AI-Workflows/packages/shared/src/index.ts",
      "@afk-geoff/core": "/Users/davidneil/Development/Personal/AI-Workflows/packages/core/src/index.ts",
      "@afk-geoff/adapter-sqlite": "/Users/davidneil/Development/Personal/AI-Workflows/packages/adapter-sqlite/src/index.ts",
      "@afk-geoff/adapter-local-git": "/Users/davidneil/Development/Personal/AI-Workflows/packages/adapter-local-git/src/index.ts",
      "@afk-geoff/adapter-github": "/Users/davidneil/Development/Personal/AI-Workflows/packages/adapter-github/src/index.ts",
      "@afk-geoff/runtime-docker": "/Users/davidneil/Development/Personal/AI-Workflows/packages/runtime-docker/src/index.ts",
      "@afk-geoff/runner-claude": "/Users/davidneil/Development/Personal/AI-Workflows/packages/runner-claude/src/index.ts",
      "@afk-geoff/runner-codex": "/Users/davidneil/Development/Personal/AI-Workflows/packages/runner-codex/src/index.ts"
    }
  }
});
