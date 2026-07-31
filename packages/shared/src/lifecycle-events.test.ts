import { describe, expect, it } from "vitest";
import { lifecycleEventSchema } from "./lifecycle-events.js";

describe("lifecycleEventSchema", () => {
  it("rejects event variants outside the version 1 workflow vocabulary", () => {
    const valid = lifecycleEventSchema.safeParse({
      kind: "run_event",
      schemaVersion: 1,
      timestamp: "2026-07-31T12:00:00.000Z",
      event: "run_requested",
      target: "file",
      value: "brief.md"
    });
    const unknown = lifecycleEventSchema.safeParse({
      kind: "run_event",
      schemaVersion: 1,
      timestamp: "2026-07-31T12:00:00.000Z",
      event: "runner_token_delta",
      token: "hello"
    });

    expect(valid.success).toBe(true);
    expect(unknown.success).toBe(false);
  });

  it("requires the selected variant fields and rejects fields from other variants", () => {
    const runStarted = {
      kind: "run_event",
      schemaVersion: 1,
      timestamp: "2026-07-31T12:00:00.000Z",
      event: "run_started",
      runId: "run_123",
      workItemId: "wi_123",
      stage: "run",
      attempt: 1,
      reused: false,
      branchName: "afk/example",
      worktreePath: "/repo/.afk/worktrees/run_123",
      runDir: "/repo/.afk/runs/run_123"
    } as const;

    expect(lifecycleEventSchema.safeParse(runStarted).success).toBe(true);
    expect(lifecycleEventSchema.safeParse({ ...runStarted, runId: undefined }).success).toBe(false);
    expect(lifecycleEventSchema.safeParse({ ...runStarted, attempt: "first" }).success).toBe(false);
    expect(lifecycleEventSchema.safeParse({ ...runStarted, verdict: "PASS" }).success).toBe(false);
  });

  it("accepts a typed payload for every version 1 lifecycle event", () => {
    const common = {
      kind: "run_event",
      schemaVersion: 1,
      timestamp: "2026-07-31T12:00:00.000Z"
    } as const;
    const run = {
      runId: "run_123",
      workItemId: "wi_123"
    } as const;
    const paths = {
      branchName: "afk/example",
      worktreePath: "/repo/.afk/worktrees/run_123",
      runDir: "/repo/.afk/runs/run_123"
    } as const;
    const events = [
      { ...common, event: "run_requested", target: "file", value: "brief.md" },
      { ...common, ...run, ...paths, event: "run_started", stage: "run", attempt: 1, reused: false },
      { ...common, ...run, event: "package_manager_warning", message: "Using Corepack" },
      {
        ...common,
        ...run,
        event: "worker_started",
        stage: "work",
        attempt: 1,
        reused: false,
        iteration: 1,
        phase: "work",
        command: "claude",
        resultPath: "/run/work-result-1.json"
      },
      {
        ...common,
        ...run,
        event: "fix_started",
        stage: "fix",
        attempt: 2,
        reused: false,
        iteration: 2,
        phase: "fix",
        command: "claude",
        resultPath: "/run/fix-result-2.json"
      },
      {
        ...common,
        ...run,
        event: "worker_completed",
        stage: "work",
        attempt: 1,
        reused: false,
        durationMs: 250,
        iteration: 1,
        phase: "work",
        status: "done",
        message: "Implemented",
        resultPath: "/run/work-result-1.json"
      },
      {
        ...common,
        ...run,
        event: "verification_started",
        stage: "verification",
        attempt: 1,
        reused: false,
        iteration: 1,
        phase: "verify"
      },
      {
        ...common,
        ...run,
        event: "verification_completed",
        stage: "verification",
        attempt: 1,
        reused: false,
        durationMs: 25,
        iteration: 1,
        phase: "verify",
        status: "passed",
        message: "1/1 passed"
      },
      {
        ...common,
        ...run,
        event: "verification_issues",
        stage: "verification",
        attempt: 1,
        iteration: 1,
        phase: "verify",
        issueCount: 1,
        issues: ["tests failed"]
      },
      {
        ...common,
        ...run,
        event: "review_started",
        stage: "review",
        attempt: 1,
        reused: false,
        iteration: 1,
        phase: "review",
        command: "claude review",
        resultPath: "/run/review-result-1.json"
      },
      {
        ...common,
        ...run,
        event: "review_issues",
        stage: "review",
        attempt: 1,
        reused: false,
        durationMs: 40,
        iteration: 1,
        phase: "review",
        verdict: "ISSUES",
        issueCount: 1,
        issues: ["Handle empty input"],
        resultPath: "/run/review-result-1.json"
      },
      {
        ...common,
        ...run,
        event: "review_completed",
        stage: "review",
        attempt: 2,
        reused: false,
        durationMs: 30,
        iteration: 2,
        phase: "review",
        verdict: "PASS",
        issueCount: 0,
        resultPath: "/run/review-result-2.json"
      },
      {
        ...common,
        ...run,
        ...paths,
        event: "run_completed",
        stage: "run",
        attempt: 1,
        reused: false,
        durationMs: 500,
        status: "done",
        message: "Completed",
        finalResultPath: "/run/final-result.json"
      },
      {
        ...common,
        ...run,
        event: "generated_artifacts_cleaned",
        stage: "cleanup",
        attempt: 1,
        iteration: 1,
        phase: "work",
        paths: ["tsconfig.tsbuildinfo"]
      },
      {
        ...common,
        ...run,
        ...paths,
        event: "watch_started",
        stage: "watch",
        attempt: 1,
        reused: false,
        status: "running"
      },
      { ...common, ...run, ...paths, event: "run_observed", status: "completed", message: "Done" },
      {
        ...common,
        ...run,
        event: "progress_observed",
        phase: "review",
        iteration: 2,
        message: "Reviewer running",
        progressUpdatedAt: "2026-07-31T11:59:59.500Z"
      },
      {
        ...common,
        ...run,
        event: "heartbeat_stale",
        phase: "review",
        iteration: 2,
        message: "last progress update 31s ago",
        progressUpdatedAt: "2026-07-31T11:59:29.000Z",
        heartbeatAgeMs: 31_000,
        staleThresholdMs: 30_000
      },
      {
        ...common,
        ...run,
        ...paths,
        event: "run_failed",
        status: "failed",
        message: "Worker exited",
        terminalFailure: { category: "orchestrator", message: "Worker exited" }
      },
      {
        ...common,
        ...run,
        event: "evidence_reused",
        sourceRunId: "run_123",
        reusedStages: ["work", "review"],
        retriedStage: "verification"
      }
    ];

    for (const event of events) {
      expect(lifecycleEventSchema.safeParse(event), event.event).toMatchObject({ success: true });
    }
  });
});
