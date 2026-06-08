require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');

const MY_SCREEN_NAME = process.env.X_SCREEN_NAME; // Your @username WITHOUT the @
const EXCLUDED_USERS = process.env.EXCLUDED_USERS
  ? process.env.EXCLUDED_USERS.split(',')
  : [];

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

const v1 = client.v1;

// Rate limit safe delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch all cursor-paginated IDs
const fetchAllIds = async (endpoint, params) => {
  let ids = [];
  let cursor = -1;
  try {
    do {
      const response = await v1.get(endpoint, { ...params, cursor });
      ids = ids.concat(response.ids || []);
      cursor = response.next_cursor || 0;
    } while (cursor && cursor !== 0);
  } catch (error) {
    console.error(`Error fetching ${endpoint}:`, error.message || error);
  }
  return ids;
};

(async () => {
  try {
    console.log(`Running as @${MY_SCREEN_NAME}`);

    // Fetch follower IDs
    console.log('Fetching your followers...');
    const followerIds = await fetchAllIds('followers/ids.json', {
      screen_name: MY_SCREEN_NAME,
      count: 5000,
    });
    console.log(`Total followers: ${followerIds.length}`);

    // Fetch friend (following) IDs
    console.log('Fetching accounts you follow...');
    const friendIds = await fetchAllIds('friends/ids.json', {
      screen_name: MY_SCREEN_NAME,
      count: 5000,
    });
    console.log(`Total following: ${friendIds.length}`);

    // Find non-reciprocal
    const followerSet = new Set(followerIds.map(String));
    const nonFollowerIds = friendIds.filter((id) => !followerSet.has(String(id)));
    console.log(`Non-reciprocal count: ${nonFollowerIds.length}`);

    if (nonFollowerIds.length === 0) {
      console.log('No non-reciprocal accounts found. Done!');
      return;
    }

    // Look up usernames in batches of 100
    let nonFollowers = [];
    for (let i = 0; i < nonFollowerIds.length; i += 100) {
      const batch = nonFollowerIds.slice(i, i + 100);
      const users = await v1.get('users/lookup.json', {
        user_id: batch.join(','),
      });
      nonFollowers = nonFollowers.concat(users);
    }

    // Exclude protected accounts
    const toUnfollow = nonFollowers.filter(
      (u) => !EXCLUDED_USERS.includes(u.screen_name)
    );

    console.log(`Accounts to unfollow: ${toUnfollow.map((u) => u.screen_name).join(', ')}`);
    console.log(`Total to unfollow: ${toUnfollow.length}`);

    // Unfollow each with rate limit delay
    for (const user of toUnfollow) {
      try {
        console.log(`Unfollowing @${user.screen_name}...`);
        await v1.post('friendships/destroy.json', { user_id: user.id_str });
        console.log(`Unfollowed @${user.screen_name}`);
        await delay(18000); // ~50 unfollows per 15 min
      } catch (err) {
        console.error(`Failed to unfollow @${user.screen_name}:`, err.message || err);
      }
    }

    console.log('Done! Unfollowed all non-reciprocal accounts.');
  } catch (error) {
    console.error('Fatal error:', error.message || error);
  }
})();
