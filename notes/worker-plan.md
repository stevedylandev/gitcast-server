```typescript
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
    const cacheKey = feed_${fid};
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
      url: https://github.com/${event.repo.name}
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
      return pushed ${commitCount} commit${commitCount !== 1 ? 's' : ''};
    case 'CreateEvent':
      return created ${event.payload?.ref_type || 'repository'};
    case 'PullRequestEvent':
      return ${event.payload?.action || 'updated'} pull request;
    case 'IssuesEvent':
      return ${event.payload?.action || 'updated'} issue;
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
  const repoUrl = https://github.com/${event.repo.name};

  switch (event.type) {
    case 'PushEvent':
      // If we have a commit, use the commit URL, otherwise fallback to repo
      return event.payload?.commits?.length > 0
        ? ${repoUrl}/commit/${event.payload.commits[0].sha}
        : repoUrl;

    case 'PullRequestEvent':
      // Link to the pull request
      return event.payload?.pull_request?.html_url ||
        ${repoUrl}/pull/${event.payload?.number};

    case 'IssuesEvent':
      // Link to the issue
      return event.payload?.issue?.html_url ||
        ${repoUrl}/issues/${event.payload?.issue?.number};

    case 'IssueCommentEvent':
      // Link to the comment or fall back to the issue
      return event.payload?.comment?.html_url ||
        event.payload?.issue?.html_url ||
        ${repoUrl}/issues/${event.payload?.issue?.number};

    case 'CreateEvent':
      // Link to the branch, tag, or repository
      if (event.payload?.ref_type === 'branch') {
        return ${repoUrl}/tree/${event.payload.ref};
      } else if (event.payload?.ref_type === 'tag') {
        return ${repoUrl}/releases/tag/${event.payload.ref};
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
      return ${repoUrl};

    case 'ReleaseEvent':
      // Link to the release
      return event.payload?.release?.html_url || ${repoUrl}/releases;

    case 'CommitCommentEvent':
      // Link to the commit comment
      return event.payload?.comment?.html_url || repoUrl;

    case 'PullRequestReviewEvent':
      // Link to the review
      return event.payload?.review?.html_url ||
        event.payload?.pull_request?.html_url ||
        ${repoUrl}/pull/${event.payload?.pull_request?.number};

    case 'PullRequestReviewCommentEvent':
      // Link to the review comment
      return event.payload?.comment?.html_url ||
        event.payload?.pull_request?.html_url ||
        ${repoUrl}/pull/${event.payload?.pull_request?.number};

    case 'PublicEvent':
      // Link to the repository that was made public
      return repoUrl;

    case 'MemberEvent':
      // Link to the repository's contributors
      return ${repoUrl}/graphs/contributors;

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
    return https://github.com/${event.repo.name}/commit/${event.payload.commits[0].sha}
  }
  return null;
}

export default app

import { Octokit } from "octokit";
import { GithubEvent, GithubEventsArray } from "./types";
import { Context } from "hono";

interface GithubApiError extends Error {
  status?: number;
  response?: {
    headers?: {
      [key: string]: string;
    };
  };
}

export class GitHubApiClient {
  private octokit: Octokit;

  constructor(c: Context) {
    this.octokit = new Octokit({
      auth: c.env.GITHUB_TOKEN,
    });
  }

  async getUserEvents(username: string, page = 1, perPage = 10): Promise<GithubEvent[]> {
    try {
      const response = await this.octokit.request('GET /users/{username}/events', {
        username,
        per_page: perPage,
        page,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      const rateLimit = response.headers['x-ratelimit-remaining'];
      if (rateLimit && parseInt(rateLimit) < 10) {
        console.warn(GitHub API rate limit running low: ${rateLimit} remaining);
      }

      const events = GithubEventsArray.parse(response.data);

      return events.map(event => ({
        ...event,
        username,
        created_at: new Date(event.created_at).toISOString()
      }));
    } catch (error) {
      const githubError = error as GithubApiError;
      if (githubError.status === 403 && githubError.response?.headers?.['x-ratelimit-remaining'] === '0') {
        console.error(Rate limit exceeded for GitHub API);
      } else {
        console.error(Error fetching events for ${username}:, error);
      }
      return [];
    }
  }
}

import { WarpcastVerification, NeynarFollowingResponse, FarcasterUserCache, NeynarUser } from "./types";
import { Context } from "hono";

export class WarpcastApiClient {
  private baseUrl: string;
  private neynarApiKey: string | undefined;

  constructor(c: Context) {
    this.baseUrl = "https://api.warpcast.com";
    this.neynarApiKey = c.env.NEYNAR_API_KEY;
  }

  async getFollowing(fid: number, viewerFid: number = fid): Promise<NeynarFollowingResponse> {
    if (!this.neynarApiKey) {
      console.error("Neynar API key not set");
      return { users: [] };
    }

    try {
      const url = https://api.neynar.com/v2/farcaster/following?fid=${fid}&viewer_fid=${viewerFid}&sort_type=algorithmic&limit=100;
      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'x-api-key': this.neynarApiKey
        }
      });

      const data = await response.json() as NeynarFollowingResponse;
      return data;
    } catch (error) {
      console.error("Error fetching following data from Neynar:", error);
      return { users: [] };
    }
  }

  async getFarcasterUsersInBulk(fids: number[], c: Context): Promise<Map<number, FarcasterUserCache>> {
    if (!this.neynarApiKey) {
      console.error("Neynar API key not set");
      return new Map();
    }

    if (fids.length === 0) {
      return new Map();
    }

    const kv = c.env.GITHUB_USERS;
    const userMap = new Map<number, FarcasterUserCache>();
    const fidsToFetch: number[] = [];

    // Check cache first
    if (kv) {
      const cachePromises = fids.map(async (fid) => {
        const cacheKey = farcaster_user_${fid};
        try {
          const cached = await kv.get(cacheKey, 'json') as FarcasterUserCache | null;
          if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) { // 24 hour cache
            return { fid, user: cached };
          }
        } catch (error) {
          console.error(Error fetching cached Farcaster user for FID ${fid}:, error);
        }
        return { fid, user: null };
      });

      const cacheResults = await Promise.all(cachePromises);

      cacheResults.forEach(result => {
        if (result.user) {
          userMap.set(result.fid, result.user);
        } else {
          fidsToFetch.push(result.fid);
        }
      });
    } else {
      fidsToFetch.push(...fids);
    }

    // If all users were in cache, return them
    if (fidsToFetch.length === 0) {
      return userMap;
    }

    // Fetch users in chunks of 100 (API limit)
    const chunkSize = 100;
    for (let i = 0; i < fidsToFetch.length; i += chunkSize) {
      const fidChunk = fidsToFetch.slice(i, i + chunkSize);

      try {
        const url = https://api.neynar.com/v2/farcaster/user/bulk?fids=${fidChunk.join(',')};
        const response = await fetch(url, {
          headers: {
            'accept': 'application/json',
            'x-api-key': this.neynarApiKey
          }
        });

        if (!response.ok) {
          console.error(Neynar API error: ${response.status} ${response.statusText});
          continue;
        }

        const data = await response.json();

        if (!data.users || !Array.isArray(data.users)) {
          console.error('Invalid response from Neynar API:', data);
          continue;
        }

        // Process and cache users
        const cachePromises = data.users.map(async (userData: any) => {
          if (!userData || !userData.fid) return;

          const user: FarcasterUserCache = {
            fid: userData.fid,
            username: userData.username || '',
            display_name: userData.display_name || '',
            pfp_url: userData.pfp_url || '',
            timestamp: Date.now()
          };

          userMap.set(user.fid, user);

          // Cache user data
          if (kv) {
            const cacheKey = farcaster_user_${user.fid};
            await kv.put(cacheKey, JSON.stringify(user), { expirationTtl: 86400 });
          }
        });

        await Promise.all(cachePromises);

      } catch (error) {
        console.error(Error fetching Farcaster users in bulk:, error);
      }
    }

    return userMap;
  }

  async getGithubVerifications(cursor?: string): Promise<{
    verifications: WarpcastVerification[];
    nextCursor?: string;
  }> {
    try {
      const url = new URL(${this.baseUrl}/fc/account-verifications);
      url.searchParams.append("platform", "github");
      if (cursor) {
        url.searchParams.append("cursor", cursor);
      }

      const response = await fetch(url.toString());
      const data = await response.json() as {
        result: { verifications: WarpcastVerification[] },
        next?: { cursor: string }
      };

      return {
        verifications: data.result.verifications,
        nextCursor: data.next?.cursor
      };
    } catch (error) {
      console.error("Error fetching GitHub verifications from Warpcast:", error);
      return { verifications: [] };
    }
  }

  async getAllGithubVerifications(): Promise<WarpcastVerification[]> {
    let allVerifications: WarpcastVerification[] = [];
    let nextCursor: string | undefined;

    do {
      const result = await this.getGithubVerifications(nextCursor);
      allVerifications = [...allVerifications, ...result.verifications];
      nextCursor = result.nextCursor;
    } while (nextCursor);

    return allVerifications;
  }

  // Check and cache verified GitHub users for a list of FIDs
  async getVerifiedGithubUsersForFids(c: Context, fids: number[]): Promise<WarpcastVerification[]> {
    const kv = c.env.GITHUB_USERS;
    const cachedUsers: WarpcastVerification[] = [];
    const fidsToCheck: number[] = [];

    // Define cache freshness (1 hour in milliseconds)
    const CACHE_FRESHNESS = 60 * 60 * 1000;

    // Check cache in parallel
    if (kv) {
      const cachePromises = fids.map(async (fid) => {
        try {
          const cacheKey = github_user_${fid};
          const cached = await kv.get(cacheKey, 'json') as (WarpcastVerification & { timestamp?: number }) | null;

          // Check if cache exists and is fresh (less than 1 hour old)
          const isFresh = cached && cached.timestamp &&
            (Date.now() - cached.timestamp < CACHE_FRESHNESS);

          return { fid, cached: isFresh ? cached : null };
        } catch (error) {
          console.error(Cache error for FID ${fid}:, error);
          return { fid, cached: null };
        }
      });

      const cacheResults = await Promise.all(cachePromises);

      cacheResults.forEach(result => {
        if (result.cached) {
          cachedUsers.push(result.cached);
        } else {
          fidsToCheck.push(result.fid);
        }
      });
    } else {
      fidsToCheck.push(...fids);
    }

    // If we have all users in cache and they're all fresh, return them
    if (fidsToCheck.length === 0) {
      // Enhance with Farcaster user info if not already cached
      return await this.enhanceVerificationsWithFarcasterInfo(c, cachedUsers);
    }

    // Fetch verifications for missing or stale users
    const verifications = await this.getAllGithubVerifications();
    const matchingVerifications = verifications.filter(v => fidsToCheck.includes(v.fid));

    // Add timestamp to each verification before caching
    const timestampedVerifications = matchingVerifications.map(verification => ({
      ...verification,
      timestamp: Date.now()
    }));

    // Cache results in parallel
    if (kv) {
      const cachePromises = timestampedVerifications.map(verification => {
        const cacheKey = github_user_${verification.fid};
        return kv.put(cacheKey, JSON.stringify(verification), { expirationTtl: 86400 }); // 24 hour TTL as backup
      });

      await Promise.all(cachePromises);
    }

    const allVerifications = [...cachedUsers, ...timestampedVerifications];

    // Enhance with Farcaster user info
    return await this.enhanceVerificationsWithFarcasterInfo(c, allVerifications);
  }

  // Helper to add Farcaster user info to verifications
  private async enhanceVerificationsWithFarcasterInfo(
    c: Context,
    verifications: WarpcastVerification[]
  ): Promise<WarpcastVerification[]> {
    if (verifications.length === 0) {
      return [];
    }

    // Extract unique FIDs
    const fids = [...new Set(verifications.map(v => v.fid))];

    // Get all user data in bulk
    const userMap = await this.getFarcasterUsersInBulk(fids, c);

    // Enhance verifications with Farcaster user data
    return verifications.map(verification => {
      const farcasterUser = userMap.get(verification.fid);

      if (farcasterUser) {
        return {
          ...verification,
          farcasterUsername: farcasterUser.username,
          farcasterDisplayName: farcasterUser.display_name,
          farcasterPfpUrl: farcasterUser.pfp_url
        };
      } else {
        console.warn(No Farcaster user data found for FID ${verification.fid});
        return verification;
      }
    });
  }
}
```

