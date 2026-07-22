import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("Given local workflow prerequisites are present, when doctor --json runs, then it reports structured success", async () => {
    const fixture = await createFixture(tempDir);

    const output = await captureConsole(async () => {
      await fixture.cli(["doctor", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      checks: Array<{ label: string; ok: boolean }>;
      failures: string[];
    };

    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(true);
    expect(payload.backend).toBe("local-docker");
    expect(payload.failures).toEqual([]);
    expect(payload.checks.some((check) => check.label === "git" && check.ok)).toBe(true);
    expect(payload.checks.some((check) => check.label === "runner" && check.ok)).toBe(true);
    expect(output).not.toContain("Doctor checks passed");
  });

  it("Given runner env vars are missing, when doctor --json runs, then it reports structured failure", async () => {
    const fixture = await createFixture(tempDir);
    rewriteConfig(fixture.repoDir, {
      githubEnabled: false,
      runnerRequiredEnv: ["OPENAI_API_KEY", "SECOND_REQUIRED_ENV"]
    });
    delete process.env.OPENAI_API_KEY;
    delete process.env.SECOND_REQUIRED_ENV;

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["doctor", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      failures: string[];
      checks: Array<{ label: string; ok: boolean; error?: string }>;
    };

    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(false);
    expect(payload.failures).toHaveLength(2);
    expect(payload.checks.find((check) => check.label === "env:OPENAI_API_KEY")?.error).toBe("Missing required env var OPENAI_API_KEY");
    expect(payload.checks.find((check) => check.label === "env:SECOND_REQUIRED_ENV")?.error).toBe("Missing required env var SECOND_REQUIRED_ENV");
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
