/* YouTube TV DVR layer. tv.youtube.com only, main frame only.
 *
 * What this is for: a DVR recording of a live broadcast carries the broadcast's own commercials
 * as frames inside the same stream. There is no ad request to block, no ad element to hide, and
 * the player never raises an ad flag -- so neither the network rules, nor cosmetic.js, nor the
 * flag-driven path in content.js can see them. The only thing that gets past them is a seek.
 *
 * Where the break positions come from, in order of preference:
 *   1. markers the player itself draws on the progress bar  (exact, automatic, when present)
 *   2. breaks you mark once with Alt+M                      (exact, kept per recording)
 *   3. a plain fixed jump on Alt+S                          (no detection at all)
 *
 * What is deliberately NOT here: any attempt to work out where a break is from the picture or the
 * sound. That detector was in this extension once and was removed for firing on scene cuts and
 * b-roll (see the README). Nothing has changed to make the guess better, and on tv.youtube.com it
 * could not run anyway -- the stream is DRM-protected, so a canvas read of the video is black.
 * Every source above is either the player's own data or yours.
 *
 * Seek safety follows the same rules content.js learned the hard way: one seek at a time, never
 * re-issued until the clock is checked, and after SEEK_FAILS seeks that do not move the clock this
 * layer stops for the rest of the recording rather than hammering the decoder. A seek that snaps
 * back means YouTube served the network's on-demand copy instead of your recording, which has
 * fast-forward disabled by contract -- that is reported, not fought. */
