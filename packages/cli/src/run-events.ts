import { AsyncLocalStorage } from "node:async_hooks";

export interface RunEvent {
  event: string;
  target?: string;
  value?: string;
  runId?: string;
  workItemId?: string;
  iteration?: number;
  phase?: string;
  status?: string;
  verdict?: string;
  message?: string;
  issueCount?: number;
  issues?: string[];
  command?: string;
  paths?: string[];
  branchName?: string;
  worktreePath?: string;
  runDir?: string;
  resultPath?: string;
  finalResultPath?: string;
}

const EVENT_KIND = "run_event";
const runEventContext = new AsyncLocalStorage<boolean>();

export async function withRunEvents<T>(action: () => Promise<T>): Promise<T> {
  return await runEventContext.run(true, action);
}

export function emitRunEvent(event: RunEvent): void {
  if (runEventContext.getStore() !== true) {
    return;
  }

  console.log(JSON.stringify({ kind: EVENT_KIND, timestamp: new Date().toISOString(), ...event }));
}

export function isRunEventLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { kind?: unknown };
    return parsed.kind === EVENT_KIND;
  } catch {
    return false;
  }
}
