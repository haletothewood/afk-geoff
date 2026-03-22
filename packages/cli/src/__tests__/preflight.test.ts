import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixture, makeTempDir, MockGitHubMirror, rewriteConfig } from "./test-helpers.js";

describe("afk CLI — preflight checks", () => {
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

  it("Given run file is missing a path, when preflight would fail, then usage validation runs first", async () => {
    const fixture = await createFixture(tempDir);

    // If preflight ran first this would fail with a runner preflight error instead.
    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerCommand: ["__afk_nonexistent_runner__", "{prompt}"]
    });

    await expect(fixture.cli(["run", "file"])).rejects.toThrow("Usage: pnpm afk run file <path>");
    expect(await fixture.store.listRuns()).toHaveLength(0);
  });

  it("Given the runner executable is not on PATH, when run is used, then it fails with a runner preflight error before creating any run records", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerCommand: ["__afk_nonexistent_runner__", "{prompt}"]
    });

    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("Preflight failed (runner):");
    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("__afk_nonexistent_runner__");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    // Work item status must not have changed.
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("todo");
  });

  it("Given a required runner env var is missing, when run is used, then it fails with a runner preflight error before creating any run records", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerRequiredEnv: ["AFK_TEST_PREFLIGHT_MISSING_VAR"]
    });
    delete process.env.AFK_TEST_PREFLIGHT_MISSING_VAR;

    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("Preflight failed (runner):");
    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow("AFK_TEST_PREFLIGHT_MISSING_VAR");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("todo");
  });

  it("Given the git origin remote is not accessible, when run --pr is used, then it fails with a git preflight error before creating any run records", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror,
      gitRemoteChecker: async () => {
        throw new Error("Preflight failed (git): origin remote is not accessible: could not connect");
      }
    });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement.",
        "",
        "## Work Item Title",
        "Git remote preflight check",
        "",
        "## Work Item Body",
        "Verify git push readiness up front.",
        "",
        "## Acceptance Criteria",
        "- Git remote is accessible before run starts"
      ].join("\n")
    );

    await expect(fixture.cli(["run", "file", "brief.md", "--pr"])).rejects.toThrow("Preflight failed (git):");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    expect(githubMirror.pullRequestRequests).toHaveLength(0);
  });

  it("Given GitHub auth is invalid, when run --pr is used, then it fails with a github preflight error before creating any run records", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror,
      githubAuthVerifier: async () => {
        throw new Error("Preflight failed (github): GitHub token is invalid or unauthenticated: HTTP 401");
      }
    });
    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement.",
        "",
        "## Work Item Title",
        "GitHub auth preflight check",
        "",
        "## Work Item Body",
        "Verify GitHub token validity up front.",
        "",
        "## Acceptance Criteria",
        "- GitHub auth is valid before run starts"
      ].join("\n")
    );

    await expect(fixture.cli(["run", "file", "brief.md", "--pr"])).rejects.toThrow("Preflight failed (github):");

    // No run record should have been created.
    expect(await fixture.store.listRuns()).toHaveLength(0);
    expect(githubMirror.pullRequestRequests).toHaveLength(0);
  });

  it("Given all preflight checks pass, when run is used, then the run proceeds normally", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("done");
    expect(await fixture.store.listRuns()).toHaveLength(1);
  });
});