(() => {
  'use strict';
  if (window.__adVaultDvr) return;
  if (location.hostname !== 'tv.youtube.com') return;
  if (window.top !== window) return;
  window.__adVaultDvr = true;

  const settings = self.AdGuardSettings.cur;
  const Sites = self.AdGuardSites;
  const log = (...a) => { try { console.log('[AdVault/dvr]', ...a); } catch (e) {} };

  const STAT_ID = 9001;        // distinct from content.js Watcher ids, which start at 1
  const SEEK_GAP = 1500;       // ms between seeks
  const SEEK_FAILS = 3;        // seeks that did not move the clock before giving up
  const VERIFY_MS = 900;       // how long to wait before checking a seek landed
  const LEAD_IN = 0.3;         // start skipping this far before a break
  const TAIL_PAD = 0.5;        // land this far after it ends
  const MAX_JUMP = 300;        // refuse any single jump longer than this
  const JUMPS = [60, 120, 180];
  const MIN_BREAK = 5, MAX_BREAK = 600;

  const BAR_SELECTORS = [
    '.ytp-progress-bar', '.ytp-progress-list',
    '[class*="progress-bar"]', '[class*="progressBar"]',
    '[class*="scrubber"]', '[role="slider"]',
  ];
  const CLASS_HINT = /(^|[-_ ])(ad|ads|advert|marker|break|cue|chapter|segment)([-_ ]|$)|ad-|-ad\b|Ad[A-Z]/;

  const PREFS = { auto: true, hud: true, jump: 120, arrows: false, arrowSeconds: 5, selector: '' };

  let video = null, hud = null, ui = {};
  let markers = [], markersDur = 0, learned = [], curId = null;
  let markStart = null, lastSeek = 0, fails = 0, locked = null;
  let status = 'waiting for a recording', discovery = false;
  let stats = { dvrSkips: 0, skipped: 0 };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = s => {
    if (!isFinite(s) || s < 0) return '--:--';
    s = Math.round(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  // ------------------------------------------------------------------ prefs --
  function loadPrefs() {
    return new Promise(res => {
      try {
        chrome.storage.local.get({ dvrPrefs: null }, o => {
          void chrome.runtime.lastError;
          if (o && o.dvrPrefs) Object.assign(PREFS, o.dvrPrefs);
          res();
        });
      } catch (e) { res(); }
    });
  }
  function savePrefs() {
    try { chrome.storage.local.set({ dvrPrefs: Object.assign({}, PREFS) }, () => void chrome.runtime.lastError); }
    catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------- recording --
  function recId() {
    const m = location.pathname.match(/\/watch\/([^/?#]+)/);
    if (m) return m[1];
    return new URLSearchParams(location.search).get('v') || null;
  }
  function loadLearned() {
    curId = recId(); markStart = null;
    return new Promise(res => {
      if (!curId) { learned = []; return res(); }
      const k = 'dvr:' + curId;
      try {
        chrome.storage.local.get({ [k]: [] }, o => {
          void chrome.runtime.lastError;
          learned = (o && o[k]) || [];
          res();
        });
      } catch (e) { learned = []; res(); }
    });
  }
  function saveLearned() {
    if (!curId) return;
    try { chrome.storage.local.set({ ['dvr:' + curId]: learned }, () => void chrome.runtime.lastError); }
    catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ video --
  function pickVideo() {
    const vs = [...document.querySelectorAll('video')]
      .filter(v => v.readyState > 0 && (v.duration > 0 || v.currentTime > 0));
    if (!vs.length) return null;
    return vs.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  /* content.js owns anything the player itself flags as an ad. If a flag is up, this layer is
   * looking at an inserted ad, not a recorded break, and must keep its hands off. */
  function playerAdUp() {
    try { return !!(Sites && video && Sites.detect(video)); } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- markers --
  function findBar() {
    let best = null, bw = 0;
    for (const s of BAR_SELECTORS) {
      let list;
      try { list = document.querySelectorAll(s); } catch (e) { continue; }
      for (const el of list) {
        const r = el.getBoundingClientRect();
        if (r.width > bw && r.width > 240 && r.height < 64) { best = el; bw = r.width; }
      }
      if (best) break;
    }
    return best;
  }
  function classOf(el) {
    const c = el.className;
    const s = (c && c.baseVal !== undefined) ? c.baseVal : c;
    return ((s || '') + ' ' + (el.id || '')).trim();
  }
  function scanMarkers() {
    if (!video || !isFinite(video.duration) || video.duration <= 0) return null;
    const bar = findBar();
    if (!bar) return null;
    const br = bar.getBoundingClientRect();
    if (br.width < 240) return null;             // controls hidden: nothing measurable
    const dur = video.duration;

    let kids;
    if (PREFS.selector) {
      try { kids = [...document.querySelectorAll(PREFS.selector)]; } catch (e) { kids = []; }
    } else {
      kids = [...bar.querySelectorAll('*')];
    }

    const out = [];
    for (const el of kids) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.width > br.width * 0.9) continue;
      if (r.left < br.left - 2 || r.right > br.right + 2) continue;
      if (!PREFS.selector && !CLASS_HINT.test(classOf(el))) continue;
      const s = ((r.left - br.left) / br.width) * dur;
      const e = ((r.right - br.left) / br.width) * dur;
      if (e - s < MIN_BREAK || e - s > MAX_BREAK) continue;
      out.push([s, e]);
    }
    return merge(out);
  }
  function merge(list) {
    const a = list.map(r => [r[0], r[1]]).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of a) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 2) last[1] = Math.max(last[1], r[1]);
      else out.push(r);
    }
    return out;
  }
  function rescan() {
    if (!video) return;
    if (video.duration !== markersDur) { markers = []; markersDur = video.duration; }
    const m = scanMarkers();
    if (m && m.length) markers = m;
  }
  const allBreaks = () => merge([...markers, ...learned]);
  function breakAt(t) {
    for (const b of allBreaks()) if (t >= b[0] - LEAD_IN && t < b[1] - 0.4) return b;
    return null;
  }
  function nextBreak(t) {
    for (const b of allBreaks()) if (b[0] > t) return b;
    return null;
  }

  // ------------------------------------------------------------------- seek --
  function seekTo(t) {
    if (!video || locked === true) return false;
    const dur = video.duration || 0;
    const from = video.currentTime;
    const target = clamp(t, 0, dur ? dur - 1 : t);
    const delta = target - from;
    if (delta <= 0.2) return false;
    if (delta > MAX_JUMP) { status = 'jump over ' + MAX_JUMP + 's refused'; return false; }

    lastSeek = Date.now();
    if (PREFS.arrows) { pressArrows(delta); return true; }
    try { video.currentTime = target; } catch (e) { locked = true; status = 'player refused the seek'; return false; }
    verify(target, delta);
    return true;
  }

  /* Fallback for a player that ignores currentTime: drive its own keyboard handler instead. */
  function pressArrows(seconds) {
    const step = Math.max(1, PREFS.arrowSeconds);
    const n = clamp(Math.round(seconds / step), 1, 120);
    const target = (video && video.closest('div')) || document.body;
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        for (const type of ['keydown', 'keyup']) {
          target.dispatchEvent(new KeyboardEvent(type, {
            key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
            bubbles: true, cancelable: true,
          }));
        }
      }, i * 60);
    }
    lastSeek = Date.now() + n * 60;
  }

  /* One check per seek, never a re-issue. Three that do not land and this layer stops: on
   * tv.youtube.com that means the on-demand copy, where fast-forward is disabled by contract. */
  function verify(target, delta) {
    setTimeout(() => {
      if (!video) return;
      if (video.currentTime < target - 3) {
        if (++fails >= SEEK_FAILS) {
          locked = true;
          status = 'VOD copy: fast-forward disabled';
          log('three seeks did not land -- standing down for this recording');
        } else {
          status = 'seek did not land (' + fails + '/' + SEEK_FAILS + ')';
        }
      } else {
        fails = 0; locked = false;
        stats.dvrSkips++; stats.skipped += delta;
        report();
      }
      paint();
    }, VERIFY_MS);
  }

  // -------------------------------------------------------------- auto-skip --
  function onTime() {
    if (!settings.active || !settings.dvrSkip || !PREFS.auto) return;
    if (!video || locked === true) return;
    if (Date.now() - lastSeek < SEEK_GAP) return;
    if (playerAdUp()) return;                    // content.js is handling a flagged ad
    const b = breakAt(video.currentTime);
    if (!b) return;
    if (seekTo(b[1] + TAIL_PAD)) {
      status = 'skipping a ' + fmt(b[1] - b[0]) + ' break';
      paint();
    }
  }

  // ----------------------------------------------------------------- manual --
  function manualSkip() {
    if (!video) return;
    const b = breakAt(video.currentTime);
    if (b) { seekTo(b[1] + TAIL_PAD); status = 'jumped a marked break'; }
    else { seekTo(video.currentTime + PREFS.jump); status = 'jumped ' + fmt(PREFS.jump); }
    paint();
  }
  function mark() {
    if (!video) return;
    if (markStart === null) {
      markStart = video.currentTime;
      status = 'break start set at ' + fmt(markStart);
    } else {
      const a = Math.min(markStart, video.currentTime);
      const b = Math.max(markStart, video.currentTime);
      markStart = null;
      if (b - a < MIN_BREAK) status = 'under ' + MIN_BREAK + 's: discarded';
      else { learned = merge([...learned, [a, b]]); saveLearned(); status = 'break saved (' + fmt(b - a) + ')'; }
    }
    paint();
  }
  function clearLearned() {
    learned = []; markStart = null; saveLearned();
    status = 'marked breaks cleared';
    paint();
  }

  // ------------------------------------------------------------------- keys --
  document.addEventListener('keydown', e => {
    if (!settings.active || !settings.dvrSkip) return;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyS') { e.preventDefault(); e.stopPropagation(); manualSkip(); }
    else if (e.code === 'KeyM') { e.preventDefault(); e.stopPropagation(); mark(); }
    else if (e.code === 'KeyH') {
      e.preventDefault(); e.stopPropagation();
      PREFS.hud = !PREFS.hud; savePrefs(); applyHud();
    }
  }, true);

  // -------------------------------------------------------------------- HUD --
  const CSS = `
.avdvr{position:fixed;top:16px;right:16px;z-index:2147483000;width:430px;
 max-width:calc(100vw - 32px);max-height:76vh;overflow-y:auto;box-sizing:border-box;
 padding:14px 16px 16px;background:#121820;border:1px solid #2b3744;border-radius:10px;
 box-shadow:0 10px 34px rgba(0,0,0,.6);font:23px/1.35 system-ui,"Segoe UI",sans-serif;color:#b9cfdd}
.avdvr[hidden]{display:none}
.avdvr .hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.avdvr .ti{font-size:25px;font-weight:600;color:#f0c56a;letter-spacing:.01em}
.avdvr .x{background:none;border:0;color:#b9cfdd;font-size:30px;line-height:1;cursor:pointer;padding:0 4px;width:auto;margin:0}
.avdvr .ln{margin:5px 0;font-size:22px;word-break:break-word}
.avdvr .st{font-weight:600}
.avdvr .ok{color:#5fd38a}.avdvr .wa{color:#f2a65a}.avdvr .ba{color:#e8736a}
.avdvr .nx{color:#8299a8}
.avdvr .sx{color:#8299a8;font-size:19px;min-height:24px}
.avdvr .bt{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}
.avdvr .bt button{flex:1 1 auto;width:auto;margin:0;padding:9px 12px;
 font:600 21px/1 system-ui,sans-serif;color:#b9cfdd;background:#1a222c;
 border:1px solid #2b3744;border-radius:8px;cursor:pointer}
.avdvr .bt button:hover{background:#223040;border-color:#35505f}
.avdvr .bt button.on{color:#121820;background:#5fd38a;border-color:#5fd38a}
.avdvr .dc{margin-top:12px;padding-top:10px;border-top:1px solid #2b3744}
.avdvr .dc[hidden]{display:none}
.avdvr .dc p{margin:0 0 8px;font-size:19px;color:#8299a8}
.avdvr .rw{display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px solid #1f2a35}
.avdvr .rw code{flex:1 1 auto;font-size:18px;color:#f0c56a;word-break:break-all}
.avdvr .rw button{flex:0 0 auto;width:auto;margin:0;padding:5px 12px;
 font:600 19px/1 system-ui,sans-serif;color:#121820;background:#f0c56a;border:0;border-radius:6px;cursor:pointer}`;

  function buildHud() {
    if (hud) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    hud = document.createElement('div');
    hud.className = 'avdvr';
    hud.innerHTML = `
      <div class="hd"><span class="ti">DVR ad skip</span>
        <button class="x" data-a="hide" title="Alt+H">&times;</button></div>
      <div class="ln st"></div>
      <div class="ln nx"></div>
      <div class="ln sx"></div>
      <div class="bt">
        <button data-a="skip">Skip</button>
        <button data-a="mark">Mark</button>
        <button data-a="auto"></button>
      </div>
      <div class="bt">
        <button data-a="jump"></button>
        <button data-a="seek"></button>
        <button data-a="clear">Clear marks</button>
      </div>
      <div class="bt"><button data-a="find">Find markers on the bar</button></div>
      <div class="dc" hidden></div>`;
    document.documentElement.appendChild(hud);

    ui = {
      st: hud.querySelector('.st'), nx: hud.querySelector('.nx'), sx: hud.querySelector('.sx'),
      auto: hud.querySelector('[data-a="auto"]'), jump: hud.querySelector('[data-a="jump"]'),
      seek: hud.querySelector('[data-a="seek"]'), dc: hud.querySelector('.dc'),
    };

    hud.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const a = btn.dataset.a;
      if (a === 'hide') { PREFS.hud = false; savePrefs(); applyHud(); }
      else if (a === 'skip') manualSkip();
      else if (a === 'mark') mark();
      else if (a === 'auto') { PREFS.auto = !PREFS.auto; savePrefs(); paint(); }
      else if (a === 'clear') clearLearned();
      else if (a === 'jump') {
        PREFS.jump = JUMPS[(JUMPS.indexOf(PREFS.jump) + 1) % JUMPS.length];
        savePrefs(); paint();
      } else if (a === 'seek') {
        PREFS.arrows = !PREFS.arrows; fails = 0; locked = null;
        savePrefs(); status = PREFS.arrows ? 'using right-arrow presses' : 'using playback position';
        paint();
      } else if (a === 'find') { discovery = !discovery; paintDiscovery(); }
      else if (a === 'use') {
        PREFS.selector = btn.dataset.sel || '';
        savePrefs(); markers = []; rescan();
        status = PREFS.selector ? 'marker selector set' : 'marker selector cleared';
        paintDiscovery(); paint();
      }
    });
  }

  function applyHud() {
    const show = PREFS.hud && settings.active && settings.dvrSkip;
    if (show) { buildHud(); hud.hidden = false; paint(); }
    else if (hud) hud.hidden = true;
  }

  function paint() {
    if (!hud || hud.hidden) return;
    const brk = allBreaks();
    let txt, cls;
    if (locked === true) { txt = 'Locked — fast-forward disabled'; cls = 'ba'; }
    else if (!video) { txt = 'No player yet'; cls = 'wa'; }
    else if (brk.length) { txt = 'Armed — ' + brk.length + ' break' + (brk.length > 1 ? 's' : '') + ' known'; cls = 'ok'; }
    else { txt = 'No breaks found yet'; cls = 'wa'; }
    ui.st.textContent = txt;
    ui.st.className = 'ln st ' + cls;

    const t = video ? video.currentTime : 0;
    const nb = nextBreak(t);
    ui.nx.textContent = nb
      ? 'Next break in ' + fmt(nb[0] - t) + ', ' + fmt(nb[1] - nb[0]) + ' long'
      : (markStart !== null ? 'Marking… start ' + fmt(markStart) : 'No break ahead');

    ui.sx.textContent = status;
    ui.auto.textContent = 'Auto ' + (PREFS.auto ? 'on' : 'off');
    ui.auto.className = PREFS.auto ? 'on' : '';
    ui.jump.textContent = 'Jump ' + fmt(PREFS.jump);
    ui.seek.textContent = PREFS.arrows ? 'Seek: arrows' : 'Seek: position';
  }

  function paintDiscovery() {
    if (!ui.dc) return;
    ui.dc.hidden = !discovery;
    if (!discovery) return;
    const bar = findBar();
    const br = bar && bar.getBoundingClientRect();
    if (!bar || br.width < 240) {
      ui.dc.innerHTML = '<p>Move the mouse over the player so the controls are showing, then press this again.</p>';
      return;
    }
    const rows = [];
    for (const el of bar.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      const first = classOf(el).trim().split(/\s+/)[0];
      if (!first) continue;
      rows.push('<div class="rw"><code>'
        + (((r.left - br.left) / br.width) * 100).toFixed(1) + '% · w '
        + ((r.width / br.width) * 100).toFixed(1) + '% · '
        + el.tagName.toLowerCase() + '.' + first
        + '</code><button data-a="use" data-sel=".' + CSS_ESC(first) + '">use</button></div>');
    }
    ui.dc.innerHTML =
      '<p>Everything drawn on the progress bar. A commercial marker is short and repeats across the '
      + 'bar. Pick one and it will be read directly from then on.</p>'
      + (rows.join('') || '<p>Nothing measurable on the bar.</p>')
      + '<div class="rw"><code>now using: ' + (PREFS.selector || 'automatic') + '</code>'
      + '<button data-a="use" data-sel="">reset</button></div>';
  }
  const CSS_ESC = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&');

  // ------------------------------------------------- status for the popup ----
  let reportTimer = null;
  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const msg = {
        type: 'stats', id: STAT_ID,
        stats: {
          host: location.hostname,
          state: locked === true ? 'DVR: fast-forward locked' : 'DVR: watching',
          dvrSkips: stats.dvrSkips, skipped: Math.round(stats.skipped),
          domSkips: 0, sbSkips: 0, site: '',
        },
      };
      try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
    }, 250);
  }

  // ------------------------------------------------------------------- boot --
  function attach() {
    const v = pickVideo();
    if (v && v !== video) {
      video = v;
      markers = []; markersDur = 0; locked = null; fails = 0;
      status = 'player attached';
      v.addEventListener('timeupdate', onTime);
      v.addEventListener('loadedmetadata', () => { markers = []; rescan(); });
      log('attached to the player');
    }
  }

  let lastHref = location.href;
  function watchNav() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    markers = []; markersDur = 0; locked = null; fails = 0; markStart = null;
    status = 'new recording';
    loadLearned().then(paint);
  }

  self.AdGuardSettings.onChange(() => { applyHud(); });

  /* Prefs and the HUD load straight away; the loops that attach to the player and issue seeks are
   * held behind the start gate (see the note at the end of src/settings.js) so nothing touches the
   * recording until 3 s after the page has finished loading. */
  (async () => {
    await loadPrefs();
    await loadLearned();
    applyHud();
    self.AdGuardSettings.gate(() => {
      setInterval(() => { attach(); watchNav(); }, 1000);
      setInterval(() => { rescan(); paint(); }, 1500);
    });
  })();
})();
