/* =============================================================================
 *  X (Twitter) Non-Follower Unfollow Tool  —  paste-into-console edition
 *  Inspired by davidarroyo1234/InstagramUnfollowers (uses the site's own API).
 *
 *  HOW TO USE
 *  ----------
 *  1. Open https://x.com in your browser and log in.
 *  2. Open DevTools console:  Windows: Ctrl+Shift+J   Mac: Cmd+Option+J
 *  3. Paste this entire file and press Enter. A panel appears bottom-right.
 *  4. Click SCAN to load everyone you follow and flag who doesn't follow back.
 *  5. (Optional) Click the heart on anyone to WHITELIST them (never unfollowed).
 *  6. Leave DRY RUN on for a safe preview, then turn it off and click
 *     UNFOLLOW SELECTED to actually unfollow.
 *
 *  NOTES
 *  -----
 *  - Whitelist + settings persist in localStorage across sessions.
 *  - Defaults are conservative (paced delays, 150/run cap). Community guidance
 *    in 2025 suggests staying around 100–150 unfollows/day to avoid flags.
 *  - This automates X's private web endpoints, which is generally against X's
 *    Terms of Service. Use at your own risk.
 *  - If SCAN returns 401, X may have rotated the public bearer token; update
 *    the BEARER constant below (grab it from a real request in the Network tab).
 * ========================================================================== */

