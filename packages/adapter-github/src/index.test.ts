import { describe, expect, it } from "vitest";
import { GitHubMirror, type OctokitLike } from "./index.js";

interface RecordedIssueCreate {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

function createMockClient(): OctokitLike & { issueCreates: RecordedIssueCreate[] } {
  const issueCreates: RecordedIssueCreate[] = [];

  return {
    issueCreates,
    issues: {
      async create(input) {
        issueCreates.push(input);
        return { data: { id: 12 + issueCreates.length, number: 34 + issueCreates.length, html_url: `https://example.com/issues/${34 + issueCreates.length}` } };
      },
      async createComment() {
        return {};
      },
      async get() {
        return { data: { state: "open" } };
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
      async create() {
        return { data: { id: 44, number: 55, html_url: "https://example.com/pulls/55" } };
      },
      async get() {
        return { data: { state: "closed", merged: true } };
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
    expect(client.issueCreates[0]?.labels).toEqual(["aiwf:requirement"]);
    expect(client.issueCreates[0]?.body).toContain("<!-- aiwf:requirement:req_1 -->");
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
    expect(client.issueCreates[0]?.labels).toEqual(["aiwf:work-item", "aiwf:afk"]);
    expect(client.issueCreates[0]?.body).toContain("Acceptance criteria:");
    expect(client.issueCreates[0]?.body).toContain("- works");
    expect(client.issueCreates[0]?.body).toContain("<!-- aiwf:work_item:wi_1 -->");
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
});
