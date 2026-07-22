import { describe, expect, it } from "vitest";
import { CodexCliRunner } from "./index.js";

describe("CodexCliRunner", () => {
  it("uses codex exec non-interactively with stdin by default", () => {
    const runner = new CodexCliRunner();

    const invocation = runner.buildInvocation({
      mode: "work",
      promptPath: "/tmp/prompt.md"
    });

    expect(invocation).toEqual({
      command: "codex",
      args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "-"],
      promptTransport: "stdin"
    });
  });

  it("passes model through to codex exec", () => {
    const runner = new CodexCliRunner();

    const invocation = runner.buildInvocation({
      mode: "work",
      promptPath: "/tmp/prompt.md",
      model: "gpt-5-codex"
    });

    expect(invocation.args).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5-codex", "-"]);
  });

  it("preserves command override behavior for custom wrappers", () => {
    const runner = new CodexCliRunner();

    const invocation = runner.buildInvocation({
      mode: "work",
      promptPath: "/tmp/prompt.md",
      commandOverride: ["node", "codex-wrapper.mjs", "{prompt}"]
    });

    expect(invocation).toEqual({
      command: "node",
      args: ["codex-wrapper.mjs", "/tmp/prompt.md"],
      promptTransport: "arg"
    });
  });
});
