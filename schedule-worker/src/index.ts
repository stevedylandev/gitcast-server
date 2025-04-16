/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Queue consumer: a Worker that can consume from a
 * Queue: https://developers.cloudflare.com/queues/get-started/
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

import { WarpcastApiClient, type Env } from "@gitcast/shared"
export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const warpcast = new WarpcastApiClient(env.NEYNAR_API_KEY)
    const db = env.DB;

    if (event.cron === "0 12 * * *") { // Run daily at 12:00 UTC
      try {
        // Get all users with GitHub usernames
        const users = await db.prepare(`
          SELECT fid, github_username
          FROM users
          WHERE github_username IS NOT NULL
        `).all();

        console.log(`Queuing starred repository refresh for ${users.results.length} users`);

        // Queue repository fetching for each user in batches to avoid overloading
        const batchSize = 100;
        for (let i = 0; i < users.results.length; i += batchSize) {
          const batch = users.results.slice(i, i + batchSize);
          console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(users.results.length / batchSize)}`);

          for (const user of batch) {
            await env.github_tasks.send({
              type: 'fetch_starred_repos',
              fid: user.fid,
              github_username: user.github_username
            });
          }
        }

        console.log(`Successfully queued repository star refresh for all users`);
      } catch (error) {
        console.error('Error refreshing repository stars:', error);
      }
    }

    // Refresh GitHub verifications every 2 days
    if (event.cron === "0 0 */2 * *") {
      try {
        // Get all GitHub verifications
        const { verifications } = await warpcast.getGithubVerifications();

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
          await env.neynar_tasks.send({
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
        `).all();

        // Queue GitHub events fetching for each user
        for (const user of users.results) {
          await env.github_tasks.send({
            type: 'fetch_github_events',
            fid: user.fid,
            github_username: user.github_username
          });
        }
      } catch (error) {
        console.error('Error refreshing GitHub events:', error);
      }
    }

    if (event.cron === "0 0 * * *") {
      try {
        // Calculate the timestamp for 5 days ago
        const fiveDaysAgo = new Date();
        fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
        const cutoffTimestamp = fiveDaysAgo.toISOString();

        // Delete events older than 5 days
        const result = await db.prepare(`
          DELETE FROM github_events
          WHERE created_at < ?
        `)
          .bind(cutoffTimestamp)
          .run();

        console.log(`Cleaned up ${result.meta?.changes || 0} events older than 5 days`);
      } catch (error) {
        console.error('Error cleaning up old events:', error);
      }
    }

  }
}
