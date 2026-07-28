import { describe, expect, it } from "vitest";
import { normalizeVerificationCommand } from "./verification-command.js";

describe("normalizeVerificationCommand", () => {
  it("strips one Markdown code span from an explicit command", () => {
    expect(normalizeVerificationCommand("`pnpm test`")).toBe("pnpm test");
  });

  it("preserves valid shell operators and quoted prose", () => {
    expect(
      normalizeVerificationCommand(`node -e "console.log('pass or fail')" && node -e "process.exit(0)"`)
    ).toBe(`node -e "console.log('pass or fail')" && node -e "process.exit(0)"`);
  });

  it.each([
    "`npm install` or `pnpm install`",
    "npm install or pnpm install",
    "npm install and/or pnpm install"
  ])("rejects the ambiguous alternative %s", (command) => {
    expect(() => normalizeVerificationCommand(command)).toThrow(
      "Verification command must be one explicit shell command"
    );
  });
});
