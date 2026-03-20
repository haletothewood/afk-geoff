import { describe, expect, it } from "vitest";
import { classifyWorkItems, evaluateNextStatus, summarizeRequirementStatus } from "./usecases.js";
import type { HydratedWorkItem } from "./domain.js";

function createItem(overrides: Partial<HydratedWorkItem>): HydratedWorkItem {
  return {
    id: "wi_1",
    requirementId: "req_1",
    title: "Item",
    body: "Body",
    type: "afk",
    status: "draft",
    planKey: "item",
    executionSummary: "Summary",
    acceptanceCriteria: [],
    dependencyIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("usecases", () => {
  it("promotes AFK items without open dependencies to todo", () => {
    const item = createItem({ status: "blocked" });
    const items = new Map([[item.id, item]]);

    expect(evaluateNextStatus(item, items)).toBe("todo");
  });

  it("keeps AFK items blocked while dependencies are incomplete", () => {
    const dependency = createItem({ id: "wi_dep", status: "in_progress" });
    const item = createItem({ dependencyIds: [dependency.id], status: "blocked" });
    const items = new Map([
      [dependency.id, dependency],
      [item.id, item]
    ]);

    expect(evaluateNextStatus(item, items)).toBe("blocked");
  });

  it("classifies runnable, blocked, and hitl queues", () => {
    const runnable = createItem({ id: "r", status: "todo" });
    const blocked = createItem({ id: "b", status: "blocked" });
    const hitl = createItem({ id: "h", type: "hitl", status: "hitl_pending" });
    const result = classifyWorkItems([runnable, blocked, hitl]);

    expect(result.runnable.map((item) => item.id)).toEqual(["r"]);
    expect(result.blocked.map((item) => item.id)).toEqual(["b"]);
    expect(result.hitl.map((item) => item.id)).toEqual(["h"]);
  });

  it("summarizes requirement status from work item states", () => {
    expect(summarizeRequirementStatus([])).toBe("captured");
    expect(summarizeRequirementStatus([createItem({ status: "draft" })])).toBe("planned");
    expect(summarizeRequirementStatus([createItem({ status: "done" })])).toBe("completed");
    expect(
      summarizeRequirementStatus([createItem({ status: "todo" }), createItem({ id: "other", status: "blocked" })])
    ).toBe("approved");
  });
});
