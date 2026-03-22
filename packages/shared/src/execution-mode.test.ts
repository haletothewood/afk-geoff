import { describe, expect, it } from "vitest";
import {
  inferPrimaryMode,
  inferOverlays,
  inferRisk,
  resolveExecutionMode,
  formatExecutionModeSection,
  PRIMARY_EXECUTION_MODES,
  EXECUTION_OVERLAYS,
  type PrimaryExecutionMode,
  type ExecutionOverlay
} from "./execution-mode.js";

// ---------------------------------------------------------------------------
// inferPrimaryMode
// ---------------------------------------------------------------------------

describe("inferPrimaryMode", () => {
  it("infers incident-responder for incident content", () => {
    const result = inferPrimaryMode("production is down, rolling back the deployment immediately");
    expect(result.mode).toBe("incident-responder");
    expect(result.rationale).toContain("incident");
  });

  it("infers incident-responder for outage keyword", () => {
    expect(inferPrimaryMode("The service is experiencing an outage").mode).toBe("incident-responder");
  });

  it("infers incident-responder for P0/P1 keywords", () => {
    expect(inferPrimaryMode("P0: all requests returning 500").mode).toBe("incident-responder");
  });

  it("infers debug-investigator for debug content", () => {
    const result = inferPrimaryMode("Investigate why the cache occasionally returns stale data");
    expect(result.mode).toBe("debug-investigator");
    expect(result.rationale).toContain("debug");
  });

  it("infers debug-investigator for root-cause content", () => {
    expect(inferPrimaryMode("Find the root cause of the intermittent 504s").mode).toBe("debug-investigator");
  });

  it("infers refactoring-surgeon for refactor content", () => {
    const result = inferPrimaryMode("Refactor the payment module to use the new abstraction");
    expect(result.mode).toBe("refactoring-surgeon");
  });

  it("infers refactoring-surgeon for restructure content", () => {
    expect(inferPrimaryMode("Restructure the auth module and move files to the new layout").mode).toBe("refactoring-surgeon");
  });

  it("infers legacy-stabiliser for legacy content", () => {
    const result = inferPrimaryMode("Stabilise the legacy billing system during the migration from the old payment provider");
    expect(result.mode).toBe("legacy-stabiliser");
  });

  it("infers brownfield-moderniser for modernise content", () => {
    const result = inferPrimaryMode("Modernise the data layer to use the new ORM incrementally");
    expect(result.mode).toBe("brownfield-moderniser");
  });

  it("infers experiment-runner for spike content", () => {
    const result = inferPrimaryMode("Spike: explore whether we can adopt the new streaming API");
    expect(result.mode).toBe("experiment-runner");
  });

  it("infers experiment-runner for prototype keyword", () => {
    expect(inferPrimaryMode("Build a prototype of the new recommendation engine").mode).toBe("experiment-runner");
  });

  it("infers production-hardener for reliability content", () => {
    const result = inferPrimaryMode("Improve the reliability of the payment service with retry logic and circuit breakers");
    expect(result.mode).toBe("production-hardener");
  });

  it("does not infer incident-responder from markdown text containing 'down' as a substring", () => {
    const result = inferPrimaryMode("Update markdown rendering in docs");
    expect(result.mode).not.toBe("incident-responder");
  });

  it("does not infer incident-responder from dropdown text containing 'down' as a substring", () => {
    const result = inferPrimaryMode("Improve dropdown keyboard navigation");
    expect(result.mode).not.toBe("incident-responder");
  });

  it("defaults to pragmatic-shipper when no indicators present", () => {
    const result = inferPrimaryMode("Add a user preferences page with name and email fields");
    expect(result.mode).toBe("pragmatic-shipper");
    expect(result.rationale).toContain("default");
  });
});

// ---------------------------------------------------------------------------
// inferOverlays
// ---------------------------------------------------------------------------

