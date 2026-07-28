import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ExternalRef, HydratedWorkItem, Requirement, RunRecord, WorkItem, WorkItemStatus } from "@afk-geoff/core";
import type { RequirementRepository, RunRepository, WorkItemRepository } from "@afk-geoff/core";
import { createId } from "@afk-geoff/shared";

type WorkItemDraftInput = Parameters<WorkItemRepository["createDraftWorkItems"]>[2][number];

interface SyncStateRecord {
  externalRefId: string;
  payload: unknown;
}

export class SqliteStateStore implements RequirementRepository, WorkItemRepository, RunRepository {
  private readonly db: Database.Database;

  public constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  public async createRequirement(requirement: Requirement): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO requirements (id, title, body, status, created_at, updated_at)
         VALUES (@id, @title, @body, @status, @created_at, @updated_at)`
      )
      .run(this.toDbRequirement(requirement));
  }

  public async updateRequirementStatus(id: string, status: Requirement["status"]): Promise<void> {
    this.db
      .prepare(`UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, timestamp(), id);
  }

  public async getRequirement(id: string): Promise<Requirement | undefined> {
    const row = this.db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(id) as DbRequirement | undefined;
    return row ? this.fromDbRequirement(row) : undefined;
  }

  public async listRequirements(): Promise<Requirement[]> {
    const rows = this.db.prepare(`SELECT * FROM requirements ORDER BY created_at ASC`).all() as DbRequirement[];
    return rows.map((row) => this.fromDbRequirement(row));
  }

  public async createDraftWorkItems(requirementId: string, summary: string, items: WorkItemDraftInput[]): Promise<HydratedWorkItem[]> {
    const existingNonDraft = this.db
      .prepare(`SELECT COUNT(*) as count FROM work_items WHERE requirement_id = ? AND status != 'draft'`)
      .get(requirementId) as { count: number };

    if (existingNonDraft.count > 0) {
      throw new Error(`Requirement ${requirementId} already has approved or completed work items.`);
    }

    this.db.prepare(`DELETE FROM work_item_dependencies WHERE work_item_id IN (SELECT id FROM work_items WHERE requirement_id = ?)`).run(requirementId);
    this.db.prepare(`DELETE FROM work_items WHERE requirement_id = ?`).run(requirementId);

    const inserted = new Map<string, HydratedWorkItem>();
    const insertWorkItem = this.db.prepare(
      `INSERT INTO work_items (
        id, requirement_id, title, body, type, status, plan_key, execution_summary, acceptance_criteria_json, created_at, updated_at
      ) VALUES (
        @id, @requirementId, @title, @body, @type, @status, @planKey, @executionSummary, @acceptanceCriteriaJson, @createdAt, @updatedAt
      )`
    );
    const insertDependency = this.db.prepare(
      `INSERT INTO work_item_dependencies (work_item_id, dependency_id) VALUES (?, ?)`
    );

    const now = timestamp();

    for (const item of items) {
      const id = createId("wi");
      const workItem: HydratedWorkItem = {
        id,
        requirementId,
        title: item.title,
        body: item.body,
        type: item.type,
        status: "draft",
        planKey: item.planKey,
        executionSummary: item.executionSummary ?? summary,
        acceptanceCriteria: [...item.acceptanceCriteria],
        dependencyIds: [],
        createdAt: now,
        updatedAt: now
      };

      insertWorkItem.run({
        id,
        requirementId,
        title: workItem.title,
        body: workItem.body,
        type: workItem.type,
        status: workItem.status,
        planKey: workItem.planKey,
        executionSummary: workItem.executionSummary,
        acceptanceCriteriaJson: JSON.stringify(workItem.acceptanceCriteria),
        createdAt: now,
        updatedAt: now
      });

      inserted.set(workItem.planKey, workItem);
    }

    for (const item of items) {
      const target = inserted.get(item.planKey);

      if (!target) {
        continue;
      }

      for (const dependencyPlanKey of item.dependencyPlanKeys) {
        const dependency = inserted.get(dependencyPlanKey);

        if (!dependency) {
          throw new Error(`Unknown dependency plan key ${dependencyPlanKey}`);
        }

        target.dependencyIds.push(dependency.id);
        insertDependency.run(target.id, dependency.id);
      }
    }

    return [...inserted.values()];
  }

  public async listWorkItems(): Promise<HydratedWorkItem[]> {
    return this.loadHydratedWorkItems();
  }

  public async listWorkItemsByRequirement(requirementId: string): Promise<HydratedWorkItem[]> {
    return this.loadHydratedWorkItems(requirementId);
  }

  public async getWorkItem(id: string): Promise<HydratedWorkItem | undefined> {
    const items = await this.loadHydratedWorkItems(undefined, id);
    return items[0];
  }

  public async updateWorkItemStatus(id: string, status: WorkItemStatus): Promise<void> {
    this.db.prepare(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?`).run(status, timestamp(), id);
  }

  public async updateWorkItemSummary(id: string, summary: string): Promise<void> {
    this.db.prepare(`UPDATE work_items SET execution_summary = ?, updated_at = ? WHERE id = ?`).run(summary, timestamp(), id);
  }

  public async createRun(run: RunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (
           id, work_item_id, mode, status, branch_name, worktree_path, run_dir, summary,
           terminal_failure_category, terminal_failure_message, created_at, updated_at
         )
         VALUES (
           @id, @work_item_id, @mode, @status, @branch_name, @worktree_path, @run_dir, @summary,
           @terminal_failure_category, @terminal_failure_message, @created_at, @updated_at
         )`
      )
      .run(this.toDbRun(run));
  }

  public async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as DbRun | undefined;

    if (!existing) {
      throw new Error(`Run ${id} not found`);
    }

    const merged: DbRun = {
      ...existing,
      work_item_id: patch.workItemId ?? existing.work_item_id,
      mode: patch.mode ?? existing.mode,
      status: patch.status ?? existing.status,
      branch_name: patch.branchName ?? existing.branch_name,
      worktree_path: patch.worktreePath ?? existing.worktree_path,
      run_dir: patch.runDir ?? existing.run_dir,
      summary: patch.summary ?? existing.summary,
      terminal_failure_category: patch.terminalFailure?.category
        ?? (patch.status && patch.status !== "failed" ? null : existing.terminal_failure_category),
      terminal_failure_message: patch.terminalFailure?.message
        ?? (patch.status && patch.status !== "failed" ? null : existing.terminal_failure_message),
      updated_at: timestamp()
    };

    this.db
      .prepare(
        `UPDATE runs
         SET work_item_id = @work_item_id, mode = @mode, status = @status, branch_name = @branch_name, worktree_path = @worktree_path,
             run_dir = @run_dir, summary = @summary, terminal_failure_category = @terminal_failure_category,
             terminal_failure_message = @terminal_failure_message, updated_at = @updated_at
         WHERE id = @id`
      )
      .run(merged);
  }

  public async listRuns(): Promise<RunRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as DbRun[];
    return rows.map((row) => this.fromDbRun(row));
  }

  public async listExternalRefs(entityType?: ExternalRef["entityType"], remoteType?: ExternalRef["remoteType"]): Promise<ExternalRef[]> {
    const clauses: string[] = [];
    const values: Array<string> = [];

    if (entityType) {
      clauses.push(`entity_type = ?`);
      values.push(entityType);
    }

    if (remoteType) {
      clauses.push(`remote_type = ?`);
      values.push(remoteType);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM external_refs ${where}`).all(...values) as DbExternalRef[];
    return rows.map((row) => this.fromDbExternalRef(row));
  }

  public async getExternalRefForEntity(entityType: ExternalRef["entityType"], entityId: string, remoteType: ExternalRef["remoteType"]): Promise<ExternalRef | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM external_refs WHERE entity_type = ? AND entity_id = ? AND remote_type = ?`)
      .get(entityType, entityId, remoteType) as DbExternalRef | undefined;
    return row ? this.fromDbExternalRef(row) : undefined;
  }

  public async saveExternalRef(ref: ExternalRef): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO external_refs (id, entity_type, entity_id, provider, remote_type, remote_number, remote_id, url, created_at, updated_at)
         VALUES (@id, @entity_type, @entity_id, @provider, @remote_type, @remote_number, @remote_id, @url, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           remote_number = excluded.remote_number,
           remote_id = excluded.remote_id,
           url = excluded.url,
           updated_at = excluded.updated_at`
      )
      .run(this.toDbExternalRef(ref));
  }

  public async getSyncState(externalRefId: string): Promise<unknown> {
    const row = this.db.prepare(`SELECT payload_json FROM sync_state WHERE external_ref_id = ?`).get(externalRefId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  public async saveSyncState(record: SyncStateRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sync_state (external_ref_id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(external_ref_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .run(record.externalRefId, JSON.stringify(record.payload), timestamp());
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_items (
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
        updated_at TEXT NOT NULL,
        FOREIGN KEY(requirement_id) REFERENCES requirements(id)
      );

      CREATE TABLE IF NOT EXISTS work_item_dependencies (
        work_item_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        PRIMARY KEY(work_item_id, dependency_id),
        FOREIGN KEY(work_item_id) REFERENCES work_items(id),
        FOREIGN KEY(dependency_id) REFERENCES work_items(id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        run_dir TEXT NOT NULL,
        summary TEXT,
        terminal_failure_category TEXT,
        terminal_failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(work_item_id) REFERENCES work_items(id)
      );

      CREATE TABLE IF NOT EXISTS external_refs (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        remote_type TEXT NOT NULL,
        remote_number INTEGER NOT NULL,
        remote_id TEXT,
        url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        external_ref_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("runs", "terminal_failure_category", "TEXT");
    this.ensureColumn("runs", "terminal_failure_message", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private loadHydratedWorkItems(requirementId?: string, workItemId?: string): HydratedWorkItem[] {
    const clauses: string[] = [];
    const values: Array<string> = [];

    if (requirementId) {
      clauses.push(`requirement_id = ?`);
      values.push(requirementId);
    }

    if (workItemId) {
      clauses.push(`id = ?`);
      values.push(workItemId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM work_items ${where} ORDER BY created_at ASC`).all(...values) as DbWorkItem[];
    const dependencyRows = this.db
      .prepare(
        `SELECT work_item_id, dependency_id FROM work_item_dependencies
         ${rows.length > 0 ? `WHERE work_item_id IN (${rows.map(() => "?").join(", ")})` : ""}`
      )
      .all(...rows.map((row) => row.id)) as Array<{ work_item_id: string; dependency_id: string }>;

    const dependencies = new Map<string, string[]>();

    for (const row of dependencyRows) {
      const current = dependencies.get(row.work_item_id) ?? [];
      current.push(row.dependency_id);
      dependencies.set(row.work_item_id, current);
    }

    return rows.map((row) => ({
      ...this.fromDbWorkItem(row),
      dependencyIds: dependencies.get(row.id) ?? []
    }));
  }

  private toDbRequirement(requirement: Requirement): DbRequirement {
    return {
      id: requirement.id,
      title: requirement.title,
      body: requirement.body,
      status: requirement.status,
      created_at: requirement.createdAt,
      updated_at: requirement.updatedAt
    };
  }

  private fromDbRequirement(row: DbRequirement): Requirement {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      status: row.status as Requirement["status"],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private fromDbWorkItem(row: DbWorkItem): WorkItem {
    return {
      id: row.id,
      requirementId: row.requirement_id,
      title: row.title,
      body: row.body,
      type: row.type as WorkItem["type"],
      status: row.status as WorkItem["status"],
      planKey: row.plan_key,
      executionSummary: row.execution_summary,
      acceptanceCriteria: JSON.parse(row.acceptance_criteria_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private toDbRun(run: RunRecord): DbRun {
    return {
      id: run.id,
      work_item_id: run.workItemId,
      mode: run.mode,
      status: run.status,
      branch_name: run.branchName ?? null,
      worktree_path: run.worktreePath ?? null,
      run_dir: run.runDir,
      summary: run.summary ?? null,
      terminal_failure_category: run.terminalFailure?.category ?? null,
      terminal_failure_message: run.terminalFailure?.message ?? null,
      created_at: run.createdAt,
      updated_at: run.updatedAt
    };
  }

  private fromDbRun(row: DbRun): RunRecord {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      mode: row.mode as RunRecord["mode"],
      status: row.status as RunRecord["status"],
      runDir: row.run_dir,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.branch_name ? { branchName: row.branch_name } : {}),
      ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.terminal_failure_category && row.terminal_failure_message
        ? {
            terminalFailure: {
              category: row.terminal_failure_category as NonNullable<RunRecord["terminalFailure"]>["category"],
              message: row.terminal_failure_message
            }
          }
        : {})
    };
  }

  private toDbExternalRef(ref: ExternalRef): DbExternalRef {
    return {
      id: ref.id,
      entity_type: ref.entityType,
      entity_id: ref.entityId,
      provider: ref.provider,
      remote_type: ref.remoteType,
      remote_number: ref.remoteNumber,
      remote_id: ref.remoteId ?? null,
      url: ref.url ?? null,
      created_at: ref.createdAt,
      updated_at: ref.updatedAt
    };
  }

  private fromDbExternalRef(row: DbExternalRef): ExternalRef {
    return {
      id: row.id,
      entityType: row.entity_type as ExternalRef["entityType"],
      entityId: row.entity_id,
      provider: row.provider as ExternalRef["provider"],
      remoteType: row.remote_type as ExternalRef["remoteType"],
      remoteNumber: row.remote_number,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.remote_id ? { remoteId: row.remote_id } : {}),
      ...(row.url ? { url: row.url } : {})
    };
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

interface DbRequirement {
  id: string;
  title: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DbWorkItem {
  id: string;
  requirement_id: string;
  title: string;
  body: string;
  type: string;
  status: string;
  plan_key: string;
  execution_summary: string;
  acceptance_criteria_json: string;
  created_at: string;
  updated_at: string;
}

interface DbRun {
  id: string;
  work_item_id: string;
  mode: string;
  status: string;
  branch_name: string | null;
  worktree_path: string | null;
  run_dir: string;
  summary: string | null;
  terminal_failure_category: string | null;
  terminal_failure_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DbExternalRef {
  id: string;
  entity_type: string;
  entity_id: string;
  provider: string;
  remote_type: string;
  remote_number: number;
  remote_id: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}
