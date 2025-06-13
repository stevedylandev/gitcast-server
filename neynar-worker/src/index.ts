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

import { WarpcastApiClient, type Env, type NeynarQueueMessage } from '@gitcast/shared';


export default {
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
    const db = env.DB;

    const warpcast = new WarpcastApiClient(env.NEYNAR_API_KEY)

    for (const message of batch.messages) {
      try {
        // Mark this message as processed
        message.ack();

        const data = message.body as NeynarQueueMessage;

        if (data.type === 'update_user') {
          const fid = data.fid;
          console.log(`Processing update_user for FID ${fid}`);

          try {
            // Get user's following list
            const followingData = await warpcast.getFollowing(fid as number)
            console.log(`Got ${followingData.users.length} follows for FID ${fid}`);

            // First, ensure all users exist in the database
            const timestamp = Date.now();

            // Ensure the main user exists
            await db.prepare(`
              INSERT INTO users (fid, last_updated)
              VALUES (?, ?)
              ON CONFLICT (fid) DO NOTHING
            `).bind(fid, timestamp).run();

            // Ensure all followed users exist
            for (const item of followingData.users) {
              const followingFid = item.user.fid;

              // First ensure the user exists
              await db.prepare(`
                INSERT INTO users (fid, last_updated)
                VALUES (?, ?)
                ON CONFLICT (fid) DO NOTHING
              `).bind(followingFid, timestamp).run();

              // Queue user data fetch for more details
              await env.neynar_tasks.send({
                type: 'fetch_user_data',
                fid: followingFid
              });
            }

            // Now we can update follows safely
            if (followingData.users.length > 0) {
              // First, remove old following relationships
              await db.prepare('DELETE FROM follows WHERE follower_fid = ?').bind(fid).run();
              console.log(`Deleted old follows for FID ${fid}`);

              // Then insert new ones
              const stmt = db.prepare('INSERT INTO follows (follower_fid, following_fid, created_at) VALUES (?, ?, ?)');

              for (const item of followingData.users) {
                const followingFid = item.user.fid;
                await stmt.bind(fid, followingFid, timestamp).run();
              }
              console.log(`Added ${followingData.users.length} new follows for FID ${fid}`);
            }

            // Get GitHub verifications for follows + self
            const allFids = followingData.users.map(item => item.user.fid);
            allFids.push(fid as number); // Include self
            console.log(`Checking GitHub verifications for ${allFids.length} FIDs`);

            // Queue GitHub verification check
            await env.neynar_tasks.send({
              type: 'check_github_verifications',
              fids: allFids
            });
          } catch (error) {
            console.error(`Error processing following data for FID ${fid}:`, error);
          }
        }

        else if (data.type === 'fetch_user_data') {
          // Get Farcaster user data from Neynar
          const userMap = await warpcast.getUserData([data.fid as number]);
          const userData = userMap.get(data.fid as number);

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
          console.log(`Checking GitHub verifications for ${fids?.length || 0} specific FIDs: ${fids?.join(', ')}`);

          try {
            if (!fids || fids.length === 0) {
              console.log('No FIDs provided for GitHub verification check');
              return;
            }

            // Use the new FID-specific method instead of fetching all verifications
            const verifications = await warpcast.getGithubVerificationsForFids(fids);
            console.log(`Found ${verifications.length} GitHub verifications for the requested FIDs`);

            // Update database with GitHub usernames
            for (const verification of verifications) {
              console.log(`Processing GitHub verification for FID ${verification.fid} (GitHub: ${verification.platformUsername})`);

              const updateResult = await db.prepare(`
                  UPDATE users SET
                  github_username = ?,
                  last_updated = ?
                  WHERE fid = ?
                `)
                .bind(verification.platformUsername, Date.now(), verification.fid)
                .run();

              if (updateResult.meta?.changes === 0) {
                // User doesn't exist yet, create them
                console.log(`User FID ${verification.fid} doesn't exist, creating new user record`);
                await db.prepare(`
                   INSERT INTO users (fid, github_username, last_updated)
                   VALUES (?, ?, ?)
                 `).bind(verification.fid, verification.platformUsername, Date.now()).run();
              }

              // Queue GitHub events fetching
              await env.github_tasks.send({
                type: 'fetch_github_events',
                fid: verification.fid,
                github_username: verification.platformUsername
              });

              console.log(`✅ Updated GitHub username and queued events fetch for FID ${verification.fid} -> ${verification.platformUsername}`);
            }

            // Log which FIDs didn't have GitHub verifications
            const verifiedFids = verifications.map(v => v.fid);
            const unverifiedFids = fids.filter(fid => !verifiedFids.includes(fid));

            if (unverifiedFids.length > 0) {
              console.log(`❌ No GitHub verifications found for FIDs: ${unverifiedFids.join(', ')}`);
            }

            console.log(`GitHub verification check completed: ${verifications.length}/${fids.length} FIDs had GitHub verifications`);
          } catch (error) {
            console.error('Error processing GitHub verifications:', error);
          }
        }
      } catch (error) {
        console.error('Error processing Neynar queue message:', error);
        // Don't ack the message so it gets retried
      }
    }
  }
} satisfies ExportedHandler<Env>;