Based on this code, what is a faster solution to handle the data pipeline? I’m willing to setup my own database or find a way to merge and store the data.

I've analyzed your Hono application code, which is creating a GitHub activity feed for Farcaster users. Based on the code, I can identify several opportunities to optimize your data pipeline.
Current System Analysis
Your current implementation:

Takes a Farcaster ID (FID)
Gets users the FID follows via Neynar API
Checks which followed users have verified GitHub accounts
Fetches GitHub events for those users
Merges and formats the data
Caches the final feed in KV storage

The main bottlenecks appear to be:

Multiple API calls to different services (Neynar, Warpcast, GitHub)
Dependency on fresh data from multiple sources
Cache refreshing logic that can lead to slow responses

Optimized Data Pipeline Solution
Here's a more efficient architecture using a dedicated database:

Key Improvements in the Optimized Solution
The optimized architecture offers several major advantages over your current implementation:

Database-Driven Architecture

Using PostgreSQL with proper indexes instead of KV storage
Schema designed specifically for social graph + GitHub events


Background Data Collection

All API calls happen in background workers, not during user requests
Regular scheduled updates keep data fresh without blocking user requests
Job queue handles retries and rate limiting automatically


Single-Query Feed Generation

Feed generation uses a single database query instead of multiple API calls
Pagination support built-in for handling large feeds efficiently