describe("inferOverlays", () => {
  it("infers security-gatekeeper for security content", () => {
    const overlays = inferOverlays("Update the authentication flow to support OAuth 2.0 and fix a potential CSRF vulnerability");
    expect(overlays).toContain("security-gatekeeper");
  });

  it("infers performance-tuner for performance content", () => {
    const overlays = inferOverlays("Optimise the search query to reduce latency on the listings page");
    expect(overlays).toContain("performance-tuner");
  });

  it("infers accessibility-advocate for a11y content", () => {
    const overlays = inferOverlays("Improve the accessibility of the checkout form; it needs WCAG 2.1 AA compliance");
    expect(overlays).toContain("accessibility-advocate");
  });

  it("returns multiple overlays when multiple signals present", () => {
    const overlays = inferOverlays("Optimise and secure the login page; ensure WCAG AA accessibility");
    expect(overlays).toContain("performance-tuner");
    expect(overlays).toContain("security-gatekeeper");
    expect(overlays).toContain("accessibility-advocate");
  });

  it("returns empty array for unrelated content", () => {
    const overlays = inferOverlays("Add a new settings page for notification preferences");
    expect(overlays).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// inferRisk
// ---------------------------------------------------------------------------

describe("inferRisk", () => {
  it("returns high for incident-responder", () => {
    expect(inferRisk("incident-responder", [])).toBe("high");
  });

  it("returns high for experiment-runner", () => {
    expect(inferRisk("experiment-runner", [])).toBe("high");
  });

  it("returns low for debug-investigator", () => {
    expect(inferRisk("debug-investigator", [])).toBe("low");
  });

  it("returns low for refactoring-surgeon", () => {
    expect(inferRisk("refactoring-surgeon", [])).toBe("low");
  });

  it("returns low for legacy-stabiliser", () => {
    expect(inferRisk("legacy-stabiliser", [])).toBe("low");
  });

  it("returns low for production-hardener", () => {
    expect(inferRisk("production-hardener", [])).toBe("low");
  });

  it("returns low when security-gatekeeper overlay is active", () => {
    expect(inferRisk("pragmatic-shipper", ["security-gatekeeper"])).toBe("low");
  });

  it("returns medium for pragmatic-shipper with no special overlays", () => {
    expect(inferRisk("pragmatic-shipper", [])).toBe("medium");
  });

  it("returns medium for brownfield-moderniser", () => {
    expect(inferRisk("brownfield-moderniser", [])).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// resolveExecutionMode — explicit config
// ---------------------------------------------------------------------------

describe("resolveExecutionMode — explicit config", () => {
  it("uses explicit primary mode when set", () => {
    const result = resolveExecutionMode("Add a user preferences page", {
      executionMode: "pragmatic-shipper"
    });
    expect(result.primaryMode).toBe("pragmatic-shipper");
    expect(result.source).toBe("explicit");
  });

  it("uses explicit primary mode case-insensitively", () => {
    const result = resolveExecutionMode("Add a user preferences page", {
      executionMode: "Pragmatic-Shipper"
    });
    expect(result.primaryMode).toBe("pragmatic-shipper");
    expect(result.source).toBe("explicit");
  });

  it("falls back to inference when explicit mode is unrecognised", () => {
    const result = resolveExecutionMode("investigate the root cause of the crash", {
      executionMode: "unknown-mode"
    });
    expect(result.primaryMode).toBe("debug-investigator");
    expect(result.source).toBe("inferred");
  });

  it("uses explicit overlay list when set", () => {
    const result = resolveExecutionMode("Add a new feature", {
      overlays: ["security-gatekeeper"]
    });
    expect(result.overlays).toEqual(["security-gatekeeper"]);
  });

  it("uses explicit risk when set", () => {
    const result = resolveExecutionMode("Refactor the auth module", {
      risk: "high"
    });
    expect(result.risk).toBe("high");
  });

  it("caps overlays at two even when config provides more", () => {
    const result = resolveExecutionMode("Add a feature", {
      overlays: ["security-gatekeeper", "performance-tuner", "accessibility-advocate"]
    });
    expect(result.overlays).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resolveExecutionMode — auto / inference
// ---------------------------------------------------------------------------

describe("resolveExecutionMode — auto inference", () => {
  it("infers from content when executionMode is auto", () => {
    const result = resolveExecutionMode("production is down, P0 incident", {
      executionMode: "auto"
    });
    expect(result.primaryMode).toBe("incident-responder");
    expect(result.source).toBe("inferred");
  });

  it("infers when no config is provided", () => {
    const result = resolveExecutionMode("Spike: explore the new streaming API");
    expect(result.primaryMode).toBe("experiment-runner");
    expect(result.source).toBe("inferred");
  });

  it("infers overlays when overlays is ['auto']", () => {
    const result = resolveExecutionMode("Improve security with better auth and fix CSRF", {
      overlays: ["auto"]
    });
    expect(result.overlays).toContain("security-gatekeeper");
  });

  it("infers risk when risk is auto", () => {
    const result = resolveExecutionMode("Refactor the module", {
      risk: "auto"
    });
    expect(result.risk).toBe("low"); // refactoring-surgeon -> low
  });
});

// ---------------------------------------------------------------------------
// resolveExecutionMode — precedence
// ---------------------------------------------------------------------------

describe("resolveExecutionMode — precedence", () => {
  it("explicit mode overrides inference", () => {
    // Content would infer debug-investigator but explicit config says pragmatic-shipper
    const result = resolveExecutionMode("investigate and debug the crash", {
      executionMode: "pragmatic-shipper"
    });
    expect(result.primaryMode).toBe("pragmatic-shipper");
    expect(result.source).toBe("explicit");
  });

  it("explicit overlays override inferred overlays", () => {
    // Content would infer security overlay, but config explicitly sets performance only
    const result = resolveExecutionMode("secure the authentication endpoint", {
      overlays: ["performance-tuner"]
    });
    expect(result.overlays).toEqual(["performance-tuner"]);
    expect(result.overlays).not.toContain("security-gatekeeper");
  });

  it("explicit risk overrides inferred risk", () => {
    // incident-responder would infer high, but explicit says low
    const result = resolveExecutionMode("production is down", {
      risk: "low"
    });
    expect(result.risk).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// formatExecutionModeSection
// ---------------------------------------------------------------------------

describe("formatExecutionModeSection", () => {
  it("includes mode label, overlays, risk, and rationale", () => {
    const resolved = resolveExecutionMode("Add a user preferences page");
    const section = formatExecutionModeSection(resolved);
    expect(section).toContain("# Execution Mode");
    expect(section).toContain("**Mode:**");
    expect(section).toContain("**Overlays:**");
    expect(section).toContain("**Risk Tolerance:**");
    expect(section).toContain("**Rationale:**");
  });

  it("includes posture bullets for the mode", () => {
    const resolved = resolveExecutionMode("production is down", { executionMode: "incident-responder" });
    const section = formatExecutionModeSection(resolved);
    expect(section).toContain("## Posture for this mode");
    expect(section).toContain("Restore service first");
  });

  it("includes overlay postures when overlays are active", () => {
    const resolved = resolveExecutionMode("secure the auth flow", {
      overlays: ["security-gatekeeper"]
    });
    const section = formatExecutionModeSection(resolved);
    expect(section).toContain("## Active overlays");
    expect(section).toContain("security review");
  });

  it("does not include overlay section when no overlays are active", () => {
    const resolved = resolveExecutionMode("Add a user preferences page", { overlays: [] });
    const section = formatExecutionModeSection(resolved);
    expect(section).not.toContain("## Active overlays");
  });
});

// ---------------------------------------------------------------------------
// Constant coverage
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports all eight primary modes", () => {
    expect(PRIMARY_EXECUTION_MODES).toHaveLength(8);
  });

  it("exports all three overlays", () => {
    expect(EXECUTION_OVERLAYS).toHaveLength(3);
  });
});
