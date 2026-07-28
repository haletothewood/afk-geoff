import { describe, expect, it } from "vitest";
import { parseExecutionBriefMarkdown } from "./execution-brief.js";

const BASE_BRIEF = [
  "# AFK Execution Brief",
  "",
  "## Requirement",
  "Ship a narrow internal improvement.",
  "",
  "## Work Item Title",
  "Add a feature",
  "",
  "## Work Item Body",
  "Implement the feature.",
  "",
  "## Acceptance Criteria",
  "- Feature is implemented"
].join("\n");

describe("parseExecutionBriefMarkdown — execution mode fields", () => {
  it("parses an explicit Execution Mode section", () => {
    const brief = [
      BASE_BRIEF,
      "",
      "## Execution Mode",
      "pragmatic-shipper"
    ].join("\n");

    const result = parseExecutionBriefMarkdown(brief);
    expect(result.executionMode).toBe("pragmatic-shipper");
  });

  it("parses auto as the execution mode value", () => {
    const brief = [BASE_BRIEF, "", "## Execution Mode", "auto"].join("\n");
    const result = parseExecutionBriefMarkdown(brief);
    expect(result.executionMode).toBe("auto");
  });

  it("parses an Overlays section with a bullet list", () => {
    const brief = [
      BASE_BRIEF,
      "",
      "## Overlays",
      "- security-gatekeeper",
      "- performance-tuner"
    ].join("\n");

    const result = parseExecutionBriefMarkdown(brief);
    expect(result.overlays).toEqual(["security-gatekeeper", "performance-tuner"]);
  });

  it("parses an auto overlay", () => {
    const brief = [BASE_BRIEF, "", "## Overlays", "- auto"].join("\n");
    const result = parseExecutionBriefMarkdown(brief);
    expect(result.overlays).toEqual(["auto"]);
  });

  it("parses a Risk section", () => {
    const brief = [BASE_BRIEF, "", "## Risk", "low"].join("\n");
    const result = parseExecutionBriefMarkdown(brief);
    expect(result.risk).toBe("low");
  });

  it("omits executionMode when the section is absent", () => {
    const result = parseExecutionBriefMarkdown(BASE_BRIEF);
    expect(result.executionMode).toBeUndefined();
  });

  it("omits overlays when the section is absent", () => {
    const result = parseExecutionBriefMarkdown(BASE_BRIEF);
    expect(result.overlays).toBeUndefined();
  });

  it("omits risk when the section is absent", () => {
    const result = parseExecutionBriefMarkdown(BASE_BRIEF);
    expect(result.risk).toBeUndefined();
  });

  it("parses all three optional sections together", () => {
    const brief = [
      BASE_BRIEF,
      "",
      "## Execution Mode",
      "incident-responder",
      "",
      "## Overlays",
      "- security-gatekeeper",
      "",
      "## Risk",
      "high"
    ].join("\n");

    const result = parseExecutionBriefMarkdown(brief);
    expect(result.executionMode).toBe("incident-responder");
    expect(result.overlays).toEqual(["security-gatekeeper"]);
    expect(result.risk).toBe("high");
  });

  it("strips Markdown code formatting from verification commands", () => {
    const brief = [
      BASE_BRIEF,
      "",
      "## Verification",
      "- `pnpm exec vitest --run app/admin/invites/__tests__/bulkInvites.test.ts`",
      "- `pnpm run typecheck`"
    ].join("\n");

    const result = parseExecutionBriefMarkdown(brief);
    expect(result.verification).toEqual([
      { command: "pnpm exec vitest --run app/admin/invites/__tests__/bulkInvites.test.ts" },
      { command: "pnpm run typecheck" }
    ]);
  });

  it("rejects natural-language alternatives instead of treating them as a shell command", () => {
    const brief = [
      BASE_BRIEF,
      "",
      "## Verification",
      "- `npm install` or `pnpm install`"
    ].join("\n");

    expect(() => parseExecutionBriefMarkdown(brief)).toThrow(
      "Verification command must be one explicit shell command"
    );
  });
});
