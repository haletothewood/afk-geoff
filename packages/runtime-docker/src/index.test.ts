import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeEntrypoint, dockerfileFingerprint } from "./index.js";

describe("runtime docker helpers", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const tempPath of tempPaths) {
      fs.rmSync(tempPath, { force: true });
    }
  });

  it("uses corepack-backed package manager bootstrap before executing the worker command", () => {
    const script = buildRuntimeEntrypoint("claude", ["--print", "/afk-run/prompt.md"]);

    expect(script).toContain("corepack pnpm install --frozen-lockfile");
    expect(script).toContain("corepack yarn install --frozen-lockfile");
    expect(script).toContain("npm ci");
    expect(script).toContain("exec 'claude' '--print' '/afk-run/prompt.md'");
  });

  it("hashes dockerfile contents for image rebuild detection", () => {
    const dockerfilePath = path.join(os.tmpdir(), `afk-dockerfile-${Date.now()}.Dockerfile`);
    tempPaths.push(dockerfilePath);

    fs.writeFileSync(dockerfilePath, "FROM node:22-bookworm\n");
    const first = dockerfileFingerprint(dockerfilePath);
    fs.writeFileSync(dockerfilePath, "FROM node:22-bookworm\nRUN corepack enable\n");
    const second = dockerfileFingerprint(dockerfilePath);

    expect(first).not.toBe(second);
  });
});
