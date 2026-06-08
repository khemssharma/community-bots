const puppeteer = require('puppeteer-core');

const X_USERNAME = process.env.X_SCREEN_NAME;
const X_PASSWORD = process.env.X_PASSWORD;
const X_EMAIL    = process.env.X_EMAIL;
const EXCLUDED_USERS = process.env.EXCLUDED_USERS
  ? process.env.EXCLUDED_USERS.split(',')
  : [];

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrollToBottom(page) {
  let lastHeight = await page.evaluate('document.body.scrollHeight');
  while (true) {
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await delay(2500);
    const newHeight = await page.evaluate('document.body.scrollHeight');
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
  }
}

async function getUsersFromList(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(3000);
  const users = new Set();
  let lastCount = 0;
  let sameCount = 0;
  while (sameCount < 3) {
    const handles = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href*="/"]');
      const found = [];
      anchors.forEach(a => {
        const href = a.getAttribute('href');
        if (href && /^\/[a-zA-Z0-9_]+$/.test(href)) {
          const username = href.replace('/', '');
          if (!['home','explore','notifications','messages','settings','i'].includes(username)) {
            found.push(username.toLowerCase());
          }
        }
      });
      return [...new Set(found)];
    });
    handles.forEach(h => users.add(h));
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await delay(3000);
    if (users.size === lastCount) {
      sameCount++;
    } else {
      sameCount = 0;
      lastCount = users.size;
    }
  }
  return users;
}

(async () => {
  console.log('Starting X.com Unfollow Bot (Puppeteer)...');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Login
  console.log('Logging in...');
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(3000);

  await page.waitForSelector('input[autocomplete="username"]', { timeout: 20000 });
  await page.type('input[autocomplete="username"]', X_EMAIL, { delay: 80 });
  await page.keyboard.press('Enter');
  await delay(3000);

  // Username challenge
  try {
    const challenge = await page.$('input[data-testid="ocfEnterTextTextInput"]');
    if (challenge) {
      console.log('Username challenge detected...');
      await challenge.type(X_USERNAME, { delay: 80 });
      await page.keyboard.press('Enter');
      await delay(3000);
    }
  } catch (e) {}

  await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 20000 });
  await page.type('input[autocomplete="current-password"]', X_PASSWORD, { delay: 80 });
  await page.keyboard.press('Enter');
  await delay(6000);

  const currentUrl = page.url();
  console.log('After login URL:', currentUrl);
  if (currentUrl.includes('login') || currentUrl.includes('error')) {
    console.error('Login may have failed!');
    await browser.close();
    process.exit(1);
  }
  console.log('Login successful!');

  // Collect following list
  console.log('Fetching following list...');
  const followingUrl = `https://x.com/${X_USERNAME}/following`;
  const following = await getUsersFromList(page, followingUrl);
  console.log(`Following count: ${following.size}`);

  // Collect followers list
  console.log('Fetching followers list...');
  const followersUrl = `https://x.com/${X_USERNAME}/followers`;
  const followers = await getUsersFromList(page, followersUrl);
  console.log(`Followers count: ${followers.size}`);

  // Find non-reciprocal
  const nonReciprocal = [...following].filter(
    u => !followers.has(u) && !EXCLUDED_USERS.map(e => e.toLowerCase()).includes(u)
  );
  console.log(`Non-reciprocal accounts: ${nonReciprocal.length}`);

  // Unfollow each
  for (const username of nonReciprocal) {
    try {
      console.log(`Unfollowing @${username}...`);
      await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000);

      // Find the Following button
      const followingBtn = await page.$('[data-testid$="-unfollow"], [aria-label="Following"]');
      if (followingBtn) {
        await followingBtn.click();
        await delay(1500);
        // Confirm unfollow in dialog
        const confirmBtn = await page.$('[data-testid="confirmationSheetConfirm"]');
        if (confirmBtn) {
          await confirmBtn.click();
          console.log(`Unfollowed @${username}`);
        }
      } else {
        console.log(`Could not find unfollow button for @${username}`);
      }
      await delay(3000);
    } catch (err) {
      console.error(`Error unfollowing @${username}: ${err.message}`);
    }
  }

  console.log('Done!');
  await browser.close();
})();
