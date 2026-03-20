import crypto from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";
}

export function deriveTitle(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? value;
  const trimmed = firstLine.trim();

  if (trimmed.length <= 80) {
    return trimmed || "Untitled requirement";
  }

  return `${trimmed.slice(0, 77).trimEnd()}...`;
}
