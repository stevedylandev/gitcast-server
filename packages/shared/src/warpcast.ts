import type { WarpcastVerification, NeynarFollowingResponse, FarcasterUserCache, NeynarUser } from "./types";

export class WarpcastApiClient {
  private baseUrl: string;
  private neynarApiKey: string | undefined;

  constructor(neynarApiKey: string) {
    this.baseUrl = "https://api.warpcast.com";
    this.neynarApiKey = neynarApiKey
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

  async getUserData(fids: number[]): Promise<Map<number, FarcasterUserCache>> {
    if (!this.neynarApiKey) {
      console.error("Neynar API key not set");
      return new Map();
    }

    if (fids.length === 0) {
      return new Map();
    }

    const userMap = new Map<number, FarcasterUserCache>();

    // Fetch users in chunks of 100 (API limit)
    const chunkSize = 100;
    for (let i = 0; i < fids.length; i += chunkSize) {
      const fidChunk = fids.slice(i, i + chunkSize);

      try {
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

        const data = await response.json() as { users?: Array<{ fid?: number, username?: string, display_name?: string, pfp_url?: string }> };

        if (!data.users || !Array.isArray(data.users)) {
          console.error('Invalid response from Neynar API:', data);
          continue;
        }

        // Process and add users to the map
        for (const userData of data.users) {
          if (!userData || !userData.fid) continue;

          const user: FarcasterUserCache = {
            fid: userData.fid,
            username: userData.username || '',
            display_name: userData.display_name || '',
            pfp_url: userData.pfp_url || '',
            timestamp: Date.now()
          };

          userMap.set(user.fid, user);
        }

      } catch (error) {
        console.error(`Error fetching Farcaster users in bulk:`, error);
      }
    }

    return userMap;
  }

  /**
   * Get GitHub verification for a specific FID
   * More reliable than fetching all verifications since it queries directly
   */
  async getGithubVerificationForFid(fid: number): Promise<WarpcastVerification | null> {
    try {
      const url = `${this.baseUrl}/fc/account-verifications?fid=${fid}&platform=github`;

      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) {
          console.log(`No GitHub verification found for FID ${fid}`);
          return null;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as {
        result: { verifications: WarpcastVerification[] }
      };

      // Should only be one GitHub verification per user, but take the first one
      const verification = data.result.verifications?.[0];

      if (verification) {
        console.log(`Found GitHub verification for FID ${fid}: ${verification.platformUsername}`);
        return verification;
      }
      console.log(`No GitHub verification found for FID ${fid}`);
      return null;
    } catch (error) {
      console.error(`Error fetching GitHub verification for FID ${fid}:`, error);
      return null;
    }
  }

  /**
   * Get GitHub verifications for multiple specific FIDs
   * More efficient than fetching all verifications when you only need specific ones
   */
  async getGithubVerificationsForFids(fids: number[]): Promise<WarpcastVerification[]> {
    console.log(`Fetching GitHub verifications for ${fids.length} specific FIDs`);

    const verifications: WarpcastVerification[] = [];

    // Process in chunks to avoid rate limiting
    const chunkSize = 5; // Conservative to avoid rate limits
    const delay = 200; // 200ms delay between requests

    for (let i = 0; i < fids.length; i += chunkSize) {
      const fidChunk = fids.slice(i, i + chunkSize);

      console.log(`Processing FID chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(fids.length / chunkSize)}: ${fidChunk.join(', ')}`);

      // Process chunk in parallel
      const chunkPromises = fidChunk.map(fid => this.getGithubVerificationForFid(fid));
      const chunkResults = await Promise.all(chunkPromises);

      // Add non-null results
      for (const verification of chunkResults) {
        if (verification) {
          verifications.push(verification);
        }
      }

      // Add delay between chunks to avoid rate limiting
      if (i + chunkSize < fids.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.log(`Found ${verifications.length} GitHub verifications out of ${fids.length} requested FIDs`);
    return verifications;
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
  async getVerifiedGithubUsersForFids(fids: number[]): Promise<WarpcastVerification[]> {
    const cachedUsers: WarpcastVerification[] = [];
    const fidsToCheck: number[] = [];

    // Define cache freshness (1 hour in milliseconds)

    // If we have all users in cache and they're all fresh, return them
    if (fidsToCheck.length === 0) {
      // Enhance with Farcaster user info if not already cached
      return await this.enhanceVerificationsWithFarcasterInfo(cachedUsers);
    }

    // Fetch verifications for missing or stale users
    const verifications = await this.getAllGithubVerifications();
    const matchingVerifications = verifications.filter(v => fidsToCheck.includes(v.fid));

    // Add timestamp to each verification before caching
    const timestampedVerifications = matchingVerifications.map(verification => ({
      ...verification,
      timestamp: Date.now()
    }));

    const allVerifications = [...cachedUsers, ...timestampedVerifications];

    // Enhance with Farcaster user info
    return await this.enhanceVerificationsWithFarcasterInfo(allVerifications);
  }

  // Helper to add Farcaster user info to verifications
  private async enhanceVerificationsWithFarcasterInfo(
    verifications: WarpcastVerification[]
  ): Promise<WarpcastVerification[]> {
    if (verifications.length === 0) {
      return [];
    }

    // Extract unique FIDs
    const fids = [...new Set(verifications.map(v => v.fid))];

    // Get all user data in bulk
    const userMap = await this.getUserData(fids);

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
        console.warn(`No Farcaster user data found for FID ${verification.fid}`);
        return verification;
      }
    });
  }
}
