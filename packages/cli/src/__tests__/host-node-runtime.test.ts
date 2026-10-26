import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DockerWorkspaceRuntime } from "@afk-geoff/runtime-docker";
import { LocalProcessWorkspaceRuntime } from "../local-process-runtime.js";
import { resolvePackageManager, runVerificationCommands, spawnReviewProcess } from "../local-docker-execution-backend.js";

const originalPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk runtime ' "));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const executable = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  executable("node", "#!/bin/sh\necho competing-node >&2\nexit 42\n");
  // Model login startup rewriting PATH, even when the parent supplies a pinned PATH.
  executable("bash", `#!${process.execPath}
process.env.PATH = ${JSON.stringify(bin)} + require('path').delimiter + process.env.PATH;
const child = require('child_process').spawnSync('/bin/bash', ['-c', process.argv[3]], {
  env: process.env, stdio: 'inherit'
});
process.exit(child.status ?? 1);
`);
  process.env.PATH = bin + path.delimiter + originalPath;
  const probe = "console.log(JSON.stringify([process.execPath, process.versions.modules, process.version]))";
  const expected = JSON.stringify([process.execPath, process.versions.modules, process.version]);
  return { dir, bin, executable, probe, expected };
}
it("shared verification pins Node after login startup and preserves shell syntax", async () => {
  const f = fixture();
  const command = `AFK_RUNTIME_TEST='space value' node -e '${f.probe}' | cat`;
  const results = await runVerificationCommands([command, command], f.dir, {});
  expect(results.map((r) => ({ passed: r.passed, stdout: r.stdout.trim() }))).toEqual([
    { passed: true, stdout: f.expected }, { passed: true, stdout: f.expected }
  ]);
});
it("local workers and host reviewers use the executing AFK Node", async () => {
  const f = fixture();
  const stdoutPath = path.join(f.dir, "stdout");
  const stderrPath = path.join(f.dir, "stderr");
  const code = await new LocalProcessWorkspaceRuntime().runWork({
    image: "unused", repoGitDir: f.dir, worktreePath: f.dir, runDir: f.dir,
    envAllowlist: [], command: "node", args: ["-e", f.probe], stdoutPath, stderrPath
  });
  expect(code).toBe(0);
  expect(fs.readFileSync(stdoutPath, "utf8").trim()).toBe(f.expected);
  expect(await spawnReviewProcess({ command: "node", args: ["-e", f.probe], promptTransport: "arg" }, undefined, f.dir, stdoutPath, stderrPath)).toBe(0);
  expect(fs.readFileSync(stdoutPath, "utf8").trim()).toBe(f.expected);
});
it("declared pnpm Corepack and package-manager scripts retain the selected runtime", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }));
  f.executable("pnpm", "#!/bin/sh\nexit 42\n");
  f.executable("corepack", "#!/bin/sh\nexit 42\n");
  const selectedDirectory = path.join(f.dir, "selected bin");
  fs.mkdirSync(selectedDirectory);
  fs.symlinkSync(process.execPath, path.join(selectedDirectory, "node"));
  fs.writeFileSync(path.join(selectedDirectory, "pnpm"), "#!/usr/bin/env node\nconsole.log('0.0.0');\n", { mode: 0o755 });
  fs.writeFileSync(path.join(selectedDirectory, "corepack"), `#!/usr/bin/env node\nif (process.argv[2] !== 'pnpm@10.20.0') process.exit(43); const c = require('child_process').spawnSync('node', ['-e', ${JSON.stringify(f.probe)}], {env:process.env, stdio:'inherit'}); process.exit(c.status ?? 1);\n`, { mode: 0o755 });
  const originalExecPath = process.execPath;
  process.execPath = path.join(selectedDirectory, "node");
  try {
    const manager = await resolvePackageManager(f.dir);
    expect(manager.warning).toContain("PATH has pnpm@0.0.0");
    const [result] = await runVerificationCommands(["pnpm run check"], f.dir, manager);
    expect(result?.passed).toBe(true);
    expect(result?.stdout.trim()).toBe(f.expected);
  } finally {
    process.execPath = originalExecPath;
  }
});
it("package-manager scripts inherit Node and unrelated environment and PATH entries", async () => {
  const f = fixture();
  f.executable("afk-runtime-helper", "#!/bin/sh\nprintf helper-ok\n");
  fs.writeFileSync(path.join(f.dir, "package.json"), JSON.stringify({ scripts: {
    check: `node -e '${f.probe}'`
  } }));
  const results = await runVerificationCommands([
    "npm run --silent check",
    "AFK_RUNTIME_TEST='space value' sh -c 'printf \"%s\\n\" \"$AFK_RUNTIME_TEST\"; afk-runtime-helper'",
    "node -e 'process.exit(7)'",
    "printf 'unterminated"
  ], f.dir, {});
  expect(results[0]?.stdout.trim()).toBe(f.expected);
  expect(results[0]?.passed).toBe(true);
  expect(results[1]?.stdout).toBe("space value\nhelper-ok");
  expect(results[2]?.exitCode).toBe(7);
  expect(results[3]?.passed).toBe(false);
});

it("Docker worker invocation retains the image runtime without host Node paths", async () => {
  const f = fixture();
  f.executable("docker", `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
  const stdoutPath = path.join(f.dir, "stdout");
  expect(await new DockerWorkspaceRuntime().runWork({ image: "fixture-image", repoGitDir: f.dir, worktreePath: f.dir, runDir: f.dir, envAllowlist: [], command: "node", args: ["worker.js"], stdoutPath, stderrPath: path.join(f.dir, "stderr") })).toBe(0);
  const args = JSON.parse(fs.readFileSync(stdoutPath, "utf8")) as string[];
  expect(args.join("\n")).not.toContain(path.dirname(process.execPath));
  expect(args.at(-1)).toContain("exec 'node' 'worker.js'");
});

it("verification quotes a selected Node installation containing spaces and apostrophes", async () => {
  const f = fixture();
  const selectedDirectory = path.join(f.dir, "selected node's bin");
  fs.mkdirSync(selectedDirectory);
  const originalExecPath = process.execPath;
  fs.symlinkSync(originalExecPath, path.join(selectedDirectory, "node"));
  process.execPath = path.join(selectedDirectory, "node");
  try {
    const [result] = await runVerificationCommands([`node -e '${f.probe}'`], f.dir, {});
    expect(result?.passed).toBe(true);
    expect(result?.stdout.trim()).toBe(f.expected);
  } finally {
    process.execPath = originalExecPath;
  }
});
