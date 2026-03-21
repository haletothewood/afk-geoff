import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceRuntime } from "@afk-geoff/core";
import { runProcess } from "@afk-geoff/shared";

const execFileAsync = promisify(execFile);

export class DockerWorkspaceRuntime implements WorkspaceRuntime {
  public async ensureImage(input: { cwd: string; image: string; dockerfilePath: string; buildContext: string }): Promise<void> {
    try {
      await execFileAsync("docker", ["image", "inspect", input.image], { cwd: input.cwd });
      return;
    } catch {
      await execFileAsync("docker", ["build", "-t", input.image, "-f", input.dockerfilePath, input.buildContext], { cwd: input.cwd });
    }
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

    const args = [
      "run",
      "--rm",
      ...(input.stdin === undefined ? [] : ["-i"]),
      ...userArgs,
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
      input.command,
      ...input.args
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
        mirrorToConsole: true
      }
    );
  }
}
