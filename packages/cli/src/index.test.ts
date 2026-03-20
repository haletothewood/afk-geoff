import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@afk-geoff/adapter-sqlite";
import type { ChangeRequest, ChangeRequestPublisher, ExternalRef, IssueMirror, Requirement, WorkItem } from "@afk-geoff/core";
import { loadProjectConfig, resolveProjectPaths } from "@afk-geoff/shared";
import { runCli } from "./index.js";

interface FixtureOptions {
  githubEnabled?: boolean;
  writeWorktreeChange?: boolean;
  githubMirror?: MockGitHubMirror;
}

interface WorkflowFixture {
  repoDir: string;
  store: SqliteStateStore;
  githubMirror: MockGitHubMirror | undefined;
  cli(args: string[]): Promise<void>;
  capture(prompt: string): Promise<Requirement>;
  planAndApprove(requirementId: string): Promise<void>;
  requirement(): Promise<Requirement>;
  items(requirementId: string): Promise<Awaited<ReturnType<SqliteStateStore["listWorkItemsByRequirement"]>>>;
}

describe("aiwf CLI BDD scenarios", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? "";
  const originalGhToken = process.env.GH_TOKEN;
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwf-"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;

    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("Given a planned requirement, when it is approved, then AFK and HITL items enter the correct queue states", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.planAndApprove(requirement.id);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "backend")?.status).toBe("todo");
    expect(items.find((item) => item.planKey === "frontend")?.status).toBe("blocked");
    expect(items.find((item) => item.planKey === "review")?.status).toBe("hitl_pending");
  });

  it("Given a blocked AFK work item, when its dependency completes and status is refreshed, then it becomes todo", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.planAndApprove(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    let items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "backend")?.status).toBe("done");

    await fixture.cli(["status"]);
    items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "frontend")?.status).toBe("todo");
  });

  it("Given a HITL work item, when review is prepared, then a review run and review brief are created", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.planAndApprove(requirement.id);
    const reviewItem = (await fixture.items(requirement.id)).find((item) => item.planKey === "review");

    expect(reviewItem).toBeDefined();
    await fixture.cli(["review", reviewItem!.id]);

    const runs = await fixture.store.listRuns();
    const reviewRun = runs.find((run) => run.mode === "review");
    expect(reviewRun).toBeDefined();
    expect(fs.existsSync(path.join(reviewRun!.runDir, "review.md"))).toBe(true);

    const reviewBrief = fs.readFileSync(path.join(reviewRun!.runDir, "review.md"), "utf8");
    expect(reviewBrief).toContain("## Requirement");
    expect(reviewBrief).toContain("Review UX copy");
    expect(reviewBrief).toContain("## Acceptance Criteria");
  });

  it("Given GitHub mirroring is enabled, when work becomes actionable, then only the requirement and actionable work items are mirrored", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      writeWorktreeChange: false,
      githubMirror
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    expect(githubMirror.requirementMirrorIds).toEqual([requirement.id]);
    expect(githubMirror.workItemMirrorIds).toEqual([]);

    await fixture.cli(["plan", requirement.id]);
    expect(githubMirror.workItemMirrorIds).toEqual([]);

    await fixture.cli(["approve", requirement.id]);
    let items = await fixture.items(requirement.id);
    const backend = items.find((item) => item.planKey === "backend");
    const frontend = items.find((item) => item.planKey === "frontend");
    const review = items.find((item) => item.planKey === "review");

    expect(backend?.status).toBe("todo");
    expect(frontend?.status).toBe("blocked");
    expect(review?.status).toBe("hitl_pending");
    expect(githubMirror.workItemMirrorIds).toEqual([backend!.id, review!.id]);

    await fixture.cli(["run", backend!.id]);
    await fixture.cli(["status"]);

    items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === frontend!.id)?.status).toBe("todo");
    expect(githubMirror.workItemMirrorIds).toEqual([backend!.id, review!.id, frontend!.id]);
    expect(githubMirror.pullRequestRequests).toHaveLength(0);
  });

  it("Given requirements and runs exist, when inspection commands are used, then they show actionable local debugging information", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.planAndApprove(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    const items = await fixture.items(requirement.id);
    const backend = items.find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const showRequirementOutput = await captureConsole(async () => {
      await fixture.cli(["show", requirement.id]);
    });
    expect(showRequirementOutput).toContain(`Requirement ${requirement.id}`);
    expect(showRequirementOutput).toContain("Work items");

    const showWorkItemOutput = await captureConsole(async () => {
      await fixture.cli(["show", backend!.id]);
    });
    expect(showWorkItemOutput).toContain(`Work item ${backend!.id}`);
    expect(showWorkItemOutput).toContain("Acceptance criteria");

    const [workRun] = await fixture.store.listRuns();
    expect(workRun).toBeDefined();

    const runsOutput = await captureConsole(async () => {
      await fixture.cli(["runs"]);
    });
    expect(runsOutput).toContain("Runs");
    expect(runsOutput).toContain(workRun!.id);

    const logsOutput = await captureConsole(async () => {
      await fixture.cli(["logs", workRun!.id]);
    });
    expect(logsOutput).toContain(`Run ${workRun!.id}`);
    expect(logsOutput).toContain("== result:");
    expect(logsOutput).toContain('"status": "done"');
  });
});

