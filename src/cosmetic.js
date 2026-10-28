/* Page-ad hiding -- the cleanup layer.
 *
 * Order of business matters here: the network layer (declarativeNetRequest, see background.js)
 * is what actually protects you. A hidden element whose request was allowed still loaded and
 * still ran its script -- that is the no-click path. Hiding is cosmetic only: it removes the
 * leftovers, the placeholders and the in-page ad markup that no request block can catch.
 *
 * Hidden means display:none, so the gap closes. There used to be a second mode, 'stealth', which
 * used visibility:hidden to keep the element's box for layout-probe anti-adblock checks. It is
 * gone: it left a hole on the page in exchange for defeating a kind of check that the sites which
 * matter here do not run, and it was one more switch to get wrong.
 *
 * Selectors come from three places:
 *   1. the hand list below (always on),
 *   2. per-site rules from EasyList's specific-hide section (data/cosmetic-sites.json),
 *   3. generic rules, applied lazily: the page is scanned for the class and id tokens it
 *      actually uses, and only selectors keyed on a present token are installed. That keeps
 *      13k generic rules off the page while still covering them all.
 * The background worker holds the databases and answers per-frame lookups.
 *
 * Rules live in a constructable stylesheet (no <style> node to find or remove), inserted one
 * rule at a time so a selector Chrome dislikes cannot take the rest down with it. */
