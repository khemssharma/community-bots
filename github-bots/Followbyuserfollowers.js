require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TARGET_USERNAME = process.env.TARGET_USERNAME;

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 60_000;   // Start retry wait at 60 s after a 429
const FOLLOW_DELAY_MS = 3_000;        // 3 s between follow calls (~1200/hour max)
const PROGRESS_FILE = path.join(__dirname, 'follow-progress.json');

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

// ─── Progress persistence ────────────────────────────────────────────────
// Tracks who has DEFINITELY been followed successfully in this run (and
// past runs), and what's left to do. This is the source of truth the
// script trusts about its own actions — independent of GitHub's follower
// list, which can lag a bit right after a follow/unfollow.

const loadProgress = () => {
  if (!fs.existsSync(PROGRESS_FILE)) return { followed: [], remaining: null };
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    console.warn('⚠️  Could not parse progress file, starting fresh.');
    return { followed: [], remaining: null };
  }
};

const saveProgress = (followedSet, remainingList) => {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify(
      { followed: Array.from(followedSet), remaining: remainingList, updatedAt: new Date().toISOString() },
      null,
      2
    )
  );
};

/**
 * Wraps an API call with exponential back-off for both primary (403/429 with
 * x-ratelimit-remaining: 0) and secondary (403 "secondary rate limit") limits.
 * When retries are exhausted due to rate limiting, the thrown error is
 * tagged with `rateLimitExhausted: true` so callers can distinguish
 * "GitHub is throttling us" from "this specific user failed for its own reason".
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
          error.rateLimitExhausted = true; // ← tag it so callers know this isn't a per-user failure
          throw error;
        }

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
    const progress = loadProgress();
    const followedLog = new Set(progress.followed);

    let toFollow;

    if (progress.remaining && progress.remaining.length > 0) {
      // ── Resume a previously interrupted run ──────────────────────────
      console.log(`Resuming previous run: ${progress.remaining.length} users still pending.`);
      toFollow = progress.remaining;
    } else {
      // ── 1. Fetch TARGET's followers (these are who we will follow) ──
      console.log(`Fetching followers of ${TARGET_USERNAME}…`);
      const targetFollowers = await fetchAllPages(`/users/${TARGET_USERNAME}/followers`);
      const targetFollowerLogins = targetFollowers.map((u) => u.login);
      console.log(`${TARGET_USERNAME} has ${targetFollowerLogins.length} followers.`);

      if (targetFollowerLogins.length === 0) {
        console.log('No followers found. Nothing to do.');
        return;
      }

      // ── 2. Fetch who YOU already follow and who already follows YOU ─
      console.log(`Fetching accounts you (${GITHUB_USERNAME}) already follow…`);
      const alreadyFollowing = await fetchAllPages(`/users/${GITHUB_USERNAME}/following`);
      const alreadyFollowingSet = new Set(alreadyFollowing.map((u) => u.login.toLowerCase()));
      console.log(`You already follow ${alreadyFollowingSet.size} accounts.`);

      console.log('Fetching your own followers…');
      const myFollowers = await fetchAllPages('/user/followers');
      const myFollowerSet = new Set(myFollowers.map((u) => u.login.toLowerCase()));
      console.log(`You currently have ${myFollowerSet.size} followers.`);

      const selfLogin = GITHUB_USERNAME.toLowerCase();

      // ── 3. Skip yourself, anyone you already follow (per API or per our
      //       own log — the log catches cases where GitHub's own listing
      //       hasn't caught up yet), and anyone who already follows you.
      toFollow = targetFollowerLogins.filter((login) => {
        const key = login.toLowerCase();
        return (
          key !== selfLogin &&
          !alreadyFollowingSet.has(key) &&
          !myFollowerSet.has(key) &&
          !followedLog.has(login)
        );
      });

      console.log(
        `\nAfter deduplication: ${toFollow.length} new accounts to follow ` +
          `(skipped ${targetFollowerLogins.length - toFollow.length}).\n`
      );
    }

    if (toFollow.length === 0) {
      console.log('Nothing left to follow. Nothing to do.');
      if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
      return;
    }

    // ── 4. Follow each user with delay + retry ──────────────────────────
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < toFollow.length; i++) {
      const user = toFollow[i];
      console.log(`[${i + 1}/${toFollow.length}] Following ${user}…`);

      try {
        await apiCallWithRetry(() => api.put(`/user/following/${user}`));
        console.log(`  ✓ Followed ${user}`);
        succeeded++;
        followedLog.add(user);
        // Persist after every success so a crash never loses confirmed progress.
        saveProgress(followedLog, toFollow.slice(i + 1));
      } catch (error) {
        if (error.rateLimitExhausted) {
          // This is the critical fix: we do NOT know whether this specific
          // follow went through, and every subsequent call will hit the
          // same wall. Stop immediately instead of marking the rest as
          // "failed" and burning through the list.
          console.error(
            `\n🛑 Rate limit exhausted at user ${user} (${i + 1}/${toFollow.length}). ` +
              `Stopping to avoid inconsistent state.`
          );
          console.error(
            `${toFollow.length - i} users remain (including ${user}, which will be retried). ` +
              `Progress saved to ${PROGRESS_FILE} — rerun the script later to resume.`
          );
          saveProgress(followedLog, toFollow.slice(i)); // re-include current user, its outcome is unknown
          process.exit(1);
        }

        // A genuine per-user failure (e.g. user not found, blocked) — safe to continue.
        console.error(
          `  ✗ Failed to follow ${user}:`,
          error.response?.data?.message || error.message
        );
        failed++;
        saveProgress(followedLog, toFollow.slice(i + 1));
      }

      if (i < toFollow.length - 1) {
        await delay(FOLLOW_DELAY_MS);
      }
    }

    console.log(`\nDone. Followed: ${succeeded}, Failed: ${failed}`);
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE); // clean slate on full completion
  } catch (error) {
    console.error('Fatal error:', error.response?.data || error.message);
    process.exit(1);
  }
})();
