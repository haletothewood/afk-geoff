import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig } from "./config.js";

export const PROJECT_DIR = ".afk";
export const CONFIG_FILE = "config.yaml";
export const STATE_DB = "state.sqlite";
export const RUNS_DIR = "runs";
export const WORKTREES_DIR = "worktrees";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DOCKERFILE_PATH = path.resolve(
  moduleDir,
  "../../../packages/shared/src/templates/default.Dockerfile"
);

export function defaultProjectConfig(): ProjectConfig {
  return {
    version: 1,
    baseBranch: "main",
    github: {
      enabled: true
    },
    runner: {
      kind: "claude",
      envAllowlist: ["GH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
    },
    docker: {
      image: "afk-worker:latest"
    },
    verification: [],
    timeouts: {
      runTimeoutMs: 30 * 60 * 1000,
      heartbeatStaleMs: 5 * 60 * 1000
    },
    paths: {
      state: path.posix.join(PROJECT_DIR, STATE_DB),
      runs: path.posix.join(PROJECT_DIR, RUNS_DIR),
      worktrees: path.posix.join(PROJECT_DIR, WORKTREES_DIR)
    }
  };
}
