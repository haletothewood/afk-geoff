const MARKDOWN_ALTERNATIVE_PATTERN = /`[^`\n]+`\s+(?:or|and\/or)\s+`[^`\n]+`/i;

export function normalizeVerificationCommands(commands: readonly string[]): string[] {
  return commands.map((command) => normalizeVerificationCommand(command));
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
