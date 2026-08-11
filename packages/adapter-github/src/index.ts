import type { ChangeRequestPublisher, CodeHost, CommitSignatureVerificationSource, ExternalRef, HydratedWorkItem, IssueMirror, ChangeRequest, PublicationResult, PullRequestReviewSource, Requirement, ResultPublisher, WorkItem, WorkSource, WorkflowArtifactSource, WorkflowDispatcher, WorkflowRunSource } from "@afk-geoff/core";
import { createId, parseExecutionBriefMarkdown } from "@afk-geoff/shared";
import { Octokit } from "@octokit/rest";

export interface OctokitLike {
  repos?: {
    getCommit(input: { owner: string; repo: string; ref: string }): Promise<{ data: { sha: string; commit: { verification?: { verified?: boolean; reason?: string | null } | null } } }>;
  };
  issues: {
    create(input: { owner: string; repo: string; title: string; body: string; labels?: string[] }): Promise<{ data: { id: number; number: number; html_url?: string } }>;
    createComment(input: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
    get(input: { owner: string; repo: string; issue_number: number }): Promise<{ data: { state: string; title?: string; body?: string; html_url?: string } }>;
    listComments(input: { owner: string; repo: string; issue_number: number; per_page?: number }): Promise<{ data: Array<{ id: number; body?: string; created_at?: string }> }>;
  };
  pulls: {
    create(input: { owner: string; repo: string; title: string; head: string; base: string; body: string }): Promise<{ data: { id: number; number: number; html_url?: string } }>;
    update(input: { owner: string; repo: string; pull_number: number; state: "open" | "closed" }): Promise<unknown>;
    get(input: { owner: string; repo: string; pull_number: number }): Promise<{ data: { state: string; merged: boolean } }>;
    listReviewComments(input: { owner: string; repo: string; pull_number: number; per_page?: number }): Promise<{ data: Array<{ id: number; body?: string; path?: string; line?: number | null; outdated?: boolean }> }>;
  };
  actions: {
    createWorkflowDispatch(input: {
      owner: string;
      repo: string;
      workflow_id: string;
      ref: string;
      inputs?: Record<string, string>;
    }): Promise<unknown>;
    listWorkflowRuns(input: {
      owner: string;
      repo: string;
      workflow_id: string;
      per_page?: number;
    }): Promise<{
      data: {
        workflow_runs: Array<{
          id: number;
          display_title?: string | null;
          name?: string | null;
          status?: string | null;
          conclusion?: string | null;
          head_branch?: string | null;
          event?: string | null;
          html_url?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        }>;
      };
    }>;
    listWorkflowRunArtifacts(input: {
      owner: string;
      repo: string;
      run_id: number;
      per_page?: number;
    }): Promise<{
      data: {
        artifacts: Array<{
          id: number;
          name: string;
          size_in_bytes?: number | null;
          expired?: boolean | null;
          url?: string | null;
          archive_download_url?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
          expires_at?: string | null;
        }>;
      };
    }>;
    downloadArtifact(input: {
      owner: string;
      repo: string;
      artifact_id: number;
      archive_format: "zip";
    }): Promise<{ data: ArrayBuffer | Uint8Array | Buffer | string }>;
  };
}

export class GitHubIssueWorkSource implements WorkSource<string> {
  private readonly client: OctokitLike;

  public constructor(token: string, client?: OctokitLike) {
    this.client = client ?? (new Octokit({ auth: token }) as unknown as OctokitLike);
  }

  public async load(input: string) {
    const parsed = parseGitHubIssueUrl(input);
    const response = await this.client.issues.get({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.issueNumber
    });
    const body = response.data.body?.trim();

    if (!body) {
      throw new Error(`GitHub issue ${input} does not contain an execution brief body.`);
    }

    const brief = parseExecutionBriefMarkdown(body);
    return {
      ...brief,
      issueUrl: response.data.html_url ?? input
    };
  }
}

export class GitHubMirror implements IssueMirror, ChangeRequestPublisher, PullRequestReviewSource, CommitSignatureVerificationSource, WorkflowArtifactSource, WorkflowDispatcher, WorkflowRunSource {
  private readonly client: OctokitLike;

  public constructor(token: string, client?: OctokitLike) {
    this.client = client ?? (new Octokit({ auth: token }) as unknown as OctokitLike);
  }

