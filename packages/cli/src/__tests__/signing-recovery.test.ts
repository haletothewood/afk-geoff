import YAML from "yaml";
import { configureFakeSigning } from "./fake-signing.js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCommitSigningPolicy, signingEnvironment } from "../commit-signing-policy.js";
import { createFixture, makeTempDir, MockGitHubMirror, writeReviewVerdicts } from "./test-helpers.js";

const originalCwd = process.cwd();
const originalGhToken = process.env.GH_TOKEN;
const originalPath = process.env.PATH;
let tempDir = "";
afterEach(() => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  delete process.env.AFK_TEST_REVIEW_VERDICTS_PATH;
  vi.unstubAllEnvs();
  if (originalGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalGhToken;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("signing recovery regressions", { timeout: 30_000 }, () => {
  it.each([
    ["verification", "commit", "PASS"], ["verification", "dirty", "PASS"],
    ["review", "commit", "PASS"], ["review", "dirty", "PASS"],
    ["review", "commit", "ISSUES"], ["review", "dirty", "ISSUES"]
  ] as const)("blocks %s retry when the stage makes the worktree %s with verdict %s", async (stage, mutation, verdict) => {
    tempDir = makeTempDir();
    const mirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true, githubMirror: mirror,
      signing: { mode: "enabled", key: "fixture-key" },
      signingCapabilityResolver: async () => ({ available: true, verified: true, format: "openpgp" }),
      verification: [stage === "verification" ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"']
    });
    configureFakeSigning(fixture.repoDir);
    writeReviewVerdicts(fixture.repoDir, [stage === "review" ? "__MISSING__" : "PASS"]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const item = (await fixture.items(requirement.id)).find((entry) => entry.planKey === "backend")!;
    await fixture.cli(["run", item.id]);
    const [run] = await fixture.store.listRuns();
    const finalPath = path.join(run!.runDir, "final-result.json");
    const before = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    const script = path.join(tempDir, "mutate.cjs");
    fs.writeFileSync(script, `const fs = require('node:fs');
      const {execFileSync} = require('node:child_process');
      fs.writeFileSync('mutation.txt', 'changed');
      ${mutation === "commit" ? `execFileSync('git', ['add', 'mutation.txt']); execFileSync('git', ['commit', '-S', '-m', 'unreviewed']);` : ""}
      ${stage === "review" ? `fs.writeFileSync(${JSON.stringify(before.reviewContractFailure?.resultPath)}, JSON.stringify({verdict: ${JSON.stringify(verdict)}, issues: ['Review issue']}));` : ""}
    `);
    if (stage === "verification") {
      for (const summary of before.verificationSummaries) {
        for (const result of summary.results) result.command = `node ${script}`;
      }
      fs.writeFileSync(finalPath, JSON.stringify(before));
    } else {
      const configPath = path.join(fixture.repoDir, ".afk", "config.yaml");
      const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
      config.runner.reviewCommand = [process.execPath, script];
      fs.writeFileSync(configPath, YAML.stringify(config));
    }
    const hostVerification = vi.spyOn(mirror, "verifyCommitSignatures");
    const remoteBefore = execFileSync("git", ["ls-remote", "origin"], { cwd: fixture.repoDir, encoding: "utf8" });
    await fixture.cli(["retry", run!.id, "--stage", stage]);
    const result = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    expect(result.status).toBe("blocked");
    expect(result.publishable).toBe(false);
    expect(result.whyNotPublishable.join("; ")).toMatch(/HEAD changed|worktree is dirty/);
    expect(hostVerification).not.toHaveBeenCalled();
    expect(await fixture.store.listRuns()).toHaveLength(1);
    expect(execFileSync("git", ["ls-remote", "origin"], { cwd: fixture.repoDir, encoding: "utf8" })).toBe(remoteBefore);
  });

  it("writes a non-publishable terminal artifact when the verifier hangs after a successful probe", { timeout: 60_000 }, async () => {
    tempDir = makeTempDir();
    const mirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true, githubMirror: mirror,
      signing: { mode: "enabled", key: "fixture-key" }
    });
    const hostVerification = vi.spyOn(mirror, "verifyCommitSignatures");
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const item = (await fixture.items(requirement.id)).find((entry) => entry.planKey === "backend")!;
    configureFakeSigning(fixture.repoDir);
    const program = path.join(fixture.repoDir, ".afk", "fake-gpg.cjs");
    const marker = path.join(tempDir, "probe-verified");
    const source = fs.readFileSync(program, "utf8").replace("if (args.includes('--verify')) {", `if (args.includes('--verify')) {
      if (fs.existsSync(${JSON.stringify(marker)})) {
        setTimeout(() => process.exit(1), 15_000);
        return;
      }
      fs.writeFileSync(${JSON.stringify(marker)}, 'verified');`);
    fs.writeFileSync(program, source);
    await expect(fixture.cli(["run", item.id])).rejects.toThrow(/timed out/);
    const [run] = await fixture.store.listRuns();
    const result = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8"));
    expect(result.commitSigningPolicy.capability.verified).toBe(true);
    expect(result.publishable).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.commitSignatureEvidence).toEqual([expect.objectContaining({ signed: true, verified: false, reason: expect.stringContaining("timed out") })]);
    expect(hostVerification).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves inherited Git settings when enforced=%s", async (enforced) => {
    vi.stubEnv("GIT_CONFIG_COUNT", "3");
    const inherited = [
      ["credential.helper", "fixture-helper"],
      ["url.ssh://git@example.test/.insteadOf", "https://example.test/"],
      ["gpg.format", "ssh"]
    ];
    for (const [index, [key, value]] of inherited.entries()) {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key!);
      vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value!);
    }
    const before = { ...process.env };
    const policy = await resolveCommitSigningPolicy({
      repoRoot: "/repo", baseBranch: "main", mode: enforced ? "enabled" : "auto", githubEnabled: false,
      capabilityResolver: async () => ({ available: true, verified: true, format: "ssh" })
    });
    const environment = { ...process.env, ...signingEnvironment(policy, enforced ? "configured-key" : undefined) };
    expect(environment.GIT_CONFIG_COUNT).toBe(enforced ? "5" : "4");
    for (const [index, [key, value]] of inherited.entries()) {
      expect(environment[`GIT_CONFIG_KEY_${index}`]).toBe(key);
      expect(environment[`GIT_CONFIG_VALUE_${index}`]).toBe(value);
    }
    expect(environment.GIT_CONFIG_KEY_3).toBe("commit.gpgsign");
    expect(environment.GIT_CONFIG_VALUE_3).toBe(String(enforced));
    expect(process.env).toEqual(before);
  });

  it.each(["required", "unavailable"] as const)("review retry rechecks %s policy with legacy unsigned evidence", async (nextRequirement) => {
    tempDir = makeTempDir();
    let requirement: "optional" | "required" | "unavailable" = "optional";
    const fixture = await createFixture(tempDir, {
      githubEnabled: true, githubMirror: new MockGitHubMirror(), verification: ['node -e "process.exit(0)"'],
      targetCommitSignaturePolicyResolver: async () => ({ requirement, source: "github-branch-rules" }),
      signingCapabilityResolver: async () => ({ available: true, verified: true, format: "ssh" })
    });
    writeReviewVerdicts(fixture.repoDir, ["__MISSING__"]);
    const itemRequirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(itemRequirement.id);
    const item = (await fixture.items(itemRequirement.id)).find((entry) => entry.planKey === "backend")!;
    await fixture.cli(["run", item.id]);
    const [run] = await fixture.store.listRuns();
    const finalPath = path.join(run!.runDir, "final-result.json");
    const legacy = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    delete legacy.commitSigningPolicy;
    delete legacy.commitSignatureEvidence;
    delete legacy.evidencePacket.commitSigning;
    fs.writeFileSync(finalPath, JSON.stringify(legacy));
    requirement = nextRequirement;
    writeReviewVerdicts(fixture.repoDir, ["PASS"]);
    await fixture.cli(["retry", run!.id, "--stage", "review"]);
    const result = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    expect(result.publishable).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.commitSigningPolicy.requirement).toBe(nextRequirement);
    expect(result.evidencePacket.commitSigning.satisfied).toBe(false);
    expect(result.evidencePacket.review.verdict).toBe("PASS");
    expect(result.evidencePacket.verification.status).toBe("passed");
    expect(result.whyNotPublishable.length).toBeGreaterThan(0);
    expect((await fixture.store.getWorkItem(item.id))?.status).toBe("blocked");
  });

  it.each(["accepted", "rejected", "missing", "unavailable", "independent blocker"] as const)("review retry requires complete host evidence: %s", async (hostState) => {
    tempDir = makeTempDir();
    const mirror = new MockGitHubMirror();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true, githubMirror: mirror,
      signing: { mode: "enabled", key: "fixture-key" },
      signingCapabilityResolver: async () => ({ available: true, verified: true, format: "openpgp" }),
      verification: ['node -e "process.exit(0)"']
    });
    configureFakeSigning(fixture.repoDir);
    writeReviewVerdicts(fixture.repoDir, ["__MISSING__"]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const item = (await fixture.items(requirement.id)).find((entry) => entry.planKey === "backend")!;
    await fixture.cli(["run", item.id]);
    const [run] = await fixture.store.listRuns();
    const finalPath = path.join(run!.runDir, "final-result.json");
    const before = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    // A pending local artifact must not be mistaken for host confirmation by PASS.
    before.whyNotPublishable.push("GitHub verification is pending for every branch commit signature");
    before.publishabilityBlockers.push({ category: "policy", message: "GitHub verification is pending for every branch commit signature" });
    if (hostState === "independent blocker") {
      before.whyNotPublishable.push("Independent repository policy hold");
      before.publishabilityBlockers.push({ category: "policy", message: "Independent repository policy hold" });
    }
    fs.writeFileSync(finalPath, JSON.stringify(before));
    if (hostState === "rejected") mirror.rejectAllCommitSignatures = "unknown_key";
    if (hostState === "missing") vi.spyOn(mirror, "verifyCommitSignatures").mockResolvedValue([]);
    if (hostState === "unavailable") vi.spyOn(mirror, "verifyCommitSignatures").mockRejectedValue(new Error("GitHub verification unavailable"));
    writeReviewVerdicts(fixture.repoDir, ["PASS"]);
    await fixture.cli(["retry", run!.id, "--stage", "review"]);
    const result = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    const accepted = hostState === "accepted";
    expect(result.publishable).toBe(accepted);
    expect(result.status).toBe(accepted ? "done" : "blocked");
    expect(result.evidencePacket.commitSigning.hostVerification.verified).toBe(accepted || hostState === "independent blocker");
    expect(result.evidencePacket.commitSigning.satisfied).toBe(accepted || hostState === "independent blocker");
    expect(result.evidencePacket.review.verdict).toBe("PASS");
    expect(result.evidencePacket.verification.status).toBe("passed");
    expect(result.evidencePacket.recommendedHumanAction).toBe(accepted ? "publish" : hostState === "independent blocker" ? "retry" : "fix_environment");
  });

  it("probe and worker share inherited Git configuration without changing the parent environment", async () => {
    tempDir = makeTempDir();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true, githubMirror: new MockGitHubMirror(),
      signing: { mode: "enabled", key: "fixture-key" },
      runnerScriptSuffix: `for (const [key, expected] of [["credential.helper", "fixture-helper"], ["gpg.format", "openpgp"], ["url.ssh://git@example.test/.insteadOf", "https://example.test/"]]) {
        const actual = execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
        if (actual !== expected) throw new Error("Inherited Git setting lost: " + key);
      }`
    });
    configureFakeSigning(fixture.repoDir);
    // Deliberately conflict with caller config: both probe and worker must see the caller value.
    execFileSync("git", ["config", "gpg.format", "ssh"], { cwd: fixture.repoDir });
    const inherited = [["credential.helper", "fixture-helper"], ["gpg.format", "openpgp"], ["url.ssh://git@example.test/.insteadOf", "https://example.test/"]];
    vi.stubEnv("GIT_CONFIG_COUNT", "3");
    for (const [index, [key, value]] of inherited.entries()) {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key!);
      vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value!);
    }
    const parent = { ...process.env };
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const item = (await fixture.items(requirement.id)).find((entry) => entry.planKey === "backend")!;
    await fixture.cli(["run", item.id]);
    const [run] = await fixture.store.listRuns();
    const result = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8"));
    expect(result.publishable).toBe(true);
    expect(result.commitSigningPolicy.capability).toMatchObject({ available: true, verified: true, format: "openpgp" });
    expect(process.env).toEqual(parent);
  });

  it("an unsigned worker fix cannot hide between signed initial and final host commits", async () => {
    tempDir = makeTempDir();
    const fixture = await createFixture(tempDir, {
      githubEnabled: true, githubMirror: new MockGitHubMirror(),
      signing: { mode: "enabled", key: "fixture-key" },
      signingCapabilityResolver: async () => ({ available: true, verified: true, format: "openpgp" }),
      runnerScriptSuffix: `if (prompt.includes("Issues to fix")) {
        fs.writeFileSync("worker-fix.txt", "worker fix");
        execFileSync("git", ["add", "worker-fix.txt"]);
        execFileSync("git", ["commit", "--no-gpg-sign", "-m", "unsigned worker fix"]);
        fs.writeFileSync("host-fix.txt", "host fix");
      }`
    });
    configureFakeSigning(fixture.repoDir);
    writeReviewVerdicts(fixture.repoDir, [{ verdict: "ISSUES", issues: ["Add the fix"] }, "PASS"]);
    const requirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(requirement.id);
    const item = (await fixture.items(requirement.id)).find((entry) => entry.planKey === "backend")!;
    await expect(fixture.cli(["run", item.id])).rejects.toThrow("commit is unsigned");
    const [run] = await fixture.store.listRuns();
    const result = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8"));
    expect(result.publishable).toBe(false);
    expect(result.commitSignatureEvidence.map((commit: { signed: boolean }) => commit.signed)).toEqual([true, false, true]);
    expect(result.evidencePacket.review.verdict).toBe("PASS");
    expect(result.evidencePacket.commitSigning.satisfied).toBe(false);
  });

  it("publication recovery rechecks changed policy before reusing an unsigned implementation", async () => {
    tempDir = makeTempDir();
    let requirement: "optional" | "required" = "optional";
    const mirror = new MockGitHubMirror();
    mirror.openPullRequestError = new Error("temporary publication failure");
    const fixture = await createFixture(tempDir, {
      githubEnabled: true, githubMirror: mirror,
      targetCommitSignaturePolicyResolver: async () => ({ requirement, source: "github-branch-rules" }),
      signingCapabilityResolver: async () => ({ available: true, verified: true, format: "openpgp" })
    });
    const itemRequirement = await fixture.capture("Add a queue-based resend workflow.");
    await fixture.seedQueue(itemRequirement.id);
    const item = (await fixture.items(itemRequirement.id)).find((entry) => entry.planKey === "backend")!;
    await expect(fixture.cli(["run", item.id, "--pr"])).rejects.toThrow("temporary publication failure");
    const [run] = await fixture.store.listRuns();
    const modifiedAt = fs.statSync(path.join(run!.runDir, "prompt.md")).mtimeMs;
    requirement = "required";
    mirror.openPullRequestError = undefined;
    await expect(fixture.cli(["run", item.id, "--pr"])).rejects.toThrow("commit is unsigned");
    const result = JSON.parse(fs.readFileSync(path.join(run!.runDir, "final-result.json"), "utf8"));
    expect(result.publishable).toBe(false);
    expect(result.commitSigningPolicy.requirement).toBe("required");
    expect(result.evidencePacket.commitSigning.satisfied).toBe(false);
    expect(fs.statSync(path.join(run!.runDir, "prompt.md")).mtimeMs).toBe(modifiedAt);
    expect(await fixture.store.listRuns()).toHaveLength(1);
  });
});

