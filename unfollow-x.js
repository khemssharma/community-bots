require('dotenv').config();
const puppeteer = require('puppeteer');

const X_USERNAME = process.env.X_SCREEN_NAME;   // Your @username (without @)
const X_PASSWORD = process.env.X_PASSWORD;       // Your X.com password
const X_EMAIL    = process.env.X_EMAIL;          // Your X.com email
const EXCLUDED_USERS = process.env.EXCLUDED_USERS
  ? process.env.EXCLUDED_USERS.split(',')
  : [];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    // --- LOG IN ---
    console.log('Logging in to X.com...');
    await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2' });
    await delay(3000);

    // Enter username/email
    await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
    await page.type('input[autocomplete="username"]', X_EMAIL, { delay: 80 });
    await page.keyboard.press('Enter');
    await delay(2000);

    // Handle optional "enter username" challenge
    const usernameChallenge = await page.$('input[data-testid="ocfEnterTextTextInput"]');
    if (usernameChallenge) {
      await usernameChallenge.type(X_USERNAME, { delay: 80 });
      await page.keyboard.press('Enter');
      await delay(2000);
    }

    // Enter password
    await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 10000 });
    await page.type('input[autocomplete="current-password"]', X_PASSWORD, { delay: 80 });
    await page.keyboard.press('Enter');
    await delay(5000);
    console.log('Logged in successfully.');

    // --- FETCH FOLLOWING LIST ---
    const followingUrl = `https://x.com/${X_USERNAME}/following`;
    console.log(`Opening following list: ${followingUrl}`);
    await page.goto(followingUrl, { waitUntil: 'networkidle2' });
    await delay(3000);

    // --- FETCH FOLLOWERS LIST for comparison ---
    console.log('Fetching followers for comparison...');
    const followersUrl = `https://x.com/${X_USERNAME}/followers`;
    await page.goto(followersUrl, { waitUntil: 'networkidle2' });
    await delay(3000);

    // Scroll and collect all follower usernames
    const followerSet = new Set();
    let lastSize = 0;
    for (let i = 0; i < 50; i++) {
      const handles = await page.$$eval(
        '[data-testid="UserCell"] a[href^="/"]',
        (els) => els.map((e) => e.getAttribute('href').replace('/', '').toLowerCase())
      );
      handles.forEach((h) => { if (h && !h.includes('/')) followerSet.add(h); });
      if (followerSet.size === lastSize) break;
      lastSize = followerSet.size;
      await page.evaluate(() => window.scrollBy(0, 1200));
      await delay(1500);
    }
    console.log(`Total followers found: ${followerSet.size}`);

    // --- BACK TO FOLLOWING LIST ---
    await page.goto(followingUrl, { waitUntil: 'networkidle2' });
    await delay(3000);

    let unfollowedCount = 0;

    // Scroll and unfollow non-reciprocal
    for (let scroll = 0; scroll < 200; scroll++) {
      // Get all Following buttons with their associated usernames
      const users = await page.$$eval('[data-testid="UserCell"]', (cells) =>
        cells.map((cell) => {
          const linkEl = cell.querySelector('a[href^="/"]');
          const btn = cell.querySelector('[data-testid="placementTracking"] button');
          const handle = linkEl ? linkEl.getAttribute('href').replace('/', '').toLowerCase() : null;
          const isFollowing = btn ? btn.innerText.trim() === 'Following' : false;
          return { handle, isFollowing };
        })
      );

      for (const user of users) {
        if (!user.handle || !user.isFollowing) continue;
        if (followerSet.has(user.handle)) continue; // they follow back
        if (EXCLUDED_USERS.map((u) => u.toLowerCase()).includes(user.handle)) continue;

        // Click Unfollow
        try {
          const cell = await page.$(`[data-testid="UserCell"] a[href="/${user.handle}"]`);
          if (!cell) continue;
          const parentCell = await cell.evaluateHandle((el) => el.closest('[data-testid="UserCell"]'));
          const btn = await parentCell.$('[data-testid="placementTracking"] button');
          if (!btn) continue;
          await btn.click();
          await delay(1000);
          // Confirm unfollow in modal
          const confirmBtn = await page.$('[data-testid="confirmationSheetConfirm"]');
          if (confirmBtn) await confirmBtn.click();
          console.log(`Unfollowed @${user.handle}`);
          unfollowedCount++;
          await delay(3000); // respectful delay
        } catch (e) {
          console.error(`Error unfollowing @${user.handle}:`, e.message);
        }
      }

      // Scroll down to load more
      const prevHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.evaluate(() => window.scrollBy(0, 1500));
      await delay(2000);
      const newHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      if (newHeight === prevHeight) break; // no more content
    }

    console.log(`\nDone! Unfollowed ${unfollowedCount} non-reciprocal account(s).`);
  } catch (err) {
    console.error('Fatal error:', err.message || err);
    await page.screenshot({ path: 'error-screenshot.png' });
  } finally {
    await browser.close();
  }
})();
