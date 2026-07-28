import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("npm publish workflow", () => {
  it("publishes version tags through trusted publishing after the release gates pass", () => {
    const workflowPath = path.join(repoRoot, ".github", "workflows", "publish-npm.yml");
    const workflow = parse(fs.readFileSync(workflowPath, "utf8")) as {
      on: { push: { tags: string[] } };
      permissions: Record<string, string>;
      jobs: {
        publish: {
          steps: Array<{ name?: string; run?: string }>;
        };
      };
    };

    expect(workflow.on.push.tags).toEqual(["v*"]);
    expect(workflow.permissions).toEqual({
      contents: "read",
      "id-token": "write"
    });

    const commands = workflow.jobs.publish.steps
      .map((step) => step.run)
      .filter((command): command is string => command !== undefined)
      .join("\n");

    expect(commands).toContain("git merge-base --is-ancestor");
    expect(commands).toContain("package_version");
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands).toContain("pnpm typecheck");
    expect(commands).toContain("pnpm build");
    expect(commands).toContain("pnpm test");
    expect(commands).toContain("pnpm test:package");
    expect(commands).toContain("npm publish --access public");
    expect(commands).not.toContain("NPM_TOKEN");

    expect(commands.indexOf("pnpm build")).toBeLessThan(commands.indexOf("pnpm test"));
  });

  it("declares the repository required by npm provenance", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8")
    ) as { repository?: { type?: string; url?: string } };

    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/haletothewood/afk-geoff.git"
    });
  });
});
