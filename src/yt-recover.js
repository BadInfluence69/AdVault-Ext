/* YouTube player recovery -- the "black screen of death" player.
 *
 * What the symptom actually means
 * ------------------------------------------------------------------------------------------------
 * Audio keeps playing, the picture is black, clicking the player does nothing, but the spacebar
 * still pauses. Those four together say the stream is *fine*: YouTube has painted its error
 * overlay on top of a video that is still decoding. The overlay (#error-screen, or the player's
 * own .ytp-error) is opaque and sits inside #movie_player above the video, so it hides the picture
 * and eats every mouse event aimed at it -- while the spacebar still works, because YouTube's
 * keyboard handler is on the document, not on the player.
 *
 * So there are two different failures wearing the same black rectangle, and they need opposite
 * treatment:
 *
 *   stream healthy, overlay up   The error is spurious -- the video is playing underneath.
 *                                Take the overlay down. That brings the picture back *and* gives
 *                                the mouse its click target back. Re-asking YouTube for the video
 *                                here would be worse than doing nothing: it throws away a working
 *                                stream and your position in it.
 *
 *   stream dead, overlay up      Nothing is decoding. Re-ask YouTube for the video at the current
 *                                position (loadVideoById, run in the page's own world by
 *                                src/inject.js) -- bounded, then give up and leave the message up.
 *
 * The overlay is only ever hidden while the stream is proven healthy, and it is put straight back
 * if the stream later dies -- so "Video unavailable", members-only and age-gate messages still
 * show normally. Nothing here is a CSS rule: hiding #error-screen from the cosmetic stylesheet
 * (what the four dead selectors in src/cosmetic.js were trying to do) would also swallow those
 * real messages, and would do it on every page whether the stream was healthy or not.
 *
 * Everything it does is logged under "[AdVault]", including the declarativeNetRequest rules that
 * fired on the page -- an overlay over a healthy stream usually means the player's own JS threw
 * after a request it wanted was blocked, and that list names the rule.
 *
 * No switch. There is no reading of this that someone would want turned off -- it only ever acts
 * on a player that is already broken, and it does nothing at all to a working one. It follows the
 * master switch and per-site off like everything else. */
