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

export const workerResultSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string().min(1),
  issueComment: z.string().default(""),
  pr: z
    .object({
      title: z.string().optional(),
      body: z.string().optional()
    })
    .optional()
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type WorkerResult = z.infer<typeof workerResultSchema>;
