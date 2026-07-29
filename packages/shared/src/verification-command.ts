import type { VerificationEntry, VerificationOrigin } from "@afk-geoff/core";

const MARKDOWN_ALTERNATIVE_PATTERN = /`[^`\n]+`\s+(?:or|and\/or)\s+`[^`\n]+`/i;

export type VerificationEntryInput = string | VerificationEntry;

export function normalizeVerificationCommands(commands: readonly string[]): string[] {
  return commands.map((command) => normalizeVerificationCommand(command));
}

export function normalizeVerificationEntries(entries: readonly VerificationEntryInput[]): VerificationEntry[] {
  return entries.map((entry) => ({
    command: normalizeVerificationCommand(typeof entry === "string" ? entry : entry.command),
    ...(typeof entry === "string" || !entry.origins ? {} : { origins: [...entry.origins] })
  }));
}

export function dedupeVerificationEntries(entries: readonly VerificationEntry[]): VerificationEntry[] {
  const deduplicated = new Map<string, VerificationEntry>();
  for (const entry of entries) {
    const existing = deduplicated.get(entry.command);
    if (!existing) {
      deduplicated.set(entry.command, {
        ...entry,
        ...(entry.origins ? { origins: [...entry.origins] } : {})
      });
      continue;
    }

    const origins = [...new Set([...(existing.origins ?? []), ...(entry.origins ?? [])])];
    if (origins.length > 0) {
      existing.origins = origins;
    }
  }
  return [...deduplicated.values()];
}

export function tagVerificationEntries(
  entries: readonly VerificationEntryInput[],
  origin: VerificationOrigin
): VerificationEntry[] {
  return normalizeVerificationEntries(entries).map((entry) => ({
    ...entry,
    origins: [...new Set([...(entry.origins ?? []), origin])]
  }));
}

export function verificationCommands(entries: readonly VerificationEntry[]): string[] {
  return entries.map((entry) => entry.command);
}

export function normalizeVerificationCommand(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Verification command must not be empty.");
  }

  if (MARKDOWN_ALTERNATIVE_PATTERN.test(trimmed)) {
    throw ambiguousVerificationCommandError(value);
  }

  const command = stripSingleMarkdownCodeSpan(trimmed);
  if (containsNaturalLanguageAlternative(command)) {
    throw ambiguousVerificationCommandError(value);
  }

  return command;
}

function stripSingleMarkdownCodeSpan(value: string): string {
  const match = value.match(/^`([^`\n]+)`$/);
  return match ? match[1]!.trim() : value;
}

function containsNaturalLanguageAlternative(command: string): boolean {
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let unquoted = "";

  for (const character of command) {
    if (escaped) {
      escaped = false;
      if (!quote) {
        unquoted += " ";
      }
      continue;
    }

    if (character === "\\") {
      escaped = true;
      if (!quote) {
        unquoted += " ";
      }
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      unquoted += " ";
      continue;
    }

    unquoted += character;
  }

  return /(?:^|\s)(?:or|and\/or)(?=\s|$)/i.test(unquoted);
}

function ambiguousVerificationCommandError(command: string): Error {
  return new Error(
    `Verification command must be one explicit shell command, not a natural-language alternative: ${JSON.stringify(command)}. ` +
    "Choose the command for this repository before starting the run."
  );
}
