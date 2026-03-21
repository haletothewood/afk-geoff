import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";

const workspaceRoot = "/Users/davidneil/Development/Personal/afk-geoff";
const cliEntry = path.join(workspaceRoot, "packages/cli/src/index.ts");
const tsxLoader = path.join(workspaceRoot, "node_modules", "tsx", "dist", "loader.mjs");

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-developer-workflow-"));
  const repoDir = path.join(tempDir, "repo");
  const fakeBinDir = path.join(tempDir, "bin");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });

  try {
    writeFakeDocker(fakeBinDir);
    writeRepoFiles(repoDir);

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`
    };

    run("git", ["init", "-b", "main"], { cwd: repoDir, env });
    run("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, env });
    run("git", ["config", "user.name", "Test User"], { cwd: repoDir, env });
    run("git", ["add", "-A"], { cwd: repoDir, env });
    run("git", ["commit", "-m", "initial"], { cwd: repoDir, env });

    cli(["init"], repoDir, env);
    rewriteConfig(repoDir);
    cli(["doctor"], repoDir, env);
    cli(["capture", "Add a queue-based resend workflow with AFK backend work."], repoDir, env);

    const config = loadProjectConfig(repoDir);
    const paths = resolveProjectPaths(repoDir, config);
    const store = new SqliteStateStore(paths.statePath);
    const [requirement] = await store.listRequirements();

    if (!requirement) {
      throw new Error("Expected capture to create a requirement");
    }

    const briefPath = path.join(repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Add a queue-based resend workflow with AFK backend work.",
        "",
        "## Work Item Title",
        "Implement backend queue",
        "",
        "## Work Item Body",
        "Create the backend processing flow.",
        "",
        "## Acceptance Criteria",
        "- Backend queue exists"
      ].join("\n")
    );

    cli(["run", "file", "brief.md"], repoDir, env);

    const [workRun] = await store.listRuns();

    if (!workRun) {
      throw new Error("Expected work run to exist");
    }

    if (!fs.existsSync(path.join(workRun.runDir, "result.json"))) {
      throw new Error("Expected work run to produce result.json");
    }

    if (!workRun.worktreePath || !fs.existsSync(path.join(workRun.worktreePath, "implemented.txt"))) {
      throw new Error("Expected worker to modify the worktree");
    }

    console.log("");
    console.log("Developer workflow smoke test passed.");
    console.log(`Temp repo: ${repoDir}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  run(process.execPath, ["--import", tsxLoader, cliEntry, ...args], { cwd, env });
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function rewriteConfig(repoDir: string): void {
  const configPath = path.join(repoDir, ".afk", "config.yaml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.github.enabled = false;
  config.runner.command = ["node", "fake-runner.mjs", "{prompt}"];
  config.runner.requiredEnv = [];
  config.runner.envAllowlist = [];
  config.verification = [];
  fs.writeFileSync(configPath, YAML.stringify(config));
}

function writeRepoFiles(repoDir: string): void {
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Fixture\n");
  fs.writeFileSync(
    path.join(repoDir, "fake-runner.mjs"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const promptPath = process.argv.at(-1);
const prompt = fs.readFileSync(promptPath, "utf8");
const match = prompt.match(/Write a JSON file to this exact path(?: when you are done)?:\\n([^\\n]+)/);
if (!match) {
  throw new Error("Missing output marker");
}
const outputPath = match[1].trim();

fs.writeFileSync(path.join(process.cwd(), "implemented.txt"), "done\\n");
fs.writeFileSync(outputPath, JSON.stringify({
  status: "done",
  summary: "Completed work item",
  issueComment: "Finished the AFK work item.",
  pr: {
    title: "AFK: complete work item",
    body: "Done"
  }
}, null, 2));
`
  );
}

function writeFakeDocker(fakeBinDir: string): void {
  const dockerPath = path.join(fakeBinDir, "docker");
  fs.writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "image" && args[1] === "inspect") {
  process.exit(1);
}
if (args[0] === "build") {
  process.exit(0);
}
if (args[0] !== "run") {
  process.exit(0);
}

let worktree = process.cwd();
const mounts = new Map();
let index = 1;
while (index < args.length) {
  if (args[index] === "--rm") {
    index += 1;
    continue;
  }
  if (args[index] === "-w") {
    index += 2;
    continue;
  }
  if (args[index] === "-v") {
    const [host, container] = args[index + 1].split(":");
    mounts.set(container, host);
    if (container === "/workspace") {
      worktree = host;
    }
    index += 2;
    continue;
  }
  if (args[index] === "-e") {
    index += 2;
    continue;
  }
  break;
}

index += 1;
const command = args[index];
const commandArgs = args.slice(index + 1).map((value) => {
  for (const [container, host] of mounts.entries()) {
    if (value.startsWith(container)) {
      return value.replace(container, host);
    }
  }
  return value;
});

const promptArgIndex = commandArgs.findIndex((value) => value.endsWith(".md"));
if (promptArgIndex >= 0) {
  const originalPromptPath = commandArgs[promptArgIndex];
  let prompt = fs.readFileSync(originalPromptPath, "utf8");
  for (const [container, host] of mounts.entries()) {
    prompt = prompt.split(container).join(host);
  }
  const rewrittenPromptPath = path.join(os.tmpdir(), \`afk-prompt-\${process.pid}-\${Date.now()}.md\`);
  fs.writeFileSync(rewrittenPromptPath, prompt);
  commandArgs[promptArgIndex] = rewrittenPromptPath;
}

const result = spawnSync(command, commandArgs, {
  cwd: worktree,
  stdio: "inherit"
});
process.exit(result.status ?? 1);
`
  );
  fs.chmodSync(dockerPath, 0o755);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