(() => {
  'use strict';
  const Sx = self.AdGuardSettings;
  if (!Sx || self.__agCosmetic) return;
  self.__agCosmetic = true;

  /* Four entries used to sit in this list as an attempt at the YouTube black-screen player:
   *   "error-screen"                                              -- a type selector. YouTube's is
   *                                                                  <div id="error-screen">, so this
   *                                                                  matched no element, ever.
   *   "yt-playability-error-supported-renderers {display: none !important;}"
   *                                                               -- a selector with a declaration
   *                                                                  block already attached. rebuild()
   *                                                                  appends another one, so
   *                                                                  insertRule() got "...{...}{...}",
   *                                                                  threw SyntaxError, and the catch
   *                                                                  below quietly dropped the rule.
   *   "style-scope yt-playability-error-supported-renderers"       -- that is a class *attribute value*.
   *                                                                  As a selector it reads as
   *                                                                  <style-scope> containing
   *                                                                  <yt-playability-error-supported-renderers>.
   *                                                                  Neither tag exists.
   *   "complementary"                                              -- a type selector for <complementary>.
   *                                                                  Nothing again.
   * So the patch was inert: the selector in devtools never changed because nothing was ever hiding it.
   * They are gone from here on purpose and not replaced by working selectors either -- hiding
   * #error-screen leaves a black player behind and swallows real messages ("Video unavailable",
   * sign-in required). src/yt-recover.js reads the error instead and re-asks YouTube for the video. */
  const HAND_GENERIC = [
    'ins.adsbygoogle', '.adsbygoogle', '[id^="google_ads_iframe"]', '[id^="google_ads_frame"]', '[id^="div-gpt-ad"]',
    'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]', 'iframe[src*="adservice.google"]',
    'iframe[id^="google_ads"]', '[data-google-query-id]', '[data-ad-slot]', '[data-adunit]', '[data-ad-client]',
    '[aria-label="Advertisement"]', '[aria-label="advertisement"]', '[aria-label="Sponsored"]',
    '.ad-slot', '.ad-container', '.ad-banner', '.advert', '.advertisement', '.adbox',
    'div[id^="taboola-"]', 'div[id^="outbrain"]', '.OUTBRAIN', '.trc_rbox_container', '[id^="gpt-passback"]',
  ];
  const HAND_SET = new Set();                      // hand-written rules get a warning when rejected
  const HAND_SITES = {
    'youtube.com': [
      '#masthead-ad', '#player-ads', 'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-display-ad-renderer',
      'ytd-promoted-sparkles-web-renderer', 'ytd-promoted-video-renderer', 'ytd-banner-promo-renderer',
      'ytd-statement-banner-renderer', 'ytd-companion-slot-renderer', 'ytd-action-companion-ad-renderer',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
      'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)', 'ytd-rich-section-renderer:has(ytd-ad-slot-renderer)',
      '.ytp-ad-overlay-container', '.ytp-ad-image-overlay',
    ],
    'twitter.com': ['[data-testid="placementTracking"]'],
    'x.com': ['[data-testid="placementTracking"]'],
    'reddit.com': ['shreddit-ad-post', '[data-testid="ad-slot"]', 'ad-slot'],
    'twitch.tv': ['[data-a-target="player-overlay-ad"]', '.ad-banner', '[data-test-selector="sad-overlay"]'],
  };

  const host = location.hostname;
  const selectors = new Set();                     // everything we have decided to hide
  const rejected = new Set();                      // hand-written selectors Chrome refused (warned once)
  let on = false, listsOn = true;
  let sheet = null, fallback = null, installed = 0, pending = false;
  self.__agRejectedSelectors = rejected;           // inspectable from devtools

  function handList() {
    const out = HAND_GENERIC.slice();
    for (const k of Object.keys(HAND_SITES)) if (host === k || host.endsWith('.' + k)) out.push(...HAND_SITES[k]);
    for (const s of out) HAND_SET.add(s);
    return out;
  }
  const body = () => '{display:none!important}';

  /* document.adoptedStyleSheets is one array shared with the page, and YouTube's Polymer assigns
   * to it rather than appending. When it did, our sheet was dropped off the end and every rule in
   * this file stopped applying -- silently, with the selectors still sitting in `selectors` and
   * the popup still reporting them as installed. Re-adopting is cheap, so it is checked whenever
   * rules are rebuilt and on a slow timer while hiding is on. */
  function ensureSheet() {
    if (sheet || fallback) return;
    try {
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch (e) {                                  // very old Chromium or a locked-down document
      fallback = document.createElement('style');
      (document.head || document.documentElement).appendChild(fallback);
    }
  }
  function reAdopt() {
    if (!sheet) {
      if (fallback && !fallback.isConnected) (document.head || document.documentElement).appendChild(fallback);
      return;
    }
    try {
      const cur = document.adoptedStyleSheets;
      if (!cur.includes(sheet)) document.adoptedStyleSheets = [...cur, sheet];
    } catch (e) { /* document going away */ }
  }
  function rebuild() {
    pending = false;
    if (!on) {
      if (sheet) sheet.replaceSync('');
      if (fallback) fallback.textContent = '';
      installed = 0;
      return;
    }
    ensureSheet();
    reAdopt();
    const list = [...selectors];
    if (fallback) { fallback.textContent = list.map(s => s + body()).join('\n'); installed = list.length; return; }
    try {
      sheet.replaceSync('');
      const b = body();
      let n = 0;
      for (const s of list) {
        try { sheet.insertRule(s + b, n); n++; }
        catch (e) {
          selectors.delete(s);
          // A list rule Chrome dislikes is normal and silent. A hand-written one being thrown out
          // means the selector in src/cosmetic.js is wrong, which is worth saying out loud --
          // otherwise it looks like the rule is installed and the page is ignoring it.
          if (HAND_SET.has(s) && !rejected.has(s)) {
            rejected.add(s);
            try { console.warn('[AdVault] hand-written selector rejected, not hiding anything:', s); } catch (e2) {}
          }
        }
      }
      installed = n;
    } catch (e) { /* sheet went away with the document */ }
  }
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(rebuild, 0);
  }
  function add(list) {
    let fresh = false;
    for (const s of list || []) if (s && !selectors.has(s)) { selectors.add(s); fresh = true; }
    if (fresh) schedule();
  }

  // --------------------------------------------- lazy generic matching ----
  const askedClass = new Set(), askedId = new Set();
  let genericAllowed = true;                       // cleared if the site is on EasyList's generic-hide exception list

  function ask(msg) {
    return new Promise(res => {
      try {
        chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || null); });
      } catch (e) { res(null); }
    });
  }

  function harvest(root, selfOnly) {
    const c = [], i = [];
    const push = el => {
      const cl = el.getAttribute && el.getAttribute('class');
      if (cl && typeof cl === 'string') {
        for (const t of cl.split(/\s+/)) if (t && !askedClass.has(t)) { askedClass.add(t); c.push(t); }
      }
      const id = el.id;
      if (id && !askedId.has(id)) { askedId.add(id); i.push(id); }
    };
    if (root.nodeType === 1) push(root);
    if (selfOnly) return { c, i };
    const els = root.querySelectorAll ? root.querySelectorAll('[class],[id]') : [];
    for (const el of els) push(el);
    return { c, i };
  }

  async function sweep(root, selfOnly) {
    if (!on || !listsOn || !genericAllowed) return;
    const { c, i } = harvest(root || document, selfOnly);
    if (!c.length && !i.length) return;
    const r = await ask({ type: 'cosGeneric', host, c, i });
    if (r && r.sel) add(r.sel);
  }

  async function loadSite() {
    if (!listsOn) return;
    const r = await ask({ type: 'cosSite', host });
    if (!r) return;
    if (r.nohide) genericAllowed = false;
    if (r.sel) add(r.sel);
    if (r.always) add(r.always);                   // generic rules with no class/id key
  }

  // --------------------------------------------- watch for new markup ----
  // A class="" or id="" change used to queue document.documentElement, so every flush ran
  // querySelectorAll('[class],[id]') over the whole page. On a player page the class attribute
  // changes several times a second (progress bar, autohide, time display), so that whole-document
  // walk ran about three times a second for as long as the video played -- the single biggest
  // reason video stutters with the extension on. The changed element is the only place a new
  // token can appear, so harvesting just that element finds exactly the same tokens.
  const IS_YT = /(^|\.)youtube\.com$/.test(host);
  const subtreeQ = new Set(), selfQ = new Set();
  let flushTimer = 0;
  const idle = cb => (self.requestIdleCallback ? requestIdleCallback(cb, { timeout: 1000 }) : cb());

  /** YouTube: the player chrome rewrites its own classes constantly and carries no list tokens
   *  (its ad markup is in the hand list above), so its attribute churn is not worth harvesting. */
  const RE_ADWORD = /ad|sponsor|promo/i;
  function noisy(el) {
    if (!IS_YT) return false;
    try {
      const cl = typeof el.className === 'string' ? el.className : '';
      if (RE_ADWORD.test(cl) || RE_ADWORD.test(el.id || '') || RE_ADWORD.test(el.localName || '')) return false;
      return !!el.closest('.html5-video-player, #movie_player, .ytp-chrome-bottom, ytd-thumbnail, tp-yt-paper-tooltip');
    } catch (e) { return false; }
  }

  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (t && t.nodeType === 1 && !noisy(t)) selfQ.add(t);
        continue;
      }
      for (const n of m.addedNodes) if (n.nodeType === 1 && !noisy(n)) subtreeQ.add(n);
    }
    arm();
  });
  function arm() {
    if (flushTimer || (!subtreeQ.size && !selfQ.size)) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      idle(() => {
        let budget = 300;                          // keep a long burst from blocking the page
        for (const n of subtreeQ) {
          subtreeQ.delete(n);
          if (n.isConnected) sweep(n, false);
          if (--budget <= 0) break;
        }
        budget = 2000;                             // self-only harvests are a few property reads each
        for (const n of selfQ) {
          selfQ.delete(n);
          if (n.isConnected) sweep(n, true);
          if (--budget <= 0) break;
        }
        arm();                                     // anything left goes in the next slice
      });
    }, IS_YT ? 600 : 300);
  }
  function watch() {
    try {
      obs.observe(document.documentElement || document, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'],
      });
    } catch (e) { /* no document yet */ }
  }

  // --------------------------------------------- YouTube enforcement wall ----
  function dismissWall() {
    const wall = document.querySelector('ytd-enforcement-message-view-model');
    if (!wall) return;
    const dlg = wall.closest('tp-yt-paper-dialog, ytd-popup-container') || wall;
    dlg.remove();
    document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach(b => b.remove());
    document.body.style.removeProperty('overflow');
    document.documentElement.style.removeProperty('overflow');
    document.querySelectorAll('video').forEach(v => { if (v.paused && !v.ended) v.play().catch(() => {}); });
  }
  let wallTimer = 0, adoptTimer = 0;

  // --------------------------------------------- wiring ----
  let started = false;
  Sx.onChange(cur => {
    const wasOn = on;
    on = !!(cur.active && cur.cosmetic);
    listsOn = cur.cosmeticLists !== false;

    if (on && !started) {
      started = true;
      add(handList());
      loadSite();
      sweep(document);
      watch();
      document.addEventListener('DOMContentLoaded', () => sweep(document), { once: true });
      setTimeout(() => sweep(document), 1200);
      setTimeout(() => sweep(document), 4000);
    } else if (on && !wasOn) {
      add(handList());
    }
    rebuild();

    /* Selector hiding is NOT gated: it only ever installs a stylesheet, never touches the <video>,
     * so it cannot cause the black screen, and delaying it would just let page ads flash in on
     * every site. dismissWall is the one exception in this file -- it calls v.play() -- so it waits
     * for the start gate (see the note at the end of src/settings.js). */
    const yt = /(^|\.)youtube\.com$/.test(host);
    if (yt && on && !wallTimer) {
      wallTimer = -1;                              // claim the slot so the gate is only armed once
      Sx.gate(() => { if (wallTimer === -1) wallTimer = setInterval(dismissWall, 1000); });
    }
    if ((!yt || !on) && wallTimer) { if (wallTimer > 0) clearInterval(wallTimer); wallTimer = 0; }

    if (on && !adoptTimer) adoptTimer = setInterval(reAdopt, 3000);
    if (!on && adoptTimer) { clearInterval(adoptTimer); adoptTimer = 0; }
  });

  // let the popup show what this frame is hiding
  try {
    chrome.runtime.onMessage.addListener((m, s, send) => {
      if (m && m.type === 'cosCount') { send({ n: installed }); return true; }
    });
  } catch (e) {}
})();