async function createFixture(tempDir: string, options: FixtureOptions = {}): Promise<WorkflowFixture> {
  const repoDir = path.join(tempDir, "repo");
  const fakeBinDir = path.join(tempDir, "bin");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });

  writeFakeDocker(fakeBinDir);
  writeRepoFiles(repoDir, options.writeWorktreeChange ?? true);
  process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;

  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });
  process.chdir(repoDir);

  const dependencies = options.githubMirror
    ? { githubFactory: () => options.githubMirror as IssueMirror & ChangeRequestPublisher }
    : undefined;

  await runCli(["node", "aiwf", "init"], dependencies);
  rewriteConfig(repoDir, { githubEnabled: options.githubEnabled ?? false });

  if (options.githubEnabled) {
    process.env.GH_TOKEN = "test-token";
  }

  const config = loadProjectConfig(repoDir);
  const paths = resolveProjectPaths(repoDir, config);
  const store = new SqliteStateStore(paths.statePath);

  return {
    repoDir,
    store,
    githubMirror: options.githubMirror,
    cli: async (args: string[]) => {
      await runCli(["node", "aiwf", ...args], dependencies);
    },
    capture: async (prompt: string) => {
      await runCli(["node", "aiwf", "capture", prompt], dependencies);
      return await firstRequirement(store);
    },
    planAndApprove: async (requirementId: string) => {
      await runCli(["node", "aiwf", "plan", requirementId], dependencies);
      await runCli(["node", "aiwf", "approve", requirementId], dependencies);
    },
    requirement: async () => firstRequirement(store),
    items: async (requirementId: string) => store.listWorkItemsByRequirement(requirementId)
  };
}

async function firstRequirement(store: SqliteStateStore): Promise<Requirement> {
  const [requirement] = await store.listRequirements();

  if (!requirement) {
    throw new Error("Expected a requirement to exist");
  }

  return requirement;
}

