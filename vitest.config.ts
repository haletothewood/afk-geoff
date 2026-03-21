import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const workspacePackage = (packageName: string) => path.resolve(rootDir, "packages", packageName, "src", "index.ts");

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
      "@afk-geoff/shared": workspacePackage("shared"),
      "@afk-geoff/core": workspacePackage("core"),
      "@afk-geoff/adapter-sqlite": workspacePackage("adapter-sqlite"),
      "@afk-geoff/adapter-local-git": workspacePackage("adapter-local-git"),
      "@afk-geoff/adapter-github": workspacePackage("adapter-github"),
      "@afk-geoff/runtime-docker": workspacePackage("runtime-docker"),
      "@afk-geoff/runner-claude": workspacePackage("runner-claude"),
      "@afk-geoff/runner-codex": workspacePackage("runner-codex")
    }
  }
});
