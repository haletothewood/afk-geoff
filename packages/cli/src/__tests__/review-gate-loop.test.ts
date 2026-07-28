import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, createFixture, makeTempDir, rewriteConfig, writeReviewVerdicts } from "./test-helpers.js";

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
  it("verification failure: failed verification forces fix iterations and blocks if it never passes", async () => {
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
    expect(run?.summary).toBe("Iteration cap (4) reached with failing verification");

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
    };
    expect(finalResult.status).toBe("blocked");
    expect(finalResult.publishable).toBe(false);
    expect(finalResult.whyNotPublishable).toEqual(
      expect.arrayContaining(['Product verification failed: node -e "process.exit(1)" (exit 1)'])
    );
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