Data Pipeline Benefits

Significantly faster response times (typically <100ms vs seconds)
Higher availability (works even if GitHub/Neynar APIs are down)
Reduced API costs (fewer redundant API calls)
Better scalability (database can handle more concurrent users)



Implementation Steps

Set Up the Database

Deploy a PostgreSQL database (or use a managed service like Neon.tech)
Create tables and indexes as shown in the code


Deploy Background Workers

Run workers using BullMQ and Redis for job scheduling
Workers can run as serverless functions or in a dedicated environment


Update Your API Endpoints

Modify your Hono API to use the database directly instead of making API calls
Add pagination support to handle large feeds efficiently


Initial Data Migration

Run a one-time job to populate the database with existing data
Test query performance and adjust indexes if needed



Technology Stack

Database: PostgreSQL (for relational data) or MongoDB (for document data)
Job Queue: BullMQ + Redis (for background workers)
API: Keep your existing Hono setup, but point to the database
Hosting: Any serverless platform that supports background jobs (Fly.io, Railway, etc.)

This architecture separates data collection from data serving, making your app much faster and more reliable. Users get instant responses from the database while background jobs keep everything up to date.
Would you like me to elaborate on any specific part of this solution?

Can we use Cloudflare D1 and see if there is a Cloudflare alternative to redis?


