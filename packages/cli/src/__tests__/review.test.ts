import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixture, makeTempDir } from "./test-helpers.js";

describe("afk CLI — review command", () => {
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

  it("Given a HITL work item, when review is prepared, then a review run and review brief are created", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    const seededItems = await fixture.seedQueue(requirement.id);
    const reviewItem = seededItems.find((item) => item.planKey === "review");

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
});
