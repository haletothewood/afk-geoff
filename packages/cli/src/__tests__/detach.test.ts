import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir, rewriteConfig } from "./test-helpers.js";

describe("afk CLI — detached run command", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? "";
  const originalGhToken = process.env.GH_TOKEN;
  const originalExecArgv = [...process.execArgv];
  let tempDir = "";

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);

    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("Given a pending AFK work item, when run --detach is used, then the CLI prints the run id and returns without waiting", async () => {
    const launchCalls: Array<{ argv: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const fixture = await createFixture(tempDir, {
      detachLauncher: (argv, env, cwd) => {
        launchCalls.push({ argv, env, cwd });
        return { pid: 0 };
      }
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["run", backend!.id, "--detach"]);
    });

    // Output should contain the run id and follow-up commands.
    expect(output).toMatch(/Run run_[a-z0-9]+/);
    expect(output).toContain("pnpm afk status");
    expect(output).toContain("pnpm afk runs");
    expect(output).not.toContain("pnpm afk watch");

    // A run record should be pre-created in the ledger.
    const runs = await fixture.store.listRuns();
    const detachedRun = runs.find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun).toBeDefined();
    expect(detachedRun?.status).toBe("running");

    // The work item should be marked in_progress so reconciliation can track it.
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("in_progress");

    // The launcher should have been called once with the run id in the environment.
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.env.AFK_DETACH_RUN_ID).toBe(detachedRun?.id);
    expect(launchCalls[0]?.argv).toContain(backend!.id);
  });

  it("Given the CLI is running through a TypeScript loader, when run --detach is used, then the child keeps the loader args", async () => {
    const launchCalls: Array<{ argv: string[] }> = [];
    process.execArgv.splice(0, process.execArgv.length, "--import", "file:///tmp/afk-test-tsx-loader.mjs");
    const fixture = await createFixture(tempDir, {
      detachLauncher: (argv) => {
        launchCalls.push({ argv });
        return { pid: 0 };
      }
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id, "--detach"]);

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.argv.slice(0, 4)).toEqual([
      process.execPath,
      "--import",
      "file:///tmp/afk-test-tsx-loader.mjs",
      process.argv[1]
    ]);
  });

  it("Given detached launcher startup fails, when run --detach is used, then the run and work item are marked failed", async () => {
    const fixture = await createFixture(tempDir, {
      detachLauncher: () => {
        throw new Error("simulated launch failure");
      }
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await expect(fixture.cli(["run", backend!.id, "--detach"])).rejects.toThrow("Detached launch failed");

    const refreshedItems = await fixture.items(requirement.id);
    expect(refreshedItems.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const detachedRun = (await fixture.store.listRuns()).find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun?.status).toBe("failed");
    expect(detachedRun?.summary).toContain("Detached launch failed");
  });

  it("Given a detached run has been started, when status and runs are used, then the detached run appears as active", async () => {
    const fixture = await createFixture(tempDir, {
      detachLauncher: () => ({ pid: 0 })
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id, "--detach"]);

    const runs = await fixture.store.listRuns();
    const detachedRun = runs.find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun).toBeDefined();

    const statusOutput = await captureConsole(async () => {
      await fixture.cli(["status"]);
    });
    expect(statusOutput).toContain(detachedRun!.id);
    expect(statusOutput).toContain("running");

    const runsOutput = await captureConsole(async () => {
      await fixture.cli(["runs"]);
    });
    expect(runsOutput).toContain(detachedRun!.id);
    expect(runsOutput).toContain(backend!.id);
  });

  it("Given a detached run with a stale heartbeat beyond the configured window, when status is refreshed, then the run and work item are marked failed", async () => {
    const fixture = await createFixture(tempDir, {
      detachLauncher: () => ({ pid: 0 })
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id, "--detach"]);

    // Write a progress file with a stale timestamp to simulate the worker going silent.
    const runs = await fixture.store.listRuns();
    const detachedRun = runs.find((run) => run.workItemId === backend!.id && run.mode === "work");
    expect(detachedRun).toBeDefined();
    fs.writeFileSync(
      path.join(detachedRun!.runDir, "progress.json"),
      JSON.stringify({ phase: "running", message: "Stuck", iteration: 1, updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }, null, 2)
    );

    // Set a very short heartbeat window and a long run timeout so only heartbeat fires.
    rewriteConfig(fixture.repoDir, { githubEnabled: false, timeouts: { runTimeoutMs: 24 * 60 * 60 * 1000, heartbeatStaleMs: 1 } });

    await fixture.cli(["status"]);

    const refreshedItems = await fixture.items(requirement.id);
    expect(refreshedItems.find((item) => item.id === backend!.id)?.status).toBe("failed");
    const refreshedRun = (await fixture.store.listRuns()).find((run) => run.id === detachedRun!.id);
    expect(refreshedRun?.status).toBe("failed");
    expect(refreshedRun?.summary).toContain("Heartbeat stale");
  });

  it("Given an execution brief file, when run file --detach is used, then it creates tracked state and starts a background worker with brief options", async () => {
    const launchCalls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
    const fixture = await createFixture(tempDir, {
      detachLauncher: (argv, env) => {
        launchCalls.push({ argv, env });
        return { pid: 0 };
      }
    });

    const briefPath = path.join(fixture.repoDir, "brief.md");
    fs.writeFileSync(
      briefPath,
      [
        "# AFK Execution Brief",
        "",
        "## Requirement",
        "Ship a narrow internal improvement for the AFK runner.",
        "",
        "## Work Item Title",
        "Add file-backed detached execution",
        "",
        "## Work Item Body",
        "Run a work item in the background from a brief file.",
        "",
        "## Acceptance Criteria",
        "- The detached run is tracked in the ledger",
        "",
        "## Verification",
        "- pnpm typecheck",
        "",
        "## GitHub Issue",
        "https://github.com/acme/demo/issues/77"
      ].join("\n")
    );

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--detach"]);
    });

    expect(output).toContain("Imported execution brief");
    expect(output).toMatch(/Run run_[a-z0-9]+/);
    expect(output).toContain("pnpm afk status");

    const runs = await fixture.store.listRuns();
    expect(runs.some((run) => run.status === "running")).toBe(true);
    expect(launchCalls).toHaveLength(1);
    const detachedOptions = JSON.parse(launchCalls[0]!.env.AFK_DETACH_RUN_OPTIONS ?? "{}") as { verification?: string[]; issueUrl?: string };
    expect(detachedOptions.verification).toEqual(["pnpm typecheck"]);
    expect(detachedOptions.issueUrl).toBe("https://github.com/acme/demo/issues/77");
  });

  it("Given an issue work source, when run issue --detach is used, then detached options include issue URL and verification", async () => {
    const launchCalls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const fixture = await createFixture(tempDir, {
      githubIssueWorkSource: {
        async load() {
          return {
            requirementBody: "Ship a narrow internal improvement for the AFK runner.",
            workItemTitle: "Run from issue in detach mode",
            workItemBody: "Execute a hand-authored GitHub issue body.",
            acceptanceCriteria: ["The runner can import a GitHub issue body"],
            verification: ["pnpm typecheck", "pnpm test -- packages/cli/src/index.test.ts"],
            issueUrl: "https://github.com/acme/demo/issues/42"
          };
        }
      },
      detachLauncher: (_argv, env) => {
        launchCalls.push({ env });
        return { pid: 0 };
      }
    });

    await fixture.cli(["run", "issue", "https://github.com/acme/demo/issues/42", "--detach"]);

    expect(launchCalls).toHaveLength(1);
    const detachedOptions = JSON.parse(launchCalls[0]!.env.AFK_DETACH_RUN_OPTIONS ?? "{}") as { verification?: string[]; issueUrl?: string };
    expect(detachedOptions.verification).toEqual(["pnpm typecheck", "pnpm test -- packages/cli/src/index.test.ts"]);
    expect(detachedOptions.issueUrl).toBe("https://github.com/acme/demo/issues/42");
  });

  it("Given runner preflight fails, when run --detach is used, then it fails before creating any run records", async () => {
    const launchCalls: Array<unknown> = [];
    const fixture = await createFixture(tempDir, {
      detachLauncher: (argv, env, cwd) => {
        launchCalls.push({ argv, env, cwd });
        return { pid: 0 };
      }
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerCommand: ["__afk_nonexistent_detach_runner__", "{prompt}"]
    });

    await expect(fixture.cli(["run", backend!.id, "--detach"])).rejects.toThrow("Preflight failed (runner):");

    // Detached launcher must not have been called and no run record must exist.
    expect(launchCalls).toHaveLength(0);
    expect(await fixture.store.listRuns()).toHaveLength(0);
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("todo");
  });
});