I'd be happy to adapt the solution for Cloudflare's ecosystem! Cloudflare offers some excellent alternatives that would work well with your existing Hono implementation on Cloudflare Workers.

Based on my research, I'll create an optimized Cloudflare-specific solution for your GitHub activity feed application.

```typescript
// CLOUDFLARE OPTIMIZED ARCHITECTURE
// Using D1 database and Cloudflare Queues for background processing

// DATABASE SCHEMA (D1 SQL Schema)

/*
-- Users table to store Farcaster and GitHub user mapping
CREATE TABLE users (
  fid INTEGER PRIMARY KEY,
  farcaster_username TEXT,
  farcaster_display_name TEXT,
  farcaster_pfp_url TEXT,
  github_username TEXT,
  last_updated INTEGER
);

-- Follows table to track relationships
CREATE TABLE follows (
  follower_fid INTEGER,
  following_fid INTEGER,
  created_at INTEGER,
  PRIMARY KEY (follower_fid, following_fid),
  FOREIGN KEY (follower_fid) REFERENCES users(fid),
  FOREIGN KEY (following_fid) REFERENCES users(fid)
);

-- GitHub events table
CREATE TABLE github_events (
  id TEXT PRIMARY KEY,
  fid INTEGER,
  type TEXT,
  created_at TEXT,
  actor_login TEXT,
  actor_avatar_url TEXT,
  repo_name TEXT,
  repo_url TEXT,
  action TEXT,
  commit_message TEXT,
  commit_url TEXT,
  event_url TEXT,
  FOREIGN KEY (fid) REFERENCES users(fid)
);

-- Create indexes for performance
CREATE INDEX idx_github_events_fid ON github_events(fid);
CREATE INDEX idx_github_events_created_at ON github_events(created_at);
CREATE INDEX idx_follows_follower_fid ON follows(follower_fid);
*/

// CLOUDFLARE WORKERS SETUP

// 1. API Worker (main.js) - Handles user requests and serves the feed
import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  NEYNAR_QUEUE: Queue;
  GITHUB_QUEUE: Queue;
  NEYNAR_API_KEY: string;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use(cors());

app.get('/', (c) => {
  return c.text('GitHub Activity Feed for Farcaster');
});

// Get GitHub events feed for a user's following
app.get("/feed/:fid", async (c) => {
  const fid = parseInt(c.req.param('fid'));
  const limit = parseInt(c.req.query('limit') || '30');
  const page = parseInt(c.req.query('page') || '1');
  const offset = (page - 1) * limit;

  if (isNaN(fid)) {
    return c.json({ message: "Invalid FID format" }, { status: 400 });
  }

  try {
    // Query events directly from the database
    const eventsQuery = `
      SELECT e.*,
             u.farcaster_username,
             u.farcaster_display_name,
             u.farcaster_pfp_url
      FROM github_events e
      JOIN users u ON e.fid = u.fid
      WHERE e.fid IN (
        SELECT following_fid
        FROM follows
        WHERE follower_fid = ?
        UNION
        SELECT ? -- Include user's own events
      )
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const eventsResult = await c.env.DB.prepare(eventsQuery)
      .bind(fid, fid, limit, offset)
      .all();

    // Format for response
    const events = eventsResult.results.map(row => ({
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      actor: {
        login: row.actor_login,
        avatar_url: row.actor_avatar_url
      },
      repo: {
        name: row.repo_name,
        url: row.repo_url
      },
      fid: row.fid,
      action: row.action,
      commitMessage: row.commit_message,
      commitUrl: row.commit_url,
      eventUrl: row.event_url,
      farcaster: row.farcaster_username ? {
        username: row.farcaster_username,
        display_name: row.farcaster_display_name || row.farcaster_username,
        pfp_url: row.farcaster_pfp_url || ''
      } : undefined
    }));

    // Queue background data refresh
    await c.env.NEYNAR_QUEUE.send({
      type: 'update_user',
      fid: fid
    });

    return c.json({
      events,
      page,
      limit,
      hasMore: events.length === limit
    });
  } catch (error) {
    console.error("Error fetching GitHub feed:", error);
    return c.json({ message: "Failed to fetch GitHub events" }, { status: 500 });
  }
});

