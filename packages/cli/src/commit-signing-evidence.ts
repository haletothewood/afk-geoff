import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { CommitSignatureVerificationSource } from "@afk-geoff/core";
import type { CliContext } from "./types.js";
import { HOST_SIGNATURE_VERIFICATION_PENDING_MESSAGE, type EffectiveCommitSigningPolicy } from "./commit-signing-policy.js";

const SIGNATURE_VERIFICATION_TIMEOUT_MS = 10_000;

export interface CommitSignatureEvidence {
  sha: string;
  signed: boolean;
  verified: boolean;
  reason?: string;
}

export function readCommitSignatureEvidence(worktreePath: string, baseBranch: string | undefined, enabled: boolean): CommitSignatureEvidence[] {
  if (!enabled) return [];

  try {
    if (!baseBranch) throw new Error("Missing base branch");
    const shas = execFileSync("git", ["rev-list", "--reverse", `${baseBranch}..HEAD`], {
      cwd: worktreePath,
      encoding: "utf8"
    }).trim().split("\n").filter(Boolean);
    return shas.map((sha) => {
      const rawCommit = execFileSync("git", ["cat-file", "commit", sha], { cwd: worktreePath, encoding: "utf8" });
      const signed = /^gpgsig(?:-sha256)? /m.test(rawCommit);
      if (!signed) {
        return { sha, signed: false, verified: false };
      }
      try {
        execFileSync("git", ["verify-commit", sha], { cwd: worktreePath, stdio: "ignore", timeout: SIGNATURE_VERIFICATION_TIMEOUT_MS, killSignal: "SIGKILL" });
        return { sha, signed: true, verified: true };
      } catch (error) {
        const timedOut = error instanceof Error && "code" in error && error.code === "ETIMEDOUT";
        return {
          sha, signed: true, verified: false,
          ...(timedOut ? { reason: `signature verification timed out after ${SIGNATURE_VERIFICATION_TIMEOUT_MS}ms` } : {})
        };
      }
    });
  } catch {
    return [{
      sha: "unavailable",
      signed: false,
      verified: false,
      reason: "AFK could not inspect the commit range"
    }];
  }
}

export interface SigningEvaluation {
  policy: EffectiveCommitSigningPolicy;
  commits: CommitSignatureEvidence[];
  satisfied: boolean;
  blockers: string[];
  hostVerification?: { verified: boolean; message?: string };
}

/** Re-read the entire proposed range; persisted or legacy evidence is never authority. */
export async function evaluateCommitSigning(
  ctx: CliContext, worktreePath: string, branchName: string | undefined
): Promise<SigningEvaluation> {
  const policy = ctx.commitSigningPolicy;
  const commits = readCommitSignatureEvidence(worktreePath, ctx.config.baseBranch, policy.enforced);
  const result = (blockers: string[], hostVerification?: SigningEvaluation["hostVerification"]): SigningEvaluation => ({
    policy, commits, satisfied: blockers.length === 0, blockers,
    ...(hostVerification ? { hostVerification } : {})
  });
  if (!policy.publishable) return result([policy.failure?.message ?? "Commit signature policy is unavailable"]);
  if (!policy.enforced) return result([]);
  const localBlockers = commits.filter((commit) => !commit.signed || !commit.verified)
    .map((commit) => `Commit signature verification failed for ${commit.sha}: ${commit.reason ?? (commit.signed ? "signature is unverifiable" : "commit is unsigned")}`);
  if (localBlockers.length) return result(localBlockers, { verified: false, message: "GitHub verification was not attempted because local signature verification failed" });
  try {
    if (!branchName || !ctx.remote || !ctx.github || !("verifyCommitSignatures" in ctx.github) || typeof ctx.github.verifyCommitSignatures !== "function") {
      throw new Error("GitHub verified-signature confirmation is unavailable; configure GitHub access and retry");
    }
    await ctx.git.pushBranch({ cwd: worktreePath, branchName });
    const verifier = ctx.github as typeof ctx.github & CommitSignatureVerificationSource;
    const verification = await verifier.verifyCommitSignatures({ ...ctx.remote, shas: commits.map((commit) => commit.sha) });
    const bySha = new Map(verification.map((commit) => [commit.sha, commit]));
    const rejected = commits.filter((commit) => bySha.get(commit.sha)?.verified !== true);
    if (rejected.length) {
      throw new Error(`GitHub rejected commit signature verification for ${rejected.map((commit) => `${commit.sha} (${bySha.get(commit.sha)?.reason ?? "GitHub returned no verification result"})`).join(", ")}`);
    }
    return result([], { verified: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result([message], { verified: false, message });
  }
}

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Replace only signing evidence and blockers; independent gates retain their authority. */
export function applySigningEvaluation(finalResult: JsonRecord, signing: SigningEvaluation): JsonRecord {
  const evidence = record(finalResult.evidencePacket);
  const previousSigning = record(evidence.commitSigning);
  const previousPolicy = record(finalResult.commitSigningPolicy);
  const previousHost = record(previousSigning.hostVerification);
  const oldSigningMessages = new Set([
    HOST_SIGNATURE_VERIFICATION_PENDING_MESSAGE,
    ...strings(previousSigning.blockers),
    ...strings(record(previousPolicy.failure).message ? [record(previousPolicy.failure).message] : []),
    ...strings(previousHost.message ? [previousHost.message] : []),
    ...records(finalResult.commitSignatureEvidence).filter((commit) => !commit.signed || !commit.verified)
      .map((commit) => `Commit signature verification failed for ${commit.sha}: ${commit.reason ?? (commit.signed ? "signature is unverifiable" : "commit is unsigned")}`)
  ]);
  const blockers = [
    ...[...records(finalResult.publishabilityBlockers), ...records(record(evidence.publishability).blockers)]
      .filter((blocker, index, all) => all.findIndex((other) => other.category === blocker.category && other.message === blocker.message) === index)
      .filter((blocker) => !oldSigningMessages.has(String(blocker.message))),
    ...signing.blockers.map((message) => ({ category: signing.policy.failure?.category ?? "policy", message }))
  ];
  const reasons = [...new Set([
    ...strings(finalResult.whyNotPublishable).filter((message) => !oldSigningMessages.has(message)),
    ...blockers.map((blocker) => String(blocker.message))
  ])];
  const publishable = signing.satisfied && reasons.length === 0 && finalResult.status === "done";
  return {
    ...finalResult, commitSigningPolicy: signing.policy, commitSignatureEvidence: signing.commits,
    publishable, whyNotPublishable: reasons, publishabilityBlockers: blockers,
    evidencePacket: {
      ...evidence, commitSigning: signing,
      publishability: { publishable, blockers },
      recommendedHumanAction: publishable ? "publish" : signing.satisfied ? "retry" : "fix_environment"
    }
  };
}

export async function evaluateRunSigning(ctx: CliContext, run: { runDir: string; worktreePath: string; branchName?: string }): Promise<void> {
  const finalPath = path.join(run.runDir, "final-result.json");
  const finalResult = JSON.parse(fs.readFileSync(finalPath, "utf8")) as JsonRecord;
  const signing = await evaluateCommitSigning(ctx, run.worktreePath, run.branchName);
  const updated = applySigningEvaluation(finalResult, signing);
  fs.writeFileSync(finalPath, JSON.stringify({ ...updated, status: updated.publishable ? finalResult.status : "blocked" }, null, 2));
  if (updated.publishable !== true) {
    const reasons = strings(updated.whyNotPublishable);
    throw new Error(reasons.join("; ") || "An independent publishability gate failed; inspect final-result.json");
  }
}
