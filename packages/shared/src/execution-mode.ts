// ---------------------------------------------------------------------------
// Execution mode types
// ---------------------------------------------------------------------------

export type PrimaryExecutionMode =
  | "brownfield-moderniser"
  | "legacy-stabiliser"
  | "refactoring-surgeon"
  | "pragmatic-shipper"
  | "experiment-runner"
  | "production-hardener"
  | "incident-responder"
  | "debug-investigator";

export const PRIMARY_EXECUTION_MODES: PrimaryExecutionMode[] = [
  "brownfield-moderniser",
  "legacy-stabiliser",
  "refactoring-surgeon",
  "pragmatic-shipper",
  "experiment-runner",
  "production-hardener",
  "incident-responder",
  "debug-investigator"
];

export type ExecutionOverlay = "security-gatekeeper" | "performance-tuner" | "accessibility-advocate";

export const EXECUTION_OVERLAYS: ExecutionOverlay[] = [
  "security-gatekeeper",
  "performance-tuner",
  "accessibility-advocate"
];

export type RiskTolerance = "low" | "medium" | "high";

export interface ResolvedExecutionMode {
  primaryMode: PrimaryExecutionMode;
  overlays: ExecutionOverlay[];
  risk: RiskTolerance;
  rationale: string;
  /** How the mode was determined. */
  source: "explicit" | "inferred";
}

export interface ExecutionModeConfig {
  /** A PrimaryExecutionMode value, "auto" (infer from content), or undefined (same as "auto"). */
  executionMode?: string;
  /** An array of ExecutionOverlay values, or ["auto"] to infer from content, or undefined. */
  overlays?: string[];
  /** A RiskTolerance value, "auto" (infer), or undefined (same as "auto"). */
  risk?: string;
}

// ---------------------------------------------------------------------------
// Human-readable mode labels and posture descriptions
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<PrimaryExecutionMode, string> = {
  "brownfield-moderniser": "Brownfield Moderniser",
  "legacy-stabiliser": "Legacy Stabiliser",
  "refactoring-surgeon": "Refactoring Surgeon",
  "pragmatic-shipper": "Pragmatic Shipper",
  "experiment-runner": "Experiment Runner",
  "production-hardener": "Production Hardener",
  "incident-responder": "Incident Responder",
  "debug-investigator": "Debug Investigator"
};

const OVERLAY_LABELS: Record<ExecutionOverlay, string> = {
  "security-gatekeeper": "Security Gatekeeper",
  "performance-tuner": "Performance Tuner",
  "accessibility-advocate": "Accessibility Advocate"
};

const MODE_POSTURES: Record<PrimaryExecutionMode, string[]> = {
  "brownfield-moderniser": [
    "Introduce improvements incrementally; preserve the existing contract for callers.",
    "Prefer small, reversible changes over large rewrites.",
    "Leave the codebase in a cleaner state than you found it, but do not over-engineer."
  ],
  "legacy-stabiliser": [
    "Minimise blast radius; prefer additive changes over modifications.",
    "Wrap rather than replace; keep existing behaviour intact unless the brief explicitly requires a change.",
    "Add regression tests before touching fragile areas."
  ],
  "refactoring-surgeon": [
    "Change structure without changing observable behaviour.",
    "Ensure every renamed symbol, moved file, and extracted abstraction is reflected in all call-sites.",
    "Run the full verification suite before marking done."
  ],
  "pragmatic-shipper": [
    "Prioritise shipping working code that meets the acceptance criteria.",
    "Prefer proven, direct solutions over clever abstractions.",
    "Accept minor imperfections if they do not block the acceptance criteria."
  ],
  "experiment-runner": [
    "Timebox exploration; stop when you have enough signal to answer the question.",
    "Document findings and assumptions explicitly in your output.",
    "Prefer throwaway scaffolding over production-quality polish for prototype code."
  ],
  "production-hardener": [
    "Treat correctness, observability, and failure handling as first-class concerns.",
    "Add or strengthen error paths, logging, and graceful degradation.",
    "Do not sacrifice reliability for delivery speed."
  ],
  "incident-responder": [
    "Restore service first; leave a clean explanation of what you changed and why.",
    "Keep each change minimal and clearly scoped to the incident.",
    "Document the root cause and mitigation in your result summary."
  ],
  "debug-investigator": [
    "Reproduce the problem before proposing a fix.",
    "Trace the failure path from symptom to root cause; document your reasoning.",
    "Prefer targeted fixes over speculative refactors."
  ]
};