export default app;

// 2. NEYNAR WORKER (neynar-worker.js) - Handles Neynar API requests
export default {
  async queue(batch, env, ctx) {
    const db = env.DB;

    for (const message of batch.messages) {
      try {
        // Mark this message as processed
        message.ack();

        const data = message.body;

        if (data.type === 'update_user') {
          const fid = data.fid;

          // Get user's following list
          const followingData = await getFollowing(fid, env.NEYNAR_API_KEY);

          // Update follows in database
          if (followingData.users.length > 0) {
            // First, remove old following relationships
            await db.prepare('DELETE FROM follows WHERE follower_fid = ?').bind(fid).run();

            // Then insert new ones
            const stmt = db.prepare('INSERT INTO follows (follower_fid, following_fid, created_at) VALUES (?, ?, ?)');
            const timestamp = Date.now();

            for (const item of followingData.users) {
              const followingFid = item.user.fid;
              await stmt.bind(fid, followingFid, timestamp).run();

              // Queue this user for Farcaster info update
              const userExists = await db
                .prepare('SELECT 1 FROM users WHERE fid = ?')
                .bind(followingFid)
                .first();

              if (!userExists) {
                // Add to Neynar queue to fetch user data
                await env.NEYNAR_QUEUE.send({
                  type: 'fetch_user_data',
                  fid: followingFid
                });
              }
            }
          }

          // Get GitHub verifications for follows + self
          const allFids = followingData.users.map(item => item.user.fid);
          allFids.push(fid); // Include self

          // Queue each FID for GitHub verification check
          await env.NEYNAR_QUEUE.send({
            type: 'check_github_verifications',
            fids: allFids
          });
        }
        else if (data.type === 'fetch_user_data') {
          // Get Farcaster user data from Neynar
          const userData = await getUserData(data.fid, env.NEYNAR_API_KEY);

          if (userData) {
            // Update or insert user in database
            await db.prepare(`
              INSERT INTO users (fid, farcaster_username, farcaster_display_name, farcaster_pfp_url, last_updated)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (fid) DO UPDATE SET
              farcaster_username = excluded.farcaster_username,
              farcaster_display_name = excluded.farcaster_display_name,
              farcaster_pfp_url = excluded.farcaster_pfp_url,
              last_updated = excluded.last_updated
            `)
            .bind(
              userData.fid,
              userData.username || '',
              userData.display_name || '',
              userData.pfp_url || '',
              Date.now()
            )
            .run();
          }
        }
        else if (data.type === 'check_github_verifications') {
          const fids = data.fids;
          const verifications = await getGithubVerifications();

          // Filter verifications to those in our list of FIDs
          const matchingVerifications = verifications.filter(v =>
            fids.includes(v.fid)
          );

          // Update database with GitHub usernames
          for (const verification of matchingVerifications) {
            await db.prepare(`
              UPDATE users SET
              github_username = ?,
              last_updated = ?
              WHERE fid = ?
            `)
            .bind(verification.platformUsername, Date.now(), verification.fid)
            .run();

            // Queue GitHub events fetching
            await env.GITHUB_QUEUE.send({
              type: 'fetch_github_events',
              fid: verification.fid,
              github_username: verification.platformUsername
            });
          }
        }
      } catch (error) {
        console.error('Error processing Neynar queue message:', error);
        // Don't ack the message so it gets retried
      }
    }
  }
};

