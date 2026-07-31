import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubTargetPolicy, resolveCommitSigningPolicy } from "../commit-signing-policy.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("detects required signatures configured through classic branch protection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const policy = await fetchGitHubTargetPolicy({
      owner: "acme",
      repo: "demo",
      branch: "release/v1",
      token: "token"
    });

    expect(policy.requirement).toBe("required");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/branches/release%2Fv1/protection/required_signatures");
  });

  it("treats a missing classic required-signatures setting as absent", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 })));

    await expect(fetchGitHubTargetPolicy({
      owner: "acme",
      repo: "demo",
      branch: "main",
      token: "token"
    })).resolves.toMatchObject({ requirement: "optional" });
  });

  it("does not treat an unavailable classic protection check as absent", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 })));

    await expect(fetchGitHubTargetPolicy({
      owner: "acme",
      repo: "demo",
      branch: "main",
      token: "token"
    })).resolves.toMatchObject({
      requirement: "unavailable",
      reason: expect.stringContaining("required-signatures API returned HTTP 403")
    });
  });
});
