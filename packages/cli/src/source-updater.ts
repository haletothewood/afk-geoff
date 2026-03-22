import type { IssueMirror, SourceUpdatePayload, SourceUpdater } from "@afk-geoff/core";

export class GitHubSourceUpdater implements SourceUpdater {
  public constructor(
    private readonly mirror: IssueMirror,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number
  ) {}

  public async update(payload: SourceUpdatePayload): Promise<void> {
    const body = payload.issueComment.trim();
    if (!body) return;
    await this.mirror.commentOnIssue({ owner: this.owner, repo: this.repo, issueNumber: this.issueNumber, body });
  }
}

export class NoOpSourceUpdater implements SourceUpdater {
  public async update(_payload: SourceUpdatePayload): Promise<void> {}
}

export function parseGitHubIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url);
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]!, issueNumber: Number(match[3]) };
}

export async function tryPostSourceUpdate(updater: SourceUpdater, payload: SourceUpdatePayload): Promise<void> {
  try {
    await updater.update(payload);
  } catch {
    // Source update failures are non-fatal; the run outcome takes precedence.
  }
}
