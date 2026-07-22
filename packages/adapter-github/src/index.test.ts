import { describe, expect, it, vi } from "vitest";
import { GitHubIssueWorkSource, GitHubMirror, GitHubPullRequestPublisher, type OctokitLike } from "./index.js";

interface RecordedIssueCreate {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

interface RecordedPullCreate {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body: string;
}

function createMockClient(): OctokitLike & { issueCreates: RecordedIssueCreate[]; pullCreates: RecordedPullCreate[] } {
  const issueCreates: RecordedIssueCreate[] = [];
  const pullCreates: RecordedPullCreate[] = [];

  return {
    issueCreates,
    pullCreates,
    issues: {
      async create(input) {
        issueCreates.push(input);
        return { data: { id: 12 + issueCreates.length, number: 34 + issueCreates.length, html_url: `https://example.com/issues/${34 + issueCreates.length}` } };
      },
      async createComment() {
        return {};
      },
      async get() {
        return {
          data: {
            state: "open",
            title: "Execution brief",
            body: [
              "# AFK Execution Brief",
              "",
              "## Requirement",
              "Ship a narrow internal improvement.",
              "",
              "## Work Item Title",
              "Run from issue",
              "",
              "## Work Item Body",
              "Use a GitHub issue as the source artifact.",
              "",
              "## Acceptance Criteria",
              "- The issue body can be parsed as an execution brief"
            ].join("\n"),
            html_url: "https://github.com/acme/demo/issues/34"
          }
        };
      },
      async listComments() {
        return {
          data: [
            {
              id: 99,
              body: "hello",
              created_at: "2026-01-01T00:00:00.000Z"
            }
          ]
        };
      }
    },
    pulls: {
      async create(input) {
        pullCreates.push(input);
        return { data: { id: 44, number: 55, html_url: "https://example.com/pulls/55" } };
      },
      async update() {
        return {};
      },
      async get() {
        return { data: { state: "closed", merged: true } };
      },
      async listReviewComments() {
        return {
          data: [
            {
              id: 101,
              body: "Please add error handling.",
              path: "src/app.ts",
              line: 12,
              outdated: false
            },
            {
              id: 102,
              body: "Old comment",
              path: "src/old.ts",
              line: 3,
              outdated: true
            }
          ]
        };
      }
    }
  };
}

describe("GitHubMirror adapter scenarios", () => {
  it("Given a requirement is mirrored, then it becomes a labeled parent issue with a stable marker", async () => {
    const client = createMockClient();
    const mirror = new GitHubMirror("token", client);

    const requirement = await mirror.mirrorRequirement({
      owner: "acme",
      repo: "demo",
      requirement: {
        id: "req_1",
        title: "Req",
        body: "Body",
        status: "captured",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    });

    expect(requirement.remoteType).toBe("issue");
    expect(client.issueCreates).toHaveLength(1);
    expect(client.issueCreates[0]?.labels).toEqual(["afk:requirement"]);
    expect(client.issueCreates[0]?.body).toContain("<!-- afk:requirement:req_1 -->");
  });

  it("Given a work item is mirrored, then it becomes a labeled child issue with acceptance criteria and a marker", async () => {
    const client = createMockClient();
    const mirror = new GitHubMirror("token", client);

    const workItem = await mirror.mirrorWorkItem({
      owner: "acme",
      repo: "demo",
      requirement: {
        id: "req_1",
        title: "Req",
        body: "Body",
        status: "captured",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      workItem: {
        id: "wi_1",
        requirementId: "req_1",
        title: "Item",
        body: "Do thing",
        type: "afk",
        status: "todo",
        planKey: "item",
        executionSummary: "Summary",
        acceptanceCriteria: ["works"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    });

    expect(workItem.remoteType).toBe("issue");
    expect(client.issueCreates).toHaveLength(1);
    expect(client.issueCreates[0]?.labels).toEqual(["afk:work-item", "afk:afk"]);
    expect(client.issueCreates[0]?.body).toContain("Acceptance criteria:");
    expect(client.issueCreates[0]?.body).toContain("- works");
    expect(client.issueCreates[0]?.body).toContain("<!-- afk:work_item:wi_1 -->");
  });

  it("Given mirrored issues and pull requests exist, when sync runs, then state and comments are imported", async () => {
    const mirror = new GitHubMirror("token", createMockClient());
    const [issueState] = await mirror.syncIssues({
      owner: "acme",
      repo: "demo",
      refs: [
        {
          id: "xref_1",
          entityType: "work_item",
          entityId: "wi_1",
          provider: "github",
          remoteType: "issue",
          remoteNumber: 34,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    const [pullState] = await mirror.syncPullRequests({
      owner: "acme",
      repo: "demo",
      refs: [
        {
          id: "xref_2",
          entityType: "work_item",
          entityId: "wi_1",
          provider: "github",
          remoteType: "pull_request",
          remoteNumber: 55,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    expect(issueState).toBeDefined();
    expect(pullState).toBeDefined();
    if (!issueState || !pullState) {
      throw new Error("Missing sync state");
    }
    expect(issueState.open).toBe(true);
    expect(issueState.comments[0]?.body).toBe("hello");
    expect(pullState.merged).toBe(true);
  });

  it("Given a pull request exists, when closePullRequest is called, then the adapter closes it through GitHub", async () => {
    const client = createMockClient();
    const mirror = new GitHubMirror("token", client);

    await expect(mirror.closePullRequest({
      owner: "acme",
      repo: "demo",
      pullNumber: 55
    })).resolves.toBeUndefined();
  });

  it("Given a GitHub issue URL, when the issue body is an execution brief, then it becomes a normalized work source input", async () => {
    const source = new GitHubIssueWorkSource("token", createMockClient());

    const brief = await source.load("https://github.com/acme/demo/issues/34");

    expect(brief.workItemTitle).toBe("Run from issue");
    expect(brief.acceptanceCriteria).toEqual(["The issue body can be parsed as an execution brief"]);
    expect(brief.issueUrl).toBe("https://github.com/acme/demo/issues/34");
  });

  it("Given GitHub PR publishing is requested, then the branch is pushed and a pull request is opened through the adapter", async () => {
    const client = createMockClient();
    const mirror = new GitHubMirror("token", client);
    const codeHost = {
      assertRepository: vi.fn(),
      getRemoteSlug: vi.fn(),
      createWorktree: vi.fn(),
      createWorktreeFromBranch: vi.fn(),
      removeWorktree: vi.fn(),
      commitAll: vi.fn(),
      pushBranch: vi.fn(),
      deleteRemoteBranch: vi.fn(),
      deleteLocalBranch: vi.fn(),
      hasDiffAgainst: vi.fn()
    };
    const publisher = new GitHubPullRequestPublisher(codeHost, mirror, {
      owner: "acme",
      repo: "demo"
    });

    const result = await publisher.publish({
      workItem: {
        id: "wi_1",
        requirementId: "req_1",
        title: "Ship change",
        body: "Do thing",
        type: "afk",
        status: "todo",
        planKey: "ship-change",
        executionSummary: "Summary",
        acceptanceCriteria: ["works"],
        dependencyIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      branchName: "afk/ship-change-123",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
      summary: "Done",
      agentName: "Geoff",
      modelLabel: "Claude CLI default (no explicit model configured)",
      pullRequest: {
        title: "AFK: Ship change",
        body: "Implemented the requested change.\n\nDone by Claude Code",
        manualQa: ["Open the page and confirm the new state renders"]
      }
    });

    expect(codeHost.pushBranch).toHaveBeenCalledWith({
      cwd: "/tmp/worktree",
      branchName: "afk/ship-change-123"
    });
    expect(client.pullCreates[0]?.body).toContain("## What Changed");
    expect(client.pullCreates[0]?.body).toContain("## Why");
    expect(client.pullCreates[0]?.body).toContain("## Model Used");
    expect(client.pullCreates[0]?.body).toContain("## Manual QA");
    expect(client.pullCreates[0]?.body).toContain("## Agent");
    expect(client.pullCreates[0]?.body).toContain("This change was completed by Geoff");
    expect(client.pullCreates[0]?.body).toContain("Claude CLI default (no explicit model configured)");
    expect(client.pullCreates[0]?.body).not.toContain("Claude Code");
    expect(result.url).toBe("https://example.com/pulls/55");
  });

  it("Given PR review comments exist, when they are listed, then current actionable comments are returned", async () => {
    const mirror = new GitHubMirror("token", createMockClient());

    const comments = await mirror.listPullRequestReviewComments({
      owner: "acme",
      repo: "demo",
      pullNumber: 55
    });

    expect(comments).toEqual([
      {
        id: "101",
        body: "Please add error handling.",
        path: "src/app.ts",
        line: 12
      }
    ]);
  });
});
