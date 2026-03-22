import path from "node:path";
import fs from "node:fs";
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
});
