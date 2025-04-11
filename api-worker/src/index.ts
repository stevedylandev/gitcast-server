import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WarpcastApiClient } from '@gitcast/shared';

type Bindings = {
  DB: D1Database;
  neynar_tasks: Queue;
  github_tasks: Queue;
  NEYNAR_API_KEY: string;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use(cors());

app.get('/', (c) => {
  return c.text('GitHub Activity Feed for Farcaster');
});

// Get GitHub events feed for a user's following
app.get("/feed/:fid", async (c) => {
  const warpcast = new WarpcastApiClient(c.env.NEYNAR_API_KEY);

  const fid = parseInt(c.req.param('fid'));
  const limit = parseInt(c.req.query('limit') || '30');
  const page = parseInt(c.req.query('page') || '1');
  const offset = (page - 1) * limit;

  if (isNaN(fid)) {
    return c.json({ message: "Invalid FID format" }, { status: 400 });
  }

  try {
    // Query events directly from the database
    const eventsQuery = `
      SELECT e.*,
             u.farcaster_username,
             u.farcaster_display_name,
             u.farcaster_pfp_url
      FROM github_events e
      JOIN users u ON e.fid = u.fid
      WHERE e.fid IN (
        SELECT following_fid
        FROM follows
        WHERE follower_fid = ?
        UNION
        SELECT ? -- Include user's own events
      )
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const eventsResult = await c.env.DB.prepare(eventsQuery)
      .bind(fid, fid, limit, offset)
      .all();

    // Format for response
    const events = eventsResult.results.map(row => ({
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      actor: {
        login: row.actor_login,
        avatar_url: row.actor_avatar_url
      },
      repo: {
        name: row.repo_name,
        url: row.repo_url
      },
      fid: row.fid,
      action: row.action,
      commitMessage: row.commit_message,
      commitUrl: row.commit_url,
      eventUrl: row.event_url,
      farcaster: row.farcaster_username ? {
        username: row.farcaster_username,
        display_name: row.farcaster_display_name || row.farcaster_username,
        pfp_url: row.farcaster_pfp_url || ''
      } : undefined
    }));

    // Queue background data refresh
    await c.env.neynar_tasks.send({
      type: 'update_user',
      fid: fid
    });

    return c.json({
      events,
      page,
      limit,
      hasMore: events.length === limit
    });
  } catch (error) {
    console.error("Error fetching GitHub feed:", error);
    return c.json({ message: "Failed to fetch GitHub events" }, { status: 500 });
  }
});

app.post("/init/:fid", async (c) => {
  const fid = parseInt(c.req.param('fid'));

  if (isNaN(fid)) {
    return c.json({ message: "Invalid FID format" }, { status: 400 });
  }

  try {
    // First, ensure the user exists in the database
    await c.env.DB.prepare(`
      INSERT INTO users (fid, last_updated)
      VALUES (?, ?)
      ON CONFLICT (fid) DO UPDATE SET last_updated = excluded.last_updated
    `).bind(fid, Date.now()).run();

    // Queue user data fetching
    await c.env.neynar_tasks.send({
      type: 'fetch_user_data',
      fid: fid
    });

    // Queue following data fetching
    await c.env.neynar_tasks.send({
      type: 'update_user',
      fid: fid
    });

    return c.json({
      message: "Bootstrap process initiated",
      note: "Data will be populated in the background. Try fetching the feed in a few moments."
    });
  } catch (error) {
    console.error("Bootstrap error:", error);
    return c.json({ message: "Failed to bootstrap data" }, { status: 500 });
  }
});

app.get("/status/:fid", async (c) => {
  const fid = parseInt(c.req.param('fid'));

  if (isNaN(fid)) {
    return c.json({ message: "Invalid FID format" }, { status: 400 });
  }

  try {
    // Get user info
    const userQuery = `SELECT * FROM users WHERE fid = ?`;
    const user = await c.env.DB.prepare(userQuery).bind(fid).first();

    // Get follows count
    const followsQuery = `SELECT COUNT(*) as count FROM follows WHERE follower_fid = ?`;
    const follows = await c.env.DB.prepare(followsQuery).bind(fid).first();

    // Get GitHub users count
    const githubUsersQuery = `
      SELECT COUNT(*) as count
      FROM users
      WHERE github_username IS NOT NULL
      AND fid IN (SELECT following_fid FROM follows WHERE follower_fid = ?)
    `;
    const githubUsers = await c.env.DB.prepare(githubUsersQuery).bind(fid).first();

    // Get events count
    const eventsQuery = `
      SELECT COUNT(*) as count
      FROM github_events
      WHERE fid IN (
        SELECT following_fid FROM follows WHERE follower_fid = ?
        UNION
        SELECT ? -- Include user's own events
      )
    `;
    const events = await c.env.DB.prepare(eventsQuery).bind(fid, fid).first();

    return c.json({
      user: user || null,
      stats: {
        follows: follows?.count || 0,
        github_users: githubUsers?.count || 0,
        events: events?.count || 0
      }
    });
  } catch (error) {
    console.error("Status check error:", error);
    return c.json({ message: "Failed to fetch status" }, { status: 500 });
  }
});



export default app;
