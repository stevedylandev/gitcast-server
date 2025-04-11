// CLOUDFLARE DEPLOYMENT CONFIGURATION

// 1. wrangler.toml for main API Worker
// api-worker/wrangler.toml
/*
name = "github-feed-api"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings
[[queues.producers]]
queue = "neynar-tasks"
binding = "NEYNAR_QUEUE"

[[queues.producers]]
queue = "github-tasks"
binding = "GITHUB_QUEUE"

[vars]
NEYNAR_API_KEY = ""
*/

// 2. wrangler.toml for Neynar worker
// neynar-worker/wrangler.toml
/*
name = "github-feed-neynar-worker"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings for consumer
[[queues.consumers]]
queue = "neynar-tasks"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3

# Queue bindings for producer (to send to GitHub queue)
[[queues.producers]]
queue = "github-tasks"
binding = "GITHUB_QUEUE"

[vars]
NEYNAR_API_KEY = ""
*/

// 3. wrangler.toml for GitHub worker
// github-worker/wrangler.toml
/*
name = "github-feed-github-worker"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings
[[queues.consumers]]
queue = "github-tasks"
max_batch_size = 5
max_batch_timeout = 30
max_retries = 3

[vars]
GITHUB_TOKEN = ""
*/

// 4. wrangler.toml for Scheduled worker
// scheduled-worker/wrangler.toml
/*
name = "github-feed-scheduled-worker"
main = "src/index.js"
compatibility_date = "2024-04-01"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-feed-db"
database_id = "YOUR_DATABASE_ID"

# Queue bindings
[[queues.producers]]
queue = "neynar-tasks"
binding = "NEYNAR_QUEUE"

[[queues.producers]]
queue = "github-tasks"
binding = "GITHUB_QUEUE"

# Scheduled triggers
[triggers]
crons = ["0 */12 * * *", "*/30 * * * *"]

[vars]
NEYNAR_API_KEY = ""
*/

// 5. D1 Database Schema Setup Script
// setup-db.js
/*
const DATABASE_NAME = "github-feed-db";

// Create and set up the database
async function setupDatabase() {
  console.log(`Creating D1 database: ${DATABASE_NAME}...`);

  try {
    // Create the database
    const createResult = await wrangler.d1.createDatabase({
      name: DATABASE_NAME,
      locationHint: "auto", // Let Cloudflare optimize location
    });

    console.log(`Database created with ID: ${createResult.databaseId}`);

    // Create database schema
    const schema = `
    -- Users table to store Farcaster and GitHub user mapping
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
    `;

    // Execute schema creation
    await wrangler.d1.execute({
      databaseId: createResult.databaseId,
      query: schema,
    });

    console.log("Database schema created successfully!");

    // Update the wrangler.toml files with the database ID
    // This would involve reading and writing to the files
    // For this example, we'll just log the ID to add manually
    console.log(`
    Add the following to your wrangler.toml files:

    [[d1_databases]]
    binding = "DB"
    database_name = "${DATABASE_NAME}"
    database_id = "${createResult.databaseId}"
    `);

  } catch (error) {
    console.error("Error setting up database:", error);
  }
}

// Create the queues
async function setupQueues() {
  console.log("Setting up Cloudflare Queues...");

  try {
    // Create Neynar queue
    await wrangler.queues.create({
      name: "neynar-tasks"
    });
    console.log("Created neynar-tasks queue");

    // Create GitHub queue
    await wrangler.queues.create({
      name: "github-tasks"
    });
    console.log("Created github-tasks queue");

  } catch (error) {
    console.error("Error setting up queues:", error);
  }
}

// Run the setup
async function run() {
  await setupDatabase();
  await setupQueues();
  console.log("Setup completed!");
}

run();
*/

// 6. Deployment Script
// deploy.sh
/*
#!/bin/bash

# Exit on any error
set -e

echo "Deploying GitHub Activity Feed for Farcaster"

# Deploy D1 database migrations if any
echo "Deploying database migrations..."
cd api-worker
wrangler d1 migrations apply github-feed-db

# Deploy API worker
echo "Deploying API worker..."
wrangler deploy
cd ..

# Deploy Neynar worker
echo "Deploying Neynar worker..."
cd neynar-worker
wrangler deploy
cd ..

# Deploy GitHub worker
echo "Deploying GitHub worker..."
cd github-worker
wrangler deploy
cd ..

# Deploy scheduled worker
echo "Deploying scheduled worker..."
cd scheduled-worker
wrangler deploy
cd ..

echo "Deployment completed successfully!"
echo "API available at: https://github-feed-api.YOUR_DOMAIN.workers.dev"
*/

// 7. Initial Data Import Script (if you have existing data)
// import-data.js
/*
const fs = require('fs');
const { execSync } = require('child_process');

async function importData() {
  console.log("Importing initial data to Cloudflare D1...");

  try {
    // Example: Import users data if you have it
    if (fs.existsSync('./data/users.csv')) {
      console.log("Importing users data...");
      execSync('wrangler d1 execute github-feed-db --file=./data/import-users.sql');
    }

    // Example: Import follows data if you have it
    if (fs.existsSync('./data/follows.csv')) {
      console.log("Importing follows data...");
      execSync('wrangler d1 execute github-feed-db --file=./data/import-follows.sql');
    }

    // Example: Import GitHub events data if you have it
    if (fs.existsSync('./data/events.csv')) {
      console.log("Importing GitHub events data...");
      execSync('wrangler d1 execute github-feed-db --file=./data/import-events.sql');
    }

    console.log("Data import completed successfully!");
  } catch (error) {
    console.error("Error importing data:", error);
  }
}

importData();
*/