(() => {
  if (window.__xUnfollowerLoaded) {
    alert('X Unfollower is already open.');
    return;
  }
  window.__xUnfollowerLoaded = true;

  // ----- constants -----------------------------------------------------------
  const BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const API = 'https://x.com/i/api/1.1';
  const WL_KEY = 'xu_whitelist';     // { id_str: { screen_name, name } }
  const CFG_KEY = 'xu_config';

  const DEFAULT_CFG = {
    delayMs: 4000,        // base delay between unfollows
    jitterMs: 3000,       // random extra 0..jitter added to each delay
    longPauseEvery: 10,   // after this many unfollows, take a long pause
    longPauseMs: 60000,   // length of the long pause
    maxPerRun: 150,       // hard cap per run (0 = no cap)
    dryRun: false,         // preview only; do not actually unfollow
    hideVerified: false,  // exclude verified accounts from the unfollow list
    hideProtected: false, // exclude protected/private accounts
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

  // ----- state ---------------------------------------------------------------
  let cfg = Object.assign({}, DEFAULT_CFG, loadJSON(CFG_KEY, {}));
  let whitelist = loadJSON(WL_KEY, {});      // id_str -> {screen_name, name}
  let nonFollowers = [];                     // array of user objects
  let selected = new Set();                  // id_str selected for unfollow
  let scanning = false;
  let running = false;
  let stopRequested = false;

  // ----- API: enumerate everyone you follow ----------------------------------
  async function handleRateLimit(res) {
    const reset = parseInt(res.headers.get('x-rate-limit-reset') || '0', 10);
    let wait = reset ? reset * 1000 - Date.now() : 60000;
    if (wait < 1000 || wait > 16 * 60000) wait = 60000;
    for (let s = Math.ceil(wait / 1000); s > 0; s--) {
      log(`Rate limited by X. Resuming in ${s}s…`, true);
      await sleep(1000);
    }
  }

  async function fetchAllFollowing(onProgress) {
    let cursor = '-1';
    const users = [];
    while (cursor !== '0') {
      if (stopRequested) break;
      const url =
        `${API}/friends/list.json?count=200&skip_status=1` +
        `&include_user_entities=0&cursor=${cursor}`;
      const res = await fetch(url, { headers: apiHeaders(), credentials: 'include' });
      if (res.status === 429) { await handleRateLimit(res); continue; }
      if (res.status === 401) {
        throw new Error('401 Unauthorized — the bearer token may have rotated. '
          + 'See the note at the top of the script.');
      }
      if (!res.ok) throw new Error('friends/list failed: HTTP ' + res.status);
      const data = await res.json();
      (data.users || []).forEach((u) => users.push(u));
      cursor = data.next_cursor_str;
      onProgress && onProgress(users.length);
      await sleep(900); // gentle pause between list pages
    }
    return users;
  }

  async function unfollowUser(idStr) {
    const res = await fetch(`${API}/friendships/destroy.json`, {
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
    if (cfg.hideProtected && u.protected) return false;
    return true;
  }
  function isWhitelisted(u) { return !!whitelist[u.id_str]; }

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
    position: 'fixed', right: '18px', bottom: '18px', width: '380px',
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
  const title = document.createElement('div');
  title.textContent = 'X · Non-Follower Cleanup';
  css(title, { fontWeight: '700', fontSize: '14px' });
  const closeBtn = mkBtn('✕', () => { root.remove(); window.__xUnfollowerLoaded = false; });
  css(closeBtn, { background: 'transparent', color: COLORS.sub, padding: '2px 8px' });
  header.append(title, closeBtn);

  // --- toolbar ---
  const toolbar = document.createElement('div');
  css(toolbar, { display: 'flex', gap: '8px', padding: '10px 14px', flexWrap: 'wrap',
    borderBottom: '1px solid ' + COLORS.line });
  const scanBtn = mkBtn('SCAN', onScan);
  css(scanBtn, { background: COLORS.accent, color: '#fff', flex: '1' });
  const unfollowBtn = mkBtn('UNFOLLOW SELECTED', onUnfollow);
  css(unfollowBtn, { background: COLORS.danger, color: '#fff', flex: '1' });
  const settingsBtn = mkBtn('⚙', () => toggle(settings));
  toolbar.append(scanBtn, unfollowBtn, settingsBtn);

  // --- sub-toolbar (select / copy) ---
  const subbar = document.createElement('div');
  css(subbar, { display: 'flex', gap: '8px', padding: '0 14px 10px', flexWrap: 'wrap' });
  const allBtn = mkBtn('Select all', () => { listData().forEach((u) => selected.add(u.id_str)); render(); });
  const noneBtn = mkBtn('Select none', () => { selected.clear(); render(); });
  const copyBtn = mkBtn('Copy @handles', onCopy);
  [allBtn, noneBtn, copyBtn].forEach((b) =>
    css(b, { background: COLORS.chipBg, color: COLORS.text, flex: '1', fontSize: '12px' }));
  subbar.append(allBtn, noneBtn, copyBtn);

  // --- settings panel ---
  const settings = document.createElement('div');
  css(settings, { display: 'none', padding: '10px 14px', borderBottom: '1px solid ' + COLORS.line,
    background: COLORS.panel });
  settings.append(
    mkToggle('Dry run (preview only — don\'t unfollow)', 'dryRun'),
    mkToggle('Exclude verified accounts', 'hideVerified'),
    mkToggle('Exclude protected accounts', 'hideProtected'),
    mkNum('Delay between unfollows (ms)', 'delayMs'),
    mkNum('Random extra delay up to (ms)', 'jitterMs'),
    mkNum('Long pause every N unfollows', 'longPauseEvery'),
    mkNum('Long pause length (ms)', 'longPauseMs'),
    mkNum('Max unfollows per run (0 = no cap)', 'maxPerRun'),
  );

  // --- status / counts ---
  const status = document.createElement('div');
  css(status, { padding: '8px 14px', color: COLORS.sub, fontSize: '12px' });
  status.textContent = 'Ready. Click SCAN to begin.';

  // --- list ---
  const list = document.createElement('div');
  css(list, { overflowY: 'auto', flex: '1', padding: '4px 8px 8px' });

  // --- log ---
  const logBox = document.createElement('div');
  css(logBox, { maxHeight: '92px', overflowY: 'auto', padding: '8px 14px',
    borderTop: '1px solid ' + COLORS.line, color: COLORS.sub, fontSize: '11px',
    fontFamily: 'ui-monospace,Menlo,Consolas,monospace', whiteSpace: 'pre-wrap' });

  root.append(header, toolbar, subbar, settings, status, list, logBox);
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
  function toggle(el) { el.style.display = el.style.display === 'none' ? 'block' : 'none'; }

  function log(msg, replaceLast) {
    const line = '› ' + msg;
    if (replaceLast && logBox.lastChild) logBox.lastChild.textContent = line;
    else { const d = document.createElement('div'); d.textContent = line; logBox.appendChild(d); }
    logBox.scrollTop = logBox.scrollHeight;
  }

  // users to show in the list (respect filters, drop whitelisted to bottom note)
  function listData() {
    return nonFollowers.filter((u) => isVisible(u) && !isWhitelisted(u));
  }

  function render() {
    list.innerHTML = '';
    const visible = listData();
    const wlCount = nonFollowers.filter(isWhitelisted).length;

    const selCount = visible.filter((u) => selected.has(u.id_str)).length;
    status.textContent =
      `${nonFollowers.length} don't follow back · ${visible.length} shown · ` +
      `${selCount} selected · ${wlCount} whitelisted` +
      (cfg.dryRun ? '  ·  DRY RUN ON' : '');
    status.style.color = cfg.dryRun ? COLORS.ok : COLORS.sub;

    if (visible.length === 0) {
      const empty = document.createElement('div');
      css(empty, { padding: '24px 12px', textAlign: 'center', color: COLORS.sub });
      empty.textContent = nonFollowers.length
        ? 'Nothing to show (check filters / whitelist).'
        : 'No results yet — click SCAN.';
      list.appendChild(empty);
      return;
    }

    visible.forEach((u) => {
      const row = document.createElement('div');
      css(row, { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 6px',
        borderBottom: '1px solid ' + COLORS.line });

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = selected.has(u.id_str);
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(u.id_str) : selected.delete(u.id_str); render();
      });

      const avatar = document.createElement('img');
      avatar.src = (u.profile_image_url_https || '').replace('_normal', '_bigger');
      avatar.referrerPolicy = 'no-referrer';
      css(avatar, { width: '34px', height: '34px', borderRadius: '50%', flex: '0 0 auto',
        background: COLORS.chipBg });

      const meta = document.createElement('div');
      css(meta, { flex: '1', minWidth: '0' });
      const nameLine = document.createElement('div');
      css(nameLine, { fontWeight: '700', whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis' });
      nameLine.innerHTML = esc(u.name)
        + (u.verified || u.is_blue_verified ? ' <span style="color:' + COLORS.accent + '">✔</span>' : '')
        + (u.protected ? ' <span style="color:' + COLORS.sub + '">🔒</span>' : '');
      const handle = document.createElement('a');
      handle.textContent = '@' + u.screen_name;
      handle.href = 'https://x.com/' + u.screen_name;
      handle.target = '_blank';
      css(handle, { color: COLORS.sub, textDecoration: 'none', fontSize: '12px' });
      meta.append(nameLine, handle);

      const heart = document.createElement('button');
      heart.title = 'Whitelist (never unfollow)';
      heart.textContent = '♡';
      css(heart, { border: 'none', background: 'transparent', cursor: 'pointer',
        color: COLORS.sub, fontSize: '18px', flex: '0 0 auto' });
      heart.addEventListener('click', () => {
        whitelist[u.id_str] = { screen_name: u.screen_name, name: u.name };
        saveJSON(WL_KEY, whitelist); selected.delete(u.id_str); render();
        log('Whitelisted @' + u.screen_name);
      });

      row.append(cb, avatar, meta, heart);
      list.appendChild(row);
    });
  }

  // ----- actions -------------------------------------------------------------
  async function onScan() {
    if (scanning || running) return;
    if (!csrfToken() || !myUserId()) {
      alert('Could not read your session cookies. Make sure you are logged in to x.com.');
      return;
    }
    scanning = true; stopRequested = false;
    scanBtn.textContent = 'SCANNING…'; scanBtn.disabled = true;
    nonFollowers = []; selected.clear(); render();
    log('Loading the accounts you follow…');
    try {
      const all = await fetchAllFollowing((n) => {
        status.textContent = `Loaded ${n} following…`;
      });
      // A non-follower = you follow them, they don't follow you back.
      nonFollowers = all.filter((u) => u.following && !u.followed_by);
      // Pre-select everyone not whitelisted / filtered out.
      listData().forEach((u) => selected.add(u.id_str));
      log(`Done. ${all.length} following · ${nonFollowers.length} don't follow back.`);
      render();
    } catch (e) {
      log('ERROR: ' + e.message);
      alert('Scan failed: ' + e.message);
    } finally {
      scanning = false; scanBtn.textContent = 'SCAN'; scanBtn.disabled = false;
    }
  }

  async function onUnfollow() {
    if (running || scanning) return;
    const targets = listData().filter((u) => selected.has(u.id_str));
    if (targets.length === 0) { alert('Nothing selected.'); return; }

    const capped = cfg.maxPerRun > 0 ? targets.slice(0, cfg.maxPerRun) : targets;
    const verb = cfg.dryRun ? 'PREVIEW (dry run) — no one will be unfollowed' : 'UNFOLLOW';
    if (!confirm(`${verb}\n\n${capped.length} account(s) will be processed`
        + (cfg.maxPerRun > 0 && targets.length > capped.length
            ? ` (capped from ${targets.length}; run again for the rest)` : '')
        + '.\n\nContinue?')) return;

    running = true; stopRequested = false;
    unfollowBtn.textContent = 'STOP';
    const stopHandler = () => { stopRequested = true; log('Stopping after current item…'); };
    unfollowBtn.removeEventListener('click', onUnfollow);
    unfollowBtn.addEventListener('click', stopHandler);

    let done = 0, ok = 0, fail = 0;
    for (const u of capped) {
      if (stopRequested) break;
      done++;
      log(`(${done}/${capped.length}) ${cfg.dryRun ? 'would unfollow' : 'unfollowing'} @${u.screen_name}…`);
      if (!cfg.dryRun) {
        try {
          let r = await unfollowUser(u.id_str);
          if (r.rateLimited) { await handleRateLimit(r.res); r = await unfollowUser(u.id_str); }
          if (r.ok) {
            ok++;
            nonFollowers = nonFollowers.filter((x) => x.id_str !== u.id_str);
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

    log(`Finished. ${cfg.dryRun ? 'Previewed' : 'Unfollowed'} ${ok}, failed ${fail}.`);
    running = false;
    unfollowBtn.textContent = 'UNFOLLOW SELECTED';
    unfollowBtn.removeEventListener('click', stopHandler);
    unfollowBtn.addEventListener('click', onUnfollow);
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
  log('Loaded. Click SCAN.');
})();