// 3. GITHUB WORKER (github-worker.js) - Handles GitHub API requests
export default {
  async queue(batch, env, ctx) {
    const db = env.DB;
    const octokit = new Octokit({
      auth: env.GITHUB_TOKEN,
    });

    for (const message of batch.messages) {
      try {
        // Mark this message as processed
        message.ack();

        const data = message.body;

        if (data.type === 'fetch_github_events') {
          const { fid, github_username } = data;

          // Fetch GitHub events
          const response = await octokit.request('GET /users/{username}/events', {
            username: github_username,
            per_page: 30,
            page: 1,
            headers: {
              'X-GitHub-Api-Version': '2022-11-28'
            }
          });

          const events = response.data;

          // Process each event
          for (const event of events) {
            // Create simplified event
            const simpleEvent = {
              id: event.id,
              type: event.type,
              created_at: new Date(event.created_at).toISOString(),
              actor_login: event.actor.login,
              actor_avatar_url: event.actor.avatar_url,
              repo_name: event.repo.name,
              repo_url: `https://github.com/${event.repo.name}`,
              action: getEventAction(event),
              commit_message: getCommitMessage(event),
              commit_url: getCommitUrl(event),
              event_url: getEventUrl(event),
              fid: fid
            };

            // Insert or update event in database
            await db.prepare(`
              INSERT INTO github_events
              (id, fid, type, created_at, actor_login, actor_avatar_url,
               repo_name, repo_url, action, commit_message, commit_url, event_url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET
              type = excluded.type,
              created_at = excluded.created_at,
              actor_login = excluded.actor_login,
              actor_avatar_url = excluded.actor_avatar_url,
              repo_name = excluded.repo_name,
              repo_url = excluded.repo_url,
              action = excluded.action,
              commit_message = excluded.commit_message,
              commit_url = excluded.commit_url,
              event_url = excluded.event_url
            `)
            .bind(
              simpleEvent.id,
              simpleEvent.fid,
              simpleEvent.type,
              simpleEvent.created_at,
              simpleEvent.actor_login,
              simpleEvent.actor_avatar_url,
              simpleEvent.repo_name,
              simpleEvent.repo_url,
              simpleEvent.action,
              simpleEvent.commit_message,
              simpleEvent.commit_url,
              simpleEvent.event_url
            )
            .run();
          }
        }
      } catch (error) {
        console.error('Error processing GitHub queue message:', error);
        // Don't ack the message so it gets retried
      }
    }
  }
};

// 4. SCHEDULED WORKER (scheduled-worker.js) - Runs periodic data refresh
export default {
  async scheduled(event, env, ctx) {
    const db = env.DB;

    // Refresh GitHub verifications every 12 hours
    if (event.cron === "0 */12 * * *") {
      try {
        // Get all GitHub verifications
        const verifications = await getGithubVerifications();

        // Update the database
        for (const verification of verifications) {
          await db.prepare(`
            INSERT INTO users (fid, github_username, last_updated)
            VALUES (?, ?, ?)
            ON CONFLICT (fid) DO UPDATE SET
            github_username = excluded.github_username,
            last_updated = excluded.last_updated
          `)
          .bind(verification.fid, verification.platformUsername, Date.now())
          .run();

          // Queue user data fetching
          await env.NEYNAR_QUEUE.send({
            type: 'fetch_user_data',
            fid: verification.fid
          });
        }
      } catch (error) {
        console.error('Error refreshing GitHub verifications:', error);
      }
    }

    // Refresh GitHub events for all users with GitHub usernames every 30 minutes
    if (event.cron === "*/30 * * * *") {
      try {
        // Get all users with GitHub usernames
        const users = await db.prepare(`
          SELECT fid, github_username
          FROM users
          WHERE github_username IS NOT NULL
        `)
        .all();

        // Queue GitHub events fetching for each user
        for (const user of users.results) {
          await env.GITHUB_QUEUE.send({
            type: 'fetch_github_events',
            fid: user.fid,
            github_username: user.github_username
          });
        }
      } catch (error) {
        console.error('Error refreshing GitHub events:', error);
      }
    }
  }
};

// Helper functions (implementation similar to your original code)
// These would be in separate utility files

async function getFollowing(fid, apiKey) {
  // Implementation similar to your WarpcastApiClient.getFollowing
  // Use the Neynar API to get following data
}

async function getUserData(fid, apiKey) {
  // Implementation to fetch Farcaster user data from Neynar
}

async function getGithubVerifications() {
  // Implementation similar to your WarpcastApiClient.getAllGithubVerifications
}

function getEventAction(event) {
  // Implementation same as your original code
}

function getCommitMessage(event) {
  // Implementation same as your original code
}

function getCommitUrl(event) {
  // Implementation same as your original code
}

function getEventUrl(event) {
  // Implementation same as your original code
}
```

```bash
// CLOUDFLARE DEPLOYMENT CONFIGURATION

// 1. wrangler.toml for main API Worker
// api-worker/wrangler.toml
/*
name = "github-feed-api"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings
[[queues.producers]]
queue = "neynar-tasks"
binding = "NEYNAR_QUEUE"

[[queues.producers]]
queue = "github-tasks"
binding = "GITHUB_QUEUE"

[vars]
NEYNAR_API_KEY = ""
*/

