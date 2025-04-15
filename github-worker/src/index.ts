/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { GitHubApiClient, getEventAction, getCommitMessage, getCommitUrl, getEventUrl } from '@gitcast/shared';

export default {
	async queue(batch: MessageBatch<any>, env: { DB: D1Database, GITHUB_TOKEN: string }, ctx: ExecutionContext) {
		const db = env.DB;
		const octokit = new GitHubApiClient(
			env.GITHUB_TOKEN as string
		);

		for (const message of batch.messages) {
			try {
				// Mark this message as processed
				message.ack();

				const data = message.body as { type: string, fid: number, github_username: string };

				if (data.type === 'fetch_github_events') {
					const { fid, github_username } = data;

					// Fetch GitHub events
					const events = await octokit.getUserEvents(github_username, 1, 30);

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
				else if (data.type === 'fetch_starred_repos') {
					const { fid, github_username } = data;

					// Fetch the user's starred repositories
					const starredRepos = await octokit.getUserStarredRepos(github_username);

					// Process each starred repository
					for (const item of starredRepos) {
						// Handle both possible response formats
						const repo = 'repo' in item ? item.repo : item;

						// First, ensure the repository exists in the repositories table
						await db.prepare(`
      INSERT INTO repositories (id, name, full_name, description, url, html_url, stars_count, forks_count, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        stars_count = excluded.stars_count,
        forks_count = excluded.forks_count,
        last_updated = excluded.last_updated
    `).bind(
							repo.id,
							repo.name,
							repo.full_name,
							repo.description || '',
							repo.url,
							repo.html_url,
							repo.stargazers_count,
							repo.forks_count,
							Date.now()
						).run();

						// Then, record that this user has starred this repository
						await db.prepare(`
      INSERT INTO user_stars (fid, repo_id, starred_at)
      VALUES (?, ?, ?)
      ON CONFLICT (fid, repo_id) DO NOTHING
    `).bind(
							fid,
							repo.id,
							Date.now()
						).run();
					}

					// Update the user's last_updated timestamp
					await db.prepare(`
    UPDATE users
    SET last_updated = ?
    WHERE fid = ?
  `).bind(
						Date.now(),
						fid
					).run();
				}
			} catch (error) {
				console.error('Error processing GitHub queue message:', error);
				// Don't ack the message so it gets retried
			}
		}
	}
};