(() => {
  'use strict';
  const Sx = self.AdGuardSettings;
  if (!Sx || self.__agYtRecover) return;
  if (!/(^|\.)youtube(-nocookie|kids|education)?\.com$/.test(location.hostname)) return;
  self.__agYtRecover = true;

  const POLL_MS = 500;           // the overlay should not be up for long enough to be noticed
  const HEALTHY_MS = 1200;       // the stream must look alive this long before the overlay comes down
  const DEAD_MS = 5000;          // ...and dead this long before the video is re-requested
  const GAP_MS = 2500;           // minimum spacing between two re-requests
  const TRIES = 3;               // re-requests per video id, then it gives up
  const SETTLE_MS = 2500;        // grace after a navigation or a re-request

  // Errors that are the answer, not a fault: re-asking just gets the same reply.
  const FINAL = /^(LOGIN_REQUIRED|UNPLAYABLE|CONTENT_CHECK_REQUIRED|AGE_CHECK_REQUIRED|LIVE_STREAM_OFFLINE)$/;

  // The opaque things YouTube lays over the video. .ytp-error is the player's own error UI;
  // #error-screen is the host for the playability-error renderers.
  const OVERLAY = '#error-screen, .ytp-error, .ytp-error-content-wrap';
  // The picture itself, in case YouTube hid it rather than just covering it.
  const PICTURE = '.html5-video-container, video.html5-main-video, video.video-stream';

  const log = (...a) => { try { console.log('[AdVault]', ...a); } catch (e) {} };

  let on = false;
  let id = null;
  let tries = 0, lastTry = 0, settleUntil = 0;
  let lastT = -1, healthySince = 0, deadSince = 0;
  let hiding = false, saidBlocked = false, finalSaid = false;
  let probe = null;

  Sx.onChange(cur => {
    const want = !!cur.active;
    if (want === on) return;
    on = want;
    if (on) settleUntil = performance.now() + SETTLE_MS;
    else if (hiding) { show(); hiding = false; }
  });

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    if (e.data.__adguardYtState) probe = e.data.__adguardYtState;
    else if (e.data.__adguardYtFixDone) log('re-request ran:', e.data.__adguardYtFixDone.did || '(no player to drive)');
  });
  const ask = msg => { try { window.postMessage(msg, location.origin); } catch (e) { /* ignore */ } };

  const player = () => document.querySelector('#movie_player, .html5-video-player');
  const video = () => document.querySelector('#movie_player video, video.html5-main-video, video.video-stream') ||
                      document.querySelector('video');

  function onScreen(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) return false;             // a stray node, not a cover
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  /** the overlay elements currently covering the picture */
  function covers() {
    const p = player();
    if (!p) return [];
    return [...p.querySelectorAll(OVERLAY)].filter(el => onScreen(el) && !el.__agHidden);
  }
  /** text of whatever is being shown, for the log */
  function coverText() {
    const p = player();
    if (!p) return '';
    for (const el of p.querySelectorAll(OVERLAY)) {
      if (!onScreen(el) && !el.__agHidden) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 160);
    }
    return '';
  }

  /* Only `display` and `visibility` are touched, and only through removeProperty on the way back.
   * The video element's inline style carries YouTube's own width/height/left/top, which it rewrites
   * continuously -- snapshotting and restoring the whole style attribute would fight it and break
   * the player's sizing. */
  const touched = new Set();
  function hide() {
    let n = 0;
    for (const el of covers()) {
      el.style.setProperty('display', 'none', 'important');
      el.__agHidden = true; touched.add(el); n++;
    }
    const p = player();
    if (p) {
      for (const el of p.querySelectorAll(PICTURE)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none') {
          el.style.removeProperty('display');
          if (getComputedStyle(el).display === 'none') el.style.setProperty('display', 'block', 'important');
          touched.add(el); n++;
        }
        if (cs.visibility === 'hidden') {
          el.style.removeProperty('visibility');
          if (getComputedStyle(el).visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important');
          touched.add(el); n++;
        }
      }
    }
    return n;
  }
  function show() {
    for (const el of touched) {
      try {
        el.style.removeProperty('display');
        el.style.removeProperty('visibility');
        delete el.__agHidden;
      } catch (e) { /* element gone with the page */ }
    }
    touched.clear();
  }

  function videoId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('v') || (/^\/(shorts|live|embed)\/([\w-]{11})/.exec(u.pathname) || [])[2] || null;
    } catch (e) { return null; }
  }

  /* The point of the whole file: is anything actually decoding?
   * A stream playing audio has readyState HAVE_ENOUGH_DATA, so that alone settles it. The moving
   * clock is the fallback for a stream still filling its buffer. */
  function healthy(v) {
    if (!v) return false;
    if (v.readyState >= 3) return true;
    const t = v.currentTime, moved = lastT >= 0 && Math.abs(t - lastT) > 0.01;
    return moved;
  }

  /** ask the worker which of its own rules fired here -- said once per video, only when an overlay shows */
  function reportBlocked() {
    if (saidBlocked) return;
    saidBlocked = true;
    try {
      chrome.runtime.sendMessage({ type: 'ytMatched' }, r => {
        void chrome.runtime.lastError;
        if (!r || !r.rules || !r.rules.length) {
          log('no AdVault network rule fired on this page, so the overlay is not coming from a block of ours.');
          return;
        }
        log('AdVault network rules that fired on this page (a blocked request the player wanted is the' +
            ' usual reason it throws and paints the overlay):');
        for (const x of r.rules) log('   ', x.ruleset + ' #' + x.id, x.filter || '(no urlFilter)', x.action || '');
      });
    } catch (e) { /* worker asleep */ }
  }

  function reset(vid) {
    if (hiding) { show(); hiding = false; }
    id = vid; tries = 0; lastTry = 0; lastT = -1;
    healthySince = 0; deadSince = 0; saidBlocked = false; finalSaid = false;
    settleUntil = performance.now() + SETTLE_MS;
    log('new video:', vid || '(none)');
  }

  /* Held behind the start gate (see the note at the end of src/settings.js): this watchdog hides
   * the player's error overlay and can re-ask YouTube for the video, both of which reach into
   * #movie_player. Running either while the player was still initialising was part of the black
   * screen it is meant to cure, so the loop does not start until 3 s after the page has finished
   * loading. The Sx.onChange subscription above stays outside the gate so `on` is already correct
   * when the loop does start. */
  Sx.gate(() => setInterval(() => {
    if (!on) return;

    const vid = videoId();
    if (vid !== id) { reset(vid); return; }
    if (!vid) return;

    ask({ __adguardYtProbe: 1 });

    const now = performance.now();
    const v = video();
    const ok = healthy(v);
    if (v) lastT = v.currentTime;

    const covering = covers();
    const status = probe && probe.status;

    // ---- a real refusal from YouTube: leave it completely alone
    if (status && FINAL.test(status)) {
      if (hiding) { show(); hiding = false; }
      if (!finalSaid) { finalSaid = true; log('YouTube says', status + ':', (probe && probe.reason) || coverText(), '-- that is the answer, leaving the message up'); }
      return;
    }
    finalSaid = false;

    // ---- an overlay we have already taken down: put it back the moment the stream dies
    if (hiding) {
      if (ok) { healthySince = healthySince || now; deadSince = 0; hide(); return; }   // keep new covers down too
      if (!deadSince) deadSince = now;
      if (now - deadSince < DEAD_MS) return;
      log('stream stopped behind the overlay -- putting the message back');
      show(); hiding = false; deadSince = 0;
      return;
    }

    if (!covering.length) { healthySince = 0; deadSince = 0; return; }

    if (now < settleUntil) return;                 // let the player finish settling first
    reportBlocked();

    // ---- overlay over a healthy stream: the error is spurious, take it down
    if (ok) {
      deadSince = 0;
      if (!healthySince) { healthySince = now; return; }
      if (now - healthySince < HEALTHY_MS) return;
      const n = hide();
      hiding = true;
      log(`overlay over a playing stream ("${coverText()}", status=${status || 'none'}) --` +
          ` hid ${n} element(s); picture and mouse clicks should be back. The stream was never broken.`);
      return;
    }

    // ---- overlay over a dead stream: re-ask YouTube for the video
    healthySince = 0;
    if (!deadSince) deadSince = now;
    if (now - deadSince < DEAD_MS) return;
    if (tries >= TRIES || now - lastTry < GAP_MS) return;
    tries++; lastTry = now; settleUntil = now + SETTLE_MS; deadSince = 0;
    log(`nothing decoding behind the overlay (readyState=${v ? v.readyState : 'no video'},` +
        ` status=${status || 'none'}) -- re-asking YouTube for this video,` +
        ` attempt ${tries}/${TRIES}`);
    ask({ __adguardYtFix: { id } });
  }, POLL_MS));

  window.addEventListener('pagehide', () => { if (hiding) show(); });

  Sx.gate(() => log('YouTube player recovery armed. It will say here what it finds and what it did.'));
})();
