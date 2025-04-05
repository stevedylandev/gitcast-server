import { z } from "zod";

// Define GitHub API response types
export const GithubUserSchema = z.object({
  login: z.string(),
  id: z.number(),
  avatar_url: z.string(),
  url: z.string(),
  html_url: z.string(),
  name: z.string().optional(),
  bio: z.string().optional()
});

export type GithubUser = z.infer<typeof GithubUserSchema>;

export const GithubEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  actor: z.object({
    id: z.number(),
    login: z.string(),
    display_login: z.string().optional(),
    avatar_url: z.string()
  }),
  repo: z.object({
    id: z.number(),
    name: z.string(),
    url: z.string()
  }),
  payload: z.any(),
  public: z.boolean(),
  created_at: z.string()
});

export type GithubEvent = z.infer<typeof GithubEventSchema> & {
  username?: string;
  fid?: number;
  created_at: Date | string;
};

export const GithubEventsArray = z.array(GithubEventSchema);

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
  // Add Farcaster info
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
