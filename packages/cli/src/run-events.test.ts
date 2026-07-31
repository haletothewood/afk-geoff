import { afterEach, describe, expect, it, vi } from "vitest";
import { emitRunEvent, withRunEvents } from "./run-events.js";

describe("run event emission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs a schema-valid versioned event before writing NDJSON", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await withRunEvents(async () => {
      emitRunEvent({ event: "run_requested", target: "file", value: "brief.md" });
    });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(expect.objectContaining({
      kind: "run_event",
      schemaVersion: 1,
      event: "run_requested",
      target: "file",
      value: "brief.md",
      timestamp: expect.any(String)
    }));
  });
});
