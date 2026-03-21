function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return raw;
  }

  const lines = trimmed.split("\n");
  if (lines.length < 3) {
    return raw;
  }

  return lines.slice(1, -1).join("\n");
}

function extractJsonEnvelope(raw: string): string {
  const firstObject = raw.indexOf("{");
  const lastObject = raw.lastIndexOf("}");

  if (firstObject !== -1 && lastObject > firstObject) {
    return raw.slice(firstObject, lastObject + 1);
  }

  const firstArray = raw.indexOf("[");
  const lastArray = raw.lastIndexOf("]");

  if (firstArray !== -1 && lastArray > firstArray) {
    return raw.slice(firstArray, lastArray + 1);
  }

  return raw;
}

function nextNonWhitespace(raw: string, startIndex: number): string | undefined {
  for (let index = startIndex; index < raw.length; index += 1) {
    const value = raw[index];
    if (value && !/\s/.test(value)) {
      return value;
    }
  }

  return undefined;
}

function repairCommonJsonMistakes(raw: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];

    if (!inString) {
      if (value === "\"") {
        inString = true;
      }
      repaired += value;
      continue;
    }

    if (escaped) {
      repaired += value;
      escaped = false;
      continue;
    }

    if (value === "\\") {
      repaired += value;
      escaped = true;
      continue;
    }

    if (value === "\"") {
      const next = nextNonWhitespace(raw, index + 1);
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        repaired += value;
      } else {
        repaired += "\\\"";
      }
      continue;
    }

    if (value === "\n") {
      repaired += "\\n";
      continue;
    }

    if (value === "\r") {
      repaired += "\\r";
      continue;
    }

    if (value === "\t") {
      repaired += "\\t";
      continue;
    }

    repaired += value;
  }

  return repaired;
}

export function parseJsonWithRecovery(raw: string): unknown {
  const normalized = raw.replace(/^\uFEFF/, "");
  const candidates = Array.from(
    new Set([
      normalized,
      stripCodeFence(normalized),
      extractJsonEnvelope(normalized),
      extractJsonEnvelope(stripCodeFence(normalized))
    ])
  );
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(repairCommonJsonMistakes(candidate));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to parse JSON");
}
