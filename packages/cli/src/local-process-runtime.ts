import fs from "node:fs";
import path from "node:path";
import type { WorkspaceRuntime } from "@afk-geoff/core";
import { runProcess } from "@afk-geoff/shared";

export class LocalProcessWorkspaceRuntime implements WorkspaceRuntime {
  public runDirPath(hostRunDir: string): string {
    return hostRunDir;
  }

  public async ensureImage(): Promise<void> {
    // Local process execution runs directly on the host; no worker image is needed.
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
    const allowedEnv = Object.fromEntries(
      input.envAllowlist.flatMap((name) => {
        const value = process.env[name];
        return value ? [[name, value]] : [];
      })
    );

    return await runProcess(
      {
        command: input.command,
        args: input.args,
        cwd: input.worktreePath,
        env: {
          ...process.env,
          ...allowedEnv,
          ...(input.extraEnv ?? {})
        },
        ...(input.stdin === undefined ? {} : { stdin: input.stdin })
      },
      {
        stdoutPath: input.stdoutPath,
        stderrPath: input.stderrPath,
        mirrorToConsole: process.env.AFK_VERBOSE === "1",
        pidPath: path.join(input.runDir, "worker-process.json"),
        pidMetadata: { runtime: "local-process" }
      }
    );
  }
}
