import { z } from "zod";

export const lifecycleEventSchemaVersion = 1 as const;

const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeDuration = z.number().finite().nonnegative();
const phaseSchema = z.enum(["work", "fix", "follow-up"]);
const workflowStageSchema = z.enum([
  "run",
  "work",
  "fix",
  "follow-up",
  "verification",
  "review",
  "cleanup",
  "watch",
  "publishing"
]);
const terminalFailureSchema = z.strictObject({
  category: z.enum(["product", "verification", "environment", "orchestrator", "publishing"]),
  message: nonEmptyString
});

const envelopeShape = {
  kind: z.literal("run_event"),
  schemaVersion: z.literal(lifecycleEventSchemaVersion),
  timestamp: z.iso.datetime()
} as const;

const runIdentityShape = {
  runId: nonEmptyString,
  workItemId: nonEmptyString
} as const;

const runPathsShape = {
  branchName: nonEmptyString,
  worktreePath: nonEmptyString,
  runDir: nonEmptyString
} as const;

const stageAttemptShape = {
  stage: workflowStageSchema,
  attempt: positiveInteger
} as const;

const stageExecutionShape = {
  ...stageAttemptShape,
  reused: z.boolean()
} as const;

const watchRunShape = {
  ...runIdentityShape,
  status: z.enum(["prepared", "running", "completed", "failed"]),
  message: nonEmptyString.optional(),
  terminalFailure: terminalFailureSchema.optional(),
  branchName: nonEmptyString.optional(),
  worktreePath: nonEmptyString.optional(),
  runDir: nonEmptyString
} as const;

const schemas = [
  z.strictObject({
    ...envelopeShape,
    event: z.literal("run_requested"),
    target: nonEmptyString,
    value: nonEmptyString.optional()
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...runPathsShape,
    event: z.literal("run_started"),
    stage: z.literal("run"),
    attempt: z.literal(1),
    reused: z.literal(false)
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    event: z.literal("package_manager_warning"),
    message: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("worker_started"),
    stage: z.enum(["work", "follow-up"]),
    iteration: positiveInteger,
    phase: z.enum(["work", "follow-up"]),
    command: nonEmptyString,
    resultPath: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("fix_started"),
    stage: z.literal("fix"),
    iteration: positiveInteger,
    phase: z.literal("fix"),
    command: nonEmptyString,
    resultPath: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("worker_completed"),
    stage: phaseSchema,
    durationMs: nonNegativeDuration,
    iteration: positiveInteger,
    phase: phaseSchema,
    status: z.enum(["done", "blocked", "failed"]),
    message: nonEmptyString,
    resultPath: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("verification_started"),
    stage: z.literal("verification"),
    iteration: positiveInteger,
    phase: z.literal("verify")
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("verification_completed"),
    stage: z.literal("verification"),
    durationMs: nonNegativeDuration,
    iteration: positiveInteger,
    phase: z.literal("verify"),
    status: z.enum(["passed", "failed", "skipped"]),
    message: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageAttemptShape,
    event: z.literal("verification_issues"),
    stage: z.literal("verification"),
    iteration: positiveInteger,
    phase: z.literal("verify"),
    issueCount: positiveInteger,
    issues: z.array(nonEmptyString).min(1)
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("review_started"),
    stage: z.literal("review"),
    iteration: positiveInteger,
    phase: z.literal("review"),
    command: nonEmptyString,
    resultPath: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("review_issues"),
    stage: z.literal("review"),
    durationMs: nonNegativeDuration,
    iteration: positiveInteger,
    phase: z.literal("review"),
    verdict: z.literal("ISSUES"),
    issueCount: positiveInteger,
    issues: z.array(nonEmptyString).min(1),
    message: nonEmptyString.optional(),
    resultPath: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("review_completed"),
    stage: z.literal("review"),
    durationMs: nonNegativeDuration,
    iteration: positiveInteger,
    phase: z.literal("review"),
    verdict: z.enum(["PASS", "BLOCKED"]),
    issueCount: nonNegativeInteger,
    issues: z.array(nonEmptyString).min(1).optional(),
    message: nonEmptyString.optional(),
    resultPath: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageExecutionShape,
    event: z.literal("review_contract_failed"),
    stage: z.literal("review"),
    iteration: positiveInteger,
    phase: z.literal("review"),
    failureKind: z.enum(["missing", "empty", "malformed"]),
    message: nonEmptyString,
    resultPath: nonEmptyString
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    event: z.literal("run_completed"),
    stage: z.enum(["run", "watch"]),
    attempt: positiveInteger,
    reused: z.boolean(),
    durationMs: nonNegativeDuration.optional(),
    status: z.enum(["done", "blocked", "failed", "completed"]),
    message: nonEmptyString.optional(),
    terminalFailure: terminalFailureSchema.optional(),
    branchName: nonEmptyString.optional(),
    worktreePath: nonEmptyString.optional(),
    runDir: nonEmptyString,
    finalResultPath: nonEmptyString.optional()
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    ...stageAttemptShape,
    event: z.literal("generated_artifacts_cleaned"),
    stage: z.literal("cleanup"),
    iteration: nonNegativeInteger,
    phase: nonEmptyString,
    paths: z.array(nonEmptyString).min(1)
  }),
  z.strictObject({
    ...envelopeShape,
    ...watchRunShape,
    ...stageExecutionShape,
    event: z.literal("watch_started"),
    stage: z.literal("watch")
  }),
  z.strictObject({
    ...envelopeShape,
    ...watchRunShape,
    event: z.literal("run_observed")
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    event: z.literal("progress_observed"),
    phase: nonEmptyString,
    iteration: nonNegativeInteger,
    message: nonEmptyString,
    progressUpdatedAt: z.iso.datetime()
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    event: z.literal("heartbeat_stale"),
    phase: nonEmptyString,
    iteration: nonNegativeInteger,
    message: nonEmptyString,
    progressUpdatedAt: z.iso.datetime(),
    heartbeatAgeMs: nonNegativeDuration,
    staleThresholdMs: nonNegativeDuration
  }),
  z.strictObject({
    ...envelopeShape,
    ...watchRunShape,
    event: z.literal("run_failed")
  }),
  z.strictObject({
    ...envelopeShape,
    ...runIdentityShape,
    event: z.literal("evidence_reused"),
    sourceRunId: nonEmptyString,
    reusedStages: z.array(z.enum(["work", "verification", "review"])).min(1),
    retriedStage: z.enum(["verification", "review", "publishing"])
  })
] as const;

export const lifecycleEventSchema = z.discriminatedUnion("event", schemas);
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

type WithoutLifecycleEnvelope<T> = T extends LifecycleEvent
  ? Omit<T, "kind" | "schemaVersion" | "timestamp">
  : never;

export type LifecycleEventInput = WithoutLifecycleEnvelope<LifecycleEvent>;

export function createLifecycleEvent(
  event: LifecycleEventInput,
  timestamp = new Date().toISOString()
): LifecycleEvent {
  return lifecycleEventSchema.parse({
    kind: "run_event",
    schemaVersion: lifecycleEventSchemaVersion,
    timestamp,
    ...event
  });
}
