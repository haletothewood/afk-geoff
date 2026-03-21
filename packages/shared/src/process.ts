import fs from "node:fs";
import { spawn } from "node:child_process";

export interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

interface ProcessLogs {
  stdoutPath?: string;
  stderrPath?: string;
  mirrorToConsole?: boolean;
  pidPath?: string;
  pidMetadata?: Record<string, unknown>;
}

export async function runProcess(spec: ProcessSpec, logs?: ProcessLogs): Promise<number> {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });

  if (logs?.pidPath && child.pid !== undefined) {
    fs.writeFileSync(
      logs.pidPath,
      JSON.stringify(
        {
          pid: child.pid,
          command: spec.command,
          args: spec.args,
          startedAt: new Date().toISOString(),
          ...(logs.pidMetadata ?? {})
        },
        null,
        2
      )
    );
  }

  if (spec.stdin !== undefined) {
    child.stdin?.write(spec.stdin);
    child.stdin?.end();
  }

  const stdoutStream = logs?.stdoutPath ? fs.createWriteStream(logs.stdoutPath) : undefined;
  const stderrStream = logs?.stderrPath ? fs.createWriteStream(logs.stderrPath) : undefined;

  child.stdout?.on("data", (chunk) => {
    stdoutStream?.write(chunk);
    if (logs?.mirrorToConsole) {
      process.stdout.write(chunk);
    }
  });

  child.stderr?.on("data", (chunk) => {
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
      if (logs?.pidPath) {
        fs.rmSync(logs.pidPath, { force: true });
      }
      resolve(code ?? 1);
    });
  });
}
