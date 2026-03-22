import { z } from "zod";

export const plannerOutputSchema = z.object({
  summary: z.string().min(1),
  items: z.array(
    z.object({
      key: z.string().min(1),
      title: z.string().min(1),
      body: z.string().min(1),
      type: z.enum(["afk", "hitl"]),
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      dependsOnKeys: z.array(z.string().min(1)).default([])
    })
  )
});

const workerStatusSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .transform((value) => {
    if (value === "completed" || value === "complete" || value === "success" || value === "succeeded") {
      return "done";
    }

    return value;
  })
  .pipe(z.enum(["done", "blocked", "failed"]));

export const workerResultSchema = z.object({
  status: workerStatusSchema,
  summary: z.string().min(1),
  issueComment: z.string().default(""),
  pr: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      manualQa: z.array(z.string().min(1)).optional()
    })
    .optional()
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type WorkerResult = z.infer<typeof workerResultSchema>;
