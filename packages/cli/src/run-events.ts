import { AsyncLocalStorage } from "node:async_hooks";
import {
  createLifecycleEvent,
  lifecycleEventSchema,
  type LifecycleEventInput
} from "@afk-geoff/shared";

const runEventContext = new AsyncLocalStorage<boolean>();

export async function withRunEvents<T>(action: () => Promise<T>): Promise<T> {
  return await runEventContext.run(true, action);
}

export function isRunEventsEnabled(): boolean {
  return runEventContext.getStore() === true;
}

export function emitRunEvent(event: LifecycleEventInput): void {
  if (!isRunEventsEnabled()) {
    return;
  }

  console.log(JSON.stringify(createLifecycleEvent(event)));
}

export function isRunEventLine(line: string): boolean {
  try {
    return lifecycleEventSchema.safeParse(JSON.parse(line)).success;
  } catch {
    return false;
  }
}
