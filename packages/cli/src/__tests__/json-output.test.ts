import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, createFixture, makeTempDir, MockGitHubMirror, rewriteConfig, writeReviewVerdicts } from "./test-helpers.js";

describe("afk CLI — JSON output", () => {
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

  it("Given run file --pr --json, when the run completes, then stdout streams events and ends with the result payload", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });
    writeBrief(fixture.repoDir);

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--pr", "--backend", "local-docker", "--json"]);
    });
    const payloads = parseNdjson(output);
    const events = payloads.filter((payload) => payload.kind === "run_event");
    const payload = payloads.at(-1) as {
      kind: string;
	      command: string;
	      ok: boolean;
	      backend: string;
      workItemId: string;
      requirementId: string;
      runId: string;
      status: string;
      branchName: string;
      worktreePath: string;
      prUrl: string;
    };

    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "run_requested",
        "run_started",
        "worker_started",
        "worker_completed",
        "verification_started",
        "verification_completed",
        "review_started",
        "review_completed",
        "run_completed"
      ])
    );
    expect(payload.kind).toBe("run_result");
	    expect(payload.command).toBe("run");
	    expect(payload.ok).toBe(true);
	    expect(payload.backend).toBe("local-docker");
    expect(payload.workItemId).toMatch(/^wi_/);
    expect(payload.requirementId).toMatch(/^req_/);
    expect(payload.runId).toMatch(/^run_/);
    expect(payload.status).toBe("completed");
    expect(payload.branchName).toMatch(/^afk\//);
    expect(payload.worktreePath).toContain(payload.runId);
    expect(payload.prUrl).toBe("https://example.com/pull_request/201");
    expect(output).not.toContain("Imported execution brief");
    expect(output).not.toContain("Opened PR:");
	  });

	  it("Given run --detach --json, when the launcher starts, then stdout includes the pre-created run id", async () => {
	    const fixture = await createFixture(tempDir, {
	      detachLauncher: () => ({ pid: 0 })
	    });
	    writeBrief(fixture.repoDir);

	    const output = await captureConsole(async () => {
	      await fixture.cli(["run", "file", "brief.md", "--detach", "--json"]);
	    });
	    const payloads = parseNdjson(output);
	    const payload = payloads.at(-1) as {
        kind: string;
	      command: string;
	      ok: boolean;
	      detached: boolean;
	      workItemId: string;
	      requirementId: string;
	      runId: string;
	      status: string;
	      branchName: string;
	      worktreePath: string;
        runDir: string;
        detachLogPaths: { stdout: string; stderr: string };
	    };

      expect(payloads[0]?.kind).toBe("run_event");
      expect(payloads[0]?.event).toBe("run_requested");
      expect(payload.kind).toBe("run_result");
	    expect(payload.command).toBe("run");
	    expect(payload.ok).toBe(true);
	    expect(payload.detached).toBe(true);
	    expect(payload.workItemId).toMatch(/^wi_/);
	    expect(payload.requirementId).toMatch(/^req_/);
	    expect(payload.runId).toMatch(/^run_/);
	    expect(payload.status).toBe("running");
	    expect(payload.branchName).toMatch(/^afk\//);
	    expect(payload.worktreePath).toContain(payload.runId);
      expect(payload.runDir).toContain(payload.runId);
      expect(payload.detachLogPaths.stdout).toBe(path.join(payload.runDir, "detach-stdout.log"));
      expect(payload.detachLogPaths.stderr).toBe(path.join(payload.runDir, "detach-stderr.log"));
      expect(fs.existsSync(payload.detachLogPaths.stdout)).toBe(true);
      expect(fs.existsSync(payload.detachLogPaths.stderr)).toBe(true);
	    expect(output).not.toContain("Imported execution brief");
	    expect(output).not.toContain("pnpm afk status");
	  });

	  it("Given run --json fails before execution, then stdout includes a structured error payload", async () => {
	    const fixture = await createFixture(tempDir);
	    writeBrief(fixture.repoDir);
	    rewriteConfig(fixture.repoDir, {
	      githubEnabled: false,
	      runnerCommand: ["__afk_nonexistent_json_runner__", "{prompt}"]
	    });

	    const output = await captureConsoleForRejected(async () => {
	      await fixture.cli(["run", "file", "brief.md", "--json"]);
	    });
	    const payloads = parseNdjson(output);
	    const payload = payloads.at(-1) as {
        kind: string;
	      command: string;
	      ok: boolean;
	      backend: string;
	      error: { message: string };
	    };

      expect(payloads[0]?.kind).toBe("run_event");
      expect(payloads[0]?.event).toBe("run_requested");
      expect(payload.kind).toBe("run_result");
	    expect(payload.command).toBe("run");
	    expect(payload.ok).toBe(false);
	    expect(payload.backend).toBe("local-docker");
	    expect(payload.error.message).toContain("Preflight failed (runner):");
	    expect(payload.error.message).toContain("__afk_nonexistent_json_runner__");
	    expect(await fixture.store.listRuns()).toHaveLength(0);
	  });

  it("Given package-manager mismatch during run --json, then stdout remains strict NDJSON", async () => {
    const fixture = await createFixture(tempDir);
    const corepackLogPath = path.join(fixture.repoDir, "corepack-calls.log");
    fs.writeFileSync(
      path.join(fixture.repoDir, "package.json"),
      JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@10.20.0" }, null, 2)
    );
    fs.writeFileSync(path.join(fixture.repoDir, "pnpm"), ["#!/usr/bin/env node", "console.log('11.7.0');"].join("\n"));
    fs.chmodSync(path.join(fixture.repoDir, "pnpm"), 0o755);
    fs.writeFileSync(
      path.join(fixture.repoDir, "corepack"),
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(corepackLogPath)}, process.argv.slice(2).join(' ') + '\\n');`,
        "if (process.argv[3] === '--version') console.log('10.20.0');"
      ].join("\n")
    );
    fs.chmodSync(path.join(fixture.repoDir, "corepack"), 0o755);
    execFileSync("git", ["add", "package.json", "pnpm", "corepack"], { cwd: fixture.repoDir });
    execFileSync("git", ["commit", "-m", "configure package manager"], { cwd: fixture.repoDir });
    process.env.PATH = `${fixture.repoDir}:${process.env.PATH ?? ""}`;
    writeBrief(fixture.repoDir, { verification: ["pnpm --version"] });

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--json"]);
    });

    expect(output.split("\n").filter(Boolean).every((line) => line.trim().startsWith("{"))).toBe(true);
    const payloads = parseNdjson(output);
    expect(payloads.every((payload) => payload.kind === "run_event" || payload.kind === "run_result")).toBe(true);
    expect(payloads.map((payload) => payload.event)).toContain("package_manager_warning");
  }, 15_000);

  it("Given runs --json, when runs exist, then it prints structured run records", async () => {
    const fixture = await createFixture(tempDir);
    writeBrief(fixture.repoDir);
    await fixture.cli(["run", "file", "brief.md"]);

    const output = await captureConsole(async () => {
      await fixture.cli(["runs", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      count: number;
      runs: Array<{
        id: string;
        status: string;
        workItemId: string;
        diagnostics: {
          runDirExists: boolean;
          worktreeExists?: boolean;
          resultExists: boolean;
          finalResultExists: boolean;
        };
      }>;
    };

    expect(payload.command).toBe("runs");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("local-docker");
    expect(payload.count).toBe(1);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]?.id).toMatch(/^run_/);
    expect(payload.runs[0]?.workItemId).toMatch(/^wi_/);
    expect(payload.runs[0]?.status).toBe("completed");
    expect(payload.runs[0]?.diagnostics.runDirExists).toBe(true);
    expect(payload.runs[0]?.diagnostics.worktreeExists).toBe(true);
    expect(payload.runs[0]?.diagnostics.resultExists).toBe(true);
    expect(payload.runs[0]?.diagnostics.finalResultExists).toBe(true);
  });

  it("Given inspect --json, when a completed run exists, then it prints run diagnostics and final result summary", async () => {
    const fixture = await createFixture(tempDir);
    writeBrief(fixture.repoDir, { verification: ["node -e \"process.exit(0)\""] });
    await fixture.cli(["run", "file", "brief.md"]);
    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    await fixture.store.saveExternalRef({
      id: "github:pull_request:201",
      entityType: "work_item",
      entityId: run!.workItemId,
      provider: "github",
      remoteType: "pull_request",
      remoteNumber: 201,
      remoteId: "201",
      url: "https://example.com/pull_request/201",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["inspect", run!.id, "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      run: { id: string; branchName: string; worktreePath: string; status: string };
      paths: { runDir: string; resultPath: string; finalResultPath: string; worktreePath: string };
      diagnostics: { runDirExists: boolean; resultExists: boolean; finalResultExists: boolean; worktreeExists?: boolean };
      derived: {
        complete: boolean;
        publishable?: boolean;
        branchName?: string;
        reviewVerdict?: string;
        verificationStatus: string;
        createdCommitCount?: number;
        worktreeClean?: boolean;
      };
      evidencePacket: {
        changedFiles: string[];
        verification: { status: string; commands: Array<{ command: string; passed: boolean; exitCode: number }> };
        review: { verdict: string; passCount: number; issueCount: number; addressedIssueCount: number; remainingIssues: string[] };
        publishability: { publishable: boolean; blockers: Array<{ category: string; message: string }> };
        understandingBrief: { keyFilesChanged: string[]; importantDesignDecisions: string[]; inspectFirst: string[] };
        recommendedHumanAction: string;
      };
      finalResult: {
        branchName: string;
        publishable: boolean;
        publishabilityBlockers: Array<{ category: string; message: string }>;
        evidencePacket: { recommendedHumanAction: string };
      };
      pullRequest: { remoteType: string; remoteNumber: number; url: string };
    };

    expect(payload.command).toBe("inspect");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("local-docker");
    expect(payload.runId).toBe(run!.id);
    expect(payload.run.id).toBe(run!.id);
    expect(payload.run.status).toBe("completed");
    expect(payload.paths.runDir).toBe(run!.runDir);
    expect(payload.paths.resultPath).toBe(path.join(run!.runDir, "result.json"));
    expect(payload.paths.finalResultPath).toBe(path.join(run!.runDir, "final-result.json"));
    expect(payload.paths.worktreePath).toBe(run!.worktreePath);
    expect(payload.diagnostics.runDirExists).toBe(true);
    expect(payload.diagnostics.resultExists).toBe(true);
    expect(payload.diagnostics.finalResultExists).toBe(true);
    expect(payload.diagnostics.worktreeExists).toBe(true);
    expect(payload.derived.complete).toBe(true);
    expect(payload.derived.branchName).toBe(run!.branchName);
    expect(payload.derived.reviewVerdict).toBe("PASS");
    expect(payload.derived.verificationStatus).toBe("passed");
    expect(payload.derived.createdCommitCount).toBe(1);
    expect(payload.derived.worktreeClean).toBe(true);
    expect(payload.finalResult.branchName).toBe(run!.branchName);
    expect(payload.finalResult.publishabilityBlockers).toEqual([]);
    expect(payload.finalResult.evidencePacket.recommendedHumanAction).toBe("publish");
    expect(payload.evidencePacket.changedFiles).toContain("implemented.txt");
    expect(payload.evidencePacket.verification).toEqual({
      status: "passed",
      commands: [{ command: "node -e \"process.exit(0)\"", passed: true, exitCode: 0 }]
    });
    expect(payload.evidencePacket.review).toEqual({
      verdict: "PASS",
      passCount: 1,
      issueCount: 0,
      addressedIssueCount: 0,
      remainingIssues: []
    });
    expect(payload.evidencePacket.publishability).toEqual({ publishable: true, blockers: [] });
    expect(payload.evidencePacket.understandingBrief.keyFilesChanged).toContain("implemented.txt");
    expect(payload.evidencePacket.understandingBrief.inspectFirst).toContain("implemented.txt");
    expect(payload.evidencePacket.understandingBrief.importantDesignDecisions).toContain("Completed work item");
    expect(payload.evidencePacket.recommendedHumanAction).toBe("publish");
    expect(payload.pullRequest.remoteType).toBe("pull_request");
    expect(payload.pullRequest.remoteNumber).toBe(201);
    expect(payload.pullRequest.url).toBe("https://example.com/pull_request/201");
  });

  it("Given inspect --json cannot find a run, then stdout includes a structured error payload", async () => {
    const fixture = await createFixture(tempDir);

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["inspect", "run_missing", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      error: { message: string };
    };

    expect(payload.command).toBe("inspect");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBe("local-docker");
    expect(payload.runId).toBe("run_missing");
    expect(payload.error.message).toBe("Run run_missing not found");
  });

  it("Given handoff --json, when a publishable run has a pull request, then it prints a bot-friendly summary", async () => {
    const fixture = await createFixture(tempDir);
    writeBrief(fixture.repoDir, { verification: ["node -e \"process.exit(0)\""] });
    await fixture.cli(["run", "file", "brief.md"]);
    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    await fixture.store.saveExternalRef({
      id: "github:pull_request:202",
      entityType: "work_item",
      entityId: run!.workItemId,
      provider: "github",
      remoteType: "pull_request",
      remoteNumber: 202,
      remoteId: "202",
      url: "https://example.com/pull_request/202",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["handoff", run!.id, "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      workItemId: string;
      status: string;
      recommendedAction: string;
      branchName: string;
      pullRequest: { remoteNumber: number; url: string };
      publishable: boolean;
      reviewVerdict: string;
      verificationStatus: string;
      createdCommitCount: number;
      worktreeClean: boolean;
      runDir: string;
      finalResultPath: string;
      worktreePath: string;
      evidencePacket: {
        changedFiles: string[];
        verification: { status: string };
        review: { verdict: string };
        publishability: { publishable: boolean; blockers: Array<{ category: string; message: string }> };
        recommendedHumanAction: string;
      };
    };

    expect(payload.command).toBe("handoff");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("local-docker");
    expect(payload.runId).toBe(run!.id);
    expect(payload.workItemId).toBe(run!.workItemId);
    expect(payload.status).toBe("completed");
    expect(payload.recommendedAction).toBe("publish");
    expect(payload.branchName).toBe(run!.branchName);
    expect(payload.pullRequest.remoteNumber).toBe(202);
    expect(payload.pullRequest.url).toBe("https://example.com/pull_request/202");
    expect(payload.publishable).toBe(true);
    expect(payload.reviewVerdict).toBe("PASS");
    expect(payload.verificationStatus).toBe("passed");
    expect(payload.createdCommitCount).toBe(1);
    expect(payload.worktreeClean).toBe(true);
    expect(payload.runDir).toBe(run!.runDir);
    expect(payload.finalResultPath).toBe(path.join(run!.runDir, "final-result.json"));
    expect(payload.worktreePath).toBe(run!.worktreePath);
    expect(payload.evidencePacket.changedFiles).toContain("implemented.txt");
    expect(payload.evidencePacket.verification.status).toBe("passed");
    expect(payload.evidencePacket.review.verdict).toBe("PASS");
    expect(payload.evidencePacket.publishability).toEqual({ publishable: true, blockers: [] });
    expect(payload.evidencePacket.recommendedHumanAction).toBe("publish");
  });

  it("Given handoff --json for an environment-blocked run, then evidence separates the blocker category", async () => {
    const fixture = await createFixture(tempDir);
    writeBrief(fixture.repoDir, { verification: ["node -e \"process.exit(0)\""] });
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "BLOCKED", blockerReason: "Missing required env var EXAMPLE_API_KEY" }
    ]);

    await fixture.cli(["run", "file", "brief.md"]);
    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["handoff", run!.id, "--json"]);
    });
    const payload = JSON.parse(output) as {
      recommendedAction: string;
      publishable: boolean;
      reviewVerdict: string;
      verificationStatus: string;
      evidencePacket: {
        publishability: { publishable: boolean; blockers: Array<{ category: string; message: string }> };
        recommendedHumanAction: string;
      };
    };

    expect(payload.recommendedAction).toBe("report_failure");
    expect(payload.publishable).toBe(false);
    expect(payload.reviewVerdict).toBe("BLOCKED");
    expect(payload.verificationStatus).toBe("passed");
    expect(payload.evidencePacket.publishability).toEqual({
      publishable: false,
      blockers: [{ category: "environment", message: "Missing required env var EXAMPLE_API_KEY" }]
    });
    expect(payload.evidencePacket.recommendedHumanAction).toBe("fix_environment");
  });

  it("Given handoff --json cannot find a run, then stdout includes a structured error payload", async () => {
    const fixture = await createFixture(tempDir);

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["handoff", "run_missing", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      error: { message: string };
    };

    expect(payload.command).toBe("handoff");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBe("local-docker");
    expect(payload.runId).toBe("run_missing");
    expect(payload.error.message).toBe("Run run_missing not found");
  });

  it("Given watch --json observes a completed run, then stdout contains a run event and final watch result", async () => {
    const fixture = await createFixture(tempDir);
    writeBrief(fixture.repoDir);
    await fixture.cli(["run", "file", "brief.md"]);
    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["watch", run!.id, "--json"]);
    });
    const payloads = parseNdjson(output);
    const event = payloads[0] as { kind: string; event: string; runId: string; status: string; workItemId: string };
    const result = payloads.at(-1) as {
      kind: string;
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      status: string;
      workItemId: string;
      branchName: string;
      worktreePath: string;
      runDir: string;
    };

    expect(event.kind).toBe("run_event");
    expect(event.event).toBe("run_observed");
    expect(event.runId).toBe(run!.id);
    expect(event.status).toBe("completed");
    expect(event.workItemId).toBe(run!.workItemId);
    expect(result.kind).toBe("watch_result");
    expect(result.command).toBe("watch");
    expect(result.ok).toBe(true);
    expect(result.backend).toBe("local-docker");
    expect(result.runId).toBe(run!.id);
    expect(result.status).toBe("completed");
    expect(result.workItemId).toBe(run!.workItemId);
    expect(result.branchName).toBe(run!.branchName);
    expect(result.worktreePath).toBe(run!.worktreePath);
    expect(result.runDir).toBe(run!.runDir);
    expect(output).not.toContain("[stdout]");
  });

  it("Given watch --json cannot find a run, then stdout includes a structured error payload", async () => {
    const fixture = await createFixture(tempDir);

    const { output, exitCode } = await captureConsoleAndExitCode(async () => {
      await fixture.cli(["watch", "run_missing", "--json"]);
    });
    const payload = JSON.parse(output) as {
      kind: string;
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      error: { message: string };
    };

    expect(payload.kind).toBe("watch_result");
    expect(payload.command).toBe("watch");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBe("local-docker");
    expect(payload.runId).toBe("run_missing");
    expect(payload.error.message).toBe("Run run_missing not found");
    expect(exitCode).toBe(1);
  });

  it("Given watch --json sees a dead detached worker before final artifacts exist, then it marks the run failed", async () => {
    const fixture = await createFixture(tempDir, { watchPollIntervalMs: 0 });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const runId = "run_dead_detached";
    const runDir = path.join(fixture.repoDir, ".afk", "runs", runId);
    const worktreePath = path.join(fixture.repoDir, ".afk", "worktrees", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    await fixture.store.createRun({
      id: runId,
      workItemId: backend!.id,
      mode: "work",
      status: "running",
      branchName: "afk/dead-detached",
      worktreePath,
      runDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await fixture.store.updateWorkItemStatus(backend!.id, "in_progress");
    fs.writeFileSync(path.join(runDir, "detach-process.json"), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }, null, 2));
    fs.writeFileSync(
      path.join(runDir, "progress.json"),
      JSON.stringify({ phase: "starting", message: "Detached worker starting", iteration: 0, updatedAt: new Date().toISOString() }, null, 2)
    );

    const { output, exitCode } = await captureConsoleAndExitCode(async () => {
      await fixture.cli(["watch", runId, "--json"]);
    });
    const payloads = parseNdjson(output);
    const events = payloads.filter((payload) => payload.kind === "run_event");
    const result = payloads.at(-1) as {
      kind: string;
      command: string;
      ok: boolean;
      runId: string;
      status: string;
      error: { message: string };
    };

    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["watch_started", "progress_observed", "run_failed"]));
    expect(result.kind).toBe("watch_result");
    expect(result.command).toBe("watch");
    expect(result.ok).toBe(false);
    expect(result.runId).toBe(runId);
    expect(result.status).toBe("failed");
    expect(result.error.message).toContain("Detached worker process 999999 exited before completing run artifacts");
    expect(exitCode).toBe(1);

    const [updatedRun] = (await fixture.store.listRuns()).filter((run) => run.id === runId);
    expect(updatedRun?.status).toBe("failed");
    expect((await fixture.items(requirement.id)).find((item) => item.id === backend!.id)?.status).toBe("failed");
  });

  it("Given status --json, when work exists, then it prints queue and next-action state", async () => {
    const fixture = await createFixture(tempDir);
    writeBrief(fixture.repoDir);
    await fixture.cli(["run", "file", "brief.md"]);
    const [run] = await fixture.store.listRuns();

    const output = await captureConsole(async () => {
      await fixture.cli(["status", run!.workItemId, "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      workItemId: string;
      requirements: unknown[];
      workItems: Array<{ id: string; status: string }>;
      focusedWorkItem: { id: string; status: string };
      nextActions: string[];
    };

    expect(payload.command).toBe("status");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("local-docker");
    expect(payload.workItemId).toBe(run!.workItemId);
    expect(payload.requirements).toHaveLength(1);
    expect(payload.workItems).toHaveLength(1);
    expect(payload.focusedWorkItem.id).toBe(run!.workItemId);
    expect(payload.focusedWorkItem.status).toBe("done");
    expect(payload.nextActions).toEqual(["- All work items are complete"]);
  });

  it("Given follow-up --json, when review comments exist, then it reports the same PR and actionable comment details", async () => {
    const githubMirror = new MockGitHubMirror();
    githubMirror.reviewComments = [
      {
        id: "comment_1",
        path: "src/app.ts",
        line: 12,
        body: "Please add error handling."
      }
    ];
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror,
      verification: ["node -e \"process.exit(0)\""]
    });
    writeBrief(fixture.repoDir);

    await fixture.cli(["run", "file", "brief.md", "--pr"]);
    const [initialRun] = await fixture.store.listRuns();

    const output = await captureConsole(async () => {
      await fixture.cli(["follow-up", initialRun!.workItemId, "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      workItemId: string;
      runId: string;
      status: string;
      branchName: string;
      prUrl: string;
      actionableReviewComments: Array<{ id: string; location: string; body: string; path?: string; line?: number }>;
      addressedReviewComments: number;
      verification: {
        status: string;
        commands: Array<{ command: string; passed: boolean; exitCode: number }>;
      };
    };

    expect(payload.command).toBe("follow-up");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("local-docker");
    expect(payload.workItemId).toBe(initialRun!.workItemId);
    expect(payload.status).toBe("completed");
    expect(payload.branchName).toBe(initialRun!.branchName);
    expect(payload.prUrl).toBe("https://example.com/pull_request/201");
    expect(payload.actionableReviewComments).toEqual([
      {
        id: "comment_1",
        location: "src/app.ts:12",
        body: "Please add error handling.",
        path: "src/app.ts",
        line: 12
      }
    ]);
    expect(payload.addressedReviewComments).toBe(1);
    expect(payload.verification).toEqual({
      status: "passed",
      commands: [{ command: "node -e \"process.exit(0)\"", passed: true, exitCode: 0 }]
    });
    expect(output).not.toContain("Addressed 1 review comment");
  });

  it("Given follow-up --json has no review comments, then stdout includes a structured error payload", async () => {
	    const githubMirror = new MockGitHubMirror();
	    const fixture = await createFixture(tempDir, {
	      githubEnabled: true,
	      githubMirror
	    });
	    writeBrief(fixture.repoDir);

	    await fixture.cli(["run", "file", "brief.md", "--pr"]);
	    const [initialRun] = await fixture.store.listRuns();

	    const output = await captureConsoleForRejected(async () => {
	      await fixture.cli(["follow-up", initialRun!.workItemId, "--json"]);
	    });
	    const payload = JSON.parse(output) as {
	      command: string;
	      ok: boolean;
	      backend: string;
	      workItemId: string;
	      error: { message: string };
	    };

	    expect(payload.command).toBe("follow-up");
	    expect(payload.ok).toBe(false);
	    expect(payload.backend).toBe("local-docker");
	    expect(payload.workItemId).toBe(initialRun!.workItemId);
    expect(payload.error.message).toContain("no actionable review comments");
  });

  it("Given submit issue --backend github-actions --json, when GitHub is configured, then it dispatches the AFK workflow", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });
    const issueUrl = "https://github.com/acme/demo/issues/42";

    const output = await captureConsole(async () => {
      await fixture.cli(["submit", "issue", issueUrl, "--backend", "github-actions", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      target: string;
      value: string;
      backend: string;
      workflowId: string;
      ref: string;
      issueUrl: string;
      requirePullRequest: boolean;
      inputs: Record<string, string>;
    };

    expect(payload.command).toBe("submit");
    expect(payload.ok).toBe(true);
    expect(payload.target).toBe("issue");
    expect(payload.value).toBe(issueUrl);
    expect(payload.backend).toBe("github-actions");
    expect(payload.workflowId).toBe("afk-run.yml");
    expect(payload.ref).toBe("main");
    expect(payload.issueUrl).toBe(issueUrl);
    expect(payload.requirePullRequest).toBe(true);
    expect(payload.inputs).toEqual({
      issue_url: issueUrl,
      backend: "local-docker",
      require_pr: "true",
      afk_repository: "haletothewood/afk-geoff",
      afk_ref: "main"
    });
    expect(githubMirror.workflowDispatches).toEqual([
      {
        owner: "acme",
        repo: "demo",
        workflowId: "afk-run.yml",
        ref: "main",
        inputs: {
          issue_url: issueUrl,
          backend: "local-docker",
          require_pr: "true",
          afk_repository: "haletothewood/afk-geoff",
          afk_ref: "main"
        }
      }
    ]);
  });

  it("Given submit issue overrides AFK repo and ref, when dispatched, then those workflow inputs are sent", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });
    const issueUrl = "https://github.com/acme/demo/issues/42";

    await captureConsole(async () => {
      await fixture.cli([
        "submit",
        "issue",
        issueUrl,
        "--backend",
        "github-actions",
        "--afk-repository",
        "acme/afk-geoff",
        "--afk-ref",
        "prototype-branch",
        "--json"
      ]);
    });

    expect(githubMirror.workflowDispatches[0]?.inputs).toMatchObject({
      afk_repository: "acme/afk-geoff",
      afk_ref: "prototype-branch"
    });
  });

  it("Given remote-runs --json, when workflow runs exist, then it lists GitHub Actions runs", async () => {
    const githubMirror = new MockGitHubMirror();
    githubMirror.workflowRuns = [
      {
        id: "123",
        name: "Run AFK work from issue",
        status: "completed",
        conclusion: "success",
        branch: "main",
        event: "workflow_dispatch",
        url: "https://github.com/acme/demo/actions/runs/123",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z"
      }
    ];
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["remote-runs", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      workflowId: string;
      runs: Array<{ id: string; status: string; conclusion: string; url: string }>;
    };

    expect(payload.command).toBe("remote-runs");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("github-actions");
    expect(payload.workflowId).toBe("afk-run.yml");
    expect(payload.runs).toEqual([
      {
        id: "123",
        name: "Run AFK work from issue",
        status: "completed",
        conclusion: "success",
        branch: "main",
        event: "workflow_dispatch",
        url: "https://github.com/acme/demo/actions/runs/123",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z"
      }
    ]);
  });

  it("Given remote-runs --json has an invalid limit, then stdout includes a structured error payload", async () => {
    const fixture = await createFixture(tempDir, { githubEnabled: true });

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["remote-runs", "--limit", "0", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      workflowId: string;
      error: { message: string };
    };

    expect(payload.command).toBe("remote-runs");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBe("github-actions");
    expect(payload.workflowId).toBe("afk-run.yml");
    expect(payload.error.message).toBe("--limit must be a positive integer");
  });

  it("Given remote-artifacts --json, when a workflow run has artifacts, then it lists artifact metadata", async () => {
    const githubMirror = new MockGitHubMirror();
    githubMirror.workflowArtifacts = [
      {
        id: "456",
        name: "afk-run-json",
        sizeInBytes: 2048,
        expired: false,
        url: "https://api.github.com/repos/acme/demo/actions/artifacts/456",
        archiveDownloadUrl: "https://api.github.com/repos/acme/demo/actions/artifacts/456/zip",
        createdAt: "2026-01-01T00:02:00Z",
        updatedAt: "2026-01-01T00:03:00Z",
        expiresAt: "2026-04-01T00:02:00Z"
      }
    ];
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });

    const output = await captureConsole(async () => {
      await fixture.cli(["remote-artifacts", "123", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      artifacts: Array<{ id: string; name: string; archiveDownloadUrl: string }>;
    };

    expect(payload.command).toBe("remote-artifacts");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("github-actions");
    expect(payload.runId).toBe("123");
    expect(payload.artifacts).toEqual([
      {
        id: "456",
        name: "afk-run-json",
        sizeInBytes: 2048,
        expired: false,
        url: "https://api.github.com/repos/acme/demo/actions/artifacts/456",
        archiveDownloadUrl: "https://api.github.com/repos/acme/demo/actions/artifacts/456/zip",
        createdAt: "2026-01-01T00:02:00Z",
        updatedAt: "2026-01-01T00:03:00Z",
        expiresAt: "2026-04-01T00:02:00Z"
      }
    ]);
  });

  it("Given remote-artifacts --json has a non-numeric run id, then stdout includes a structured error payload", async () => {
    const fixture = await createFixture(tempDir, { githubEnabled: true });

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["remote-artifacts", "run_123", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      runId: string;
      error: { message: string };
    };

    expect(payload.command).toBe("remote-artifacts");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBe("github-actions");
    expect(payload.runId).toBe("run_123");
    expect(payload.error.message).toBe("runId must be a GitHub Actions numeric run id");
  });

  it("Given remote-download --json, when an artifact exists, then it saves the artifact ZIP and reports the path", async () => {
    const githubMirror = new MockGitHubMirror();
    githubMirror.workflowArtifactBytes = new Uint8Array(Buffer.from("zip-bytes"));
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });
    const outputPath = `${fixture.repoDir}/downloaded.zip`;

    const output = await captureConsole(async () => {
      await fixture.cli(["remote-download", "456", "--output", outputPath, "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      artifactId: string;
      outputPath: string;
      bytes: number;
    };

    expect(payload.command).toBe("remote-download");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("github-actions");
    expect(payload.artifactId).toBe("456");
    expect(payload.outputPath).toBe(outputPath);
    expect(payload.bytes).toBe(9);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("zip-bytes");
  });

  it("Given remote-download --json has a non-numeric artifact id, then stdout includes a structured error payload", async () => {
    const fixture = await createFixture(tempDir, { githubEnabled: true });

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["remote-download", "artifact_456", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      artifactId: string;
      error: { message: string };
    };

    expect(payload.command).toBe("remote-download");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBe("github-actions");
    expect(payload.artifactId).toBe("artifact_456");
    expect(payload.error.message).toBe("artifactId must be a GitHub Actions numeric artifact id");
  });
});

async function captureConsoleForRejected(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });

  try {
    await expect(action()).rejects.toThrow();
  } finally {
    logSpy.mockRestore();
  }

  return lines.join("\n");
}

async function captureConsoleAndExitCode(action: () => Promise<void>): Promise<{ output: string; exitCode: string | number | undefined }> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const output = await captureConsole(action);
    return { output, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

function parseNdjson(output: string): Array<Record<string, any>> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function writeBrief(repoDir: string, options: { verification?: string[] } = {}): void {
  fs.writeFileSync(
    `${repoDir}/brief.md`,
    [
      "# AFK Execution Brief",
      "",
      "## Requirement",
      "Ship a narrow internal improvement for the AFK runner.",
      "",
      "## Work Item Title",
      "Publish a PR",
      "",
      "## Work Item Body",
      "Create a branch and pull request.",
      "",
      "## Acceptance Criteria",
      "- A pull request is opened for review",
      ...(options.verification && options.verification.length > 0
        ? ["", "## Verification", ...options.verification.map((command) => `- ${command}`)]
        : [])
    ].join("\n")
  );
}
