import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig } from "./config.js";

export const PROJECT_DIR = ".afk";
export const CONFIG_FILE = "config.yaml";
export const STATE_DB = "state.sqlite";
export const RUNS_DIR = "runs";
export const WORKTREES_DIR = "worktrees";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DOCKERFILE_PATH = resolveTemplatePath("default.Dockerfile");
export const DEFAULT_GITHUB_ACTIONS_WORKFLOW_PATH = resolveTemplatePath("afk-run.workflow.yml");

function resolveTemplatePath(filename: string): string {
  const candidates = [
    path.resolve(moduleDir, "../templates", filename),
    path.resolve(moduleDir, "../../../packages/shared/src/templates", filename)
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

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
    execution: {
      backend: "local-docker"
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
