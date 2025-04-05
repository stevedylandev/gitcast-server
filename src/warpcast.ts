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
        const cacheKey = `farcaster_user_${fid}`;
        try {
          const cached = await kv.get(cacheKey, 'json') as FarcasterUserCache | null;
          if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) { // 24 hour cache
            return { fid, user: cached };
          }
        } catch (error) {
          console.error(`Error fetching cached Farcaster user for FID ${fid}:`, error);
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
        console.log(`Fetching ${fidChunk.length} Farcaster users from Neynar API`);
        const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fidChunk.join(',')}`;
        const response = await fetch(url, {
          headers: {
            'accept': 'application/json',
            'x-api-key': this.neynarApiKey
          }
        });

        if (!response.ok) {
          console.error(`Neynar API error: ${response.status} ${response.statusText}`);
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
            const cacheKey = `farcaster_user_${user.fid}`;
            await kv.put(cacheKey, JSON.stringify(user), { expirationTtl: 86400 });
          }
        });

        await Promise.all(cachePromises);

      } catch (error) {
        console.error(`Error fetching Farcaster users in bulk:`, error);
      }
    }

    return userMap;
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
    if (verifications.length === 0) {
      return [];
    }

    console.log(`Enhancing ${verifications.length} GitHub verifications with Farcaster info`);

    // Extract unique FIDs
    const fids = [...new Set(verifications.map(v => v.fid))];

    // Get all user data in bulk
    const userMap = await this.getFarcasterUsersInBulk(fids, c);

    // Enhance verifications with Farcaster user data
    return verifications.map(verification => {
      const farcasterUser = userMap.get(verification.fid);

      if (farcasterUser) {
        console.log(`Found Farcaster user for FID ${verification.fid}: ${farcasterUser.username}`);
        return {
          ...verification,
          farcasterUsername: farcasterUser.username,
          farcasterDisplayName: farcasterUser.display_name,
          farcasterPfpUrl: farcasterUser.pfp_url
        };
      } else {
        console.warn(`No Farcaster user data found for FID ${verification.fid}`);
        return verification;
      }
    });
  }
}
