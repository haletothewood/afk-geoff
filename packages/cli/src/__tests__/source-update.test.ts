import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixture, makeTempDir, MockGitHubMirror } from "./test-helpers.js";

describe("afk CLI — source-aware run completion", () => {
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

  it("Given a run started from a GitHub issue URL, when the run succeeds, then a final update is posted to the source issue", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubMirror,
      githubIssueWorkSource: {
        async load() {
          return {
            requirementBody: "Ship a narrow internal improvement for the AFK runner.",
            workItemTitle: "Source update on success",
            workItemBody: "Verify that a completion comment is posted back to the source issue.",
            acceptanceCriteria: ["Comment is posted on the source issue"],
            verification: [],
            issueUrl: "https://github.com/acme/demo/issues/42"
          };
        }
      }
    });

    await fixture.cli(["run", "issue", "https://github.com/acme/demo/issues/42"]);

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    expect(workItem?.status).toBe("done");

    // A comment should have been posted to issue #42 (the source issue).
    const sourceComments = githubMirror.issueComments.filter((c) => c.issueNumber === 42);
    expect(sourceComments).toHaveLength(1);
    // The worker result includes issueComment "Finished the AFK work item." which should appear in the comment.
    expect(sourceComments[0]?.body).toContain("Finished the AFK work item.");
  });

  it("Given a worker result uses status completed, when run issue is used, then AFK treats it as done", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubMirror,
      githubIssueWorkSource: {
        async load() {
          return {
            requirementBody: "Ship a narrow internal improvement for the AFK runner.",
            workItemTitle: "Normalize completed status",
            workItemBody: "Treat completed as done for worker result compatibility.",
            acceptanceCriteria: ["completed maps to done"],
            verification: [],
            issueUrl: "https://github.com/acme/demo/issues/66"
          };
        }
      },
      runnerScriptSuffix: [
        "fs.writeFileSync(outputPath, JSON.stringify({",
        '  status: "completed",',
        '  summary: "Work completed with legacy status",',
        '  issueComment: "Legacy completed status still succeeded."',
        "}, null, 2));",
        "process.exit(0);"
      ].join("\n")
    });

    await fixture.cli(["run", "issue", "https://github.com/acme/demo/issues/66"]);

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    expect(workItem?.status).toBe("done");

    const sourceComments = githubMirror.issueComments.filter((c) => c.issueNumber === 66);
    expect(sourceComments).toHaveLength(1);
    expect(sourceComments[0]?.body).toContain("Legacy completed status still succeeded.");
  });

  it("Given a run started from a GitHub issue URL, when the run fails, then a failure update is posted to the source issue", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubMirror,
      githubIssueWorkSource: {
        async load() {
          return {
            requirementBody: "Ship a narrow internal improvement for the AFK runner.",
            workItemTitle: "Source update on failure",
            workItemBody: "Verify that a failure comment is posted back to the source issue.",
            acceptanceCriteria: ["Failure comment is posted on the source issue"],
            verification: [],
            issueUrl: "https://github.com/acme/demo/issues/55"
          };
        }
      },
      runnerScriptSuffix: [
        "fs.writeFileSync(outputPath, JSON.stringify({",
        '  status: "failed",',
        '  summary: "Could not complete the work item",',
        '  issueComment: "AFK encountered an error while working on this issue."',
        "}, null, 2));",
        "process.exit(0);"
      ].join("\n")
    });

    await fixture.cli(["run", "issue", "https://github.com/acme/demo/issues/55"]);

    const [requirement] = await fixture.store.listRequirements();
    const [workItem] = await fixture.items(requirement!.id);
    expect(workItem?.status).toBe("failed");

    // A comment should have been posted to issue #55 (the source issue).
    const sourceComments = githubMirror.issueComments.filter((c) => c.issueNumber === 55);
    expect(sourceComments).toHaveLength(1);
    expect(sourceComments[0]?.body).toContain("AFK encountered an error while working on this issue.");
  });

  it("Given a run started from a work item ID (not an issue URL), when the run succeeds, then no source comment is posted", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true,
      githubMirror
    });
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );
    await fixture.seedQueue(requirement.id);
    const backend = (await fixture.items(requirement.id)).find((item) => item.planKey === "backend");
    expect(backend).toBeDefined();

    await fixture.cli(["run", backend!.id]);

    // No source comments should have been posted (non-issue run flow).
    expect(githubMirror.issueComments).toHaveLength(0);
  });

  it("Given a run from an issue with no worker-provided comment, when the run succeeds, then a CLI-generated fallback comment is posted", async () => {
    const githubMirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubMirror,
      githubIssueWorkSource: {
        async load() {
          return {
            requirementBody: "Ship a narrow internal improvement for the AFK runner.",
            workItemTitle: "Fallback comment on empty issueComment",
            workItemBody: "Ensure a fallback comment is posted when the worker provides no issueComment.",
            acceptanceCriteria: ["Fallback comment is posted"],
            verification: [],
            issueUrl: "https://github.com/acme/demo/issues/99"
          };
        }
      },
      runnerScriptSuffix: [
        "fs.writeFileSync(outputPath, JSON.stringify({",
        '  status: "done",',
        '  summary: "Work completed without a custom comment",',
        '  issueComment: ""',
        "}, null, 2));",
        "process.exit(0);"
      ].join("\n")
    });

    await fixture.cli(["run", "issue", "https://github.com/acme/demo/issues/99"]);

    // A fallback comment should have been posted, mentioning 'completed' and the summary.
    const sourceComments = githubMirror.issueComments.filter((c) => c.issueNumber === 99);
    expect(sourceComments).toHaveLength(1);
    expect(sourceComments[0]?.body).toContain("completed");
    expect(sourceComments[0]?.body).toContain("Work completed without a custom comment");
  });
});
