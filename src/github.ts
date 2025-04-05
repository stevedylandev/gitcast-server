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
        console.warn(`GitHub API rate limit running low: ${rateLimit} remaining`);
      }

      const events = GithubEventsArray.parse(response.data);

      return events.map(event => ({
        ...event,
        created_at: new Date(event.created_at) as unknown as string,
        username
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