function rewriteConfig(repoDir: string, options: { githubEnabled: boolean }): void {
  const configPath = path.join(repoDir, ".ai-workflows", "config.yaml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
  config.github.enabled = options.githubEnabled;
  config.github.owner = options.githubEnabled ? "acme" : undefined;
  config.github.repo = options.githubEnabled ? "demo" : undefined;
  config.runner.command = ["node", "fake-runner.mjs", "{prompt}"];
  config.runner.requiredEnv = [];
  config.runner.envAllowlist = [];
  config.verification = [];
  fs.writeFileSync(configPath, YAML.stringify(config));
}

function writeRepoFiles(repoDir: string, writeWorktreeChange: boolean): void {
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

if (prompt.includes('"items": [')) {
  fs.writeFileSync(outputPath, JSON.stringify({
    summary: "Planned work items",
    items: [
      {
        key: "backend",
        title: "Implement backend queue",
        body: "Create the backend processing flow.",
        type: "afk",
        acceptanceCriteria: ["Backend queue exists"],
        dependsOnKeys: []
      },
      {
        key: "frontend",
        title: "Wire frontend state",
        body: "Hook the UI into the backend queue.",
        type: "afk",
        acceptanceCriteria: ["UI uses backend queue"],
        dependsOnKeys: ["backend"]
      },
      {
        key: "review",
        title: "Review UX copy",
        body: "Human must confirm the UX wording.",
        type: "hitl",
        acceptanceCriteria: ["Copy decision recorded"],
        dependsOnKeys: []
      }
    ]
  }, null, 2));
  process.exit(0);
}

${writeWorktreeChange ? 'fs.writeFileSync(path.join(process.cwd(), "implemented.txt"), "done\\\\n");' : ""}
fs.writeFileSync(outputPath, JSON.stringify({
  status: "done",
  summary: "Completed work item",
  issueComment: "Finished the AFK work item.",
  pr: {
    title: "AIWF: complete work item",
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
  const rewrittenPromptPath = path.join(os.tmpdir(), \`aiwf-prompt-\${process.pid}-\${Date.now()}.md\`);
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

class MockGitHubMirror implements IssueMirror, ChangeRequestPublisher {
  public readonly requirementMirrorIds: string[] = [];
  public readonly workItemMirrorIds: string[] = [];
  public readonly pullRequestRequests: ChangeRequest[] = [];
  public readonly issueComments: Array<{ issueNumber: number; body: string }> = [];

  public async mirrorRequirement(input: { owner: string; repo: string; requirement: Requirement }): Promise<ExternalRef> {
    this.requirementMirrorIds.push(input.requirement.id);
    return createRef("requirement", input.requirement.id, "issue", this.requirementMirrorIds.length);
  }

  public async mirrorWorkItem(input: { owner: string; repo: string; workItem: WorkItem; requirement: Requirement }): Promise<ExternalRef> {
    this.workItemMirrorIds.push(input.workItem.id);
    return createRef("work_item", input.workItem.id, "issue", this.workItemMirrorIds.length + 100);
  }

  public async commentOnIssue(input: { owner: string; repo: string; issueNumber: number; body: string }): Promise<void> {
    this.issueComments.push({ issueNumber: input.issueNumber, body: input.body });
  }

  public async syncIssues(): Promise<Array<{ refId: string; open: boolean; comments: Array<{ id: string; body: string; createdAt: string }> }>> {
    return [];
  }

  public async openPullRequest(input: { owner: string; repo: string; changeRequest: ChangeRequest }): Promise<ExternalRef> {
    this.pullRequestRequests.push(input.changeRequest);
    return createRef("work_item", input.changeRequest.workItemId, "pull_request", this.pullRequestRequests.length + 200);
  }

  public async syncPullRequests(): Promise<Array<{ refId: string; state: "open" | "closed"; merged: boolean }>> {
    return [];
  }
}

function createRef(
  entityType: ExternalRef["entityType"],
  entityId: string,
  remoteType: ExternalRef["remoteType"],
  remoteNumber: number
): ExternalRef {
  const now = new Date().toISOString();
  return {
    id: `xref_${entityId}_${remoteType}_${remoteNumber}`,
    entityType,
    entityId,
    provider: "github",
    remoteType,
    remoteNumber,
    remoteId: String(remoteNumber),
    url: `https://example.com/${remoteType}/${remoteNumber}`,
    createdAt: now,
    updatedAt: now
  };
}

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });

  try {
    await action();
  } finally {
    logSpy.mockRestore();
  }

  return lines.join("\n");
}