  public async mirrorRequirement(input: { owner: string; repo: string; requirement: Requirement }): Promise<ExternalRef> {
    const response = await this.client.issues.create({
      owner: input.owner,
      repo: input.repo,
      title: input.requirement.title,
      body: `${input.requirement.body}\n\n<!-- afk:requirement:${input.requirement.id} -->`,
      labels: ["afk:requirement"]
    });
    return this.buildExternalRef("requirement", input.requirement.id, "issue", response.data.id, response.data.number, response.data.html_url);
  }

  public async mirrorWorkItem(input: { owner: string; repo: string; workItem: WorkItem; requirement: Requirement }): Promise<ExternalRef> {
    const labels = ["afk:work-item", input.workItem.type === "afk" ? "afk:afk" : "afk:hitl"];
    const response = await this.client.issues.create({
      owner: input.owner,
      repo: input.repo,
      title: input.workItem.title,
      body: [
        `Parent requirement: ${input.requirement.title}`,
        "",
        input.workItem.body,
        "",
        "Acceptance criteria:",
        ...input.workItem.acceptanceCriteria.map((criterion) => `- ${criterion}`),
        "",
        `<!-- afk:work_item:${input.workItem.id} -->`
      ].join("\n"),
      labels
    });
    return this.buildExternalRef("work_item", input.workItem.id, "issue", response.data.id, response.data.number, response.data.html_url);
  }

