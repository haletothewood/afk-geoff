import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackageManagerContract } from "./package-manager.js";

describe("resolvePackageManagerContract", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "afk-package-manager-"));
    directories.push(directory);
    return directory;
  }

  it("selects the package manager declared by metadata and its matching lockfile", () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }));
    fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(resolvePackageManagerContract(directory, ["pnpm test"])).toEqual({
      selected: "pnpm",
      declared: "pnpm",
      detectedLockfiles: [{ manager: "pnpm", filename: "pnpm-lock.yaml" }]
    });
  });

  it("rejects a secondary lockfile", () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(directory, "package-lock.json"), "{}");

    expect(() => resolvePackageManagerContract(directory)).toThrow(
      /Package manager conflict: .*package-lock\.json.*pnpm-lock\.yaml|Package manager conflict: .*pnpm-lock\.yaml.*package-lock\.json/
    );
  });

  it("rejects verification that uses a different package manager", () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, "yarn.lock"), "");

    expect(() => resolvePackageManagerContract(directory, ["npm test"])).toThrow(
      "repository selects yarn, but verification uses npm"
    );
  });
});
