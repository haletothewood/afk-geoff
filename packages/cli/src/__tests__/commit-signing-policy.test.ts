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

  it("treats an authorized missing classic required-signatures setting on a protected branch as absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/rules/branches/")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/protection/required_signatures")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/protection")) {
        return new Response(JSON.stringify({ required_status_checks: { strict: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ protected: true }), { status: 200 });
    }));

    await expect(fetchGitHubTargetPolicy({
      owner: "acme",
      repo: "demo",
      branch: "main",
      token: "token"
    })).resolves.toMatchObject({ requirement: "optional" });
  });

  it("does not treat a permission-limited classic required-signatures response as absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/rules/branches/")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/protection/required_signatures")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/protection")) {
        return new Response(null, { status: 403 });
      }
      return new Response(JSON.stringify({ protected: true }), { status: 200 });
    }));

    await expect(fetchGitHubTargetPolicy({
      owner: "acme",
      repo: "demo",
      branch: "main",
      token: "token"
    })).resolves.toMatchObject({
      requirement: "unavailable",
      reason: expect.stringContaining("branch-protection API returned HTTP 403")
    });
  });

  it("detects required signatures on a later branch-rules page", async () => {
    const firstPage = Array.from({ length: 100 }, () => ({ type: "deletion" }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("page=2")) {
        return new Response(JSON.stringify([{ type: "required_signatures" }]), { status: 200 });
      }
      if (url.includes("/rules/branches/")) {
        return new Response(JSON.stringify(firstPage), {
          status: 200,
          headers: { Link: '<https://api.github.com/repos/acme/demo/rules/branches/main?per_page=100&page=2>; rel="next"' }
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubTargetPolicy({
      owner: "acme",
      repo: "demo",
      branch: "main",
      token: "token"
    })).resolves.toMatchObject({ requirement: "required" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("per_page=100&page=2"))).toBe(true);
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
