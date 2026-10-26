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
  it("canonicalizes legacy duplicate PR references when publication is saved again", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-sqlite-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "state.db");
    const store = new SqliteStateStore(dbPath);
    const ref = {
      id: "xref_original", entityType: "work_item" as const, entityId: "wi_retry",
      provider: "github" as const, remoteType: "pull_request" as const,
      remoteNumber: 56, remoteId: "1056", url: "https://github.com/acme/demo/pull/56",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    };
    await store.saveExternalRef(ref);
    // Reproduce rows persisted by the old append-by-local-id behavior.
    const legacyDb = new Database(dbPath);
    try {
      legacyDb.exec(`
        INSERT INTO external_refs SELECT 'xref_duplicate', entity_type, entity_id, provider,
          remote_type, 57, '1057', 'https://github.com/acme/demo/pull/57', '2026-01-02T00:00:00.000Z', updated_at
          FROM external_refs WHERE id = 'xref_original';
      `);
      await store.saveSyncState({ externalRefId: "xref_duplicate", payload: { open: false } });
      const published = { ...ref, id: "xref_retry", remoteNumber: 57, remoteId: "1057",
        url: "https://github.com/acme/demo/pull/57", updatedAt: "2026-01-02T00:00:00.000Z" };
      await store.saveExternalRef(published);
      await store.saveExternalRef({ ...published, id: "xref_another_retry" });
      expect(await store.getExternalRefForEntity("work_item", "wi_retry", "pull_request"))
        .toEqual({ ...published, id: "xref_original" });
      expect(await store.getSyncState("xref_duplicate")).toBeUndefined();
      expect(await store.listExternalRefs("work_item", "pull_request")).toHaveLength(1);
    } finally {
      legacyDb.close();
    }
  });
});