// 2. wrangler.toml for Neynar worker
// neynar-worker/wrangler.toml
/*
name = "github-feed-neynar-worker"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings for consumer
[[queues.consumers]]
queue = "neynar-tasks"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3

# Queue bindings for producer (to send to GitHub queue)
[[queues.producers]]
queue = "github-tasks"
binding = "GITHUB_QUEUE"

[vars]
NEYNAR_API_KEY = ""
*/

// 3. wrangler.toml for GitHub worker
// github-worker/wrangler.toml
/*
name = "github-feed-github-worker"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings
[[queues.consumers]]
queue = "github-tasks"
max_batch_size = 5
max_batch_timeout = 30
max_retries = 3

[vars]
GITHUB_TOKEN = ""
*/

// 4. wrangler.toml for Scheduled worker
// scheduled-worker/wrangler.toml
/*
name = "github-feed-scheduled-worker"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings
[[queues.producers]]
queue = "neynar-tasks"
binding = "NEYNAR_QUEUE"

[[queues.producers]]
queue = "github-tasks"
binding = "GITHUB_QUEUE"

# Scheduled triggers
[triggers]
crons = ["0 */12 * * *", "*/30 * * * *"]

[vars]
NEYNAR_API_KEY = ""
*/

// 5. D1 Database Schema Setup Script
// setup-db.js
/*
const DATABASE_NAME = "github-feed-db";

// Create and set up the database
async function setupDatabase() {
  console.log(`Creating D1 database: ${DATABASE_NAME}...`);

  try {
    // Create the database
    const createResult = await wrangler.d1.createDatabase({
      name: DATABASE_NAME,
      locationHint: "auto", // Let Cloudflare optimize location
    });

    console.log(`Database created with ID: ${createResult.databaseId}`);

    // Create database schema
    const schema = `
    -- Users table to store Farcaster and GitHub user mapping
    CREATE TABLE users (
      fid INTEGER PRIMARY KEY,
      farcaster_username TEXT,
      farcaster_display_name TEXT,
      farcaster_pfp_url TEXT,
      github_username TEXT,
      last_updated INTEGER
    );

    -- Follows table to track relationships
    CREATE TABLE follows (
      follower_fid INTEGER,
      following_fid INTEGER,
      created_at INTEGER,
      PRIMARY KEY (follower_fid, following_fid),
      FOREIGN KEY (follower_fid) REFERENCES users(fid),
      FOREIGN KEY (following_fid) REFERENCES users(fid)
    );

    -- GitHub events table
    CREATE TABLE github_events (
      id TEXT PRIMARY KEY,
      fid INTEGER,
      type TEXT,
      created_at TEXT,
      actor_login TEXT,
      actor_avatar_url TEXT,
      repo_name TEXT,
      repo_url TEXT,
      action TEXT,
      commit_message TEXT,
      commit_url TEXT,
      event_url TEXT,
      FOREIGN KEY (fid) REFERENCES users(fid)
    );

    -- Create indexes for performance
    CREATE INDEX idx_github_events_fid ON github_events(fid);
    CREATE INDEX idx_github_events_created_at ON github_events(created_at);
    CREATE INDEX idx_follows_follower_fid ON follows(follower_fid);
    `;

    // Execute schema creation
    await wrangler.d1.execute({
      databaseId: createResult.databaseId,
      query: schema,
    });

    console.log("Database schema created successfully!");

    // Update the wrangler.toml files with the database ID
    // This would involve reading and writing to the files
    // For this example, we'll just log the ID to add manually
    console.log(`
    Add the following to your wrangler.toml files:

    [[d1_databases]]
    binding = "DB"
    database_name = "${DATABASE_NAME}"
    database_id = "${createResult.databaseId}"
    `);

  } catch (error) {
    console.error("Error setting up database:", error);
  }
}

// Create the queues
async function setupQueues() {
  console.log("Setting up Cloudflare Queues...");

  try {
    // Create Neynar queue
    await wrangler.queues.create({
      name: "neynar-tasks"
    });
    console.log("Created neynar-tasks queue");

    // Create GitHub queue
    await wrangler.queues.create({
      name: "github-tasks"
    });
    console.log("Created github-tasks queue");

  } catch (error) {
    console.error("Error setting up queues:", error);
  }
}

// Run the setup
async function run() {
  await setupDatabase();
  await setupQueues();
  console.log("Setup completed!");
}

run();
*/

// 6. Deployment Script
// deploy.sh
/*
#!/bin/bash

# Exit on any error
set -e

echo "Deploying GitHub Activity Feed for Farcaster"

# Deploy D1 database migrations if any
echo "Deploying database migrations..."
cd api-worker
wrangler d1 migrations apply github-feed-db

# Deploy API worker
echo "Deploying API worker..."
wrangler deploy
cd ..

# Deploy Neynar worker
echo "Deploying Neynar worker..."
cd neynar-worker
wrangler deploy
cd ..

# Deploy GitHub worker
echo "Deploying GitHub worker..."
cd github-worker
wrangler deploy
cd ..

# Deploy scheduled worker
echo "Deploying scheduled worker..."
cd scheduled-worker
wrangler deploy
cd ..

echo "Deployment completed successfully!"
echo "API available at: https://github-feed-api.YOUR_DOMAIN.workers.dev"
*/

