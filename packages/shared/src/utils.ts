import type { GithubEvent, SimplifiedEvent, WarpcastVerification } from "./types";

export function getEventAction(event: GithubEvent): string {
  switch (event.type) {
    case 'PushEvent':
      const commitCount = event.payload?.commits?.length || 0;
      return `pushed ${commitCount} commit${commitCount !== 1 ? 's' : ''}`;
    case 'CreateEvent':
      return `created ${event.payload?.ref_type || 'repository'}`;
    case 'PullRequestEvent':
      return `${event.payload?.action || 'updated'} pull request`;
    case 'IssuesEvent':
      return `${event.payload?.action || 'updated'} issue`;
    case 'IssueCommentEvent':
      return 'commented on issue';
    case 'WatchEvent':
      return 'starred repository';
    case 'ForkEvent':
      return 'forked repository';
    default:
      return event.type.replace('Event', '');
  }
}

export function getEventUrl(event: GithubEvent): string {
  // Default to the repository URL
  const repoUrl = `https://github.com/${event.repo.name}`;

  switch (event.type) {
    case 'PushEvent':
      // If we have a commit, use the commit URL, otherwise fallback to repo
      return event.payload?.commits?.length > 0
        ? `${repoUrl}/commit/${event.payload.commits[0].sha}`
        : repoUrl;

    case 'PullRequestEvent':
      // Link to the pull request
      return event.payload?.pull_request?.html_url ||
        `${repoUrl}/pull/${event.payload?.number}`;

    case 'IssuesEvent':
      // Link to the issue
      return event.payload?.issue?.html_url ||
        `${repoUrl}/issues/${event.payload?.issue?.number}`;

    case 'IssueCommentEvent':
      // Link to the comment or fall back to the issue
      return event.payload?.comment?.html_url ||
        event.payload?.issue?.html_url ||
        `${repoUrl}/issues/${event.payload?.issue?.number}`;

    case 'CreateEvent':
      // Link to the branch, tag, or repository
      if (event.payload?.ref_type === 'branch') {
        return `${repoUrl}/tree/${event.payload.ref}`;
      } else if (event.payload?.ref_type === 'tag') {
        return `${repoUrl}/releases/tag/${event.payload.ref}`;
      }
      return repoUrl;

    case 'DeleteEvent':
      // Just link to the repository since the branch/tag is gone
      return repoUrl;

    case 'ForkEvent':
      // Link to the forked repository
      return event.payload?.forkee?.html_url || repoUrl;

    case 'WatchEvent':
      // Link to the repository's stargazers
      return `${repoUrl}`;

    case 'ReleaseEvent':
      // Link to the release
      return event.payload?.release?.html_url || `${repoUrl}/releases`;

    case 'CommitCommentEvent':
      // Link to the commit comment
      return event.payload?.comment?.html_url || repoUrl;

    case 'PullRequestReviewEvent':
      // Link to the review
      return event.payload?.review?.html_url ||
        event.payload?.pull_request?.html_url ||
        `${repoUrl}/pull/${event.payload?.pull_request?.number}`;

    case 'PullRequestReviewCommentEvent':
      // Link to the review comment
      return event.payload?.comment?.html_url ||
        event.payload?.pull_request?.html_url ||
        `${repoUrl}/pull/${event.payload?.pull_request?.number}`;

    case 'PublicEvent':
      // Link to the repository that was made public
      return repoUrl;

    case 'MemberEvent':
      // Link to the repository's contributors
      return `${repoUrl}/graphs/contributors`;

    default:
      // Default to repository URL for any other event type
      return repoUrl;
  }
}


// Extract commit message if available
export function getCommitMessage(event: GithubEvent): string | null {
  if (event.type === 'PushEvent' && event.payload?.commits?.length > 0) {
    return event.payload.commits[0].message;
  }
  return null;
}

export function getCommitUrl(event: GithubEvent): string | null {
  if (event.type === 'PushEvent' && event.payload?.commits?.length > 0) {
    return `https://github.com/${event.repo.name}/commit/${event.payload.commits[0].sha}`
  }
  return null;
}

export function simplifyEvent(event: GithubEvent, user: WarpcastVerification): SimplifiedEvent {
  const simpleEvent: SimplifiedEvent = {
    id: event.id,
    type: event.type,
    created_at: event.created_at,
    actor: {
      login: event.actor.login,
      avatar_url: event.actor.avatar_url
    },
    repo: {
      name: event.repo.name,
      url: `https://github.com/${event.repo.name}`
    },
    fid: user.fid,
    action: getEventAction(event),
    commitMessage: getCommitMessage(event),
    commitUrl: getCommitUrl(event),
    eventUrl: getEventUrl(event)
  };

  // Only add Farcaster info if we have a username
  if (user.farcasterUsername) {
    simpleEvent.farcaster = {
      username: user.farcasterUsername,
      display_name: user.farcasterDisplayName || user.farcasterUsername,
      pfp_url: user.farcasterPfpUrl || ''
    };
  }

  return simpleEvent;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> {
  let lastError: Error;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }

  throw lastError!;
}
