import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SIGNING_PROBE_TIMEOUT_MS = 10_000;
const GITHUB_POLICY_TIMEOUT_MS = 8_000;
export const HOST_SIGNATURE_VERIFICATION_PENDING_MESSAGE = "GitHub verification is pending for every branch commit signature";

export type CommitSigningMode = "auto" | "enabled" | "disabled";
export type CommitSignatureRequirement = "required" | "optional" | "unavailable";
export type CommitSigningFormat = "openpgp" | "ssh" | "x509" | "unknown";

export interface TargetCommitSignaturePolicy {
  requirement: CommitSignatureRequirement;
  source: "github-branch-rules" | "operator" | "local-default";
  reason?: string;
}

export interface CommitSigningCapability {
  available: boolean;
  verified: boolean;
  format: CommitSigningFormat;
  reason?: string;
}

export interface EffectiveCommitSigningPolicy {
  targetBranch: string;
  mode: CommitSigningMode;
  requirement: CommitSignatureRequirement;
  source: TargetCommitSignaturePolicy["source"];
  enforced: boolean;
  publishable: boolean;
  capability: CommitSigningCapability;
  failure?: {
    category: "policy" | "environment";
    message: string;
    remediation: string;
  };
}

export type TargetPolicyResolver = (input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}) => Promise<TargetCommitSignaturePolicy>;

export type SigningCapabilityResolver = (input: {
  repoRoot: string;
  key?: string;
}) => Promise<CommitSigningCapability>;

export async function resolveCommitSigningPolicy(input: {
  repoRoot: string;
  baseBranch: string;
  mode: CommitSigningMode;
  key?: string;
  githubEnabled: boolean;
  remote?: { owner: string; repo: string };
  githubToken?: string;
  targetPolicyResolver?: TargetPolicyResolver;
  capabilityResolver?: SigningCapabilityResolver;
}): Promise<EffectiveCommitSigningPolicy> {
  const targetPolicy = await resolveTargetPolicy(input);
  const enforced = input.mode === "enabled" || targetPolicy.requirement === "required";
  const emptyCapability: CommitSigningCapability = {
    available: false,
    verified: false,
    format: "unknown",
    reason: enforced ? "Signing capability was not checked" : "Signing is not required"
  };

  if (targetPolicy.requirement === "unavailable") {
    return {
      targetBranch: input.baseBranch,
      mode: input.mode,
      requirement: targetPolicy.requirement,
      source: targetPolicy.source,
      enforced: false,
      publishable: false,
      capability: emptyCapability,
      failure: {
        category: "policy",
        message: `Commit signature policy for target branch ${input.baseBranch} is unavailable: ${targetPolicy.reason ?? "unknown policy discovery failure"}`,
        remediation: "Grant the GitHub token read access to repository rules or set git.signing.mode to enabled when signatures are known to be required."
      }
    };
  }

  if (targetPolicy.requirement === "required" && input.mode === "disabled") {
    return {
      targetBranch: input.baseBranch,
      mode: input.mode,
      requirement: targetPolicy.requirement,
      source: targetPolicy.source,
      enforced: false,
      publishable: false,
      capability: emptyCapability,
      failure: {
        category: "policy",
        message: `Target branch ${input.baseBranch} requires verified commit signatures, but git.signing.mode is disabled.`,
        remediation: "Set git.signing.mode to auto or enabled and configure a signing key GitHub can verify."
      }
    };
  }

  if (!enforced) {
    return {
      targetBranch: input.baseBranch,
      mode: input.mode,
      requirement: targetPolicy.requirement,
      source: targetPolicy.source,
      enforced: false,
      publishable: true,
      capability: emptyCapability
    };
  }

  const capability = await (input.capabilityResolver ?? probeSigningCapability)({
    repoRoot: input.repoRoot,
    ...(input.key ? { key: input.key } : {})
  });
  if (!capability.available || !capability.verified) {
    return {
      targetBranch: input.baseBranch,
      mode: input.mode,
      requirement: targetPolicy.requirement,
      source: targetPolicy.source,
      enforced: true,
      publishable: false,
      capability,
      failure: {
        category: "environment",
        message: `Verified commit signing is required, but the signing capability is unavailable or unverifiable: ${capability.reason ?? "signing probe did not verify"}`,
        remediation: "Configure a Git signing key and trust configuration for this repository, then confirm the key is registered with GitHub."
      }
    };
  }

  return {
    targetBranch: input.baseBranch,
    mode: input.mode,
    requirement: targetPolicy.requirement,
    source: targetPolicy.source,
    enforced: true,
    publishable: true,
    capability
  };
}

