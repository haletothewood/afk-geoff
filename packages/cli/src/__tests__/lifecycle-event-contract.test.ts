import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lifecycleEventSchema } from "@afk-geoff/shared";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "lifecycle-events-v1"
);

const scenarios = {
  "successful-foreground.ndjson": {
    events: [
      "run_requested",
      "run_started",
      "worker_started",
      "worker_completed",
      "verification_started",
      "verification_completed",
      "review_started",
      "review_completed",
      "run_completed"
    ],
    terminalKind: "run_result"
  },
  "detached-observation.ndjson": {
    events: ["watch_started", "progress_observed", "heartbeat_stale", "run_completed"],
    terminalKind: "watch_result"
  },
  "verification-review-failure.ndjson": {
    events: [
      "verification_started",
      "verification_completed",
      "review_started",
      "review_issues",
      "verification_issues",
      "run_completed"
    ],
    terminalKind: "run_result"
  },
  "orchestrator-failure.ndjson": {
    events: ["run_started", "run_completed"],
    terminalKind: "run_result"
  },
  "publishing-failure.ndjson": {
    events: ["run_started", "run_completed"],
    terminalKind: "run_result"
  },
  "retry-reused-evidence.ndjson": {
    events: ["evidence_reused", "verification_started", "verification_completed"],
    terminalKind: "retry_result"
  }
} as const;

describe("lifecycle event v1 NDJSON contract fixtures", () => {
  for (const [fixture, expected] of Object.entries(scenarios)) {
    it(`keeps ${fixture} schema-valid and terminal`, () => {
      const lines = fs.readFileSync(path.join(fixtureDir, fixture), "utf8").trim().split("\n");
      const payloads = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const events = payloads.slice(0, -1).map((payload) => lifecycleEventSchema.parse(payload));

      expect(events.map((event) => event.event)).toEqual(expected.events);
      expect(payloads.at(-1)?.kind).toBe(expected.terminalKind);
      expect(payloads.at(-1)?.command).toBe(
        expected.terminalKind === "watch_result"
          ? "watch"
          : expected.terminalKind === "retry_result"
            ? "retry"
            : "run"
      );
    });
  }
});
