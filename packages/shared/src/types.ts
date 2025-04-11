import type { D1Database, Queue } from "@cloudflare/workers-types"
// Define GitHub API response types
export interface GithubUser {
  login: string;
  id: number;
  avatar_url: string;
  url: string;
  html_url: string;
  name?: string;
  bio?: string;
}

export interface GithubEvent {
  id: string;
  type: string;
  actor: {
    id: number;
    login: string;
    display_login?: string;
    avatar_url: string;
  };
  repo: {
    id: number;
    name: string;
    url: string;
  };
  payload: any;
  public: boolean;
  created_at: string | Date;
  username?: string;
  fid?: number;
}

export type GithubEventsArray = GithubEvent[];

// Warpcast verification type
export type WarpcastVerification = {
  fid: number;
  platform: string;
  platformId: string;
  platformUsername: string;
  verifiedAt: number;
  farcasterUsername?: string;
  farcasterDisplayName?: string;
  farcasterPfpUrl?: string;
  timestamp?: number;
};

// Neynar API response types
export interface NeynarUser {
  object: string;
  fid: number;
  username: string;
  display_name: string;
  custody_address: string;
  pfp_url: string;
  follower_count: number;
  following_count: number;
  profile?: {
    bio?: {
      text: string;
    };
  };
}

export interface NeynarFollowItem {
  object: string;
  user: NeynarUser;
}

export interface NeynarFollowingResponse {
  users: NeynarFollowItem[];
  next?: {
    cursor: string;
  };
}

// For caching feed data
export interface CachedFeed {
  events: SimplifiedEvent[];
  timestamp: number;
}

// For the simplified event returned to client
export interface SimplifiedEvent {
  id: string;
  type: string;
  created_at: string | Date;
  actor: {
    login: string;
    avatar_url: string;
  };
  repo: {
    name: string;
    url: string;
  };
  fid: number;
  action: string;
  commitMessage: string | null;
  commitUrl: string | null;
  eventUrl: string;
  farcaster?: {
    username: string;
    display_name?: string;
    pfp_url: string;
  };
}

// For storing Farcaster user data in KV
export interface FarcasterUserCache {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string;
  timestamp: number;
}

export interface NeynarQueueMessage {
  type: 'update_user' | 'fetch_user_data' | 'check_github_verifications';
  fid?: number;
  fids?: number[];
}

export interface GitHubQueueMessage {
  type: 'fetch_github_events';
  fid: number;
  github_username: string;
}

// Environment types for Workers
export interface Env {
  DB: D1Database;
  neynar_tasks: Queue;
  github_tasks: Queue;
  NEYNAR_API_KEY: string;
  GITHUB_TOKEN: string;
}
