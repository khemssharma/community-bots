require('dotenv').config();
const axios = require('axios');

const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TARGET_USERNAME = process.env.TARGET_USERNAME;

// GitHub REST API allows 5000 requests/hour for authenticated users.
// Secondary rate limits kick in for too many mutating calls in a short burst.
// We budget conservatively: follow actions use ~1 call each, plus pagination
// calls at the start. We track remaining calls from response headers.
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 60_000;   // Start retry wait at 60 s after a 429
const FOLLOW_DELAY_MS = 3_000;        // 3 s between follow calls (~1200/hour max)

const api = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': GITHUB_USERNAME,
  },
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns how many milliseconds to wait before the primary rate limit resets,
 * derived from the X-RateLimit-Reset header (Unix timestamp in seconds).
 */
const msUntilReset = (headers) => {
  const reset = parseInt(headers['x-ratelimit-reset'] || '0', 10);
  if (!reset) return BASE_RETRY_DELAY_MS;
  const waitMs = reset * 1000 - Date.now() + 5_000; // +5 s buffer
  return Math.max(waitMs, 0);
};

/**
 * Wraps an API call with exponential back-off for both primary (403/429 with
 * x-ratelimit-remaining: 0) and secondary (403 "secondary rate limit") limits.
 */
const apiCallWithRetry = async (fn, retries = MAX_RETRIES) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fn();

      // Warn when we're running low on primary quota
      const remaining = parseInt(response.headers['x-ratelimit-remaining'] || '5000', 10);
      if (remaining < 100) {
        console.warn(`⚠️  Primary rate limit low: ${remaining} requests remaining.`);
      }
      if (remaining === 0) {
        const waitMs = msUntilReset(response.headers);
        console.log(`Primary rate limit exhausted. Waiting ${Math.ceil(waitMs / 1000)} s for reset…`);
        await delay(waitMs);
      }

      return response;
    } catch (error) {
      const status = error.response?.status;
      const message = error.response?.data?.message || '';

      const isSecondaryLimit =
        (status === 403 || status === 429) &&
        (message.toLowerCase().includes('secondary rate limit') ||
          error.response?.headers?.['retry-after']);

      const isPrimaryLimit =
        status === 403 &&
        parseInt(error.response?.headers?.['x-ratelimit-remaining'] || '1', 10) === 0;

      if (isSecondaryLimit || isPrimaryLimit) {
        if (attempt === retries) {
          console.error(`Rate limit hit and max retries (${retries}) exhausted. Giving up.`);
          throw error;
        }

        // Honour Retry-After header if present, otherwise use exponential back-off
        const retryAfterSec = parseInt(error.response?.headers?.['retry-after'] || '0', 10);
        const waitMs = retryAfterSec
          ? retryAfterSec * 1000 + 2_000
          : isPrimaryLimit
          ? msUntilReset(error.response.headers)
          : BASE_RETRY_DELAY_MS * 2 ** attempt; // exponential back-off for secondary

        console.log(
          `Rate limit hit (attempt ${attempt + 1}/${retries}). ` +
            `Waiting ${Math.ceil(waitMs / 1000)} s before retry…`
        );
        await delay(waitMs);
        continue;
      }

      // Non-rate-limit error — surface it immediately
      throw error;
    }
  }
};

/**
 * Fetches all pages of a paginated GitHub endpoint, respecting rate limits.
 */
const fetchAllPages = async (path) => {
  let results = [];
  let page = 1;

  while (true) {
    const response = await apiCallWithRetry(() =>
      api.get(path, { params: { per_page: 100, page } })
    );
    results = results.concat(response.data);
    if (response.data.length < 100) break;
    page++;
  }

  return results;
};

(async () => {
  try {
    // ── 1. Fetch the target's following list ────────────────────────────────
    console.log(`Fetching users followed by ${TARGET_USERNAME}…`);
    const targetFollowing = await fetchAllPages(`/users/${TARGET_USERNAME}/following`);
    const toFollow = targetFollowing.map((u) => u.login);
    console.log(`${TARGET_USERNAME} follows ${toFollow.length} users.`);

    if (toFollow.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    // ── 2. Follow each user with delay + retry ──────────────────────────────
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < toFollow.length; i++) {
      const user = toFollow[i];
      console.log(`[${i + 1}/${toFollow.length}] Following ${user}…`);

      try {
        await apiCallWithRetry(() => api.put(`/user/following/${user}`));
        console.log(`  ✓ Followed ${user}`);
        succeeded++;
      } catch (error) {
        console.error(
          `  ✗ Failed to follow ${user}:`,
          error.response?.data?.message || error.message
        );
        failed++;
      }

      // Throttle between every follow call to stay clear of secondary limits.
      // 3 s gap → max ~1200 follow calls/hour, well within the 5000/hour budget.
      if (i < toFollow.length - 1) {
        await delay(FOLLOW_DELAY_MS);
      }
    }

    console.log(`\nDone. Followed: ${succeeded}, Failed: ${failed}`);
  } catch (error) {
    console.error('Fatal error:', error.response?.data || error.message);
    process.exit(1);
  }
})();
