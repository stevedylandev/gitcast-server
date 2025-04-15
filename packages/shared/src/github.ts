import { Octokit } from "octokit";
import type { GithubEvent } from "./types";

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

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
    });
  }

  async getUserStarredRepos(username: string, page: number = 1, per_page: number = 100) {
    try {
      const response = await this.octokit.request('GET /users/{username}/starred', {
        username,
        page,
        per_page,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      return response.data;
    } catch (error) {
      console.error(`Error fetching starred repos for ${username}:`, error);
      return [];
    }
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
        console.warn(`GitHub API rate limit running low: ${rateLimit} remaining`);
      }

      const events = response.data as GithubEvent[];

      return events.map(event => ({
        ...event,
        username,
        created_at: new Date(event.created_at).toISOString()
      }));
    } catch (error) {
      const githubError = error as GithubApiError;
      if (githubError.status === 403 && githubError.response?.headers?.['x-ratelimit-remaining'] === '0') {
        console.error(`Rate limit exceeded for GitHub API`);
      } else {
        console.error(`Error fetching events for ${username}:`, error);
      }
      return [];
    }
  }
}
