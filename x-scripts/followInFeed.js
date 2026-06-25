/* =============================================================================
 *  X (Twitter) Feed Auto-Follow Tool  —  paste-into-console edition
 *
 *  HOW TO USE
 *  ----------
 *  1. Open https://x.com/home in your browser and log in.
 *  2. Scroll down a bit so plenty of tweets are loaded (the more the better).
 *  3. Open DevTools console:  Windows: Ctrl+Shift+J   Mac: Cmd+Option+J
 *  4. Paste this entire file and press Enter. A panel appears bottom-left.
 *  5. Click SCAN FEED — it auto-scrolls your feed, extracts every tweet
 *     author, then checks via API which ones you don't already follow.
 *  6. (Optional) Click 🚫 on anyone to BLACKLIST them (never followed).
 *  7. Select the ones you want and click FOLLOW SELECTED.
 *
 *  NOTES
 *  -----
 *  - Blacklist + settings persist in localStorage across sessions.
 *  - Defaults are conservative (paced delays, 50/run cap).
 *  - You can also type a keyword and click SEARCH to find extra accounts.
 *  - This automates X's private web endpoints, which is generally against
 *    X's Terms of Service. Use at your own risk.
 * ========================================================================== */

(() => {
  if (window.__xFollowerLoaded) {
    alert('X Auto-Follow is already open.');
    return;
  }
  window.__xFollowerLoaded = true;

  // ----- constants -----------------------------------------------------------
  const BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const API    = 'https://x.com/i/api/1.1';
  const BL_KEY  = 'xf_blacklist';
  const CFG_KEY = 'xf_config';

  const RESERVED_PATHS = new Set([
    'home','explore','search','notifications','messages','i','settings',
    'compose','logout','login','tos','privacy','about','help','jobs',
    'lists','bookmarks','communities','premium','verified','analytics',
    'hashtag','intent','share','account','signup',
  ]);

  const DEFAULT_CFG = {
    delayMs:        5000,
    jitterMs:       4000,
    longPauseEvery: 10,
    longPauseMs:    90000,
    maxPerRun:      50,
    dryRun:         false,
    minFollowers:   0,
    maxFollowers:   0,
    hideVerified:   false,
    scrollCount:    12,      // how many times to auto-scroll before scanning
  };

  // ----- tiny helpers --------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getCookie(name) {
    const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : null;
  }
  function csrfToken() { return getCookie('ct0'); }
  function myUserId() {
    const t = getCookie('twid');
    return t ? decodeURIComponent(t).split('=')[1] : null;
  }
  function myScreenName() {
    // try to grab from the nav sidebar link
    const el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (el) {
      const m = el.getAttribute('href')?.match(/^\/([A-Za-z0-9_]+)/);
      if (m) return m[1].toLowerCase();
    }
    return null;
  }
  function apiHeaders(extra) {
    return Object.assign(
      {
        authorization: BEARER,
        'x-csrf-token': csrfToken() || '',
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': 'en',
      },
      extra || {}
    );
  }
  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  }
  function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  function css(el, obj) { Object.assign(el.style, obj); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  // ----- state ---------------------------------------------------------------
  let cfg       = Object.assign({}, DEFAULT_CFG, loadJSON(CFG_KEY, {}));
  let blacklist = loadJSON(BL_KEY, {});
  let discovered = [];
  let selected   = new Set();
  let scanning   = false;
  let running    = false;
  let stopRequested = false;

  // ----- API: rate-limit handler ---------------------------------------------
  async function handleRateLimit(res) {
    const reset = parseInt(res.headers.get('x-rate-limit-reset') || '0', 10);
    let wait = reset ? reset * 1000 - Date.now() : 60000;
    if (wait < 1000 || wait > 16 * 60000) wait = 60000;
    for (let s = Math.ceil(wait / 1000); s > 0; s--) {
      log(`Rate limited by X. Resuming in ${s}s…`, true);
      await sleep(1000);
    }
  }

  // ----- DOM: extract handles from visible tweets ----------------------------
  function scrapeHandlesFromDOM() {
    const handles = new Set();
    const mySn = myScreenName();

    // Strategy 1: find all links inside tweet articles
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach((article) => {
      // The first profile link in a tweet is the author
      const links = article.querySelectorAll('a[href^="/"]');
      links.forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
          if (!mySn || m[1].toLowerCase() !== mySn) {
            handles.add(m[1]);
          }
        }
      });
    });

    // Strategy 2: broader sweep for user links (catches "Who to follow" cards etc.)
    const allLinks = document.querySelectorAll(
      '[data-testid="UserCell"] a[href^="/"], ' +
      'aside a[href^="/"]'
    );
    allLinks.forEach((a) => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
        if (!mySn || m[1].toLowerCase() !== mySn) {
          handles.add(m[1]);
        }
      }
    });

    return [...handles];
  }

  // ----- DOM: auto-scroll to load more tweets --------------------------------
  async function autoScroll(times, onTick) {
    for (let i = 0; i < times; i++) {
      if (stopRequested) break;
      window.scrollBy({ top: window.innerHeight * 2.5, behavior: 'smooth' });
      onTick && onTick(i + 1, times);
      // wait for new tweets to render
      await sleep(1800 + Math.random() * 1200);
    }
  }

  // ----- API: look up users by screen_name -----------------------------------
  async function lookupUsers(screenNames, onProgress) {
    const users = [];
    // /users/lookup.json accepts up to 100 comma-separated screen_names
    for (let i = 0; i < screenNames.length; i += 100) {
      if (stopRequested) break;
      const batch = screenNames.slice(i, i + 100);
      const url = `${API}/users/lookup.json?screen_name=${batch.join(',')}` +
        `&include_entities=0`;
      try {
        const res = await fetch(url, { headers: apiHeaders(), credentials: 'include' });
        if (res.status === 429) { await handleRateLimit(res); i -= 100; continue; }
        if (res.status === 401) {
          throw new Error('401 Unauthorized — bearer token may have rotated.');
        }
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) users.push(...data);
        }
      } catch (e) {
        log('Lookup error: ' + e.message);
      }
      onProgress && onProgress(users.length, screenNames.length);
      await sleep(600);
    }
    return users;
  }

  // ----- API: search for users by keyword ------------------------------------
  async function searchUsers(query, maxPages, onProgress) {
    const users = [];
    const seen = new Set(discovered.map((u) => u.id_str));
    maxPages = maxPages || 5;
    for (let page = 1; page <= maxPages; page++) {
      if (stopRequested) break;
      const url = `${API}/users/search.json` +
        `?q=${encodeURIComponent(query)}&count=20&page=${page}&include_entities=0`;
      try {
        const res = await fetch(url, { headers: apiHeaders(), credentials: 'include' });
        if (res.status === 429) { await handleRateLimit(res); continue; }
        if (!res.ok) break;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) break;
        data.forEach((u) => {
          if (u && u.id_str && !u.following && !seen.has(u.id_str)) {
            seen.add(u.id_str);
            users.push(u);
          }
        });
        onProgress && onProgress(users.length);
      } catch (e) { log('Search error: ' + e.message); break; }
      await sleep(800);
    }
    return users;
  }

  // ----- API: follow a user --------------------------------------------------
  async function followUser(idStr) {
    const res = await fetch(`${API}/friendships/create.json`, {
      method: 'POST',
      headers: apiHeaders({ 'content-type': 'application/x-www-form-urlencoded' }),
      credentials: 'include',
      body: 'user_id=' + encodeURIComponent(idStr),
    });
    if (res.status === 429) return { ok: false, rateLimited: true, res };
    return { ok: res.ok, status: res.status, res };
  }

  // ----- filtering -----------------------------------------------------------
  function isVisible(u) {
    if (cfg.hideVerified && (u.verified || u.is_blue_verified)) return false;
    if (cfg.minFollowers > 0 && (u.followers_count || 0) < cfg.minFollowers) return false;
    if (cfg.maxFollowers > 0 && (u.followers_count || 0) > cfg.maxFollowers) return false;
    return true;
  }
  function isBlacklisted(u) { return !!blacklist[u.id_str]; }

  // ==========================================================================
  //  UI
  // ==========================================================================
  const COLORS = {
    bg: '#15181c', panel: '#1d2126', line: '#2a2f36', text: '#e7e9ea',
    sub: '#8b98a5', accent: '#1d9bf0', danger: '#f4212e', ok: '#00ba7c',
    chipBg: '#262b31',
  };

  const root = document.createElement('div');
  css(root, {
    position: 'fixed', left: '18px', bottom: '18px', width: '400px',
    maxHeight: '82vh', background: COLORS.bg, color: COLORS.text,
    font: '13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    borderRadius: '16px', boxShadow: '0 18px 50px rgba(0,0,0,.55)',
    zIndex: '2147483647', display: 'flex', flexDirection: 'column',
    border: '1px solid ' + COLORS.line, overflow: 'hidden',
  });

  // --- header ---
  const header = document.createElement('div');
  css(header, {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 14px', borderBottom: '1px solid ' + COLORS.line, cursor: 'move',
  });
  const titleEl = document.createElement('div');
  titleEl.textContent = 'X · Feed Auto-Follow';
  css(titleEl, { fontWeight: '700', fontSize: '14px' });
  const closeBtn = mkBtn('✕', () => { root.remove(); window.__xFollowerLoaded = false; });
  css(closeBtn, { background: 'transparent', color: COLORS.sub, padding: '2px 8px' });
  header.append(titleEl, closeBtn);

  // --- toolbar ---
  const toolbar = document.createElement('div');
  css(toolbar, { display: 'flex', gap: '8px', padding: '10px 14px', flexWrap: 'wrap',
    borderBottom: '1px solid ' + COLORS.line });
  const scanBtn = mkBtn('SCAN FEED', onScanFeed);
  css(scanBtn, { background: COLORS.accent, color: '#fff', flex: '1' });
  const followBtn = mkBtn('FOLLOW SELECTED', onFollow);
  css(followBtn, { background: COLORS.ok, color: '#fff', flex: '1' });
  const settingsBtn = mkBtn('⚙', () => toggleEl(settingsPanel));
  toolbar.append(scanBtn, followBtn, settingsBtn);

  // --- search bar ---
  const searchBar = document.createElement('div');
  css(searchBar, { display: 'flex', gap: '8px', padding: '8px 14px',
    borderBottom: '1px solid ' + COLORS.line });
  const searchInput = document.createElement('input');
  searchInput.type = 'text'; searchInput.placeholder = 'Or search users by keyword…';
  css(searchInput, { flex: '1', background: COLORS.panel, color: COLORS.text,
    border: '1px solid ' + COLORS.line, borderRadius: '999px', padding: '8px 14px',
    fontSize: '13px', outline: 'none' });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSearch(); });
  const searchBtn = mkBtn('SEARCH', onSearch);
  css(searchBtn, { background: COLORS.chipBg, color: COLORS.text });
  searchBar.append(searchInput, searchBtn);

  // --- sub-toolbar ---
  const subbar = document.createElement('div');
  css(subbar, { display: 'flex', gap: '8px', padding: '0 14px 10px', flexWrap: 'wrap' });
  const allBtn   = mkBtn('Select all', () => { listData().forEach((u) => selected.add(u.id_str)); render(); });
  const noneBtn  = mkBtn('Select none', () => { selected.clear(); render(); });
  const copyBtn  = mkBtn('Copy @handles', onCopy);
  const clearBtn = mkBtn('Clear list', () => { discovered = []; selected.clear(); render(); log('List cleared.'); });
  [allBtn, noneBtn, copyBtn, clearBtn].forEach((b) =>
    css(b, { background: COLORS.chipBg, color: COLORS.text, flex: '1', fontSize: '12px' }));
  subbar.append(allBtn, noneBtn, copyBtn, clearBtn);

  // --- settings panel ---
  const settingsPanel = document.createElement('div');
  css(settingsPanel, { display: 'none', padding: '10px 14px',
    borderBottom: '1px solid ' + COLORS.line, background: COLORS.panel });
  settingsPanel.append(
    mkToggle('Dry run (preview only — don\'t follow)', 'dryRun'),
    mkToggle('Exclude verified / blue-check accounts', 'hideVerified'),
    mkNum('Auto-scroll passes before scan', 'scrollCount'),
    mkNum('Min follower count (0 = any)', 'minFollowers'),
    mkNum('Max follower count (0 = no limit)', 'maxFollowers'),
    mkNum('Delay between follows (ms)', 'delayMs'),
    mkNum('Random extra delay up to (ms)', 'jitterMs'),
    mkNum('Long pause every N follows', 'longPauseEvery'),
    mkNum('Long pause length (ms)', 'longPauseMs'),
    mkNum('Max follows per run (0 = no cap)', 'maxPerRun'),
  );

  // --- status ---
  const statusEl = document.createElement('div');
  css(statusEl, { padding: '8px 14px', color: COLORS.sub, fontSize: '12px' });
  statusEl.textContent = 'Ready. Click SCAN FEED to begin.';

  // --- list ---
  const listEl = document.createElement('div');
  css(listEl, { overflowY: 'auto', flex: '1', padding: '4px 8px 8px' });

  // --- log ---
  const logBox = document.createElement('div');
  css(logBox, { maxHeight: '92px', overflowY: 'auto', padding: '8px 14px',
    borderTop: '1px solid ' + COLORS.line, color: COLORS.sub, fontSize: '11px',
    fontFamily: 'ui-monospace,Menlo,Consolas,monospace', whiteSpace: 'pre-wrap' });

  root.append(header, toolbar, searchBar, subbar, settingsPanel, statusEl, listEl, logBox);
  document.body.appendChild(root);
  makeDraggable(root, header);

  // ----- UI builders ---------------------------------------------------------
  function mkBtn(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    css(b, { border: 'none', borderRadius: '999px', padding: '8px 12px',
      fontWeight: '700', cursor: 'pointer', fontSize: '13px',
      background: COLORS.chipBg, color: COLORS.text });
    b.addEventListener('click', onClick);
    return b;
  }
  function mkToggle(label, key) {
    const wrap = document.createElement('label');
    css(wrap, { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 0',
      cursor: 'pointer' });
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!cfg[key];
    cb.addEventListener('change', () => { cfg[key] = cb.checked; saveJSON(CFG_KEY, cfg); render(); });
    const span = document.createElement('span'); span.textContent = label;
    wrap.append(cb, span);
    return wrap;
  }
  function mkNum(label, key) {
    const wrap = document.createElement('label');
    css(wrap, { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '8px', padding: '5px 0' });
    const span = document.createElement('span'); span.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.value = cfg[key]; inp.min = '0';
    css(inp, { width: '90px', background: COLORS.bg, color: COLORS.text,
      border: '1px solid ' + COLORS.line, borderRadius: '8px', padding: '4px 6px' });
    inp.addEventListener('change', () => {
      cfg[key] = Math.max(0, parseInt(inp.value || '0', 10)); saveJSON(CFG_KEY, cfg);
    });
    wrap.append(span, inp);
    return wrap;
  }
  function toggleEl(el) { el.style.display = el.style.display === 'none' ? 'block' : 'none'; }

  function log(msg, replaceLast) {
    const line = '› ' + msg;
    if (replaceLast && logBox.lastChild) logBox.lastChild.textContent = line;
    else { const d = document.createElement('div'); d.textContent = line; logBox.appendChild(d); }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function listData() {
    return discovered.filter((u) => isVisible(u) && !isBlacklisted(u));
  }

  function render() {
    listEl.innerHTML = '';
    const visible = listData();
    const blCount = discovered.filter(isBlacklisted).length;
    const selCount = visible.filter((u) => selected.has(u.id_str)).length;

    statusEl.textContent =
      `${discovered.length} found · ${visible.length} shown · ` +
      `${selCount} selected · ${blCount} blacklisted` +
      (cfg.dryRun ? '  ·  DRY RUN ON' : '');
    statusEl.style.color = cfg.dryRun ? COLORS.ok : COLORS.sub;

    if (visible.length === 0) {
      const empty = document.createElement('div');
      css(empty, { padding: '24px 12px', textAlign: 'center', color: COLORS.sub });
      empty.textContent = discovered.length
        ? 'Nothing to show (check filters / blacklist).'
        : 'No users yet — click SCAN FEED.';
      listEl.appendChild(empty);
      return;
    }

    visible.forEach((u) => {
      const row = document.createElement('div');
      css(row, { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 6px',
        borderBottom: '1px solid ' + COLORS.line });

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = selected.has(u.id_str);
      css(cb, { marginTop: '10px' });
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(u.id_str) : selected.delete(u.id_str); render();
      });

      const avatar = document.createElement('img');
      avatar.src = (u.profile_image_url_https || '').replace('_normal', '_bigger');
      avatar.referrerPolicy = 'no-referrer';
      css(avatar, { width: '34px', height: '34px', borderRadius: '50%', flex: '0 0 auto',
        background: COLORS.chipBg, marginTop: '2px' });

      const meta = document.createElement('div');
      css(meta, { flex: '1', minWidth: '0' });
      const nameLine = document.createElement('div');
      css(nameLine, { fontWeight: '700', whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis' });
      nameLine.innerHTML = esc(u.name)
        + (u.verified || u.is_blue_verified
            ? ' <span style="color:' + COLORS.accent + '">✔</span>' : '')
        + (u.protected
            ? ' <span style="color:' + COLORS.sub + '">🔒</span>' : '');
      const handle = document.createElement('a');
      handle.textContent = '@' + u.screen_name;
      handle.href = 'https://x.com/' + u.screen_name;
      handle.target = '_blank';
      css(handle, { color: COLORS.sub, textDecoration: 'none', fontSize: '12px' });
      const stats = document.createElement('div');
      css(stats, { color: COLORS.sub, fontSize: '11px', marginTop: '2px' });
      stats.textContent =
        `${fmtNum(u.followers_count || 0)} followers · ${fmtNum(u.friends_count || 0)} following`;
      const bio = document.createElement('div');
      css(bio, { color: COLORS.sub, fontSize: '11px', marginTop: '3px',
        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: '2',
        WebkitBoxOrient: 'vertical' });
      bio.textContent = (u.description || '').replace(/\n/g, ' ');
      meta.append(nameLine, handle, stats);
      if (u.description) meta.appendChild(bio);

      const blockBtn = document.createElement('button');
      blockBtn.title = 'Blacklist (never follow)';
      blockBtn.textContent = '🚫';
      css(blockBtn, { border: 'none', background: 'transparent', cursor: 'pointer',
        color: COLORS.sub, fontSize: '16px', flex: '0 0 auto', marginTop: '6px' });
      blockBtn.addEventListener('click', () => {
        blacklist[u.id_str] = { screen_name: u.screen_name, name: u.name };
        saveJSON(BL_KEY, blacklist); selected.delete(u.id_str); render();
        log('Blacklisted @' + u.screen_name);
      });

      row.append(cb, avatar, meta, blockBtn);
      listEl.appendChild(row);
    });
  }

  // ----- actions -------------------------------------------------------------

  async function onScanFeed() {
    if (scanning || running) return;
    if (!csrfToken() || !myUserId()) {
      alert('Could not read session cookies. Make sure you are logged in to x.com.');
      return;
    }
    scanning = true; stopRequested = false;
    scanBtn.textContent = 'SCROLLING…'; scanBtn.disabled = true;

    // Step 1: auto-scroll the feed to load lots of tweets
    const scrolls = cfg.scrollCount || 12;
    log(`Auto-scrolling ${scrolls} times to load tweets…`);
    const startY = window.scrollY;
    await autoScroll(scrolls, (i, total) => {
      statusEl.textContent = `Scrolling… ${i}/${total}`;
    });

    // Step 2: scrape handles from the DOM
    scanBtn.textContent = 'SCANNING…';
    log('Extracting usernames from loaded tweets…');
    const handles = scrapeHandlesFromDOM();
    log(`Found ${handles.length} unique handles in the DOM.`);

    // Scroll back to roughly where we started
    window.scrollTo({ top: startY, behavior: 'smooth' });

    if (handles.length === 0) {
      log('No handles found — are you on x.com/home?');
      scanning = false;
      scanBtn.textContent = 'SCAN FEED'; scanBtn.disabled = false;
      return;
    }

    // Step 3: look up via API and filter to non-followed
    log('Looking up user details via API…');
    try {
      const existingIds = new Set(discovered.map((u) => u.id_str));
      const users = await lookupUsers(handles, (done, total) => {
        statusEl.textContent = `Looked up ${done}/${total} handles…`;
      });

      let added = 0;
      users.forEach((u) => {
        // Only keep users you do NOT already follow
        if (u && u.id_str && !u.following && !existingIds.has(u.id_str)) {
          discovered.push(u);
          existingIds.add(u.id_str);
          added++;
        }
      });

      // Pre-select all visible new users
      listData().forEach((u) => selected.add(u.id_str));
      log(`Done. ${added} non-followed accounts added (${discovered.length} total).`);
      render();
    } catch (e) {
      log('ERROR: ' + e.message);
      alert('Scan failed: ' + e.message);
    } finally {
      scanning = false;
      scanBtn.textContent = 'SCAN FEED'; scanBtn.disabled = false;
    }
  }

  async function onSearch() {
    if (scanning || running) return;
    const q = searchInput.value.trim();
    if (!q) { alert('Type a keyword to search.'); return; }
    if (!csrfToken()) {
      alert('Could not read session cookies. Make sure you are logged in to x.com.');
      return;
    }
    scanning = true; stopRequested = false;
    searchBtn.textContent = '…'; searchBtn.disabled = true;
    log(`Searching users for "${q}"…`);
    try {
      const users = await searchUsers(q, 5, (n) => {
        statusEl.textContent = `Search found ${n} new users…`;
      });
      const existing = new Set(discovered.map((u) => u.id_str));
      let added = 0;
      users.forEach((u) => {
        if (!existing.has(u.id_str)) {
          discovered.push(u);
          existing.add(u.id_str);
          added++;
        }
      });
      listData().forEach((u) => selected.add(u.id_str));
      log(`Search done. ${added} new accounts added (${discovered.length} total).`);
      render();
    } catch (e) {
      log('ERROR: ' + e.message);
    } finally {
      scanning = false; searchBtn.textContent = 'SEARCH'; searchBtn.disabled = false;
    }
  }

  async function onFollow() {
    if (running || scanning) return;
    const targets = listData().filter((u) => selected.has(u.id_str));
    if (targets.length === 0) { alert('Nothing selected.'); return; }

    const capped = cfg.maxPerRun > 0 ? targets.slice(0, cfg.maxPerRun) : targets;
    const verb = cfg.dryRun ? 'PREVIEW (dry run) — no one will be followed' : 'FOLLOW';
    if (!confirm(`${verb}\n\n${capped.length} account(s) will be processed`
        + (cfg.maxPerRun > 0 && targets.length > capped.length
            ? ` (capped from ${targets.length}; run again for the rest)` : '')
        + '.\n\nContinue?')) return;

    running = true; stopRequested = false;
    followBtn.textContent = 'STOP';
    const stopHandler = () => { stopRequested = true; log('Stopping after current item…'); };
    followBtn.removeEventListener('click', onFollow);
    followBtn.addEventListener('click', stopHandler);

    let done = 0, ok = 0, fail = 0;
    for (const u of capped) {
      if (stopRequested) break;
      done++;
      log(`(${done}/${capped.length}) ${cfg.dryRun ? 'would follow' : 'following'} @${u.screen_name}…`);
      if (!cfg.dryRun) {
        try {
          let r = await followUser(u.id_str);
          if (r.rateLimited) { await handleRateLimit(r.res); r = await followUser(u.id_str); }
          if (r.ok) {
            ok++;
            discovered = discovered.filter((x) => x.id_str !== u.id_str);
            selected.delete(u.id_str);
            render();
          } else { fail++; log(`  failed (@${u.screen_name}): HTTP ${r.status}`); }
        } catch (e) { fail++; log(`  error (@${u.screen_name}): ${e.message}`); }
      } else { ok++; }

      if (done < capped.length && !stopRequested) {
        const isLong = cfg.longPauseEvery > 0 && done % cfg.longPauseEvery === 0;
        const wait = isLong
          ? cfg.longPauseMs
          : cfg.delayMs + Math.floor(Math.random() * (cfg.jitterMs + 1));
        if (isLong) {
          for (let s = Math.ceil(wait / 1000); s > 0 && !stopRequested; s--) {
            log(`Long pause: ${s}s…`, true); await sleep(1000);
          }
        } else { await sleep(wait); }
      }
    }

    log(`Finished. ${cfg.dryRun ? 'Previewed' : 'Followed'} ${ok}, failed ${fail}.`);
    running = false;
    followBtn.textContent = 'FOLLOW SELECTED';
    followBtn.removeEventListener('click', stopHandler);
    followBtn.addEventListener('click', onFollow);
    render();
  }

  async function onCopy() {
    const handles = listData().map((u) => '@' + u.screen_name).sort().join('\n');
    if (!handles) { alert('Nothing to copy.'); return; }
    try { await navigator.clipboard.writeText(handles); log('Copied handles to clipboard.'); }
    catch { prompt('Copy the list:', handles); }
  }

  // ----- drag ----------------------------------------------------------------
  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      css(el, { right: 'auto', bottom: 'auto', left: ox + 'px', top: oy + 'px' });
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      css(el, { left: ox + (e.clientX - sx) + 'px', top: oy + (e.clientY - sy) + 'px' });
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  render();
  log('Loaded. Click SCAN FEED on x.com/home.');
})();
