const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Configuration
const API_BASE_URL = 'https://api.gitcast.dev';
const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES = 2000;
const OFFSET = 200; // Start where you left off (after the first 500)
const LIMIT = 1500; // Process 1500 more users

async function queryD1(query) {
  try {
    // Escape any double quotes in the SQL query to prevent command line issues
    const escapedQuery = query.replace(/"/g, '\\"');
    console.log('Executing D1 query...');

    const { stdout } = await execAsync(`wrangler d1 execute gitcast-db --command="${escapedQuery}" --json --remote`);
    const parsedOutput = JSON.parse(stdout);

    // The result is an array with one object that contains the results property
    const result = parsedOutput[0];

    console.log(`Query returned ${result.results?.length || 0} rows`);
    return result;
  } catch (error) {
    console.error('D1 query error:', error.message);
    // Print the output for debugging
    if (error.stdout) console.log('stdout:', error.stdout);
    if (error.stderr) console.error('stderr:', error.stderr);
    return { results: [] };
  }
}

async function initUserRepos(fid) {
  try {
    console.log(`Initializing repos for FID ${fid}...`);
    const response = await fetch(`${API_BASE_URL}/init-repos/${fid}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return { fid, success: response.ok, message: data.message || 'No message returned' };
  } catch (error) {
    console.error(`Error initializing repos for FID ${fid}:`, error.message);
    return { fid, success: false, message: error.message };
  }
}

async function processUserBatch(users) {
  console.log(`Processing batch of ${users.length} users...`);
  const results = await Promise.all(
    users.map(user => initUserRepos(user.fid))
  );

  results.forEach(result => {
    if (result.success) {
      console.log(`✅ FID ${result.fid}: ${result.message}`);
    } else {
      console.error(`❌ FID ${result.fid}: ${result.message}`);
    }
  });

  return results;
}

async function main() {
  console.log(`Fetching next ${LIMIT} users with GitHub usernames starting from offset ${OFFSET}...`);

  const query = `
    SELECT u.fid, u.github_username
    FROM users u
    WHERE u.github_username IS NOT NULL
    LIMIT ${LIMIT} OFFSET ${OFFSET}
  `;

  const result = await queryD1(query);

  if (!result.results || !Array.isArray(result.results)) {
    console.error('Invalid query result structure:', result);
    throw new Error('Failed to get valid query results');
  }

  if (result.results.length === 0) {
    console.log('No more users with GitHub usernames found');
    return;
  }

  const users = result.results;
  console.log(`Found ${users.length} users with GitHub usernames (offset: ${OFFSET}, limit: ${LIMIT})`);

  // Process in batches
  let processedCount = 0;
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(users.length / BATCH_SIZE)} (${batch.length} users)`);

    await processUserBatch(batch);
    processedCount += batch.length;

    console.log(`Progress: ${processedCount}/${users.length} users (${Math.round(processedCount / users.length * 100)}%)`);
    console.log(`Overall progress: ${OFFSET + processedCount}/${OFFSET + LIMIT} users`);

    if (i + BATCH_SIZE < users.length) {
      console.log(`Waiting ${DELAY_BETWEEN_BATCHES / 1000} seconds before next batch...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
  }

  console.log(`✨ Repository initialization complete for ${users.length} more users!`);
  console.log(`Total users processed so far: ${OFFSET + users.length}`);
}

// Run the script
main().catch(error => {
  console.error('Script error:', error);
  process.exit(1);
});
