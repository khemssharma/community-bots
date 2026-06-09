require('dotenv').config();
const axios = require('axios');

const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const EXCLUDED_USERS = ['prabhatojha', 'KumarGourav07', 'github', 'torvalds']; // Add usernames you don't want to unfollow here

const api = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': GITHUB_USERNAME,
  },
});

// Function to fetch all paginated data
const fetchPaginatedData = async (url) => {
  let results = [];
  let page = 1;
  let response;

  try {
    do {
      response = await api.get(`${url}?per_page=100&page=${page}`);
      results = results.concat(response.data);
      page++;
    } while (response.data.length > 0);
  } catch (error) {
    console.error('Error fetching paginated data:', error.response ? error.response.data : error.message);
  }

  return results;
};

(async () => {
  try {
    // Fetch all followers (handles pagination)
    const followers = await fetchPaginatedData(`/users/${GITHUB_USERNAME}/followers`);
    const followerLogins = followers.map((user) => user.login);

    // Fetch all accounts you follow (handles pagination)
    const following = await fetchPaginatedData(`/users/${GITHUB_USERNAME}/following`);
    const followingLogins = following.map((user) => user.login);

    // Identify non-reciprocal accounts
    const nonFollowers = followingLogins.filter((user) => !followerLogins.includes(user));

    // Exclude specific usernames
    const filteredNonFollowers = nonFollowers.filter((user) => !EXCLUDED_USERS.includes(user));

    console.log(`Accounts not following you back: ${filteredNonFollowers.join(', ')}`);

    // Unfollow non-reciprocal accounts
    for (const user of filteredNonFollowers) {
      console.log(`Unfollowing ${user}...`);
      await api.delete(`/user/following/${user}`);
      console.log(`Unfollowed ${user}`);
    }

    console.log('Unfollowed all non-reciprocal accounts, excluding specified users!');
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
  }
})();
