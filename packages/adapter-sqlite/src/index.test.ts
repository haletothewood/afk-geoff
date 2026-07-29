import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "./index.js";

describe("SqliteStateStore migrations", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads legacy work items that predate persisted brief verification", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-sqlite-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "state.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_key TEXT NOT NULL,
        execution_summary TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO work_items VALUES (
        'wi_legacy',
        'req_legacy',
        'Legacy item',
        'Existing AFK work',
        'afk',
        'done',
        'legacy-item',
        'Imported before brief verification persistence',
        '[]',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
    `);
    legacyDb.close();

    const store = new SqliteStateStore(dbPath);
    const workItem = await store.getWorkItem("wi_legacy");

    expect(workItem?.id).toBe("wi_legacy");
    expect(workItem?.briefVerification).toBeUndefined();
  });
});
