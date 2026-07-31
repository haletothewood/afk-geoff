import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
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
    expect(Object.keys(payload).sort()).toEqual(["backend", "checks", "command", "failures", "ok"]);
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
      error: { message: string };
      checks: Array<{ label: string; ok: boolean; error?: string }>;
    };

    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(["backend", "checks", "command", "error", "failures", "ok"]);
    expect(payload.error.message).toBe("Doctor checks failed (2 issues)");
    expect(payload.failures).toHaveLength(2);
    expect(payload.checks.find((check) => check.label === "env:OPENAI_API_KEY")?.error).toBe("Missing required env var OPENAI_API_KEY");
    expect(payload.checks.find((check) => check.label === "env:SECOND_REQUIRED_ENV")?.error).toBe("Missing required env var SECOND_REQUIRED_ENV");
  });

  it("Given configuration is invalid, when doctor --json runs, then it emits a context failure envelope", async () => {
    const fixture = await createFixture(tempDir);
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.version = 2;
    fs.writeFileSync(configPath, YAML.stringify(config));

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["doctor", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: null;
      checks: unknown[];
      failures: string[];
      error: { message: string };
    };

    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBeNull();
    expect(payload.checks).toEqual([]);
    expect(payload.failures).toEqual([payload.error.message]);
    expect(payload.error.message).toContain("version");
    expect(Object.keys(payload).sort()).toEqual(["backend", "checks", "command", "error", "failures", "ok"]);
  });

  it("Given doctor report construction fails, when doctor --json runs, then it emits a structured failure envelope", async () => {
    const fixture = await createFixture(tempDir);
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.runner.kind = "custom";
    delete config.runner.command;
    fs.writeFileSync(configPath, YAML.stringify(config));

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["doctor", "--json"]);
    });
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      backend: string;
      checks: unknown[];
      failures: string[];
      error: { message: string };
    };

    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(false);
    expect(payload.backend).toBe("local-docker");
    expect(payload.checks).toEqual([]);
    expect(payload.failures).toEqual([payload.error.message]);
    expect(payload.error.message).toBe("Custom runner requires runner.command in .afk/config.yaml");
    expect(Object.keys(payload).sort()).toEqual(["backend", "checks", "command", "error", "failures", "ok"]);
  });

  it("Given GitHub is enabled without repository coordinates, when doctor --json runs, then it reports the repository precondition", async () => {
    const fixture = await createFixture(tempDir);
    const fakeGhPath = path.join(tempDir, "bin", "gh");
    fs.writeFileSync(fakeGhPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeGhPath, 0o755);
    const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.github = { enabled: true };
    config.execution = { backend: "local-process" };
    fs.writeFileSync(configPath, YAML.stringify(config));

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["doctor", "--json"]);
    });
    const payload = JSON.parse(output) as {
      ok: boolean;
      checks: Array<{ label: string; ok: boolean; error?: string }>;
    };

    expect(payload.ok).toBe(false);
    expect(payload.checks).toEqual([
      { label: "git", ok: true, detail: "git" },
      { label: "runner", ok: true, detail: "node" },
      { label: "gh", ok: true, detail: "gh" },
      {
        label: "github",
        ok: false,
        error: "GitHub is enabled but origin remote owner/repo could not be resolved."
      }
    ]);
  });

  it("Given the local Docker backend executable is missing, when doctor --json runs, then it reports the backend-specific failure", async () => {
    const fixture = await createFixture(tempDir);
    const isolatedBin = path.join(tempDir, "doctor-bin");
    fs.mkdirSync(isolatedBin);
    const requiredExecutables: Array<[string, string]> = [
      ["node", process.execPath],
      ["git", execFileSync("which", ["git"], { encoding: "utf8" }).trim()],
      ["gh", execFileSync("which", ["gh"], { encoding: "utf8" }).trim()],
      ["which", execFileSync("which", ["which"], { encoding: "utf8" }).trim()]
    ];
    for (const [name, executable] of requiredExecutables) {
      fs.symlinkSync(executable, path.join(isolatedBin, name));
    }
    process.env.PATH = isolatedBin;

    const output = await captureConsoleForRejected(async () => {
      await fixture.cli(["doctor", "--json"]);
    });
    const payload = JSON.parse(output) as {
      backend: string;
      ok: boolean;
      checks: Array<{ label: string; ok: boolean; error?: string }>;
    };

    expect(payload.backend).toBe("local-docker");
    expect(payload.ok).toBe(false);
    expect(payload.checks.find((check) => check.label === "docker")).toEqual({
      label: "docker",
      ok: false,
      error: "Missing docker executable: docker"
    });
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