const OVERLAY_POSTURES: Record<ExecutionOverlay, string> = {
  "security-gatekeeper": "Apply security review to all changes: check for injection risks, auth gaps, and secrets exposure.",
  "performance-tuner": "Profile before optimising; measure the impact of every performance-affecting change.",
  "accessibility-advocate": "Validate WCAG compliance for any UI changes; include keyboard navigation and screen-reader support."
};

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

function normalise(text: string): string {
  return text.toLowerCase();
}

function contains(text: string, terms: string[]): boolean {
  const n = normalise(text);
  return terms.some((term) => n.includes(term));
}

/**
 * Infer a primary execution mode from free-text content.
 * Returns the mode and a concise rationale.
 */
export function inferPrimaryMode(content: string): { mode: PrimaryExecutionMode; rationale: string } {
  if (contains(content, ["incident", "outage", "down", "p0", "p1", "emergency", "production is", "site is", "service is down", "rollback"])) {
    return {
      mode: "incident-responder",
      rationale: "Content contains incident or outage indicators suggesting an urgent production issue."
    };
  }

  if (contains(content, ["debug", "investigate", "diagnose", "root cause", "trace", "why is", "reproduce", "intermittent", "flaky", "bisect"])) {
    return {
      mode: "debug-investigator",
      rationale: "Content describes debugging, investigation, or root-cause analysis work."
    };
  }

  if (contains(content, ["refactor", "restructure", "reorganise", "reorganize", "rename", "extract", "move file", "clean up code", "code structure"])) {
    return {
      mode: "refactoring-surgeon",
      rationale: "Content describes structural code changes without changing observable behaviour."
    };
  }

  if (contains(content, ["legacy", "old system", "dated", "tech debt", "technical debt", "strangler", "migration from", "migrate from", "replace old", "rewrite", "upgrade from"])) {
    return {
      mode: "legacy-stabiliser",
      rationale: "Content references legacy systems or technical debt stabilisation work."
    };
  }

  if (contains(content, ["modernise", "modernize", "modernisation", "modernization", "upgrade", "migrate to", "adopt new", "brownfield", "incremental improvement"])) {
    return {
      mode: "brownfield-moderniser",
      rationale: "Content describes incremental modernisation of an existing codebase."
    };
  }

  if (contains(content, ["experiment", "prototype", "spike", "poc", "proof of concept", "explore", "feasibility", "research"])) {
    return {
      mode: "experiment-runner",
      rationale: "Content describes experimental, prototype, or exploratory work."
    };
  }

  if (contains(content, ["harden", "hardening", "observability", "monitoring", "alerting", "reliability", "resilience", "sla", "slo", "uptime", "error rate", "retry", "circuit breaker", "rate limit"])) {
    return {
      mode: "production-hardener",
      rationale: "Content describes reliability, observability, or production-hardening work."
    };
  }

  return {
    mode: "pragmatic-shipper",
    rationale: "No specialised mode indicators found; defaulting to balanced, delivery-focused execution."
  };
}

/**
 * Infer overlays from free-text content.
 */
export function inferOverlays(content: string): ExecutionOverlay[] {
  const overlays: ExecutionOverlay[] = [];

  if (contains(content, ["security", "secure", "auth", "authentication", "authorisation", "authorization", "vulnerability", "exploit", "cve", "injection", "xss", "csrf", "secret", "credential", "permission", "rbac", "oauth", "jwt"])) {
    overlays.push("security-gatekeeper");
  }

  if (contains(content, ["performance", "optimise", "optimize", "optimisation", "optimization", "latency", "throughput", "profil", "benchmark", "cache", "bottleneck", "slow", "fast", "speed"])) {
    overlays.push("performance-tuner");
  }

  if (contains(content, ["accessibility", "a11y", "wcag", "screen reader", "aria", "keyboard navigation", "focus trap", "contrast ratio", "colour contrast", "color contrast"])) {
    overlays.push("accessibility-advocate");
  }

  return overlays;
}

/**
 * Infer a risk tolerance from mode and overlays.
 */