  public async commentOnIssue(input: { owner: string; repo: string; issueNumber: number; body: string }): Promise<void> {
    await this.client.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
      body: input.body
    });
  }

  public async syncIssues(input: { owner: string; repo: string; refs: ExternalRef[] }): Promise<Array<{ refId: string; open: boolean; comments: Array<{ id: string; body: string; createdAt: string }> }>> {
    const results: Array<{ refId: string; open: boolean; comments: Array<{ id: string; body: string; createdAt: string }> }> = [];

    for (const ref of input.refs) {
      const issue = await this.client.issues.get({
        owner: input.owner,
        repo: input.repo,
        issue_number: ref.remoteNumber
      });
      const comments = await this.client.issues.listComments({
        owner: input.owner,
        repo: input.repo,
        issue_number: ref.remoteNumber,
        per_page: 100
      });
      results.push({
        refId: ref.id,
        open: issue.data.state === "open",
        comments: comments.data.map((comment) => ({
          id: String(comment.id),
          body: comment.body ?? "",
          createdAt: comment.created_at ?? new Date(0).toISOString()
        }))
      });
    }

    return results;
  }

  public async openPullRequest(input: { owner: string; repo: string; changeRequest: ChangeRequest }): Promise<ExternalRef> {
    const response = await this.client.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.changeRequest.title,
      head: input.changeRequest.branchName,
      base: input.changeRequest.baseBranch,
      body: `${input.changeRequest.body}\n\n<!-- afk:work_item:${input.changeRequest.workItemId} -->`
    });
    return this.buildExternalRef("work_item", input.changeRequest.workItemId, "pull_request", response.data.id, response.data.number, response.data.html_url);
  }

  public async closePullRequest(input: { owner: string; repo: string; pullNumber: number }): Promise<void> {
    await this.client.pulls.update({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      state: "closed"
    });
  }

  public async syncPullRequests(input: { owner: string; repo: string; refs: ExternalRef[] }): Promise<Array<{ refId: string; state: "open" | "closed"; merged: boolean }>> {
    const results: Array<{ refId: string; state: "open" | "closed"; merged: boolean }> = [];

    for (const ref of input.refs) {
      const response = await this.client.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: ref.remoteNumber
      });
      results.push({
        refId: ref.id,
        state: response.data.state === "open" ? "open" : "closed",
        merged: response.data.merged
      });
    }

    return results;
  }

  public async listPullRequestReviewComments(input: { owner: string; repo: string; pullNumber: number }): Promise<Array<{ id: string; body: string; path?: string; line?: number }>> {
    const response = await this.client.pulls.listReviewComments({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      per_page: 100
    });

    return response.data
      .filter((comment) => !comment.outdated && (comment.body ?? "").trim().length > 0)
      .map((comment) => ({
        id: String(comment.id),
        body: comment.body ?? "",
        ...(comment.path ? { path: comment.path } : {}),
        ...(typeof comment.line === "number" ? { line: comment.line } : {})
      }));
  }

  public async verifyCommitSignatures(input: { owner: string; repo: string; shas: string[] }): Promise<Array<{ sha: string; verified: boolean; reason?: string }>> {
    if (!this.client.repos) {
      throw new Error("GitHub commit verification API is unavailable");
    }
    return await Promise.all(input.shas.map(async (sha) => {
      const response = await this.client.repos!.getCommit({ owner: input.owner, repo: input.repo, ref: sha });
      const verification = response.data.commit.verification;
      return {
        sha,
        verified: verification?.verified === true,
        ...(verification?.reason ? { reason: verification.reason } : {})
      };
    }));
  }

  public async dispatchWorkflow(input: {
    owner: string;
    repo: string;
    workflowId: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void> {
    await this.client.actions.createWorkflowDispatch({
      owner: input.owner,
      repo: input.repo,
      workflow_id: input.workflowId,
      ref: input.ref,
      inputs: input.inputs
    });
  }

  public async listWorkflowRuns(input: {
    owner: string;
    repo: string;
    workflowId: string;
    limit: number;
  }): Promise<Array<{ id: string; correlationId?: string; name?: string; status?: string; conclusion?: string; branch?: string; event?: string; url?: string; createdAt?: string; updatedAt?: string }>> {
    const response = await this.client.actions.listWorkflowRuns({
      owner: input.owner,
      repo: input.repo,
      workflow_id: input.workflowId,
      per_page: input.limit
    });

    return response.data.workflow_runs.map((run) => ({
      id: String(run.id),
      ...(run.display_title ? { correlationId: run.display_title } : {}),
      ...(run.name ? { name: run.name } : {}),
      ...(run.status ? { status: run.status } : {}),
      ...(run.conclusion ? { conclusion: run.conclusion } : {}),
      ...(run.head_branch ? { branch: run.head_branch } : {}),
      ...(run.event ? { event: run.event } : {}),
      ...(run.html_url ? { url: run.html_url } : {}),
      ...(run.created_at ? { createdAt: run.created_at } : {}),
      ...(run.updated_at ? { updatedAt: run.updated_at } : {})
    }));
  }

  public async listWorkflowArtifacts(input: {
    owner: string;
    repo: string;
    runId: string;
    limit: number;
  }): Promise<Array<{ id: string; name: string; sizeInBytes?: number; expired?: boolean; url?: string; archiveDownloadUrl?: string; createdAt?: string; updatedAt?: string; expiresAt?: string }>> {
    const response = await this.client.actions.listWorkflowRunArtifacts({
      owner: input.owner,
      repo: input.repo,
      run_id: Number(input.runId),
      per_page: input.limit
    });

    return response.data.artifacts.map((artifact) => ({
      id: String(artifact.id),
      name: artifact.name,
      ...(typeof artifact.size_in_bytes === "number" ? { sizeInBytes: artifact.size_in_bytes } : {}),
      ...(typeof artifact.expired === "boolean" ? { expired: artifact.expired } : {}),
      ...(artifact.url ? { url: artifact.url } : {}),
      ...(artifact.archive_download_url ? { archiveDownloadUrl: artifact.archive_download_url } : {}),
      ...(artifact.created_at ? { createdAt: artifact.created_at } : {}),
      ...(artifact.updated_at ? { updatedAt: artifact.updated_at } : {}),
      ...(artifact.expires_at ? { expiresAt: artifact.expires_at } : {})
    }));
  }

  public async downloadWorkflowArtifact(input: {
    owner: string;
    repo: string;
    artifactId: string;
  }): Promise<Uint8Array> {
    const response = await this.client.actions.downloadArtifact({
      owner: input.owner,
      repo: input.repo,
      artifact_id: Number(input.artifactId),
      archive_format: "zip"
    });

    return toUint8Array(response.data);
  }

  private buildExternalRef(entityType: ExternalRef["entityType"], entityId: string, remoteType: ExternalRef["remoteType"], remoteId: number, remoteNumber: number, url?: string): ExternalRef {
    const now = new Date().toISOString();
    return {
      id: createId("xref"),
      entityType,
      entityId,
      provider: "github",
      remoteType,
      remoteNumber,
      remoteId: String(remoteId),
      createdAt: now,
      updatedAt: now,
      ...(url ? { url } : {})
    };
  }
}

function toUint8Array(data: ArrayBuffer | Uint8Array | Buffer | string): Uint8Array {
  if (typeof data === "string") {
    return Buffer.from(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }

  return new Uint8Array(data);
}

export class GitHubPullRequestPublisher implements ResultPublisher {
  public constructor(
    private readonly codeHost: CodeHost,
    private readonly publisher: ChangeRequestPublisher,
    private readonly remote: { owner: string; repo: string }
  ) {}

  public async publish(input: {
    workItem: HydratedWorkItem;
    branchName: string;
    worktreePath: string;
    baseBranch: string;
    summary: string;
    agentName: string;
    modelLabel: string;
    requireVerifiedCommitSignatures?: boolean;
    pullRequest?: {
      title: string;
      body: string;
      manualQa?: string[];
    };
  }): Promise<PublicationResult> {
    await this.codeHost.pushBranch({
      cwd: input.worktreePath,
      branchName: input.branchName
    });

    if (input.requireVerifiedCommitSignatures) {
      const verifier = asCommitSignatureVerificationSource(this.publisher);
      if (!this.codeHost.listCommitsSince || !verifier) {
        throw new Error("GitHub verified-signature confirmation is unavailable after push");
      }
      const shas = await this.codeHost.listCommitsSince({ cwd: input.worktreePath, baseBranch: input.baseBranch });
      const verification = await verifier.verifyCommitSignatures({ owner: this.remote.owner, repo: this.remote.repo, shas });
      const rejected = verification.filter((commit) => !commit.verified);
      if (rejected.length > 0) {
        throw new Error(`GitHub rejected commit signature verification for ${rejected.map((commit) => `${commit.sha}${commit.reason ? ` (${commit.reason})` : ""}`).join(", ")}`);
      }
    }

    const ref = await this.publisher.openPullRequest({
      owner: this.remote.owner,
      repo: this.remote.repo,
      changeRequest: {
        workItemId: input.workItem.id,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
        title: input.pullRequest?.title ?? `AFK: ${input.workItem.title}`,
        body: buildPullRequestBody(input)
      }
    });

    return {
      externalRef: ref,
      ...(ref.url ? { url: ref.url } : {})
    };
  }
}

function asCommitSignatureVerificationSource(value: ChangeRequestPublisher): CommitSignatureVerificationSource | undefined {
  return "verifyCommitSignatures" in value && typeof value.verifyCommitSignatures === "function"
    ? value as ChangeRequestPublisher & CommitSignatureVerificationSource
    : undefined;
}

function buildPullRequestBody(input: {
  workItem: HydratedWorkItem;
  summary: string;
  agentName: string;
  modelLabel: string;
  pullRequest?: {
    body: string;
    manualQa?: string[];
  };
}): string {
  const whatChanged = sanitizeChangeSummary(input.pullRequest?.body ?? input.summary);
  const manualQa = input.pullRequest?.manualQa?.filter(Boolean) ?? [];

  return [
    "## What Changed",
    "",
    whatChanged,
    "",
    "## Why",
    "",
    input.workItem.body,
    "",
    "## Model Used",
    "",
    `- ${input.modelLabel}`,
    "",
    "## Manual QA",
    "",
    ...(manualQa.length > 0 ? manualQa.map((step) => `- ${step}`) : ["- Not provided by the run"]),
    "",
    "## Agent",
    "",
    `- This change was completed by ${input.agentName}`
  ].join("\n");
}

function sanitizeChangeSummary(source: string): string {
  const lines = source
    .split("\n")
    .filter((line) => !/claude code/i.test(line))
    .map((line) => line.trimEnd());
  const sanitized = lines.join("\n").trim();
  return sanitized || "No structured change summary was provided.";
}

function parseGitHubIssueUrl(input: string): { owner: string; repo: string; issueNumber: number } {
  const match = input.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/);

  if (!match) {
    throw new Error(`Invalid GitHub issue URL: ${input}`);
  }

  return {
    owner: match[1]!,
    repo: match[2]!,
    issueNumber: Number(match[3])
  };
}
