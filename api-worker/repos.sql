CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  html_url TEXT NOT NULL,
  stars_count INTEGER NOT NULL DEFAULT 0,
  forks_count INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL
);

CREATE TABLE user_stars (
  fid INTEGER NOT NULL,
  repo_id TEXT NOT NULL,
  starred_at INTEGER NOT NULL,
  PRIMARY KEY (fid, repo_id),
  FOREIGN KEY (fid) REFERENCES users(fid),
  FOREIGN KEY (repo_id) REFERENCES repositories(id)
);

CREATE INDEX idx_repositories_stars ON repositories(stars_count DESC);
CREATE INDEX idx_user_stars_repo_id ON user_stars(repo_id);
CREATE INDEX idx_user_stars_fid ON user_stars(fid);