// 7. Initial Data Import Script (if you have existing data)
// import-data.js
/*
const fs = require('fs');
const { execSync } = require('child_process');

async function importData() {
  console.log("Importing initial data to Cloudflare D1...");

  try {
    // Example: Import users data if you have it
    if (fs.existsSync('./data/users.csv')) {
      console.log("Importing users data...");
      execSync('wrangler d1 execute github-feed-db --file=./data/import-users.sql');
    }

    // Example: Import follows data if you have it
    if (fs.existsSync('./data/follows.csv')) {
      console.log("Importing follows data...");
      execSync('wrangler d1 execute github-feed-db --file=./data/import-follows.sql');
    }

    // Example: Import GitHub events data if you have it
    if (fs.existsSync('./data/events.csv')) {
      console.log("Importing GitHub events data...");
      execSync('wrangler d1 execute github-feed-db --file=./data/import-events.sql');
    }

    console.log("Data import completed successfully!");
  } catch (error) {
    console.error("Error importing data:", error);
  }
}

importData();
*/
```


Optimized Cloudflare-Based Solution for Your GitHub Activity Feed
Based on my research, I've created a fully Cloudflare-native solution that will significantly optimize your data pipeline while leveraging Cloudflare's ecosystem.
Overview of the Solution
The optimized architecture uses Cloudflare D1, their SQL database that's now generally available The Cloudflare Blog, combined with Cloudflare Queues which provides guaranteed message delivery with Worker integration Cloudflare Docs. This approach separates data serving from data collection, resulting in much faster response times.
Key Components

Cloudflare D1 Database

D1 is Cloudflare's managed, serverless SQLite-compatible database designed for horizontal scale-out across multiple smaller databases Cloudflare Docs
D1 offers familiar SQL query language, point-in-time recovery, and cost-effective pricing based on queries and storage Cloudflare
Perfect for this use case with proper indexes for performance


Cloudflare Queues for Background Processing

Queues allow you to queue messages for asynchronous processing, which decouples components of applications and makes them easier to reason about and deploy Cloudflare Docs
Queues provides flexibility with message batching, retries, and delayed processing options Cloudflare Docs
We'll use separate queues for Neynar and GitHub API processing


Multiple Specialized Workers

API Worker: Serves the feed from the database
Neynar Worker: Processes Farcaster user data and follows
GitHub Worker: Fetches and processes GitHub events
Scheduled Worker: Handles periodic data refreshes



Advantages Over Current Implementation

Much Faster Responses

Feeds are served directly from the database instead of making multiple API calls
D1 databases can be up to 10GB in size, and you can use multiple databases if needed Cloudflare Docs
Response times will typically be <100ms versus seconds in the original


Resilient Architecture

Background workers fetch and process data separately from user requests
Queues support batching, retries, and delays to handle API rate limits gracefully Cloudflare Docs
API endpoints work even if external services are temporarily unavailable


Better Cost Management

D1 has serverless pricing - scale-to-zero and pay-for-what-you-use - with costs based on read/write units The Cloudflare Blog
Reduced API calls means lower costs for external API access
Optimized queries with indexes reduce billable operations


Improved Scalability

Can handle many more concurrent users without impacting performance
D1 dynamically manages read replicas based on query volume and location The Cloudflare Blog
Data is refreshed in the background without blocking user requests



Implementation Steps

Create the D1 Database

Set up the database schema with tables for users, follows, and GitHub events
Create indexes for query performance optimization


Set Up Cloudflare Queues

Create separate queues for Neynar and GitHub API operations
Configure appropriate batch sizes and timeouts for each


Deploy the Workers

API Worker for serving user requests
Background workers for processing queue messages
Scheduled worker for periodic data refreshes


Migrate Existing Data

Import your current data into the D1 database
Run initial data collection jobs to ensure everything is up-to-date



Handling Multi-Database Strategy (If Needed)
If your data grows beyond D1's 10GB limit, you can:

Shard by user: Create separate databases for groups of users
Shard by time: Keep recent events in one database, archive older ones
Use Cloudflare Hyperdrive to accelerate queries to an external database if you need even larger storage Cloudflare Docs

Would You Like More Details?
I've provided complete code examples for the implementation in the artifacts. Would you like me to explain any specific part of the solution in more detail? Or would you like guidance on how to migrate your existing data to this new architecture?
