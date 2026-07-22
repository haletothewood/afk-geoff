#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(dirname, "../src/index.ts");
const tsxLoader = pathToFileURL(path.resolve(dirname, "../node_modules/tsx/dist/loader.mjs")).href;
const result = spawnSync(process.execPath, ["--import", tsxLoader, entry, ...process.argv.slice(2)], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