async function resolveTargetPolicy(input: {
  baseBranch: string;
  mode: CommitSigningMode;
  githubEnabled: boolean;
  remote?: { owner: string; repo: string };
  githubToken?: string;
  targetPolicyResolver?: TargetPolicyResolver;
}): Promise<TargetCommitSignaturePolicy> {
  if (input.mode === "enabled") {
    return { requirement: "required", source: "operator" };
  }

  if (!input.githubEnabled) {
    return { requirement: "optional", source: "local-default" };
  }

  if (!input.remote || !input.githubToken) {
    return {
      requirement: "unavailable",
      source: "github-branch-rules",
      reason: !input.remote ? "GitHub repository identity is unavailable" : "GitHub authentication is unavailable"
    };
  }

  return await (input.targetPolicyResolver ?? fetchGitHubTargetPolicy)({
    owner: input.remote.owner,
    repo: input.remote.repo,
    branch: input.baseBranch,
    token: input.githubToken
  });
}

export async function fetchGitHubTargetPolicy(input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}): Promise<TargetCommitSignaturePolicy> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), GITHUB_POLICY_TIMEOUT_MS);
  try {
    const repositoryEndpoint = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const request = {
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "afk-geoff/commit-signing-policy"
      },
      signal: abortController.signal
    } satisfies RequestInit;
    const [rulesetsPolicy, classicProtectionPolicy] = await Promise.all([
      fetchRulesetsSignaturePolicy(
        `${repositoryEndpoint}/rules/branches/${encodeURIComponent(input.branch)}`,
        request
      ),
      fetchClassicProtectionSignaturePolicy(
        `${repositoryEndpoint}/branches/${encodeURIComponent(input.branch)}/protection/required_signatures`,
        request
      )
    ]);
    return reconcileGitHubSignaturePolicies(rulesetsPolicy, classicProtectionPolicy);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRulesetsSignaturePolicy(endpoint: string, request: RequestInit): Promise<TargetCommitSignaturePolicy> {
  try {
    const response = await fetch(endpoint, request);
    if (!response.ok) {
      return unavailableGitHubPolicy("branch-rules", response.status);
    }
    const rules = await response.json() as Array<{ type?: string }>;
    return githubPolicy(rules.some((rule) => rule.type === "required_signatures") ? "required" : "optional");
  } catch (error) {
    return unavailableGitHubPolicy("branch-rules", error);
  }
}

async function fetchClassicProtectionSignaturePolicy(endpoint: string, request: RequestInit): Promise<TargetCommitSignaturePolicy> {
  try {
    const response = await fetch(endpoint, request);
    if (response.status === 404) {
      return githubPolicy("optional");
    }
    if (!response.ok) {
      return unavailableGitHubPolicy("required-signatures", response.status);
    }
    const setting = await response.json() as { enabled?: boolean };
    return githubPolicy(setting.enabled === false ? "optional" : "required");
  } catch (error) {
    return unavailableGitHubPolicy("required-signatures", error);
  }
}

function reconcileGitHubSignaturePolicies(...policies: TargetCommitSignaturePolicy[]): TargetCommitSignaturePolicy {
  if (policies.some((policy) => policy.requirement === "required")) {
    return githubPolicy("required");
  }
  const unavailable = policies.filter((policy) => policy.requirement === "unavailable");
  if (unavailable.length > 0) {
    return {
      requirement: "unavailable",
      source: "github-branch-rules",
      reason: unavailable.map((policy) => policy.reason).filter(Boolean).join("; ")
    };
  }
  return githubPolicy("optional");
}

function githubPolicy(requirement: "required" | "optional"): TargetCommitSignaturePolicy {
  return { requirement, source: "github-branch-rules" };
}

function unavailableGitHubPolicy(api: string, error: number | unknown): TargetCommitSignaturePolicy {
  const reason = typeof error === "number"
    ? `GitHub ${api} API returned HTTP ${error}`
    : error instanceof Error && error.name === "AbortError"
      ? `GitHub ${api} API timed out after ${GITHUB_POLICY_TIMEOUT_MS}ms`
      : error instanceof Error ? error.message : String(error);
  return { requirement: "unavailable", source: "github-branch-rules", reason };
}

export async function probeSigningCapability(input: { repoRoot: string; key?: string }): Promise<CommitSigningCapability> {
  const format = await readSigningFormat(input.repoRoot);
  try {
    const { stdout: tree } = await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: input.repoRoot });
    const signArg = input.key ? `-S${input.key}` : "-S";
    const { stdout: commit } = await execFileAsync("git", ["commit-tree", tree.trim(), "-p", "HEAD", signArg, "-m", "AFK commit-signing capability probe"], {
      cwd: input.repoRoot,
      timeout: SIGNING_PROBE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    await execFileAsync("git", ["verify-commit", commit.trim()], {
      cwd: input.repoRoot,
      timeout: SIGNING_PROBE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    return { available: true, verified: true, format };
  } catch (error) {
    const reason = error instanceof Error && "killed" in error && error.killed
      ? `signing probe timed out after ${SIGNING_PROBE_TIMEOUT_MS}ms`
      : "git could not create and locally verify a signed probe commit";
    return { available: false, verified: false, format, reason };
  }
}

async function readSigningFormat(repoRoot: string): Promise<CommitSigningFormat> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "gpg.format"], { cwd: repoRoot });
    const value = stdout.trim();
    return value === "ssh" || value === "x509" || value === "openpgp" ? value : "unknown";
  } catch {
    return "openpgp";
  }
}
