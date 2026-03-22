import { describe, expect, it } from "vitest";
import { projectConfigSchema } from "./config.js";

describe("projectConfigSchema — runner model fields", () => {
  const baseConfig = {
    version: 1 as const,
    docker: { image: "afk-worker:latest" },
    runner: { kind: "claude" as const },
    paths: {
      state: ".afk/state.sqlite",
      runs: ".afk/runs",
      worktrees: ".afk/worktrees"
    }
  };

  it("parses config without model fields (defaults to undefined)", () => {
    const result = projectConfigSchema.parse(baseConfig);
    expect(result.runner.model).toBeUndefined();
    expect(result.runner.review).toBeUndefined();
  });

  it("parses runner.model", () => {
    const result = projectConfigSchema.parse({
      ...baseConfig,
      runner: { kind: "claude", model: "claude-sonnet-4-6" }
    });
    expect(result.runner.model).toBe("claude-sonnet-4-6");
  });

  it("parses runner.review.model", () => {
    const result = projectConfigSchema.parse({
      ...baseConfig,
      runner: { kind: "claude", model: "claude-sonnet-4-6", review: { model: "claude-opus-4-6" } }
    });
    expect(result.runner.model).toBe("claude-sonnet-4-6");
    expect(result.runner.review?.model).toBe("claude-opus-4-6");
  });

  it("parses runner.review.model without runner.model", () => {
    const result = projectConfigSchema.parse({
      ...baseConfig,
      runner: { kind: "claude", review: { model: "claude-opus-4-6" } }
    });
    expect(result.runner.model).toBeUndefined();
    expect(result.runner.review?.model).toBe("claude-opus-4-6");
  });

  it("parses review block without model override", () => {
    const result = projectConfigSchema.parse({
      ...baseConfig,
      runner: { kind: "claude", model: "claude-sonnet-4-6", review: {} }
    });
    expect(result.runner.model).toBe("claude-sonnet-4-6");
    expect(result.runner.review?.model).toBeUndefined();
  });
});
