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
      const url = `https://api.neynar.com/v2/farcaster/following?fid=${fid}&viewer_fid=${viewerFid}&sort_type=algorithmic&limit=100`;
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

  async getFarcasterUser(fid: number, c: Context): Promise<FarcasterUserCache | null> {
    const kv = c.env.GITHUB_USERS;
    const cacheKey = `farcaster_user_${fid}`;

    // Check cache first
    if (kv) {
      try {
        const cached = await kv.get(cacheKey, 'json') as FarcasterUserCache | null;
        if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) { // 24 hour cache
          return cached;
        }
      } catch (error) {
        console.error(`Error fetching cached Farcaster user for FID ${fid}:`, error);
      }
    }

    // If no cached data, fetch it
    if (!this.neynarApiKey) {
      console.error("Neynar API key not set");
      return null;
    }

    try {
      const url = `https://api.neynar.com/v2/farcaster/user?fid=${fid}`;
      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'x-api-key': this.neynarApiKey
        }
      });

      const data = await response.json();

      if (!data.user) {
        return null;
      }

      const user: FarcasterUserCache = {
        fid: data.user.fid,
        username: data.user.username,
        display_name: data.user.display_name,
        pfp_url: data.user.pfp_url,
        timestamp: Date.now()
      };

      // Cache the user data
      if (kv) {
        await kv.put(cacheKey, JSON.stringify(user), { expirationTtl: 86400 });
      }

      return user;
    } catch (error) {
      console.error(`Error fetching Farcaster user for FID ${fid}:`, error);
      return null;
    }
  }

  async getGithubVerifications(cursor?: string): Promise<{
    verifications: WarpcastVerification[];
    nextCursor?: string;
  }> {
    try {
      const url = new URL(`${this.baseUrl}/fc/account-verifications`);
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

    // Check cache in parallel
    if (kv) {
      const cachePromises = fids.map(async (fid) => {
        try {
          const cacheKey = `github_user_${fid}`;
          const cached = await kv.get(cacheKey, 'json') as WarpcastVerification | null;
          return { fid, cached };
        } catch (error) {
          console.error(`Cache error for FID ${fid}:`, error);
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

    // If we have all users in cache, return them
    if (fidsToCheck.length === 0) {
      // Enhance with Farcaster user info if not already cached
      return await this.enhanceVerificationsWithFarcasterInfo(c, cachedUsers);
    }

    // Fetch verifications for missing users
    const verifications = await this.getAllGithubVerifications();
    const matchingVerifications = verifications.filter(v => fidsToCheck.includes(v.fid));

    // Cache results in parallel
    if (kv) {
      const cachePromises = matchingVerifications.map(verification => {
        const cacheKey = `github_user_${verification.fid}`;
        return kv.put(cacheKey, JSON.stringify(verification), { expirationTtl: 86400 }); // 24 hour TTL
      });

      await Promise.all(cachePromises);
    }

    const allVerifications = [...cachedUsers, ...matchingVerifications];

    // Enhance with Farcaster user info
    return await this.enhanceVerificationsWithFarcasterInfo(c, allVerifications);
  }

  // Helper to add Farcaster user info to verifications
  private async enhanceVerificationsWithFarcasterInfo(
    c: Context,
    verifications: WarpcastVerification[]
  ): Promise<WarpcastVerification[]> {
    const enhanced: WarpcastVerification[] = [];

    for (const verification of verifications) {
      const farcasterUser = await this.getFarcasterUser(verification.fid, c);

      if (farcasterUser) {
        enhanced.push({
          ...verification,
          farcasterUsername: farcasterUser.username,
          farcasterDisplayName: farcasterUser.display_name,
          farcasterPfpUrl: farcasterUser.pfp_url
        });
      } else {
        enhanced.push(verification);
      }
    }

    return enhanced;
  }
}
