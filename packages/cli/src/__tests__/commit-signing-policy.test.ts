import { describe, expect, it, vi } from "vitest";
import { resolveCommitSigningPolicy } from "../commit-signing-policy.js";

describe("commit signing policy", () => {
  it("keeps unsigned commits optional for a local repository in auto mode", async () => {
    const capabilityResolver = vi.fn(async () => ({
      available: false,
      verified: false,
      format: "openpgp" as const,
      reason: "no signing key"
    }));

    const policy = await resolveCommitSigningPolicy({
      repoRoot: "/repo",
      baseBranch: "main",
      mode: "auto",
      githubEnabled: false,
      capabilityResolver
    });

    expect(policy.requirement).toBe("optional");
    expect(policy.enforced).toBe(false);
    expect(policy.publishable).toBe(true);
    expect(capabilityResolver).not.toHaveBeenCalled();
  });

  it("enforces signing when the target branch requires verified signatures", async () => {
    const policy = await resolveCommitSigningPolicy({
      repoRoot: "/repo",
      baseBranch: "main",
      mode: "auto",
      githubEnabled: true,
      remote: { owner: "acme", repo: "demo" },
      githubToken: "token",
      targetPolicyResolver: async () => ({ requirement: "required", source: "github-branch-rules" }),
      capabilityResolver: async () => ({ available: true, verified: true, format: "ssh" })
    });

    expect(policy.requirement).toBe("required");
    expect(policy.enforced).toBe(true);
    expect(policy.publishable).toBe(true);
    expect(policy.capability).toMatchObject({ available: true, verified: true, format: "ssh" });
  });

  it("returns an actionable non-publishable policy when signing is unavailable", async () => {
    const policy = await resolveCommitSigningPolicy({
      repoRoot: "/repo",
      baseBranch: "main",
      mode: "auto",
      githubEnabled: true,
      remote: { owner: "acme", repo: "demo" },
      githubToken: "token",
      targetPolicyResolver: async () => ({ requirement: "required", source: "github-branch-rules" }),
      capabilityResolver: async () => ({ available: false, verified: false, format: "openpgp", reason: "signing probe failed" })
    });

    expect(policy.publishable).toBe(false);
    expect(policy.failure?.category).toBe("environment");
    expect(policy.failure?.message).toContain("signing probe failed");
  });

  it("does not silently downgrade when target policy discovery is unavailable", async () => {
    const policy = await resolveCommitSigningPolicy({
      repoRoot: "/repo",
      baseBranch: "main",
      mode: "auto",
      githubEnabled: true,
      remote: { owner: "acme", repo: "demo" },
      githubToken: "token",
      targetPolicyResolver: async () => ({ requirement: "unavailable", source: "github-branch-rules", reason: "HTTP 403" }),
      capabilityResolver: async () => ({ available: true, verified: true, format: "ssh" })
    });

    expect(policy.requirement).toBe("unavailable");
    expect(policy.publishable).toBe(false);
    expect(policy.failure).toMatchObject({ category: "policy" });
  });

  it("rejects disabled signing when the target requires signatures", async () => {
    const policy = await resolveCommitSigningPolicy({
      repoRoot: "/repo",
      baseBranch: "main",
      mode: "disabled",
      githubEnabled: true,
      remote: { owner: "acme", repo: "demo" },
      githubToken: "token",
      targetPolicyResolver: async () => ({ requirement: "required", source: "github-branch-rules" }),
      capabilityResolver: async () => ({ available: true, verified: true, format: "ssh" })
    });

    expect(policy.publishable).toBe(false);
    expect(policy.failure?.message).toContain("mode is disabled");
  });
});
