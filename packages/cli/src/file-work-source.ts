import fs from "node:fs";
import path from "node:path";
import type { ExecutionBrief, WorkSource } from "@afk-geoff/core";
import { parseExecutionBriefMarkdown } from "@afk-geoff/shared";

export class MarkdownFileWorkSource implements WorkSource<string> {
  public constructor(private readonly cwd: string) {}

  public async load(inputPath: string): Promise<ExecutionBrief> {
    const briefPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(this.cwd, inputPath);

    if (!fs.existsSync(briefPath)) {
      throw new Error(`Execution brief not found: ${briefPath}`);
    }

    return parseExecutionBriefMarkdown(fs.readFileSync(briefPath, "utf8"));
  }
}

export function resolveBriefPath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}
