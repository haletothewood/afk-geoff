import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_FILE, DEFAULT_GITHUB_ACTIONS_WORKFLOW_PATH, PROJECT_DIR, RUNS_DIR, STATE_DB, WORKTREES_DIR, defaultProjectConfig } from "./defaults.js";

export const runnerKindSchema = z.enum(["claude", "codex"]);
export const executionBackendKindSchema = z.enum(["local-docker"]);
export const runnerProfiles = ["claude", "codex", "smoke"] as const;
export type RunnerProfile = typeof runnerProfiles[number];

export const projectConfigSchema = z.object({
  version: z.literal(1),
  baseBranch: z.string().min(1).default("main"),
  github: z
    .object({
      enabled: z.boolean().default(true),
      owner: z.string().min(1).optional(),
      repo: z.string().min(1).optional()
    })
    .default({ enabled: true }),
  runner: z.object({
    kind: runnerKindSchema.default("claude"),
    model: z.string().min(1).optional(),
    command: z.array(z.string().min(1)).optional(),
    reviewCommand: z.array(z.string().min(1)).optional(),
    review: z
      .object({
        model: z.string().min(1).optional()
      })
      .optional(),
    requiredEnv: z.array(z.string().min(1)).optional(),
    envAllowlist: z.array(z.string().min(1)).default([])
  }),
  execution: z
    .object({
      backend: executionBackendKindSchema.default("local-docker")
    })
    .default({ backend: "local-docker" }),
  docker: z.object({
    image: z.string().min(1),
    dockerfilePath: z.string().min(1).optional()
  }),
  verification: z.array(z.string().min(1)).default([]),
  timeouts: z
    .object({
      runTimeoutMs: z.number().int().positive().default(30 * 60 * 1000),
      heartbeatStaleMs: z.number().int().positive().default(5 * 60 * 1000)
    })
    .default({ runTimeoutMs: 30 * 60 * 1000, heartbeatStaleMs: 5 * 60 * 1000 }),
  prompts: z
    .object({
      plan: z.string().min(1).optional(),
      worker: z.string().min(1).optional(),
      review: z.string().min(1).optional()
    })
    .optional(),
  paths: z.object({
    state: z.string().min(1).default(path.posix.join(PROJECT_DIR, STATE_DB)),
    runs: z.string().min(1).default(path.posix.join(PROJECT_DIR, RUNS_DIR)),
    worktrees: z.string().min(1).default(path.posix.join(PROJECT_DIR, WORKTREES_DIR))
  })
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ResolvedProjectPaths {
  projectDir: string;
  configPath: string;
  statePath: string;
  runsDir: string;
  worktreesDir: string;
}

export function configFilePath(cwd: string): string {
  return path.join(cwd, PROJECT_DIR, CONFIG_FILE);
}

export function loadProjectConfig(cwd: string): ProjectConfig {
  const configPath = configFilePath(cwd);
  const source = fs.readFileSync(configPath, "utf8");
  const parsed = YAML.parse(source) ?? {};
  return projectConfigSchema.parse(parsed);
}

export function resolveProjectPaths(cwd: string, config: ProjectConfig): ResolvedProjectPaths {
  return {
    projectDir: path.join(cwd, PROJECT_DIR),
    configPath: configFilePath(cwd),
    statePath: path.join(cwd, config.paths.state),
    runsDir: path.join(cwd, config.paths.runs),
    worktreesDir: path.join(cwd, config.paths.worktrees)
  };
}

export function ensureProjectLayout(cwd: string, config: ProjectConfig): ResolvedProjectPaths {
  const paths = resolveProjectPaths(cwd, config);
  fs.mkdirSync(paths.projectDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  return paths;
}

export interface WriteDefaultProjectFilesOptions {
  withOverrides?: boolean;
  withGitHubActions?: boolean;
  overwriteGitHubActions?: boolean;
  runnerProfile?: RunnerProfile;
}

export function writeDefaultProjectFiles(cwd: string, options: boolean | WriteDefaultProjectFilesOptions = false): ResolvedProjectPaths {
  const normalizedOptions = typeof options === "boolean" ? { withOverrides: options } : options;
  const config = applyRunnerProfile(defaultProjectConfig(), normalizedOptions.runnerProfile ?? "claude");
  const paths = resolveProjectPaths(cwd, config);
  fs.mkdirSync(paths.projectDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  fs.writeFileSync(paths.configPath, YAML.stringify(config));
  fs.writeFileSync(
    path.join(paths.projectDir, ".gitignore"),
    [STATE_DB, `${RUNS_DIR}/`, `${WORKTREES_DIR}/`].join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(paths.projectDir, "iteration-loop.md"),
    [
      "# Iteration Loop",
      "",
      "Use this before opening a PR to reduce follow-up fix rounds.",
      "",
      "## 1. Map all behavior paths",
      "",
      "Create a matrix for command target x mode/flags x success/failure.",
      "",
      "## 2. Keep behavior parity",
      "",
      "If a feature works in one path, ensure it carries the same inputs, outputs, and error handling in every equivalent path.",
      "",
      "## 3. Add focused tests",
      "",
      "- Add one success-path test for each new path.",
      "- Add one failure-path test for each new path.",
      "",
      "## 4. Validate CLI UX contract",
      "",
      "Every follow-up command printed by CLI output must be implemented and usable.",
      "",
      "## 5. Run a local gate",
      "",
      "Run language-specific checks before PR.",
      "",
      "Examples by stack:",
      "",
      "- TypeScript/Node: typecheck + targeted tests",
      "- Python: lint + typecheck + targeted tests",
      "- Go: go test + go vet",
      "- Rust: cargo test + cargo clippy -- -D warnings",
      "- Java/Kotlin: gradle or maven test + static analysis",
      "",
      "Record the exact gate command in your repo docs and run it before review.",
      ""
    ].join("\n")
  );

  if (normalizedOptions.withOverrides) {
    fs.mkdirSync(path.join(paths.projectDir, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(paths.projectDir, "prompts", "plan.md"), "# Extra planning instructions\n");
    fs.writeFileSync(path.join(paths.projectDir, "prompts", "worker.md"), "# Extra worker instructions\n");
    fs.writeFileSync(path.join(paths.projectDir, "prompts", "review.md"), "# Extra review instructions\n");
    fs.writeFileSync(
      path.join(paths.projectDir, "Dockerfile.worker"),
      "FROM node:22-bookworm\nRUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*\n"
    );
  }

  if (normalizedOptions.runnerProfile === "smoke") {
    writeSmokeRunner(cwd);
  }

  if (normalizedOptions.withGitHubActions) {
    writeGitHubActionsWorkflow(cwd, { overwrite: normalizedOptions.overwriteGitHubActions ?? false });
  }

  return paths;
}

export function writeRunnerProfile(cwd: string, profile: RunnerProfile): string {
  const configPath = configFilePath(cwd);
  const config = fs.existsSync(configPath) ? loadProjectConfig(cwd) : defaultProjectConfig();
  const nextConfig = applyRunnerProfile(config, profile);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(nextConfig));

  if (profile === "smoke") {
    writeSmokeRunner(cwd);
  }

  return profile;
}

export function applyRunnerProfile(config: ProjectConfig, profile: RunnerProfile): ProjectConfig {
  const next: ProjectConfig = structuredClone(config);

  if (profile === "codex") {
    next.github = { enabled: false };
    next.runner = {
      kind: "codex",
      requiredEnv: [],
      envAllowlist: ["GH_TOKEN", "OPENAI_API_KEY"]
    };
    return next;
  }

  if (profile === "smoke") {
    next.github = { enabled: false };
    next.runner = {
      kind: "claude",
      command: ["node", ".afk/smoke-runner.mjs", "{prompt}"],
      reviewCommand: ["node", ".afk/smoke-runner.mjs", "{prompt}"],
      requiredEnv: [],
      envAllowlist: ["GH_TOKEN"]
    };
    return next;
  }

  next.github = { enabled: false };
  next.runner = {
    kind: "claude",
    requiredEnv: [],
    envAllowlist: ["GH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
  };
  return next;
}

export function writeSmokeRunner(cwd: string): string {
  const runnerPath = path.join(cwd, PROJECT_DIR, "smoke-runner.mjs");
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.writeFileSync(runnerPath, SMOKE_RUNNER_SOURCE);
  return runnerPath;
}

const SMOKE_RUNNER_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

const promptPath = process.argv.at(-1);
if (!promptPath) {
  throw new Error("Usage: node .afk/smoke-runner.mjs <prompt-path>");
}

const prompt = fs.readFileSync(promptPath, "utf8");

const reviewMatch = prompt.match(/Write your review verdict JSON to this exact path:\\n([^\\n]+)/);
if (reviewMatch) {
  fs.writeFileSync(reviewMatch[1].trim(), JSON.stringify({ verdict: "PASS" }, null, 2));
  process.exit(0);
}

const progressMatch = prompt.match(/Write progress updates to this exact path while the run is active:\\n([^\\n]+)/);
if (progressMatch) {
  fs.writeFileSync(progressMatch[1].trim(), JSON.stringify({
    phase: "smoke",
    message: "Smoke runner received the AFK prompt",
    iteration: 1,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

const resultMatch = prompt.match(/Write a JSON file to this exact path when you are done:\\n([^\\n]+)/);
if (!resultMatch) {
  throw new Error("Prompt did not include an AFK result path");
}

fs.writeFileSync(resultMatch[1].trim(), JSON.stringify({
  status: "done",
  summary: "Smoke runner completed without making changes",
  issueComment: "AFK smoke runner completed successfully. No repository changes were made."
}, null, 2));
`;

export function writeGitHubActionsWorkflow(cwd: string, options: { overwrite?: boolean } = {}): string {
  const workflowPath = path.join(cwd, ".github", "workflows", "afk-run.yml");
  if (fs.existsSync(workflowPath) && !(options.overwrite ?? false)) {
    throw new Error(`GitHub Actions workflow already exists at ${workflowPath}`);
  }

  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.copyFileSync(DEFAULT_GITHUB_ACTIONS_WORKFLOW_PATH, workflowPath);
  return workflowPath;
}

export function maybeReadOverride(cwd: string, filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

  if (!fs.existsSync(absolutePath)) {
    return undefined;
  }

  return fs.readFileSync(absolutePath, "utf8");
}
