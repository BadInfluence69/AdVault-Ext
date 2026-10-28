/* Shared settings for the content scripts (they share one global scope per frame).
 *
 * Five switches, and that is deliberate. Everything that used to be here and is not here now was
 * either removed outright or made permanent -- see the table in the README. The rule is: a switch
 * exists only if there is a real reason someone would turn it off. Anything that simply works is
 * on and has no switch; anything that did not work is gone, not labelled "experimental". */
(function (root) {
  'use strict';
  if (root.AdGuardSettings) return;
  const DEFAULTS = {
    enabled: true,                                 // master switch
    // --- page layer
    cosmetic: true,                                // hide page ads
    cosmeticLists: true,                           // use the full EasyList selector database
    uboRules: true,                                // uBO site rules on other sites (not YouTube)
    // --- video players
    dom: true,                                     // click "Skip", handle player-flagged ads
    sponsorblock: true,                            // YouTube sponsor / self-promo / interaction segments
    dvrSkip: true,                                 // YouTube TV: skip recorded broadcast breaks
    offSites: [],                                  // hostnames switched off entirely
  };
  const cur = Object.assign({}, DEFAULTS, { active: true });
  const subs = [];
  let loaded = false;

  function recompute() {
    cur.active = !!cur.enabled && !cur.offSites.includes(location.hostname);
  }
  function publish() {
    recompute();
    subs.forEach(f => { try { f(cur); } catch (e) { /* a subscriber must not break the others */ } });
  }

  /* Why there are three ways in here instead of one chrome.storage.sync.get().
   *
   * Every layer waits on the first publish(): cosmetic.js does not install a single rule until
   * then, content.js does not scan, the YouTube recovery watchdog never arms. chrome.storage.sync
   * is network-backed -- on a cold profile, just after the browser starts, signed out, or while
   * the sync quota is in backoff, its callback can take seconds or never arrive. When that
   * happened the page ran with the extension doing nothing, and toggling the extension off and on
   * was the only way out. So:
   *   1. storage.local mirror  -- local, always fast, holds the last known-good settings
   *   2. storage.sync          -- the real source; overwrites the mirror when it answers
   *   3. a 1.2 s floor         -- if neither has answered, come up on DEFAULTS rather than inert */
  const SETTLE_MS = 1200;
  let fromSync = false;
  function settle(src) {
    if (src !== 'sync' && fromSync) return;
    if (src === 'sync') fromSync = true;
    loaded = true;
    publish();
  }
  const mirror = () => {
    try { chrome.storage.local.set({ __agMirror: Object.assign({}, cur) }, () => void chrome.runtime.lastError); }
    catch (e) { /* ignore */ }
  };

  try {
    chrome.storage.local.get({ __agMirror: null }, o => {
      void chrome.runtime.lastError;
      if (o && o.__agMirror && !fromSync) Object.assign(cur, o.__agMirror);
      settle('local');
    });
    chrome.storage.sync.get(DEFAULTS, o => {
      void chrome.runtime.lastError;
      if (o) Object.assign(cur, o);
      settle('sync');
      mirror();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync') return;
      for (const k of Object.keys(ch)) cur[k] = ch[k].newValue === undefined ? DEFAULTS[k] : ch[k].newValue;
      fromSync = true;
      loaded = true;
      publish();
      mirror();
    });
  } catch (e) { settle('floor'); }
  setTimeout(() => { if (!loaded) settle('floor'); }, SETTLE_MS);

  root.AdGuardSettings = {
    cur, DEFAULTS,
    onChange(f) { subs.push(f); if (loaded) f(cur); },
  };
})(self);

/* ------------------------------------------------------------------- start gate ----
 *
 * Why this exists. On a YouTube watch page that opens with a pre-roll, arming the player layers
 * while the player was still initialising left a black screen: the layers set playbackRate, muted
 * and currentTime on a <video> whose stream was still being wired up, YouTube's player threw, and
 * it painted its error overlay. Disabling the extension, letting the video start, then re-enabling
 * it mid-ad always worked -- the same code is harmless once the player is running, and it still
 * skips every ad in the rest of the timeline.
 *
 * run_at does not fix this. document_start vs document_idle is a difference of a few hundred
 * milliseconds and neither waits for YouTube's player, which boots asynchronously well after
 * window.load. So the layers are injected as before and simply do not ACT until GATE_MS after the
 * page has finished loading. By then the player is rendered and playing, which reproduces the
 * working manual case automatically.
 *
 * Scope: YouTube hosts only. Every other site is unchanged and arms immediately -- a delay there
 * would just let page ads flash in before they were hidden, and no other site has this problem.
 *
 * FLOOR_MS is a safety net: a page that never fires 'load' (a stalled subresource, a frame held
 * open) would otherwise leave the layers armed but never acting. */
(function (root) {
  'use strict';
  const S = root.AdGuardSettings;
  if (!S || S.gate) return;

  const GATE_MS = 3000;        // after load, before the player layers may touch anything
  const FLOOR_MS = 10000;      // arm anyway if 'load' never arrives

  const DELAYED_HOST = /(^|\.)youtube(-nocookie|kids|education)?\.com$/.test(location.hostname);

  let open = !DELAYED_HOST;    // every non-YouTube site: no gate at all
  const queue = [];

  function release() {
    if (open) return;
    open = true;
    while (queue.length) { const f = queue.shift(); try { f(); } catch (e) { /* one layer must not break the others */ } }
    try { console.log('[AdVault] start gate open - player layers armed'); } catch (e) {}
  }

  if (!open) {
    let timer = 0;
    const arm = () => { if (!timer) timer = setTimeout(release, GATE_MS); };
    if (document.readyState === 'complete') arm();
    else window.addEventListener('load', arm, { once: true });
    setTimeout(arm, FLOOR_MS);
  }

  /** Run fn once the player is safe to touch: immediately off YouTube, GATE_MS after load on it. */
  S.gate = function (fn) {
    if (open) { try { fn(); } catch (e) {} return; }
    queue.push(fn);
  };
  S.gateOpen = () => open;
})(self);
