import { describe, expect, it } from "vitest";
import { classifyVerificationFailure } from "./failure.js";

describe("classifyVerificationFailure", () => {
  it("classifies unavailable commands as environment failures", () => {
    expect(
      classifyVerificationFailure({
        exitCode: 127,
        stderr: "bash: afk-tool-that-does-not-exist: command not found"
      })
    ).toBe("environment");
  });

  it("classifies malformed shell syntax as a verification-contract failure", () => {
    expect(
      classifyVerificationFailure({
        exitCode: 2,
        stderr: "bash: unexpected EOF while looking for matching `\"'"
      })
    ).toBe("verification");
  });

  it("classifies an ordinary failing check as a product failure", () => {
    expect(
      classifyVerificationFailure({
        exitCode: 1,
        stderr: "Expected true but received false"
      })
    ).toBe("product");
  });
});
