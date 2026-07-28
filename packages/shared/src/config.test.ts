import { describe, expect, it } from "vitest";
import { applyRunnerProfile, projectConfigSchema } from "./config.js";

describe("projectConfigSchema — runner model fields", () => {
  function baseConfig(overrides: object = {}): object {
    return {
      version: 1,
      runner: {
        kind: "claude",
        ...overrides
      },
      docker: { image: "afk-worker:latest" },
      paths: {
        state: ".afk/state.sqlite",
        runs: ".afk/runs",
        worktrees: ".afk/worktrees"
      }
    };
  }

  it("parses runner.model when provided", () => {
    const config = projectConfigSchema.parse(baseConfig({ model: "claude-sonnet-4-6" }));
    expect(config.runner.model).toBe("claude-sonnet-4-6");
  });

  it("allows runner.model to be omitted (undefined)", () => {
    const config = projectConfigSchema.parse(baseConfig());
    expect(config.runner.model).toBeUndefined();
  });

  it("parses runner.review.model when provided", () => {
    const config = projectConfigSchema.parse(
      baseConfig({ review: { model: "claude-opus-4-6" } })
    );
    expect(config.runner.review?.model).toBe("claude-opus-4-6");
  });

  it("allows runner.review to be omitted (undefined)", () => {
    const config = projectConfigSchema.parse(baseConfig());
    expect(config.runner.review).toBeUndefined();
  });

  it("parses both runner.model and runner.review.model together", () => {
    const config = projectConfigSchema.parse(
      baseConfig({
        model: "claude-sonnet-4-6",
        review: { model: "claude-opus-4-6" }
      })
    );
    expect(config.runner.model).toBe("claude-sonnet-4-6");
    expect(config.runner.review?.model).toBe("claude-opus-4-6");
  });

  it("review model falls back to work model when runner.review is not set", () => {
    const config = projectConfigSchema.parse(baseConfig({ model: "claude-sonnet-4-6" }));
    // The fallback is computed at runtime, not in the schema; schema just stores the raw values.
    const resolvedReviewModel = config.runner.review?.model ?? config.runner.model;
    expect(resolvedReviewModel).toBe("claude-sonnet-4-6");
  });

  it("rejects runner.model that is an empty string", () => {
    expect(() => projectConfigSchema.parse(baseConfig({ model: "" }))).toThrow();
  });

  it("defaults execution.backend to local-docker", () => {
    const config = projectConfigSchema.parse(baseConfig());
    expect(config.execution.backend).toBe("local-docker");
  });

  it("parses execution.backend when provided", () => {
    const config = projectConfigSchema.parse({
      ...baseConfig(),
      execution: {
        backend: "local-docker"
      }
    });
    expect(config.execution.backend).toBe("local-docker");
  });

  it("rejects unsupported execution.backend values", () => {
    expect(() => projectConfigSchema.parse({
      ...baseConfig(),
      execution: {
        backend: "github-actions"
      }
    })).toThrow();
  });

  it("parses local-process execution backend", () => {
    const config = projectConfigSchema.parse({
      ...baseConfig(),
      execution: {
        backend: "local-process"
      }
    });
    expect(config.execution.backend).toBe("local-process");
  });

  it("configures smoke profile with a no-key command runner", () => {
    const config = projectConfigSchema.parse(baseConfig());
    const profiled = applyRunnerProfile(config, "smoke");

    expect(profiled.runner.kind).toBe("claude");
    expect(profiled.runner.command).toEqual(["node", ".afk/smoke-runner.mjs", "{prompt}"]);
    expect(profiled.runner.reviewCommand).toEqual(["node", ".afk/smoke-runner.mjs", "{prompt}"]);
    expect(profiled.runner.requiredEnv).toEqual([]);
    expect(profiled.github.enabled).toBe(false);
    expect(profiled.execution.backend).toBe("local-process");
  });

  it("configures local Claude profile without requiring API env vars", () => {
    const config = projectConfigSchema.parse(baseConfig({ requiredEnv: ["ANTHROPIC_API_KEY"] }));
    const profiled = applyRunnerProfile(config, "claude");

    expect(profiled.runner.kind).toBe("claude");
    expect(profiled.runner.command).toBeUndefined();
    expect(profiled.runner.requiredEnv).toEqual([]);
    expect(profiled.github.enabled).toBe(false);
    expect(profiled.execution.backend).toBe("local-process");
  });

  it("configures local Codex profile without requiring API env vars", () => {
    const config = projectConfigSchema.parse(baseConfig());
    const profiled = applyRunnerProfile(config, "codex");

    expect(profiled.runner.kind).toBe("codex");
    expect(profiled.runner.command).toBeUndefined();
    expect(profiled.runner.requiredEnv).toEqual([]);
    expect(profiled.github.enabled).toBe(false);
    expect(profiled.execution.backend).toBe("local-process");
  });

  it("parses custom command runners for other agent CLIs", () => {
    const config = projectConfigSchema.parse(baseConfig({
      kind: "custom",
      command: ["opencode", "run", "{prompt}"],
      reviewCommand: ["other-agent-review", "{prompt}"],
      requiredEnv: []
    }));

    expect(config.runner.kind).toBe("custom");
    expect(config.runner.command).toEqual(["opencode", "run", "{prompt}"]);
    expect(config.runner.reviewCommand).toEqual(["other-agent-review", "{prompt}"]);
  });

  it("rejects ambiguous verification alternatives in project config", () => {
    expect(() => projectConfigSchema.parse({
      ...baseConfig(),
      verification: ["npm install or pnpm install"]
    })).toThrow("Verification command must be one explicit shell command");
  });
});
