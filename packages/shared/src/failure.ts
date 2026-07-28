export { failureCategories } from "@afk-geoff/core";
export type { FailureCategory } from "@afk-geoff/core";
import type { FailureCategory } from "@afk-geoff/core";
export type VerificationFailureCategory = Extract<
  FailureCategory,
  "product" | "verification" | "environment"
>;

export function classifyVerificationFailure(input: {
  exitCode: number;
  stderr: string;
  errorCode?: string;
}): VerificationFailureCategory {
  const stderr = input.stderr.toLowerCase();
  const errorCode = input.errorCode?.toUpperCase();

  if (
    input.exitCode === 126 ||
    input.exitCode === 127 ||
    errorCode === "ENOENT" ||
    errorCode === "EACCES" ||
    /\bcommand not found\b|\bno such file or directory\b|\bpermission denied\b|\bmodule_not_found\b|\bcannot find module\b/.test(stderr)
  ) {
    return "environment";
  }

  if (
    /\bsyntax error\b|\bparse error\b|unexpected eof|unexpected end of file|unmatched (?:quote|['"`])|looking for matching/.test(stderr)
  ) {
    return "verification";
  }

  return "product";
}
