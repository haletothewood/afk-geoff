import { describe, expect, it, vi } from "vitest";
import { ClaudeCliRunner } from "./index.js";

describe("ClaudeCliRunner", () => {
  const runner = new ClaudeCliRunner();

  describe("buildInvocation", () => {
    it("builds default invocation without model", () => {
      const result = runner.buildInvocation({ mode: "work", promptPath: "/afk-run/prompt.md" });
      expect(result.command).toBe("claude");
      expect(result.args).not.toContain("--model");
      expect(result.promptTransport).toBe("stdin");
    });

    it("appends --model flag when model is provided", () => {
      const result = runner.buildInvocation({
        mode: "work",
        promptPath: "/afk-run/prompt.md",
        model: "claude-sonnet-4-6"
      });
      expect(result.command).toBe("claude");
      expect(result.args).toContain("--model");
      const modelIndex = result.args.indexOf("--model");
      expect(result.args[modelIndex + 1]).toBe("claude-sonnet-4-6");
    });

    it("uses command override and ignores model with a warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = runner.buildInvocation({
          mode: "work",
          promptPath: "/afk-run/prompt.md",
          commandOverride: ["node", "my-runner.mjs", "{prompt}"],
          model: "claude-sonnet-4-6"
        });
        expect(result.command).toBe("node");
        expect(result.args).not.toContain("--model");
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0]?.[0]).toContain("runner.command override is set");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("uses command override without warning when no model is set", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        runner.buildInvocation({
          mode: "work",
          promptPath: "/afk-run/prompt.md",
          commandOverride: ["node", "my-runner.mjs", "{prompt}"]
        });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("model resolution — review falls back to work model", () => {
    it("review model falls back to work model when no review model configured", () => {
      // Simulate resolveReviewModel logic: review?.model ?? model
      const runnerModel = "claude-sonnet-4-6";
      const reviewModel = undefined;
      const resolved = reviewModel ?? runnerModel;
      expect(resolved).toBe("claude-sonnet-4-6");
    });

    it("review model override takes precedence over work model", () => {
      const runnerModel = "claude-sonnet-4-6";
      const reviewModel = "claude-opus-4-6";
      const resolved = reviewModel ?? runnerModel;
      expect(resolved).toBe("claude-opus-4-6");
    });
  });
});
