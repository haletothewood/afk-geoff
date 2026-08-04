import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, createFixture, makeTempDir, MockGitHubMirror, rewriteConfig, writeReviewVerdicts } from "./test-helpers.js";

describe("afk CLI — autonomous review gate loop", () => {
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

    delete process.env.AFK_TEST_REVIEW_VERDICTS_PATH;

    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // PASS path
  // -----------------------------------------------------------------------
  it("PASS path: when review returns PASS on the first iteration, the run completes as done", async () => {
    const fixture = await createFixture(tempDir);
    // Default review verdict is PASS (no control file = default PASS).

    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("done");

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("completed");
  });

  // -----------------------------------------------------------------------
  // Repeated ISSUES path (ISSUES → PASS)
  // -----------------------------------------------------------------------
  it("repeated ISSUES path: when review returns ISSUES then PASS, the run completes after a fix iteration", async () => {
    const fixture = await createFixture(tempDir);
    // First review: ISSUES; second review: PASS.
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["Missing error handling in the queue processor"] },
      { verdict: "PASS" }
    ]);

    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("done");

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("completed");

    // There should be both a work prompt and a fix prompt in the run directory.
    expect(fs.existsSync(path.join(run!.runDir, "prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(run!.runDir, "fix-prompt-2.md"))).toBe(true);
    expect(fs.existsSync(path.join(run!.runDir, "work-result-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(run!.runDir, "fix-result-2.json"))).toBe(true);

    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      summary: string;
      workerResults: Array<{ phase: string }>;
      reviewResults: Array<{ verdict: string; issues?: string[] }>;
      commits: Array<{ created: boolean }>;
    };
    expect(finalResult.summary).toContain("2 worker phases");
    expect(finalResult.summary).toContain("2 review passes");
    expect(finalResult.workerResults.map((result) => result.phase)).toEqual(["work", "fix"]);
    expect(finalResult.reviewResults).toEqual([
      expect.objectContaining({
        verdict: "ISSUES",
        issues: ["Missing error handling in the queue processor"]
      }),
      expect.objectContaining({ verdict: "PASS" })
    ]);
    expect(finalResult.commits.some((commit) => commit.created)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // BLOCKED path
  // -----------------------------------------------------------------------
  it("blocked path: when review returns BLOCKED, the run is marked blocked", async () => {
    const fixture = await createFixture(tempDir);
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "BLOCKED", blockerReason: "Cannot proceed without external API credentials" }
    ]);

    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("blocked");

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("completed");
    expect(run?.summary).toContain("Cannot proceed without external API credentials");
  });

  // -----------------------------------------------------------------------
  // Malformed review output
  // -----------------------------------------------------------------------
  it("malformed review output: when review agent writes invalid JSON, the run fails", async () => {
    const fixture = await createFixture(tempDir);
    // Use a special sentinel verdict that causes the fake runner to produce malformed JSON.
    writeReviewVerdicts(fixture.repoDir, [{ verdict: "__MALFORMED__" }]);

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("failed");

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("failed");
    expect(run?.summary).toContain("malformed");
    expect(run?.terminalFailure).toEqual({
      category: "orchestrator",
      message: expect.stringContaining("malformed")
    });
    const finalResult = JSON.parse(
      fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")
    ) as {
      terminalFailure?: { category: string; message: string };
      evidencePacket?: { terminalFailure?: { category: string; message: string } };
    };
    expect(finalResult.terminalFailure).toEqual(run?.terminalFailure);
    expect(finalResult.evidencePacket?.terminalFailure).toEqual(run?.terminalFailure);
  });

  it("review retry: a missing verdict reruns only review against the unchanged verified commit", async () => {
    const verificationLog = path.join(tempDir, "verification.log");
    const fixture = await createFixture(tempDir, {
      verification: [`node -e "require('fs').appendFileSync('${verificationLog}', 'verified\\n')"`]
    });
    writeReviewVerdicts(fixture.repoDir, ["__MISSING__"]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    const originalHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: run!.worktreePath!,
      encoding: "utf8"
    }).trim();
    const workerPromptModifiedAt = fs.statSync(path.join(run!.runDir, "prompt.md")).mtimeMs;
    writeReviewVerdicts(fixture.repoDir, ["PASS"]);

    const retryOutput = await captureConsole(async () => {
      await fixture.cli(["retry", run!.id, "--stage", "review", "--json"]);
    });
    const payloads = retryOutput.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      kind?: string;
      event?: string;
      reusedStages?: string[];
      retriedStage?: string;
      status?: string;
      recovery?: { reviewAttempt: number; maxReviewAttempts: number };
    }>;

    expect(payloads.filter((payload) => payload.kind === "run_event").map((payload) => payload.event)).toEqual([
      "evidence_reused",
      "review_started",
      "review_completed"
    ]);
    expect(payloads[0]).toEqual(expect.objectContaining({
      reusedStages: ["work", "verification"],
      retriedStage: "review"
    }));
    expect(payloads.at(-1)).toEqual(expect.objectContaining({
      kind: "retry_result",
      status: "done",
      recovery: expect.objectContaining({ reviewAttempt: 2, maxReviewAttempts: 3 })
    }));

    const finalResult = JSON.parse(
      fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")
    ) as {
      status: string;
      publishable: boolean;
      terminalFailure?: unknown;
      workerResults: unknown[];
      verificationSummaries: unknown[];
      reviewResults: Array<{ verdict: string; recovery?: boolean; attempt?: number }>;
      recovery: { reusedStages: string[]; retriedStages: string[]; reviewAttempt: number };
      evidencePacket: { recovery: { retriedStages: string[] }; review: { verdict: string } };
    };
    expect(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: run!.worktreePath!,
      encoding: "utf8"
    }).trim()).toBe(originalHead);
    expect(fs.readFileSync(verificationLog, "utf8").trim().split("\n")).toEqual(["verified"]);
    expect(fs.statSync(path.join(run!.runDir, "prompt.md")).mtimeMs).toBe(workerPromptModifiedAt);
    expect(finalResult).toEqual(expect.objectContaining({
      status: "done",
      publishable: true,
      workerResults: [expect.any(Object)],
      verificationSummaries: [expect.any(Object)],
      reviewResults: [expect.objectContaining({ verdict: "PASS", recovery: true, attempt: 2 })]
    }));
    expect(finalResult.terminalFailure).toBeUndefined();
    expect(finalResult.recovery).toEqual(expect.objectContaining({
      reusedStages: ["work", "verification"],
      retriedStages: ["review"],
      reviewAttempt: 2
    }));
    expect(finalResult.evidencePacket.recovery).toEqual(finalResult.recovery);
    expect(finalResult.evidencePacket.review.verdict).toBe("PASS");
  });

  it("review retry: actionable issues continue into the normal fix workflow", async () => {
    const fixture = await createFixture(tempDir, {
      verification: ['node -e "process.exit(0)"']
    });
    writeReviewVerdicts(fixture.repoDir, ["__MISSING__"]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");

    await fixture.cli(["run", backend!.id]);
    const [sourceRun] = await fixture.store.listRuns();
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["Handle retry exhaustion explicitly"] },
      "PASS"
    ]);

    await fixture.cli(["retry", sourceRun!.id, "--stage", "review"]);

    const [continuationRun, preservedSourceRun] = await fixture.store.listRuns();
    expect(continuationRun?.id).not.toBe(sourceRun?.id);
    expect(continuationRun).toEqual(expect.objectContaining({
      status: "completed",
      branchName: sourceRun?.branchName,
      worktreePath: sourceRun?.worktreePath
    }));
    expect(preservedSourceRun?.id).toBe(sourceRun?.id);
    expect((await fixture.items(requirement.id)).find((item) => item.id === backend!.id)?.status).toBe("done");
    expect(fs.readFileSync(path.join(continuationRun!.runDir, "follow-up-prompt.md"), "utf8"))
      .toContain("Handle retry exhaustion explicitly");
    const finalResult = JSON.parse(
      fs.readFileSync(path.join(continuationRun!.runDir, "final-result.json"), "utf8")
    ) as {
      status: string;
      workerResults: Array<{ phase: string }>;
      reviewResults: Array<{ verdict: string }>;
      recovery?: { sourceRunId: string; retriedStages: string[] };
    };
    expect(finalResult).toEqual(expect.objectContaining({
      status: "done",
      workerResults: [expect.objectContaining({ phase: "follow-up" })],
      reviewResults: [expect.objectContaining({ verdict: "PASS" })],
      recovery: expect.objectContaining({
        sourceRunId: sourceRun?.id,
        retriedStages: ["review"]
      })
    }));
  });

  it("review retry: accumulated issue evidence survives a recovered later review", async () => {
    const fixture = await createFixture(tempDir, {
      verification: ['node -e "process.exit(0)"']
    });
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["Handle retry exhaustion explicitly"] },
      "__MISSING__"
    ]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    writeReviewVerdicts(fixture.repoDir, ["PASS"]);

    await fixture.cli(["retry", run!.id, "--stage", "review"]);

    const finalResult = JSON.parse(
      fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")
    ) as {
      reviewResults: Array<{ verdict: string; issues?: string[] }>;
      evidencePacket: {
        review: {
          verdict: string;
          passCount: number;
          issueCount: number;
          addressedIssueCount: number;
          remainingIssues: string[];
        };
      };
    };
    expect(finalResult.reviewResults).toEqual([
      expect.objectContaining({ verdict: "ISSUES", issues: ["Handle retry exhaustion explicitly"] }),
      expect.objectContaining({ verdict: "PASS" })
    ]);
    expect(finalResult.evidencePacket.review).toEqual({
      verdict: "PASS",
      passCount: 1,
      issueCount: 1,
      addressedIssueCount: 1,
      remainingIssues: []
    });
  });

  it.each([
    ["empty", "__EMPTY__"],
    ["malformed", "__MALFORMED__"]
  ])("review retry: %s verdict output remains eligible for reviewer-only recovery", async (expectedKind, sentinel) => {
    const fixtureDir = path.join(tempDir, expectedKind);
    fs.mkdirSync(fixtureDir);
    const fixture = await createFixture(fixtureDir, {
      verification: ['node -e "process.exit(0)"']
    });
    writeReviewVerdicts(fixture.repoDir, [sentinel]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    const failedResult = JSON.parse(
      fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")
    ) as { reviewContractFailure: { kind: string; attempt: number } };
    expect(failedResult.reviewContractFailure).toEqual(expect.objectContaining({
      kind: expectedKind,
      attempt: 1
    }));

    writeReviewVerdicts(fixture.repoDir, ["PASS"]);
    await fixture.cli(["retry", run!.id, "--stage", "review"]);

    const recoveredResult = JSON.parse(
      fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")
    ) as { status: string; publishable: boolean; reviewContractFailure?: unknown };
    expect(recoveredResult).toEqual(expect.objectContaining({ status: "done", publishable: true }));
    expect(recoveredResult.reviewContractFailure).toBeUndefined();
  });

  it("review retry: exhausting the retry budget leaves a truthful blocked result", async () => {
    const fixture = await createFixture(tempDir, {
      verification: ['node -e "process.exit(0)"']
    });
    writeReviewVerdicts(fixture.repoDir, ["__MISSING__"]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();

    for (const expectedAttempt of [2, 3]) {
      writeReviewVerdicts(fixture.repoDir, ["__MISSING__"]);
      const output = await captureConsole(async () => {
        await fixture.cli(["retry", run!.id, "--stage", "review", "--json"]);
      });
      const events = output.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        kind?: string;
        event?: string;
        attempt?: number;
        status?: string;
        review?: unknown;
        reviewContractFailure?: { kind: string; attempt: number; maxAttempts: number };
      }>;
      expect(events.filter((event) => event.kind === "run_event").map((event) => event.event)).toEqual([
        "evidence_reused",
        "review_started",
        "review_contract_failed"
      ]);
      expect(events.find((event) => event.event === "review_contract_failed")?.attempt).toBe(expectedAttempt);
      expect(events.at(-1)).toEqual(expect.objectContaining({
        kind: "retry_result",
        status: expectedAttempt === 3 ? "blocked" : "failed",
        reviewContractFailure: expect.objectContaining({
          kind: "missing",
          attempt: expectedAttempt,
          maxAttempts: 3
        })
      }));
      expect(events.at(-1)?.review).toBeUndefined();
    }

    const finalResult = JSON.parse(
      fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")
    ) as {
      status: string;
      publishable: boolean;
      terminalFailure?: unknown;
      workerResults: unknown[];
      verificationSummaries: unknown[];
      reviewContractFailure: { attempt: number; maxAttempts: number; reviewedHead: string };
      recovery: { reviewAttempt: number; maxReviewAttempts: number; reusedStages: string[]; retriedStages: string[] };
      evidencePacket: {
        terminalFailure?: unknown;
        recovery: { reviewAttempt: number };
        publishability: { publishable: boolean; blockers: Array<{ category: string }> };
        recommendedHumanAction: string;
      };
    };
    expect(finalResult).toEqual(expect.objectContaining({
      status: "blocked",
      publishable: false,
      workerResults: [expect.any(Object)],
      verificationSummaries: [expect.any(Object)],
      reviewContractFailure: expect.objectContaining({ attempt: 3, maxAttempts: 3 }),
      recovery: expect.objectContaining({
        reviewAttempt: 3,
        maxReviewAttempts: 3,
        reusedStages: ["work", "verification"],
        retriedStages: ["review"]
      })
    }));
    expect(finalResult.terminalFailure).toBeUndefined();
    expect(finalResult.evidencePacket.terminalFailure).toBeUndefined();
    expect(finalResult.evidencePacket.publishability).toEqual({
      publishable: false,
      blockers: [expect.objectContaining({ category: "review" })]
    });
    expect(finalResult.evidencePacket.recommendedHumanAction).toBe("inspect");
    expect((await fixture.items(requirement.id)).find((item) => item.id === backend!.id)?.status).toBe("blocked");

    const inspection = JSON.parse(await captureConsole(async () => {
      await fixture.cli(["inspect", run!.id, "--json"]);
    })) as {
      derived: { publishable: boolean };
      evidencePacket: { recovery: { reviewAttempt: number }; recommendedHumanAction: string };
    };
    const handoff = JSON.parse(await captureConsole(async () => {
      await fixture.cli(["handoff", run!.id, "--json"]);
    })) as {
      status: string;
      recommendedAction: string;
      evidencePacket: { recovery: { retriedStages: string[] } };
    };
    expect(inspection.derived.publishable).toBe(false);
    expect(inspection.evidencePacket).toEqual(expect.objectContaining({
      recovery: expect.objectContaining({ reviewAttempt: 3 }),
      recommendedHumanAction: "inspect"
    }));
    expect(handoff).toEqual(expect.objectContaining({
      status: "completed",
      recommendedAction: "inspect"
    }));
    expect(handoff.evidencePacket.recovery.retriedStages).toEqual(["review"]);

    await expect(fixture.cli(["retry", run!.id, "--stage", "review"]))
      .rejects.toThrow("exhausted its review retry budget (3 attempts)");
  });

  // -----------------------------------------------------------------------
  // Fix failure
  // -----------------------------------------------------------------------
  it("fix failure: when the fix agent returns failed, the run stops as failed", async () => {
    const fixture = await createFixture(tempDir, {
      runnerScriptSuffix: `
// On fix iterations (detected via "Issues to fix" in the prompt), write a failed result.
if (prompt.includes("# Issues to fix")) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "failed",
    summary: "Fix agent could not resolve the issues",
    issueComment: "Fix failed"
  }, null, 2));
  process.exit(0);
}
`
    });

    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["Missing error handling"] }
    ]);

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("failed");

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("failed");
  });

  // -----------------------------------------------------------------------
  // Missing fix output must fail (no stale result reuse)
  // -----------------------------------------------------------------------
  it("missing fix output: when a fix iteration exits without writing result.json, the run fails", async () => {
    const fixture = await createFixture(tempDir, {
      runnerScriptSuffix: `
// On fix iterations, exit successfully but do not write a result file.
if (prompt.includes("# Issues to fix")) {
  process.exit(0);
}
`
    });

    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["Missing error handling"] }
    ]);

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await expect(fixture.cli(["run", backend!.id])).rejects.toThrow(
      "did not produce result.json"
    );

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("failed");

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("failed");
    expect(run?.summary).toContain("No result.json found");
    expect(run?.summary).toContain("iteration 2");
  });

  // -----------------------------------------------------------------------
  // Verification command shell semantics
  // -----------------------------------------------------------------------
  it("verification shell semantics: quoted shell command executes correctly and is marked passed", async () => {
    const fixture = await createFixture(tempDir);
    const verificationCommand = `node -e "console.log('quoted command works')" && node -e "process.exit(0)"`;

    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (config as { verification: string[] }).verification = [verificationCommand];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();

    const reviewPromptPath = path.join(run!.runDir, "review-prompt-1.md");
    const reviewPrompt = fs.readFileSync(reviewPromptPath, "utf8");
    expect(reviewPrompt).toContain(`## ${verificationCommand} [PASSED]`);
  });

  // -----------------------------------------------------------------------
  // Verification failure is not ignored
  // -----------------------------------------------------------------------
  it("verification failure: the same failure on an unchanged commit stops after one fix attempt", async () => {
    const fixture = await createFixture(tempDir);
    // Add a failing verification command to the config after fixture setup.
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    // This command fails intentionally and should be surfaced to the review agent.
    (config as { verification: string[] }).verification = ['node -e "process.exit(1)"'];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    // Review defaults to PASS, but wrapper verification is authoritative and should still block.
    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();
    expect(run?.summary).toContain("Repeated verification failure");

    // The review prompt must include the verification results section.
    const reviewPromptPath = path.join(run!.runDir, "review-prompt-1.md");
    expect(fs.existsSync(reviewPromptPath)).toBe(true);
    const reviewPrompt = fs.readFileSync(reviewPromptPath, "utf8");
    expect(reviewPrompt).toContain("# Verification Results");
    // The failed command should appear in the verification section.
    expect(reviewPrompt).toContain('node -e "process.exit(1)"');
    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      status: string;
      publishable: boolean;
      whyNotPublishable: string[];
      workerResults: Array<{ phase: string }>;
      reviewResults: Array<{ verdict: string }>;
      repeatedFailure: {
        kind: string;
        firstIteration: number;
        repeatedIteration: number;
        unchangedHead: string;
      };
    };
    expect(finalResult.status).toBe("blocked");
    expect(finalResult.publishable).toBe(false);
    expect(finalResult.workerResults.map((result) => result.phase)).toEqual(["work", "fix"]);
    expect(finalResult.reviewResults).toHaveLength(1);
    expect(finalResult.repeatedFailure).toEqual(
      expect.objectContaining({
        kind: "verification",
        firstIteration: 1,
        repeatedIteration: 2
      })
    );
    expect(finalResult.whyNotPublishable).toEqual(
      expect.arrayContaining(['Product verification failed: node -e "process.exit(1)" (exit 1)'])
    );
    expect(fs.existsSync(path.join(run!.runDir, "fix-prompt-3.md"))).toBe(false);
  });

  it("verification recovery: historical failures remain evidence without blocking the final passing iteration", async () => {
    const fixture = await createFixture(tempDir, {
      runnerScriptSuffix: `
if (prompt.includes("# Issues to fix")) {
  fs.writeFileSync(path.join(process.cwd(), "verification-ready"), "ready\\n");
}
`
    });
    const verificationCommand = `node -e "process.exit(require('fs').existsSync('verification-ready') ? 0 : 1)"`;
    rewriteConfig(fixture.repoDir, { githubEnabled: false, verification: [verificationCommand] });

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    const finalResult = JSON.parse(
      fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")
    ) as {
      status: string;
      publishable: boolean;
      whyNotPublishable: string[];
      publishabilityBlockers: Array<{ category: string; message: string }>;
      verificationSummaries: Array<{
        iteration: number;
        results: Array<{ command: string; passed: boolean; exitCode: number }>;
      }>;
      evidencePacket: {
        verification: {
          status: string;
          commands: Array<{ command: string; passed: boolean; exitCode: number }>;
        };
        publishability: {
          publishable: boolean;
          blockers: Array<{ category: string; message: string }>;
        };
        recommendedHumanAction: string;
      };
    };

    expect(finalResult.verificationSummaries).toEqual([
      expect.objectContaining({
        iteration: 1,
        results: [expect.objectContaining({ command: verificationCommand, passed: false, exitCode: 1 })]
      }),
      expect.objectContaining({
        iteration: 2,
        results: [expect.objectContaining({ command: verificationCommand, passed: true, exitCode: 0 })]
      })
    ]);
    expect(finalResult).toEqual(expect.objectContaining({
      status: "done",
      publishable: true,
      whyNotPublishable: [],
      publishabilityBlockers: []
    }));
    expect(finalResult.evidencePacket.verification).toEqual({
      status: "passed",
      commands: [expect.objectContaining({ command: verificationCommand, passed: true, exitCode: 0 })]
    });
    expect(finalResult.evidencePacket.publishability).toEqual({
      publishable: true,
      blockers: []
    });
    expect(finalResult.evidencePacket.recommendedHumanAction).toBe("publish");

    const inspection = JSON.parse(await captureConsole(async () => {
      await fixture.cli(["inspect", run!.id, "--json"]);
    })) as {
      derived: { verificationStatus: string; publishable: boolean; whyNotPublishable: string[] };
    };
    const handoff = JSON.parse(await captureConsole(async () => {
      await fixture.cli(["handoff", run!.id, "--json"]);
    })) as {
      verificationStatus: string;
      publishable: boolean;
      whyNotPublishable: string[];
      recommendedAction: string;
    };

    expect(inspection.derived).toEqual(expect.objectContaining({
      verificationStatus: "passed",
      publishable: true,
      whyNotPublishable: []
    }));
    expect(handoff).toEqual(expect.objectContaining({
      verificationStatus: "passed",
      publishable: true,
      whyNotPublishable: [],
      recommendedAction: "publish"
    }));
  });

  it("verification retry: a reviewed unchanged commit reruns verification without another agent iteration", async () => {
    const fixture = await createFixture(tempDir);
    const readinessMarker = path.join(tempDir, "verification-ready");
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (config as { verification: string[] }).verification = [
      `node -e 'process.exit(require("fs").existsSync(${JSON.stringify(readinessMarker)}) ? 0 : 1)'`
    ];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    const promptModifiedAt = fs.statSync(path.join(run!.runDir, "prompt.md")).mtimeMs;
    fs.writeFileSync(readinessMarker, "ready\n");

    const retryOutput = await captureConsole(async () => {
      await fixture.cli(["retry", run!.id, "--stage", "verification", "--json"]);
    });
    const retryPayloads = retryOutput.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      kind?: string;
      schemaVersion?: number;
      event?: string;
      command?: string;
      reusedStages?: string[];
      retriedStage?: string;
      status?: string;
    }>;
    const retryEvents = retryPayloads.filter((payload) => payload.kind === "run_event");

    expect(retryEvents.map((event) => event.event)).toEqual([
      "evidence_reused",
      "verification_started",
      "verification_completed"
    ]);
    expect(retryEvents[0]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      reusedStages: ["work", "review"],
      retriedStage: "verification"
    }));
    expect(retryPayloads.at(-1)).toEqual(expect.objectContaining({
      kind: "retry_result",
      command: "retry",
      status: "done"
    }));

    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      status: string;
      publishable: boolean;
      workerResults: Array<{ phase: string }>;
      reviewResults: Array<{ verdict: string }>;
      verificationSummaries: Array<{ recovery?: boolean }>;
      recovery: { reusedStages: string[]; retriedStages: string[] };
      evidencePacket: {
        verification: { status: string };
        recovery: { reusedStages: string[]; retriedStages: string[] };
      };
    };

    expect(await fixture.store.listRuns()).toHaveLength(1);
    expect((await fixture.items(requirement.id)).find((item) => item.id === backend!.id)?.status).toBe("done");
    expect(finalResult.status).toBe("done");
    expect(finalResult.publishable).toBe(true);
    expect(finalResult.workerResults.map((result) => result.phase)).toEqual(["work", "fix"]);
    expect(finalResult.reviewResults).toHaveLength(1);
    expect(finalResult.verificationSummaries.at(-1)?.recovery).toBe(true);
    expect(finalResult.recovery).toEqual(
      expect.objectContaining({
        reusedStages: ["work", "review"],
        retriedStages: ["verification"]
      })
    );
    expect(finalResult.evidencePacket.verification.status).toBe("passed");
    expect(finalResult.evidencePacket.recovery).toEqual(finalResult.recovery);
    expect(fs.statSync(path.join(run!.runDir, "prompt.md")).mtimeMs).toBe(promptModifiedAt);
    expect(fs.existsSync(path.join(run!.runDir, "fix-prompt-3.md"))).toBe(false);

    const inspectOutput = await captureConsole(async () => {
      await fixture.cli(["inspect", run!.id, "--json"]);
    });
    const inspection = JSON.parse(inspectOutput.trim()) as {
      derived: { verificationStatus: string; publishable: boolean };
      evidencePacket: { recovery: { retriedStages: string[] } };
    };
    expect(inspection.derived.verificationStatus).toBe("passed");
    expect(inspection.derived.publishable).toBe(true);
    expect(inspection.evidencePacket.recovery.retriedStages).toEqual(["verification"]);

    const handoffOutput = await captureConsole(async () => {
      await fixture.cli(["handoff", run!.id, "--json"]);
    });
    const handoff = JSON.parse(handoffOutput.trim()) as {
      verificationStatus: string;
      recommendedAction: string;
      evidencePacket: { recovery: { reusedStages: string[] } };
    };
    expect(handoff.verificationStatus).toBe("passed");
    expect(handoff.recommendedAction).toBe("publish");
    expect(handoff.evidencePacket.recovery.reusedStages).toEqual(["work", "review"]);
  });

  it("verification retry safety: a commit added after review invalidates reusable evidence", async () => {
    const fixture = await createFixture(tempDir);
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (config as { verification: string[] }).verification = ['node -e "process.exit(1)"'];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    fs.writeFileSync(path.join(run!.worktreePath!, "manual-change.txt"), "changed after review\n");
    execFileSync("git", ["add", "manual-change.txt"], { cwd: run!.worktreePath! });
    execFileSync("git", ["commit", "-m", "manual change after review"], { cwd: run!.worktreePath! });

    await expect(
      fixture.cli(["retry", run!.id, "--stage", "verification"])
    ).rejects.toThrow("worktree HEAD changed after review");

    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      status: string;
      recovery?: unknown;
    };
    expect(finalResult.status).toBe("blocked");
    expect(finalResult.recovery).toBeUndefined();
  });

  it("verification retry rechecks current signing policy and the complete commit range when legacy evidence is missing", async () => {
    let signatureRequirement: "optional" | "required" = "optional";
    const readinessMarker = path.join(tempDir, "verification-ready");
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror: new MockGitHubMirror(),
      targetCommitSignaturePolicyResolver: async () => ({
        requirement: signatureRequirement,
        source: "github-branch-rules"
      }),
      signingCapabilityResolver: async () => ({ available: true, verified: true, format: "ssh" })
    });
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (config as { verification: string[] }).verification = [
      `node -e 'process.exit(require("fs").existsSync(${JSON.stringify(readinessMarker)}) ? 0 : 1)'`
    ];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    const finalResultPath = path.join(run!.runDir, "final-result.json");
    const legacyFinalResult = JSON.parse(fs.readFileSync(finalResultPath, "utf8")) as {
      evidencePacket: Record<string, unknown>;
      repeatedFailure: { unchangedHead: string };
    };
    fs.writeFileSync(path.join(run!.worktreePath!, "legacy-fix-phase.txt"), "done\n");
    execFileSync("git", ["add", "legacy-fix-phase.txt"], { cwd: run!.worktreePath! });
    execFileSync("git", ["commit", "-m", "legacy fix phase"], { cwd: run!.worktreePath! });
    legacyFinalResult.repeatedFailure.unchangedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: run!.worktreePath!,
      encoding: "utf8"
    }).trim();
    delete legacyFinalResult.evidencePacket.commitSigning;
    fs.writeFileSync(finalResultPath, JSON.stringify(legacyFinalResult, null, 2));

    signatureRequirement = "required";
    fs.writeFileSync(readinessMarker, "ready\n");
    await fixture.cli(["retry", run!.id, "--stage", "verification"]);

    const finalResult = JSON.parse(fs.readFileSync(finalResultPath, "utf8")) as {
      status: string;
      publishable: boolean;
      commitSigningPolicy: { requirement: string };
      commitSignatureEvidence: Array<{ sha: string; signed: boolean; verified: boolean }>;
      evidencePacket: {
        commitSigning: {
          satisfied: boolean;
          commits: Array<{ sha: string; signed: boolean; verified: boolean }>;
        };
      };
    };
    const expectedRange = execFileSync("git", ["rev-list", "--reverse", "main..HEAD"], {
      cwd: run!.worktreePath!,
      encoding: "utf8"
    }).trim().split("\n").filter(Boolean);

    expect(expectedRange).toHaveLength(2);
    expect(finalResult.status).toBe("blocked");
    expect(finalResult.publishable).toBe(false);
    expect(finalResult.commitSigningPolicy.requirement).toBe("required");
    expect(finalResult.commitSignatureEvidence.map((commit) => commit.sha)).toEqual(expectedRange);
    expect(finalResult.commitSignatureEvidence.every((commit) => !commit.signed && !commit.verified)).toBe(true);
    expect(finalResult.evidencePacket.commitSigning).toMatchObject({
      satisfied: false,
      commits: finalResult.commitSignatureEvidence
    });
  });

  it("verification retry requires authoritative host verification for a required-signature range", async () => {
    const privateKeyPath = path.join(tempDir, "retry-signing-key");
    const allowedSignersPath = path.join(tempDir, "retry-allowed-signers");
    const readinessMarker = path.join(tempDir, "verification-ready");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath]);
    fs.writeFileSync(
      allowedSignersPath,
      `test@example.com ${fs.readFileSync(`${privateKeyPath}.pub`, "utf8").trim()}\n`
    );
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror: new MockGitHubMirror(),
      signing: { mode: "auto", key: privateKeyPath },
      targetCommitSignaturePolicyResolver: async () => ({ requirement: "required", source: "github-branch-rules" }),
      signingCapabilityResolver: async () => ({ available: true, verified: true, format: "ssh" }),
      verification: [
        `node -e 'process.exit(require("fs").existsSync(${JSON.stringify(readinessMarker)}) ? 0 : 1)'`
      ]
    });
    execFileSync("git", ["config", "gpg.format", "ssh"], { cwd: fixture.repoDir });
    execFileSync("git", ["config", "gpg.ssh.allowedSignersFile", allowedSignersPath], { cwd: fixture.repoDir });

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);
    const [run] = await fixture.store.listRuns();
    fs.writeFileSync(readinessMarker, "ready\n");
    await fixture.cli(["retry", run!.id, "--stage", "verification"]);

    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      status: string;
      publishable: boolean;
      evidencePacket: {
        commitSigning: {
          satisfied: boolean;
          commits: Array<{ signed: boolean; verified: boolean }>;
          hostVerification: { verified: boolean };
        };
      };
    };
    expect(finalResult.status).toBe("done");
    expect(finalResult.publishable).toBe(true);
    expect(finalResult.evidencePacket.commitSigning.commits.length).toBeGreaterThan(0);
    expect(finalResult.evidencePacket.commitSigning.commits.every((commit) => commit.signed && commit.verified)).toBe(true);
    expect(finalResult.evidencePacket.commitSigning).toMatchObject({
      satisfied: true,
      hostVerification: { verified: true }
    });
  });

  it("environment verification failure: a missing tool blocks after one worker without launching a fix worker", async () => {
    const fixture = await createFixture(tempDir);
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (config as { verification: string[] }).verification = ["afk-tool-that-does-not-exist --version"];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      status: string;
      workerResults: Array<{ phase: string }>;
      reviewResults: Array<{ verdict: string }>;
      verificationSummaries: Array<{
        results: Array<{ command: string; failureCategory?: string }>;
      }>;
      evidencePacket: {
        publishability: { blockers: Array<{ category: string; message: string }> };
        recommendedHumanAction: string;
      };
    };

    expect(finalResult.status).toBe("blocked");
    expect(finalResult.workerResults.map((result) => result.phase)).toEqual(["work"]);
    expect(finalResult.reviewResults).toEqual([]);
    expect(finalResult.verificationSummaries[0]?.results[0]).toEqual(
      expect.objectContaining({ failureCategory: "environment" })
    );
    expect(finalResult.evidencePacket.publishability.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "environment" })
      ])
    );
    expect(finalResult.evidencePacket.recommendedHumanAction).toBe("fix_environment");
    expect(fs.existsSync(path.join(run!.runDir, "fix-prompt-2.md"))).toBe(false);
  });

  it("verification-contract failure: malformed shell syntax blocks without launching a fix worker", async () => {
    const fixture = await createFixture(tempDir);
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (config as { verification: string[] }).verification = ['node -e "process.exit(0)'];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      workerResults: Array<{ phase: string }>;
      reviewResults: Array<{ verdict: string }>;
      verificationSummaries: Array<{
        results: Array<{ failureCategory?: string }>;
      }>;
      evidencePacket: {
        publishability: { blockers: Array<{ category: string }> };
        recommendedHumanAction: string;
      };
    };

    expect(finalResult.workerResults.map((result) => result.phase)).toEqual(["work"]);
    expect(finalResult.reviewResults).toEqual([]);
    expect(finalResult.verificationSummaries[0]?.results[0]?.failureCategory).toBe("verification");
    expect(finalResult.evidencePacket.publishability.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "verification" })])
    );
    expect(finalResult.evidencePacket.recommendedHumanAction).toBe("retry");
    expect(fs.existsSync(path.join(run!.runDir, "fix-prompt-2.md"))).toBe(false);
  });

  it("verification package manager: declared pnpm version is used through Corepack when PATH differs", async () => {
    const fixture = await createFixture(tempDir);
    const corepackLogPath = path.join(fixture.repoDir, "corepack-calls.log");
    const packageJsonPath = path.join(fixture.repoDir, "package.json");
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@10.20.0" }, null, 2));
    fs.writeFileSync(
      path.join(fixture.repoDir, "pnpm"),
      ["#!/usr/bin/env node", "console.log('11.7.0');"].join("\n")
    );
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

    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (config as { verification: string[] }).verification = ["pnpm --version"];
    fs.writeFileSync(configPath, YAML.stringify(config));

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const warnSpy = vi.spyOn(console, "warn");
    await fixture.cli(["run", backend!.id]);

    expect(fs.readFileSync(corepackLogPath, "utf8")).toContain("pnpm@10.20.0 --version");
    const warnCalls = warnSpy.mock.calls.map((args) => args.join(" "));
    expect(warnCalls.some((msg) => msg.includes("repo declares pnpm@10.20.0") && msg.includes("PATH has pnpm@11.7.0"))).toBe(true);

    const [run] = await fixture.store.listRuns();
    const reviewPrompt = fs.readFileSync(path.join(run!.runDir, "review-prompt-1.md"), "utf8");
    expect(reviewPrompt).toContain("## pnpm --version [PASSED]");
    expect(reviewPrompt).toContain("10.20.0");
  });

  // -----------------------------------------------------------------------
  // Iteration cap
  // -----------------------------------------------------------------------
  it("iteration cap: when review keeps returning ISSUES past the cap, the run is marked blocked", async () => {
    const fixture = await createFixture(tempDir);
    // Provide more ISSUES verdicts than the iteration cap allows (cap is 4 total iterations).
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["Problem A"] },
      { verdict: "ISSUES", issues: ["Problem B"] },
      { verdict: "ISSUES", issues: ["Problem C"] },
      { verdict: "ISSUES", issues: ["Problem D"] },
      { verdict: "ISSUES", issues: ["Problem E"] }
    ]);

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("blocked");

    const [run] = await fixture.store.listRuns();
    expect(run?.status).toBe("completed"); // blocked runs use "completed" status in the run record
    expect(run?.summary).toContain("cap");
  });

  it("repeated review failure: the same issues on an unchanged commit stop before the iteration cap", async () => {
    const fixture = await createFixture(tempDir);
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["The queue processor still drops retries"] },
      { verdict: "ISSUES", issues: ["The queue processor still drops retries"] },
      { verdict: "PASS" }
    ]);

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    const finalResult = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8")) as {
      status: string;
      summary: string;
      workerResults: Array<{ phase: string }>;
      reviewResults: Array<{ verdict: string }>;
      repeatedFailure: {
        kind: string;
        firstIteration: number;
        repeatedIteration: number;
      };
    };

    expect(finalResult.status).toBe("blocked");
    expect(finalResult.summary).toContain("Repeated review failure");
    expect(finalResult.workerResults.map((result) => result.phase)).toEqual(["work", "fix"]);
    expect(finalResult.reviewResults).toHaveLength(2);
    expect(finalResult.repeatedFailure).toEqual(
      expect.objectContaining({
        kind: "review",
        firstIteration: 1,
        repeatedIteration: 2
      })
    );
    expect(fs.existsSync(path.join(run!.runDir, "fix-prompt-3.md"))).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Review prompt construction
  // -----------------------------------------------------------------------
  it("review prompt construction: the review prompt includes requirement, acceptance criteria, diff, and verification results", async () => {
    const fixture = await createFixture(tempDir);

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();

    const reviewPromptPath = path.join(run!.runDir, "review-prompt-1.md");
    expect(fs.existsSync(reviewPromptPath)).toBe(true);
    const reviewPrompt = fs.readFileSync(reviewPromptPath, "utf8");

    expect(reviewPrompt).toContain("autonomous code review");
    expect(reviewPrompt).toContain("Write your review verdict JSON to this exact path:");
    expect(reviewPrompt).toContain("# Requirement");
    expect(reviewPrompt).toContain("# Acceptance Criteria");
    expect(reviewPrompt).toContain("# Verification Results");
    expect(reviewPrompt).toContain("# Git Diff");
    // Should NOT include the work agent prompt/reasoning.
    expect(reviewPrompt).not.toContain("Write a JSON file to this exact path when you are done:");
    expect(reviewPrompt).not.toContain("progressPath");
  });

  // -----------------------------------------------------------------------
  // Fix prompt construction (issues from review)
  // -----------------------------------------------------------------------
  it("fix prompt: the fix prompt contains the issues from the review agent", async () => {
    const fixture = await createFixture(tempDir);
    writeReviewVerdicts(fixture.repoDir, [
      { verdict: "ISSUES", issues: ["Missing error handling", "No unit tests for edge cases"] },
      { verdict: "PASS" }
    ]);

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    const [run] = await fixture.store.listRuns();
    expect(run).toBeDefined();

    const fixPromptPath = path.join(run!.runDir, "fix-prompt-2.md");
    expect(fs.existsSync(fixPromptPath)).toBe(true);
    const fixPrompt = fs.readFileSync(fixPromptPath, "utf8");

    expect(fixPrompt).toContain("# Issues to fix");
    expect(fixPrompt).toContain("Missing error handling");
    expect(fixPrompt).toContain("No unit tests for edge cases");
    expect(fixPrompt).toContain("Fix ONLY the issues listed below");
  });

  // -----------------------------------------------------------------------
  // Model resolution — console output
  // -----------------------------------------------------------------------
  it("model resolution: runner and model are printed before each phase", async () => {
    const fixture = await createFixture(tempDir);
    rewriteConfig(fixture.repoDir, { githubEnabled: false, runnerModel: "claude-test-model" });

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["run", backend!.id]);
    });

    // runner.command is set (overrides model for actual invocation but the phase
    // log lines are always emitted showing the runner kind).
    expect(output).toContain("[work] runner: claude");
    expect(output).toContain("[review] runner: claude");
  });

  // -----------------------------------------------------------------------
  // Command override warning
  // -----------------------------------------------------------------------
  it("command override warning: when runner.command is set alongside runner.model, a warning is logged", async () => {
    const fixture = await createFixture(tempDir);
    rewriteConfig(fixture.repoDir, { githubEnabled: false, runnerModel: "claude-sonnet-4-6" });

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const warnSpy = vi.spyOn(console, "warn");
    await fixture.cli(["run", backend!.id]);

    const warnCalls = warnSpy.mock.calls.map((args) => args.join(" "));
    expect(
      warnCalls.some((msg) => msg.includes("runner.model") && msg.includes("ignored") && msg.includes("runner.command"))
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Model fallback: review falls back to runner.model when runner.review.model unset
  // -----------------------------------------------------------------------
  it("model fallback: review uses runner.model when runner.review.model is not configured", async () => {
    const fixture = await createFixture(tempDir);
    rewriteConfig(fixture.repoDir, { githubEnabled: false, runnerModel: "claude-test-fallback" });

    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    const output = await captureConsole(async () => {
      await fixture.cli(["run", backend!.id]);
    });

    expect(output).toContain("[work] runner: claude");
    expect(output).toContain("[review] runner: claude");

    // The run itself should succeed (PASS is the default review verdict).
    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.id === backend!.id)?.status).toBe("done");
  });
});
