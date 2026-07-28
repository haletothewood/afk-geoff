#!/usr/bin/env node
import { runCli } from "../dist/bundle/index.js";

process.env.AFK_CWD = process.cwd();

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
