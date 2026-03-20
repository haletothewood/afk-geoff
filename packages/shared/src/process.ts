import fs from "node:fs";
import { spawn } from "node:child_process";

export interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export async function runProcess(spec: ProcessSpec, logs?: { stdoutPath?: string; stderrPath?: string; mirrorToConsole?: boolean }): Promise<number> {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdoutStream = logs?.stdoutPath ? fs.createWriteStream(logs.stdoutPath) : undefined;
  const stderrStream = logs?.stderrPath ? fs.createWriteStream(logs.stderrPath) : undefined;

  child.stdout.on("data", (chunk) => {
    stdoutStream?.write(chunk);
    if (logs?.mirrorToConsole) {
      process.stdout.write(chunk);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrStream?.write(chunk);
    if (logs?.mirrorToConsole) {
      process.stderr.write(chunk);
    }
  });

  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      stdoutStream?.end();
      stderrStream?.end();
      resolve(code ?? 1);
    });
  });
}
