import { Hono } from 'hono'
import { GitHubApiClient } from "./github";
import { WarpcastApiClient } from "./warpcast";
import { GithubEvent, WarpcastVerification, CachedFeed, SimplifiedEvent } from './types';
import { cors } from "hono/cors"

type Bindings = {
  NEYNAR_API_KEY: string;
  GITHUB_USERS: KVNamespace;
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(cors())

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

// Get GitHub events for a user's following (those with GitHub verifications)
app.get("/feed/:fid", async (c) => {
  const githubClient = new GitHubApiClient(c);
  const warpcastClient = new WarpcastApiClient(c);
  const kv = c.env.GITHUB_USERS;

  try {
    const fid = parseInt(c.req.param('fid'));
    const limit = parseInt(c.req.query('limit') || '30');

    if (isNaN(fid)) {
      return c.json({ message: "Invalid FID format" }, { status: 400 });
    }

    // Check cache for user's feed
    const cacheKey = `feed_${fid}`;
    const cachedFeed = await kv?.get(cacheKey, 'json') as CachedFeed | null;
    const cacheAge = cachedFeed?.timestamp ? Date.now() - cachedFeed.timestamp : Infinity;

    // Return cached feed if it's less than 5 minutes old
    if (cachedFeed && cacheAge < 5 * 60 * 1000) {
      return c.json({
        events: cachedFeed.events.slice(0, limit),
        fromCache: true,
        cacheAge: Math.round(cacheAge / 1000)
      });
    }

    // Get followed accounts + user's own FID
    const followingData = await warpcastClient.getFollowing(fid);
    const followingFids = [...followingData.users.map(item => item.user.fid), fid];

    // Get GitHub verifications (using cached data where available)
    const verifiedUsers = await warpcastClient.getVerifiedGithubUsersForFids(c, followingFids);

    if (verifiedUsers.length === 0) {
      return c.json({
        message: "No GitHub verifications found",
        events: []
      });
    }

    // Fetch events in parallel (limited batch size to avoid rate limits)
    const batchSize = 5;
    let allEvents: SimplifiedEvent[] = [];

    for (let i = 0; i < verifiedUsers.length; i += batchSize) {
      const batch = verifiedUsers.slice(i, i + batchSize);
      const eventPromises = batch.map(user =>
        githubClient.getUserEvents(user.platformUsername, 1, 10)
          .then(events => events.map(event => simplifyEvent(event, user)))
      );

      const batchEvents = await Promise.all(eventPromises);
      allEvents = [...allEvents, ...batchEvents.flat()];
    }

    // Sort all events by creation date (newest first)
    allEvents.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // Cache the results
    if (kv) {
      await kv.put(cacheKey, JSON.stringify({
        events: allEvents,
        timestamp: Date.now()
      }), { expirationTtl: 3600 }); // 1 hour TTL as a backup
    }

    return c.json({
      events: allEvents.slice(0, limit),
      fromCache: false
    });
  } catch (error) {
    console.error("Error fetching GitHub feed:", error);
    return c.json({ message: "Failed to fetch GitHub events" }, { status: 500 });
  }
});

// Helper function to simplify event data
function simplifyEvent(event: GithubEvent, user: WarpcastVerification): SimplifiedEvent {
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

// Extract meaningful action description from event
function getEventAction(event: GithubEvent): string {
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

function getEventUrl(event: GithubEvent): string {
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
function getCommitMessage(event: GithubEvent): string | null {
  if (event.type === 'PushEvent' && event.payload?.commits?.length > 0) {
    return event.payload.commits[0].message;
  }
  return null;
}

function getCommitUrl(event: GithubEvent): string | null {
  if (event.type === 'PushEvent' && event.payload?.commits?.length > 0) {
    return `https://github.com/${event.repo.name}/commit/${event.payload.commits[0].sha}`
  }
  return null;
}

export default app
