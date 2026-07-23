import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceRuntime } from "@afk-geoff/core";
import { runProcess } from "@afk-geoff/shared";

const execFileAsync = promisify(execFile);
const DOCKERFILE_SHA_LABEL = "afk.dockerfile-sha";

export class DockerWorkspaceRuntime implements WorkspaceRuntime {
  public async ensureImage(input: { cwd: string; image: string; dockerfilePath: string; buildContext: string }): Promise<void> {
    const dockerfileSha = dockerfileFingerprint(input.dockerfilePath);
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["image", "inspect", input.image, "--format", `{{ index .Config.Labels "${DOCKERFILE_SHA_LABEL}" }}`],
        { cwd: input.cwd }
      );
      if (stdout.trim() === dockerfileSha) {
        return;
      }
    } catch {
      // fall through to rebuild when the image is missing or unlabeled
    }

    await execFileAsync(
      "docker",
      ["build", "--label", `${DOCKERFILE_SHA_LABEL}=${dockerfileSha}`, "-t", input.image, "-f", input.dockerfilePath, input.buildContext],
      { cwd: input.cwd }
    );
  }

  public async runWork(input: {
    image: string;
    repoGitDir: string;
    worktreePath: string;
    runDir: string;
    envAllowlist: string[];
    extraEnv?: NodeJS.ProcessEnv;
    command: string;
    args: string[];
    stdin?: string;
    stdoutPath: string;
    stderrPath: string;
  }): Promise<number> {
    fs.mkdirSync(input.runDir, { recursive: true });
    const runId = path.basename(input.runDir);
    const containerName = `afk-${runId}`;
    const envArgs = input.envAllowlist.flatMap((name) => {
      const value = process.env[name];
      return value ? ["-e", `${name}=${value}`] : [];
    });
    const extraEnvArgs = Object.entries(input.extraEnv ?? {}).flatMap(([name, value]) => (
      value === undefined ? [] : ["-e", `${name}=${value}`]
    ));
    const userArgs = typeof process.getuid === "function" && typeof process.getgid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : [];

    const entrypointScript = buildRuntimeEntrypoint(input.command, input.args);
    const args = [
      "run",
      "--rm",
      ...(input.stdin === undefined ? [] : ["-i"]),
      ...userArgs,
      "--name",
      containerName,
      "-w",
      input.worktreePath,
      "-v",
      `${input.worktreePath}:/workspace`,
      "-v",
      `${input.worktreePath}:${input.worktreePath}`,
      "-v",
      `${input.repoGitDir}:${input.repoGitDir}`,
      "-v",
      `${input.runDir}:/afk-run`,
      ...envArgs,
      ...extraEnvArgs,
      input.image,
      "bash",
      "-lc",
      entrypointScript
    ];

    return await runProcess(
      {
        command: "docker",
        args,
        cwd: input.worktreePath,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin })
      },
      {
        stdoutPath: input.stdoutPath,
        stderrPath: input.stderrPath,
        mirrorToConsole: process.env.AFK_VERBOSE === "1",
        pidPath: path.join(input.runDir, "worker-process.json"),
        pidMetadata: { containerName, runtime: "docker" }
      }
    );
  }
}

export function buildRuntimeEntrypoint(command: string, args: string[]): string {
  const executable = [command, ...args].map(shellQuote).join(" ");
  const bootstrap = [
    "if [ -f package.json ]; then",
    "  if [ -f pnpm-lock.yaml ]; then",
    "    AFK_PACKAGE_MANAGER=$(node -e \"try { const pm = JSON.parse(require('fs').readFileSync('package.json', 'utf8')).packageManager; if (typeof pm === 'string') process.stdout.write(pm); } catch {}\")",
    "    case \"$AFK_PACKAGE_MANAGER\" in",
    "      pnpm@*) corepack \"$AFK_PACKAGE_MANAGER\" install --frozen-lockfile ;;",
    "      *) corepack pnpm install --frozen-lockfile ;;",
    "    esac",
    "  elif [ -f package-lock.json ]; then",
    "    npm ci",
    "  elif [ -f yarn.lock ]; then",
    "    corepack yarn install --frozen-lockfile",
    "  fi",
    "fi"
  ].join("\n");

  return `set -euo pipefail\n${bootstrap}\nexec ${executable}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function dockerfileFingerprint(dockerfilePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(dockerfilePath)).digest("hex");
}
