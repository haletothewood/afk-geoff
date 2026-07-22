import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { createFixture, makeTempDir } from "./test-helpers.js";

describe("afk CLI — init command", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? "";
  const originalGhToken = process.env.GH_TOKEN;
  let tempDir = "";

  beforeEach(() => {
    tempDir = makeTempDir();
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

  it("Given a newly initialized repo, when init scaffolds project files, then it includes the iteration loop template", async () => {
    const fixture = await createFixture(tempDir);
    const loopPath = path.join(fixture.repoDir, ".afk", "iteration-loop.md");
    const loopTemplate = fs.readFileSync(loopPath, "utf8");

    expect(loopTemplate).toContain("Map all behavior paths");
    expect(loopTemplate).toContain("Run language-specific checks before PR");
  });

  it("Given an initialized repo, when init adds GitHub Actions, then it writes the AFK run workflow", async () => {
    const fixture = await createFixture(tempDir);
    const workflowPath = path.join(fixture.repoDir, ".github", "workflows", "afk-run.yml");

    await fixture.cli(["init", "--with-github-actions"]);

    const workflow = fs.readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("name: AFK Run");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("repository: ${{ inputs.afk_repository }}");
    expect(workflow).toContain("path: target");
    expect(workflow).toContain("working-directory: afk-geoff");
    expect(workflow).toContain("../afk-geoff/packages/cli/bin/afk.js doctor --json");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("set -o pipefail");
  });

  it("Given the AFK bin is run from another repo without local tsx, when init adds GitHub Actions, then it still starts", async () => {
    const fixture = await createFixture(tempDir);
    const workflowPath = path.join(fixture.repoDir, ".github", "workflows", "afk-run.yml");
    const binPath = path.join(originalCwd, "packages", "cli", "bin", "afk.js");

    execFileSync(binPath, ["init", "--with-github-actions"], { cwd: fixture.repoDir });

    expect(fs.readFileSync(workflowPath, "utf8")).toContain("name: AFK Run");
  });

  it("Given smoke runner profile is requested, when init runs, then it writes a no-key smoke runner command", async () => {
    const fixture = await createFixture(tempDir);
    const smokeRunnerPath = path.join(fixture.repoDir, ".afk", "smoke-runner.mjs");

    await fixture.cli(["init", "--runner-profile", "smoke"]);

    const config = YAML.parse(fs.readFileSync(path.join(fixture.repoDir, ".afk", "config.yaml"), "utf8"));
    expect(config.runner.command).toEqual(["node", ".afk/smoke-runner.mjs", "{prompt}"]);
    expect(config.runner.reviewCommand).toEqual(["node", ".afk/smoke-runner.mjs", "{prompt}"]);
    expect(config.runner.requiredEnv).toEqual([]);
    expect(config.execution.backend).toBe("local-process");
    expect(fs.readFileSync(smokeRunnerPath, "utf8")).toContain("Smoke runner completed without making changes");
  });

  it("Given an existing config, when local Codex profile is requested, then init updates runner settings without API env requirements", async () => {
    const fixture = await createFixture(tempDir);

    await fixture.cli(["init", "--runner-profile", "codex"]);

    const config = YAML.parse(fs.readFileSync(path.join(fixture.repoDir, ".afk", "config.yaml"), "utf8"));
    expect(config.runner.kind).toBe("codex");
    expect(config.runner.command).toBeUndefined();
    expect(config.runner.requiredEnv).toEqual([]);
    expect(config.execution.backend).toBe("local-process");
  });

  it("Given a GitHub Actions workflow already exists, when init adds GitHub Actions, then it refuses to overwrite it", async () => {
    const fixture = await createFixture(tempDir);
    const workflowPath = path.join(fixture.repoDir, ".github", "workflows", "afk-run.yml");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, "name: Custom Workflow\n");

    await expect(fixture.cli(["init", "--with-github-actions"])).rejects.toThrow("GitHub Actions workflow already exists");
    expect(fs.readFileSync(workflowPath, "utf8")).toBe("name: Custom Workflow\n");
  });

  it("Given a GitHub Actions workflow already exists, when init is forced, then it replaces the workflow", async () => {
    const fixture = await createFixture(tempDir);
    const workflowPath = path.join(fixture.repoDir, ".github", "workflows", "afk-run.yml");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, "name: Custom Workflow\n");

    await fixture.cli(["init", "--with-github-actions", "--force-github-actions"]);

    const workflow = fs.readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("name: AFK Run");
    expect(workflow).not.toBe("name: Custom Workflow\n");
  });
});
