import type { ExecutionBrief } from "@afk-geoff/core";

export function parseExecutionBriefMarkdown(source: string): ExecutionBrief {
  const sections = parseMarkdownSections(source);
  const requirementBody = getRequiredSection(sections, "Requirement");
  const workItemTitle = getRequiredSection(sections, "Work Item Title");
  const workItemBody = getRequiredSection(sections, "Work Item Body");
  const acceptanceCriteria = parseBulletList(getRequiredSection(sections, "Acceptance Criteria"));
  const verification = sections.get("verification")
    ? parseBulletList(sections.get("verification") ?? "", { stripMarkdownCode: true })
    : [];
  const issueUrl = sections.get("github issue");

  // Optional execution-control fields
  const executionModeRaw = sections.get("execution mode");
  const overlaysRaw = sections.get("overlays");
  const riskRaw = sections.get("risk");

  const executionMode = executionModeRaw ? executionModeRaw.trim() : undefined;
  const overlays = overlaysRaw ? parseBulletList(overlaysRaw) : undefined;
  const risk = riskRaw ? riskRaw.trim() : undefined;

  if (acceptanceCriteria.length === 0) {
    throw new Error("Execution brief must include at least one acceptance criterion.");
  }

  return {
    requirementBody,
    workItemTitle,
    workItemBody,
    acceptanceCriteria,
    verification,
    ...(issueUrl ? { issueUrl } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(overlays && overlays.length > 0 ? { overlays } : {}),
    ...(risk ? { risk } : {})
  };
}

function parseMarkdownSections(source: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = source.split("\n");
  let currentHeading: string | undefined;
  let currentBody: string[] = [];

  const flush = (): void => {
    if (!currentHeading) {
      return;
    }

    const body = currentBody.join("\n").trim();
    if (body) {
      sections.set(currentHeading, body);
    }
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentHeading = line.slice(3).trim().toLowerCase();
      currentBody = [];
      continue;
    }

    if (currentHeading) {
      currentBody.push(line);
    }
  }

  flush();
  return sections;
}

function getRequiredSection(sections: Map<string, string>, heading: string): string {
  const value = sections.get(heading.toLowerCase());

  if (!value) {
    throw new Error(`Execution brief is missing required section: ${heading}`);
  }

  return value;
}

function parseBulletList(source: string, options: { stripMarkdownCode?: boolean } = {}): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .map((line) => options.stripMarkdownCode ? stripMarkdownCodeFence(line) : line)
    .filter(Boolean);
}

function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
