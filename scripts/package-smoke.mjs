import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDir = path.join(rootDir, "dist-pack");
const tarball = fs.readdirSync(packDir)
  .filter((name) => /^afk-geoff-\d+\.\d+\.\d+\.tgz$/.test(name))
  .sort()
  .at(-1);

if (!tarball) {
  throw new Error(`No afk-geoff tarball found in ${packDir}. Run pnpm pack:cli first.`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-package-smoke-"));
const installDir = path.join(tempDir, "install");
const targetRepo = path.join(tempDir, "target");

try {
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(targetRepo, { recursive: true });

  execFileSync("npm", ["install", path.join(packDir, tarball)], { cwd: installDir, stdio: "inherit" });

  const afkBin = path.join(installDir, "node_modules", ".bin", "afk");
  execFileSync(afkBin, ["--help"], { cwd: installDir, stdio: "inherit" });

  execFileSync("git", ["init", "-b", "main"], { cwd: targetRepo, stdio: "inherit" });
  execFileSync("git", ["config", "user.email", "afk-smoke@example.com"], { cwd: targetRepo });
  execFileSync("git", ["config", "user.name", "AFK Package Smoke"], { cwd: targetRepo });
  fs.writeFileSync(path.join(targetRepo, "README.md"), "# Package smoke\n");
  execFileSync("git", ["add", "README.md"], { cwd: targetRepo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: targetRepo, stdio: "inherit" });

  execFileSync(afkBin, ["init", "--runner-profile", "smoke"], { cwd: targetRepo, stdio: "inherit" });

  const configPath = path.join(targetRepo, ".afk", "config.yaml");
  const smokeRunnerPath = path.join(targetRepo, ".afk", "smoke-runner.mjs");
  if (!fs.existsSync(configPath) || !fs.existsSync(smokeRunnerPath)) {
    throw new Error("Package smoke did not create the expected AFK repo files.");
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
