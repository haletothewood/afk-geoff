import type { ChangeRequestPublisher, ExternalRef, IssueMirror, ChangeRequest, Requirement, WorkItem } from "@afk-geoff/core";
import { createId } from "@afk-geoff/shared";
import { Octokit } from "@octokit/rest";

export interface OctokitLike {
  issues: {
    create(input: { owner: string; repo: string; title: string; body: string; labels?: string[] }): Promise<{ data: { id: number; number: number; html_url?: string } }>;
    createComment(input: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
    get(input: { owner: string; repo: string; issue_number: number }): Promise<{ data: { state: string } }>;
    listComments(input: { owner: string; repo: string; issue_number: number; per_page?: number }): Promise<{ data: Array<{ id: number; body?: string; created_at?: string }> }>;
  };
  pulls: {
    create(input: { owner: string; repo: string; title: string; head: string; base: string; body: string }): Promise<{ data: { id: number; number: number; html_url?: string } }>;
    get(input: { owner: string; repo: string; pull_number: number }): Promise<{ data: { state: string; merged: boolean } }>;
  };
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
      body: `${input.requirement.body}\n\n<!-- aiwf:requirement:${input.requirement.id} -->`,
      labels: ["aiwf:requirement"]
    });
    return this.buildExternalRef("requirement", input.requirement.id, "issue", response.data.id, response.data.number, response.data.html_url);
  }

  public async mirrorWorkItem(input: { owner: string; repo: string; workItem: WorkItem; requirement: Requirement }): Promise<ExternalRef> {
    const labels = ["aiwf:work-item", input.workItem.type === "afk" ? "aiwf:afk" : "aiwf:hitl"];
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
        `<!-- aiwf:work_item:${input.workItem.id} -->`
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
      body: `${input.changeRequest.body}\n\n<!-- aiwf:work_item:${input.changeRequest.workItemId} -->`
    });
    return this.buildExternalRef("work_item", input.changeRequest.workItemId, "pull_request", response.data.id, response.data.number, response.data.html_url);
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
