import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, createFixture, makeTempDir, MockGitHubMirror, rewriteConfig } from "./test-helpers.js";

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

  it("Given run file --pr --json, when the run completes, then stdout is one machine-readable payload", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });
    writeBrief(fixture.repoDir);

    const output = await captureConsole(async () => {
      await fixture.cli(["run", "file", "brief.md", "--pr", "--backend", "local-docker", "--json"]);
    });
	    const payload = JSON.parse(output) as {
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
	    const payload = JSON.parse(output) as {
	      command: string;
	      ok: boolean;
	      detached: boolean;
	      workItemId: string;
	      requirementId: string;
	      runId: string;
	      status: string;
	      branchName: string;
	      worktreePath: string;
	    };

	    expect(payload.command).toBe("run");
	    expect(payload.ok).toBe(true);
	    expect(payload.detached).toBe(true);
	    expect(payload.workItemId).toMatch(/^wi_/);
	    expect(payload.requirementId).toMatch(/^req_/);
	    expect(payload.runId).toMatch(/^run_/);
	    expect(payload.status).toBe("running");
	    expect(payload.branchName).toMatch(/^afk\//);
	    expect(payload.worktreePath).toContain(payload.runId);
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
	    const payload = JSON.parse(output) as {
	      command: string;
	      ok: boolean;
	      backend: string;
	      error: { message: string };
	    };

	    expect(payload.command).toBe("run");
	    expect(payload.ok).toBe(false);
	    expect(payload.backend).toBe("local-docker");
	    expect(payload.error.message).toContain("Preflight failed (runner):");
	    expect(payload.error.message).toContain("__afk_nonexistent_json_runner__");
	    expect(await fixture.store.listRuns()).toHaveLength(0);
	  });

  it("Given runs --json, when runs exist, then it prints structured run records", async () => {
    const fixture = await createFixture(tempDir);
    writeBrief(fixture.repoDir);
    await fixture.cli(["run", "file", "brief.md"]);

    const output = await captureConsole(async () => {
      await fixture.cli(["runs", "--json"]);
    });
    const payload = JSON.parse(output) as { command: string; runs: Array<{ id: string; status: string; workItemId: string }> };

    expect(payload.command).toBe("runs");
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]?.id).toMatch(/^run_/);
    expect(payload.runs[0]?.workItemId).toMatch(/^wi_/);
    expect(payload.runs[0]?.status).toBe("completed");
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
      backend: string;
      workItemId: string;
      requirements: unknown[];
      workItems: Array<{ id: string; status: string }>;
      focusedWorkItem: { id: string; status: string };
      nextActions: string[];
    };

    expect(payload.command).toBe("status");
    expect(payload.workItemId).toBe(run!.workItemId);
    expect(payload.requirements).toHaveLength(1);
    expect(payload.workItems).toHaveLength(1);
    expect(payload.focusedWorkItem.id).toBe(run!.workItemId);
    expect(payload.focusedWorkItem.status).toBe("done");
    expect(payload.nextActions).toEqual(["- All work items are complete"]);
  });

  it("Given follow-up --json, when review comments exist, then it reports the same PR and addressed comment count", async () => {
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
      githubMirror
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
      addressedReviewComments: number;
    };

	    expect(payload.command).toBe("follow-up");
	    expect(payload.ok).toBe(true);
	    expect(payload.backend).toBe("local-docker");
    expect(payload.workItemId).toBe(initialRun!.workItemId);
    expect(payload.status).toBe("completed");
    expect(payload.branchName).toBe(initialRun!.branchName);
    expect(payload.prUrl).toBe("https://example.com/pull_request/201");
    expect(payload.addressedReviewComments).toBe(1);
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

function writeBrief(repoDir: string): void {
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
      "- A pull request is opened for review"
    ].join("\n")
  );
}