export function inferRisk(mode: PrimaryExecutionMode, overlays: ExecutionOverlay[]): RiskTolerance {
  if (mode === "incident-responder") {
    return "high";
  }

  if (mode === "experiment-runner") {
    return "high";
  }

  if (mode === "debug-investigator" || mode === "refactoring-surgeon" || mode === "legacy-stabiliser") {
    return "low";
  }

  if (mode === "production-hardener" || overlays.includes("security-gatekeeper")) {
    return "low";
  }

  return "medium";
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function parsePrimaryMode(value: string): PrimaryExecutionMode | undefined {
  const normalised = value.trim().toLowerCase() as PrimaryExecutionMode;
  return PRIMARY_EXECUTION_MODES.includes(normalised) ? normalised : undefined;
}

function parseOverlay(value: string): ExecutionOverlay | undefined {
  const normalised = value.trim().toLowerCase() as ExecutionOverlay;
  return EXECUTION_OVERLAYS.includes(normalised) ? normalised : undefined;
}

function parseRisk(value: string): RiskTolerance | undefined {
  const normalised = value.trim().toLowerCase() as RiskTolerance;
  return ["low", "medium", "high"].includes(normalised) ? normalised : undefined;
}

/**
 * Resolve the execution mode from an explicit config and/or inferred from content.
 *
 * Precedence (highest to lowest):
 * 1. Explicit values in config (non-"auto", non-empty)
 * 2. Inferred from content
 */
export function resolveExecutionMode(content: string, config?: ExecutionModeConfig): ResolvedExecutionMode {
  const inferredMode = inferPrimaryMode(content);
  const inferredOverlays = inferOverlays(content);

  // Resolve primary mode
  let primaryMode: PrimaryExecutionMode;
  let modeSource: "explicit" | "inferred" = "inferred";
  let modeRationale: string = inferredMode.rationale;

  if (config?.executionMode && config.executionMode !== "auto") {
    const parsed = parsePrimaryMode(config.executionMode);
    if (parsed) {
      primaryMode = parsed;
      modeSource = "explicit";
      modeRationale = `Explicitly set to ${MODE_LABELS[parsed]} in the execution brief.`;
    } else {
      // Unknown explicit value; fall back to inferred
      primaryMode = inferredMode.mode;
    }
  } else {
    primaryMode = inferredMode.mode;
  }

  // Resolve overlays
  let overlays: ExecutionOverlay[];

  if (config?.overlays && !(config.overlays.length === 1 && config.overlays[0] === "auto")) {
    // Explicit overlay list — parse valid ones, discard unknowns
    const parsed = config.overlays.flatMap((o) => {
      const p = parseOverlay(o);
      return p ? [p] : [];
    });
    overlays = parsed;
  } else {
    overlays = inferredOverlays;
  }

  // Cap at two overlays per the v1 model
  overlays = overlays.slice(0, 2);

  // Resolve risk
  let risk: RiskTolerance;

  if (config?.risk && config.risk !== "auto") {
    const parsed = parseRisk(config.risk);
    risk = parsed ?? inferRisk(primaryMode, overlays);
  } else {
    risk = inferRisk(primaryMode, overlays);
  }

  return {
    primaryMode,
    overlays,
    risk,
    rationale: modeRationale,
    source: modeSource
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a resolved execution mode for inclusion in a prompt.
 */
export function formatExecutionModeSection(mode: ResolvedExecutionMode): string {
  const label = MODE_LABELS[mode.primaryMode];
  const overlayLabels = mode.overlays.map((o) => OVERLAY_LABELS[o]);
  const overlayLine = overlayLabels.length > 0 ? overlayLabels.join(", ") : "None";
  const riskLabel = mode.risk.charAt(0).toUpperCase() + mode.risk.slice(1);
  const posture = MODE_POSTURES[mode.primaryMode];
  const overlayPostures = mode.overlays.map((o) => OVERLAY_POSTURES[o]);

  const lines = [
    "# Execution Mode",
    "",
    `**Mode:** ${label}`,
    `**Overlays:** ${overlayLine}`,
    `**Risk Tolerance:** ${riskLabel}`,
    `**Rationale:** ${mode.rationale}`,
    "",
    "## Posture for this mode",
    "",
    ...posture.map((p) => `- ${p}`),
    ...(overlayPostures.length > 0
      ? [
          "",
          "## Active overlays",
          "",
          ...overlayPostures.map((p) => `- ${p}`)
        ]
      : [])
  ];

  return lines.join("\n");
}
