/* =============================================================================
 *  Indeed (India) Job Finder  —  paste-into-console edition
 *  Scans Indeed search results, normalizes salaries to a MONTHLY figure,
 *  keeps jobs paying >= a threshold (default Rs.40,000/month), and gives you a
 *  reviewable shortlist you can export or open to apply yourself.
 *
 *  WHAT THIS DOES / DOESN'T DO
 *  ---------------------------
 *  - It FINDS and ORGANIZES jobs. It does NOT auto-submit applications.
 *    Indeed's ToS prohibit automating the Apply process, it sits behind
 *    Cloudflare/CAPTCHA that a console script can't bypass, and auto-answered
 *    screener questions trigger automatic rejections. "Open selected" instead
 *    opens each job so you review and click Apply yourself (one human click).
 *
 *  HOW TO USE
 *  ----------
 *  1. Go to in.indeed.com and run a search. To cover all of India, set the
 *     location box to "India" (and a job title/keyword if you want). Example:
 *       https://in.indeed.com/jobs?q=&l=India
 *  2. Open DevTools console (Windows: Ctrl+Shift+J, Mac: Cmd+Option+J).
 *  3. Paste this whole file, press Enter. A panel appears bottom-right.
 *  4. Click "Scan this page". Go to the next results page and scan again, or
 *     try "Auto-scan" to pull several pages automatically. Results accumulate.
 *  5. Review the list, then "Open selected" to apply, or "Copy CSV" to export.
 *
 *  NOTES
 *  -----
 *  - Scraping Indeed is against its ToS; this is read-only personal use, but
 *    use it gently (the script paces page fetches).
 *  - Salary period conversions are approximate: year/12, week*4.33, day*26,
 *    hour*208. Jobs with no listed salary are hidden unless you enable them.
 *  - Indeed changes its HTML often; if scanning finds 0 jobs, the card
 *    selectors in parseCards() are what to update.
 * ========================================================================== */

