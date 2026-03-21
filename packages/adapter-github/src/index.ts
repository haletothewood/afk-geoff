import type { ChangeRequestPublisher, CodeHost, ExternalRef, HydratedWorkItem, IssueMirror, ChangeRequest, PublicationResult, Requirement, ResultPublisher, WorkItem, WorkSource } from "@afk-geoff/core";
import { createId, parseExecutionBriefMarkdown } from "@afk-geoff/shared";
import { Octokit } from "@octokit/rest";

export interface OctokitLike {
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

export class GitHubMirror implements IssueMirror, ChangeRequestPublisher {
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
