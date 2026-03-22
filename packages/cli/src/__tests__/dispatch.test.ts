import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir } from "./test-helpers.js";

describe("afk CLI — dispatch command", () => {
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

  it("Given a blocked AFK work item, when its dependency completes and status is refreshed, then it becomes todo", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    await fixture.cli(["dispatch", "--max", "1"]);

    let items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "backend")?.status).toBe("done");

    await fixture.cli(["status"]);
    items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "frontend")?.status).toBe("todo");
  });

  it("Given dependent AFK work exists, when dispatch runs with the default loop, then it keeps executing until the queue is drained or the loop limit is hit", async () => {
    const fixture = await createFixture(tempDir);
    const requirement = await fixture.capture(
      "Add a queue-based resend workflow with AFK backend work, a blocked UI step, and a HITL review."
    );

    await fixture.seedQueue(requirement.id);
    const output = await captureConsole(async () => {
      await fixture.cli(["dispatch"]);
    });

    const items = await fixture.items(requirement.id);
    expect(items.find((item) => item.planKey === "backend")?.status).toBe("done");
    expect(items.find((item) => item.planKey === "frontend")?.status).toBe("done");
    expect(items.find((item) => item.planKey === "review")?.status).toBe("hitl_pending");
    expect(output).toContain("Dispatch iteration 1/10");
    expect(output).toContain("Dispatch iteration 2/10");
    expect(output).toContain("Dispatch complete after 2 iteration(s): queue drained");
  });
});