(() => {
  if (window.__indeedFinderLoaded) { alert('Indeed Job Finder is already open.'); return; }
  window.__indeedFinderLoaded = true;

  const STORE_KEY = 'ijf_jobs';
  const CFG_KEY = 'ijf_cfg';

  const DEFAULT_CFG = {
    minMonthly: 40000,     // keep jobs paying at least this (Rs./month)
    includeNoSalary: false,// also keep jobs with no listed salary
    easyApplyOnly: false,  // show only one-click "Easily apply" jobs
    autoPages: 5,          // pages to pull in "Auto-scan"
    pageDelayMs: 2500,     // pause between auto-scanned pages
  };

  let cfg = Object.assign({}, DEFAULT_CFG, load(CFG_KEY, {}));
  let jobs = load(STORE_KEY, {});        // jk -> job object (dedup by job key)
  let selected = new Set();
  let busy = false, stop = false;

  // ---------- helpers ----------
  function load(k, fb) { try { return JSON.parse(localStorage.getItem(k)) || fb; } catch { return fb; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function css(el, o) { Object.assign(el.style, o); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- salary parsing ----------
  // Returns { min, max, period } in Rs./month, or null if unknown.
  function parseMonthly(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    let factor;
    if (/year|annum|\bp\.?a\.?\b|yr/.test(t)) factor = 1 / 12;
    else if (/month|\/mo|p\.?m\.?|mnth/.test(t)) factor = 1;
    else if (/week|\/wk/.test(t)) factor = 52 / 12;
    else if (/day|\/day/.test(t)) factor = 26;
    else if (/hour|\/hr|hr\b/.test(t)) factor = 208;
    else return null; // period unknown -> treat as no reliable salary
    const nums = (t.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [])
      .map(Number).filter((n) => n > 0);
    if (!nums.length) return null;
    const min = Math.min(...nums) * factor;
    const max = Math.max(...nums) * factor;
    return { min: Math.round(min), max: Math.round(max), period: factor };
  }
  function fmtRs(n) { return 'Rs.' + Math.round(n).toLocaleString('en-IN'); }

  // ---------- DOM scraping ----------
  function parseCards(scope) {
    const cards = scope.querySelectorAll(
      'div.job_seen_beacon, div.cardOutline, td.resultContent, [data-testid="slider_item"]');
    const found = [];
    cards.forEach((card) => {
      const a = card.querySelector('h2.jobTitle a, a.jcs-JobTitle, a[data-jk]');
      if (!a) return;
      const jk = a.getAttribute('data-jk')
        || ((a.getAttribute('href') || '').match(/jk=([0-9a-f]+)/i) || [])[1] || '';
      const title = (card.querySelector('h2.jobTitle span[title], h2.jobTitle a, a.jcs-JobTitle')
        ?.textContent || '').trim();
      const company = (card.querySelector('[data-testid="company-name"], .companyName')
        ?.textContent || '').trim();
      const loc = (card.querySelector('[data-testid="text-location"], .companyLocation')
        ?.textContent || '').trim();

      let salaryText = '';
      card.querySelectorAll(
        '[data-testid="attribute_snippet_testid"], .salary-snippet-container, ' +
        '.metadata.salary-snippet-container, .estimated-salary, .metadata').forEach((el) => {
        const txt = el.textContent.trim();
        if (!salaryText && /(?:₹|rs\.?|inr)\s*\d|a month|a year|a week|a day|an hour|per /i.test(txt)) {
          salaryText = txt;
        }
      });

      const easyApply = !!card.querySelector('[data-testid="indeedApply"]')
        || /easily apply/i.test(card.textContent);
      const url = jk ? location.origin + '/viewjob?jk=' + jk : a.href;
      found.push({ jk: jk || url, title, company, loc, salaryText, easyApply, url });
    });
    return found;
  }

  function addJobs(found) {
    let kept = 0;
    found.forEach((j) => {
      const sal = parseMonthly(j.salaryText);
      const qualifies = sal ? sal.max >= cfg.minMonthly : cfg.includeNoSalary;
      if (!qualifies) return;
      j.monthlyMin = sal ? sal.min : null;
      j.monthlyMax = sal ? sal.max : null;
      if (!jobs[j.jk]) kept++;
      jobs[j.jk] = j;
    });
    save(STORE_KEY, jobs);
    return kept;
  }

  // Fetch a results page by index without navigating (best-effort; may be
  // blocked by Cloudflare, in which case we fall back to manual paging).
  async function fetchPage(start) {
    const u = new URL(location.href);
    u.searchParams.set('start', String(start));
    const res = await fetch(u.toString(), { credentials: 'include', headers: { accept: 'text/html' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    if (/just a moment|cf-challenge|verifying you are human/i.test(html)) {
      throw new Error('blocked by bot-check');
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return parseCards(doc);
  }

  // ---------- UI ----------
  const C = { bg: '#10243e', panel: '#16314f', line: '#23456b', text: '#eef3f8',
    sub: '#9fb3c8', accent: '#2557a7', accent2: '#1f8a70', danger: '#c0392b', chip: '#1d3c5f' };

  const root = document.createElement('div');
  css(root, { position: 'fixed', right: '18px', bottom: '18px', width: '400px', maxHeight: '84vh',
    background: C.bg, color: C.text, zIndex: 2147483647, borderRadius: '16px',
    border: '1px solid ' + C.line, boxShadow: '0 18px 50px rgba(0,0,0,.5)', display: 'flex',
    flexDirection: 'column', overflow: 'hidden',
    font: '13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif' });

  const header = document.createElement('div');
  css(header, { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 14px', borderBottom: '1px solid ' + C.line, cursor: 'move' });
  const h = document.createElement('div'); h.textContent = 'Indeed Job Finder · India';
  css(h, { fontWeight: 700, fontSize: '14px' });
  const x = btn('✕', () => { root.remove(); window.__indeedFinderLoaded = false; });
  css(x, { background: 'transparent', color: C.sub });
  header.append(h, x);

  const bar = document.createElement('div');
  css(bar, { display: 'flex', gap: '8px', padding: '10px 14px', flexWrap: 'wrap',
    borderBottom: '1px solid ' + C.line });
  const scanBtn = btn('Scan this page', onScanOne); css(scanBtn, { background: C.accent, color: '#fff', flex: '1' });
  const autoBtn = btn('Auto-scan', onAutoScan); css(autoBtn, { background: C.accent2, color: '#fff', flex: '1' });
  const setBtn = btn('⚙', () => toggle(settings));
  bar.append(scanBtn, autoBtn, setBtn);

  const bar2 = document.createElement('div');
  css(bar2, { display: 'flex', gap: '8px', padding: '0 14px 10px', flexWrap: 'wrap' });
  const openBtn = btn('Open selected', onOpenSelected);
  const openAllBtn = btn('Open all', onOpenAll);
  [openBtn, openAllBtn].forEach((b) => css(b, { background: C.chip, color: C.text, flex: '1', fontSize: '12px' }));
  const csvBtn = btn('Copy CSV', onCSV); css(csvBtn, { background: C.chip, color: C.text, fontSize: '12px' });
  const clrBtn = btn('Clear', () => { jobs = {}; selected.clear(); save(STORE_KEY, jobs); render(); });
  css(clrBtn, { background: C.chip, color: C.sub, fontSize: '12px' });
  bar2.append(openBtn, openAllBtn, csvBtn, clrBtn);

  const settings = document.createElement('div');
  css(settings, { display: 'none', padding: '10px 14px', background: C.panel,
    borderBottom: '1px solid ' + C.line });
  settings.append(
    num('Minimum salary (Rs./month)', 'minMonthly'),
    num('Auto-scan: number of pages', 'autoPages'),
    toggleRow('Also keep jobs with no listed salary', 'includeNoSalary'),
    toggleRow('Show only one-click "Easily apply" jobs', 'easyApplyOnly'),
  );

  const selbar = document.createElement('div');
  css(selbar, { display: 'flex', gap: '8px', padding: '0 14px 8px' });
  const allBtn = btn('Select all', () => { visible().forEach((j) => selected.add(j.jk)); render(); });
  const noneBtn = btn('Select none', () => { selected.clear(); render(); });
  [allBtn, noneBtn].forEach((b) => css(b, { background: 'transparent', color: C.sub, fontSize: '12px', padding: '2px 6px' }));
  selbar.append(allBtn, noneBtn);

  const status = document.createElement('div');
  css(status, { padding: '0 14px 8px', color: C.sub, fontSize: '12px' });

  const list = document.createElement('div');
  css(list, { overflowY: 'auto', flex: 1, padding: '0 8px 8px' });

  const logBox = document.createElement('div');
  css(logBox, { maxHeight: '84px', overflowY: 'auto', padding: '8px 14px', borderTop: '1px solid ' + C.line,
    color: C.sub, fontSize: '11px', fontFamily: 'ui-monospace,Menlo,Consolas,monospace', whiteSpace: 'pre-wrap' });

  root.append(header, bar, bar2, settings, selbar, status, list, logBox);
  document.body.appendChild(root);
  drag(root, header);

  function btn(label, fn) {
    const b = document.createElement('button'); b.textContent = label;
    css(b, { border: 'none', borderRadius: '999px', padding: '8px 12px', fontWeight: 700,
      fontSize: '13px', cursor: 'pointer', background: C.chip, color: C.text });
    b.addEventListener('click', fn); return b;
  }
  function num(label, key) {
    const w = document.createElement('label');
    css(w, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' });
    const s = document.createElement('span'); s.textContent = label;
    const i = document.createElement('input'); i.type = 'number'; i.value = cfg[key]; i.min = '0';
    css(i, { width: '110px', background: C.bg, color: C.text, border: '1px solid ' + C.line,
      borderRadius: '8px', padding: '4px 6px' });
    i.addEventListener('change', () => { cfg[key] = Math.max(0, parseInt(i.value || '0', 10)); save(CFG_KEY, cfg); render(); });
    w.append(s, i); return w;
  }
  function toggleRow(label, key) {
    const w = document.createElement('label');
    css(w, { display: 'flex', gap: '8px', alignItems: 'center', padding: '5px 0', cursor: 'pointer' });
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!cfg[key];
    c.addEventListener('change', () => { cfg[key] = c.checked; save(CFG_KEY, cfg); render(); });
    const s = document.createElement('span'); s.textContent = label; w.append(c, s); return w;
  }
  function toggle(el) { el.style.display = el.style.display === 'none' ? 'block' : 'none'; }
  function log(m, replace) {
    const line = '› ' + m;
    if (replace && logBox.lastChild) logBox.lastChild.textContent = line;
    else { const d = document.createElement('div'); d.textContent = line; logBox.appendChild(d); }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function visible() {
    let v = Object.values(jobs);
    if (cfg.easyApplyOnly) v = v.filter((j) => j.easyApply);
    return v.sort((a, b) => (b.monthlyMax || 0) - (a.monthlyMax || 0));
  }

  function render() {
    const v = visible();
    status.textContent = `${v.length} jobs kept (>= ${fmtRs(cfg.minMonthly)}/mo) · `
      + `${v.filter((j) => selected.has(j.jk)).length} selected`;
    list.innerHTML = '';
    if (!v.length) {
      const e = document.createElement('div');
      css(e, { padding: '22px 12px', textAlign: 'center', color: C.sub });
      e.textContent = 'No jobs yet. Run a search on Indeed, then click "Scan this page".';
      list.appendChild(e); return;
    }
    v.forEach((j) => {
      const row = document.createElement('div');
      css(row, { display: 'flex', gap: '10px', padding: '9px 6px', borderBottom: '1px solid ' + C.line });
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selected.has(j.jk);
      css(cb, { marginTop: '3px' });
      cb.addEventListener('change', () => { cb.checked ? selected.add(j.jk) : selected.delete(j.jk); render(); });
      const meta = document.createElement('div'); css(meta, { flex: 1, minWidth: 0 });
      const t = document.createElement('a'); t.href = j.url; t.target = '_blank';
      t.textContent = j.title || '(untitled)';
      css(t, { color: C.text, fontWeight: 700, textDecoration: 'none', display: 'block' });
      const sub = document.createElement('div');
      css(sub, { color: C.sub, fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      sub.textContent = [j.company, j.loc].filter(Boolean).join(' · ');
      const sal = document.createElement('div'); css(sal, { fontSize: '12px', marginTop: '2px', color: C.accent2 });
      sal.textContent = j.monthlyMax
        ? (j.monthlyMin && j.monthlyMin !== j.monthlyMax
            ? `${fmtRs(j.monthlyMin)}–${fmtRs(j.monthlyMax)}/mo` : `${fmtRs(j.monthlyMax)}/mo`)
          + (j.salaryText ? `  (listed: ${esc(j.salaryText)})` : '')
        : 'salary not listed';
      if (j.easyApply) {
        const tag = document.createElement('span'); tag.textContent = '  · Easily apply';
        css(tag, { color: C.accent }); sal.appendChild(tag);
      }
      meta.append(t, sub, sal);
      row.append(cb, meta); list.appendChild(row);
    });
  }

  // ---------- actions ----------
  async function onScanOne() {
    if (busy) return;
    const found = parseCards(document);
    if (!found.length) { log('No job cards found on this page. (Selectors may need updating.)'); return; }
    const kept = addJobs(found);
    log(`Scanned page: ${found.length} cards, kept ${kept} new (>= ${fmtRs(cfg.minMonthly)}/mo).`);
    render();
  }

  async function onAutoScan() {
    if (busy) return;
    busy = true; stop = false; autoBtn.textContent = 'Stop';
    const orig = onAutoScan; autoBtn.removeEventListener('click', orig);
    const stopFn = () => { stop = true; }; autoBtn.addEventListener('click', stopFn);

    addJobs(parseCards(document)); render();
    let curStart = parseInt(new URL(location.href).searchParams.get('start') || '0', 10);
    log('Auto-scan started…');
    try {
      for (let p = 1; p <= cfg.autoPages && !stop; p++) {
        curStart += 10;
        log(`Fetching page (start=${curStart})…`, true);
        try {
          const found = await fetchPage(curStart);
          if (!found.length) { log('No more results — stopping.'); break; }
          const kept = addJobs(found); render();
          log(`Page ${p}: ${found.length} cards, +${kept} new.`);
        } catch (e) {
          log(`Auto-fetch stopped (${e.message}). Page through Indeed manually and click "Scan this page".`);
          break;
        }
        await sleep(cfg.pageDelayMs);
      }
    } finally {
      busy = false; autoBtn.textContent = 'Auto-scan';
      autoBtn.removeEventListener('click', stopFn); autoBtn.addEventListener('click', orig);
    }
  }

  function openJobs(toOpen) {
    if (!toOpen.length) { alert('Nothing to open. Select jobs or scan some first.'); return; }
    if (toOpen.length > 15 &&
        !confirm(`Open ${toOpen.length} tabs? If your browser blocks them, allow pop-ups for ${location.host} and click again.`))
      return;
    // Open synchronously inside the click gesture — setTimeout would get
    // every tab blocked by the pop-up blocker.
    let blocked = 0;
    toOpen.forEach((j) => { if (!window.open(j.url, '_blank')) blocked++; });
    if (blocked) {
      log(`Opened ${toOpen.length - blocked}, ${blocked} blocked by the pop-up blocker.`);
      alert(`${blocked} tab(s) were blocked.\n\nClick the pop-up icon in your address bar, choose "Always allow pop-ups for ${location.host}", then click the button again.`);
    } else {
      log(`Opened ${toOpen.length} job tab(s) — review and click Apply in each.`);
    }
  }
  function onOpenSelected() { openJobs(visible().filter((j) => selected.has(j.jk))); }
  function onOpenAll() { openJobs(visible()); }

  function onCSV() {
    const v = visible();
    if (!v.length) { alert('Nothing to export.'); return; }
    const rows = [['title', 'company', 'location', 'monthly_min', 'monthly_max', 'listed_salary', 'easy_apply', 'url']];
    v.forEach((j) => rows.push([j.title, j.company, j.loc, j.monthlyMin || '', j.monthlyMax || '',
      j.salaryText, j.easyApply ? 'yes' : 'no', j.url]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    navigator.clipboard.writeText(csv).then(() => log('CSV copied to clipboard.'),
      () => prompt('Copy CSV:', csv));
  }

  function drag(el, handle) {
    let sx, sy, ox, oy, on = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      css(el, { right: 'auto', bottom: 'auto', left: ox + 'px', top: oy + 'px' }); e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => { if (on) css(el, { left: ox + (e.clientX - sx) + 'px', top: oy + (e.clientY - sy) + 'px' }); });
    window.addEventListener('mouseup', () => { on = false; });
  }

  render();
  log('Loaded. Run an Indeed search, then click "Scan this page".');
})();
