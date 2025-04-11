CREATE TABLE users (
  fid INTEGER PRIMARY KEY,
  farcaster_username TEXT,
  farcaster_display_name TEXT,
  farcaster_pfp_url TEXT,
  github_username TEXT,
  last_updated INTEGER
);

-- Follows table to track relationships
CREATE TABLE follows (
  follower_fid INTEGER,
  following_fid INTEGER,
  created_at INTEGER,
  PRIMARY KEY (follower_fid, following_fid),
  FOREIGN KEY (follower_fid) REFERENCES users(fid),
  FOREIGN KEY (following_fid) REFERENCES users(fid)
);

-- GitHub events table
CREATE TABLE github_events (
  id TEXT PRIMARY KEY,
  fid INTEGER,
  type TEXT,
  created_at TEXT,
  actor_login TEXT,
  actor_avatar_url TEXT,
  repo_name TEXT,
  repo_url TEXT,
  action TEXT,
  commit_message TEXT,
  commit_url TEXT,
  event_url TEXT,
  FOREIGN KEY (fid) REFERENCES users(fid)
);

-- Create indexes for performance
CREATE INDEX idx_github_events_fid ON github_events(fid);
CREATE INDEX idx_github_events_created_at ON github_events(created_at);
CREATE INDEX idx_follows_follower_fid ON follows(follower_fid);
