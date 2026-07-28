import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDistDir = path.join(rootDir, "packages", "cli", "dist");
const bundleDir = path.join(cliDistDir, "bundle");
const templateDir = path.join(cliDistDir, "templates");

const workspaceAliases = new Map([
  ["@afk-geoff/adapter-github", "packages/adapter-github/dist/index.js"],
  ["@afk-geoff/adapter-local-git", "packages/adapter-local-git/dist/index.js"],
  ["@afk-geoff/adapter-sqlite", "packages/adapter-sqlite/dist/index.js"],
  ["@afk-geoff/core", "packages/core/dist/index.js"],
  ["@afk-geoff/runner-claude", "packages/runner-claude/dist/index.js"],
  ["@afk-geoff/runner-codex", "packages/runner-codex/dist/index.js"],
  ["@afk-geoff/runtime-docker", "packages/runtime-docker/dist/index.js"],
  ["@afk-geoff/shared", "packages/shared/dist/index.js"]
]);

const workspaceAliasPlugin = {
  name: "workspace-package-aliases",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@afk-geoff\// }, (args) => {
      const alias = workspaceAliases.get(args.path);
      if (!alias) {
        return undefined;
      }

      return { path: path.join(rootDir, alias) };
    });
  }
};

fs.rmSync(bundleDir, { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(templateDir, { recursive: true });
fs.copyFileSync(
  path.join(rootDir, "packages", "shared", "src", "templates", "default.Dockerfile"),
  path.join(templateDir, "default.Dockerfile")
);
fs.copyFileSync(
  path.join(rootDir, "packages", "shared", "src", "templates", "afk-run.workflow.yml"),
  path.join(templateDir, "afk-run.workflow.yml")
);

await build({
  entryPoints: [path.join(cliDistDir, "index.js")],
  outfile: path.join(bundleDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["better-sqlite3"],
  banner: {
    js: "import { createRequire as __afkCreateRequire } from 'node:module';\nconst require = __afkCreateRequire(import.meta.url);"
  },
  plugins: [workspaceAliasPlugin]
});

fs.writeFileSync(
  path.join(bundleDir, "index.d.ts"),
  [
    "export interface CliDependencies {",
    "  githubFactory?: (token: string) => unknown;",
    "  githubIssueWorkSourceFactory?: (token: string) => unknown;",
    "  githubTokenResolver?: () => Promise<string | undefined>;",
    "  detachLauncher?: (argv: string[], env: Record<string, string | undefined>, cwd: string) => { pid: number };",
    "  watchPollIntervalMs?: number;",
    "  onAfterPoll?: () => Promise<void>;",
    "  gitRemoteChecker?: (repoRoot: string) => Promise<void>;",
    "  githubAuthVerifier?: (token: string, remote: { owner: string; repo: string }) => Promise<void>;",
    "  backendOverride?: \"local-docker\" | \"local-process\";",
    "}",
    "export declare function runCli(argv?: string[], dependencies?: CliDependencies): Promise<void>;",
    ""
  ].join("\n")
);
