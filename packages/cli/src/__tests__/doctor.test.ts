import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createFixture, makeTempDir, rewriteConfig } from "./test-helpers.js";

describe("afk CLI — doctor command", () => {
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

  it("Given local workflow prerequisites are present, when doctor runs, then it reports success", async () => {
    const fixture = await createFixture(tempDir);

    const output = await captureConsole(async () => {
      await fixture.cli(["doctor"]);
    });

    expect(output).toContain("OK git: git");
    expect(output).toContain("OK docker: docker");
    expect(output).toContain("OK runner: node");
    expect(output).toContain("Doctor checks passed");
  });

  it("Given runner env vars are missing, when doctor runs, then it reports all missing requirements before failing", async () => {
    const fixture = await createFixture(tempDir);
    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerRequiredEnv: ["OPENAI_API_KEY", "SECOND_REQUIRED_ENV"]
    });
    delete process.env.OPENAI_API_KEY;
    delete process.env.SECOND_REQUIRED_ENV;

    const output = await captureConsole(async () => {
      await expect(fixture.cli(["doctor"])).rejects.toThrow("Doctor checks failed (2 issues)");
    });

    expect(output).toContain("FAIL env:OPENAI_API_KEY: Missing required env var OPENAI_API_KEY");
    expect(output).toContain("FAIL env:SECOND_REQUIRED_ENV: Missing required env var SECOND_REQUIRED_ENV");
  });
});
