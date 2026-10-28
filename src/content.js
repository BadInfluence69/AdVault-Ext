/* Video-player layer. Two jobs, both of which do what they say on every site:
 *
 *   dom           The page's own player tells you an ad is on (YouTube sets .ad-showing on the
 *                 player root, JW sets .jw-flag-ads, and so on -- see src/sites.js). While it
 *                 does: mute, fast-forward no faster than the download, and click the player's
 *                 own Skip button the moment it appears. When the flag clears: normal speed,
 *                 sound back, and on YouTube a short watchdog to unstick a player that came out
 *                 of the ad parked in a buffer gap.
 *   sponsorblock  YouTube only. Community-marked sponsor / self-promo / interaction segments are
 *                 seeked past. Only the first 4 hex digits of the video id's SHA-256 leave the
 *                 browser (SponsorBlock's k-anonymity API); the match happens in background.js.
 *
 * What used to be here and is not any more
 * ------------------------------------------------------------------------------------------------
 * The picture-and-sound ad detector: a canvas frame-grab and a WebAudio tap on every media second,
 * feeding a statistical engine (src/engine.js) that guessed where the ad breaks were. It is gone,
 * along with engine.js, the remembered-breaks store and the Python bridge calls that fed the same
 * data to a detector offline. It was the "Experimental, turn this off if videos speed up" switch,
 * and the speed-ups were real: it fired on scene cuts, b-roll and product demos, so it would
 * fast-forward through programme and then seek you back. A guess that is wrong often enough to
 * need a warning label is not a feature. Ads are found by asking the player, which is exact.
 *
 * Losing it also removed the reason the YouTube smooth-playback switch existed -- there is no
 * per-frame readback left to switch off -- so that switch is gone too, and YouTube is simply fast
 * now. */
(() => {
  'use strict';
  if (window.__adGuard) return;
  window.__adGuard = true;

  const S = self.AdGuardSites;
  const settings = self.AdGuardSettings.cur;       // settings.active = on, and not off for this site
  const FAST = 8;                                  // fast-forward ceiling during a flagged ad
  let nextId = 1;

  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);

  /* YouTube pre-roll buffering. A flat fast rate drained the player's buffer faster than
   * googlevideo could refill it and the player got stuck in a stall that carried over into the
   * programme, so the rate follows how much media is buffered ahead and never outruns the
   * download. */
  function bufferedAhead(v) {
    try {
      const b = v.buffered, t = v.currentTime;
      for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.1 && t <= b.end(i)) return b.end(i) - t;
    } catch (e) { /* no buffer yet */ }
    return 0;
  }
  function ytRate(v, max) {
    if (v.readyState < 3) return 1;                // HAVE_FUTURE_DATA not reached: let it fill
    const a = bufferedAhead(v);
    if (a < 2) return 1;
    if (a < 6) return Math.min(max, 4);
    return max;
  }
  const YT_RECOVER_MS = 15000, YT_STALL_MS = 1500;

  /* Non-skippable ads: seek through what has already downloaded.
   *
   * playbackRate alone cannot clear a long ad, and raising the ceiling does not help. ytRate above
   * deliberately refuses to outrun the download -- that is the guard against the old stall -- so on
   * an ad longer than YouTube pre-buffers, fast-forwarding drains the buffer faster than
   * googlevideo refills it, `bufferedAhead` falls under two seconds, and the rate collapses to 1x
   * for most of the ad. A five-second skippable ad is fully buffered almost at once and does run at
   * the ceiling the whole way, which is why those felt fast and the non-skippable ones did not.
   *
   * Playback speed can never beat the download, so the answer is to stop decoding the ad at all.
   * Seeking to the end of data that has ALREADY ARRIVED always lands, costs no decoding, and
   * consumes the ad as fast as it is delivered.
   *
   * This is not the thing that broke the player before. That was a seek to duration - 0.1 -- a
   * point that had not downloaded -- re-issued five times a second forever, so it never landed and
   * the decoder was reset continuously (see the long note in src/sites.js). Every difference that
   * matters is guarded here: the target is inside a buffered range, it is at least SEEK_MIN ahead,
   * at most one seek per SEEK_GAP, the last AD_TAIL seconds are left to play out normally so
   * YouTube's own ad-end logic fires, and if a seek fails to move the clock SEEK_FAILS times in a
   * row this gives up for the rest of the ad and falls back to playbackRate alone. */
  const SEEK_GAP = 350;        // ms between seeks
  const SEEK_MIN = 0.7;        // only jump if there is at least this much buffered data to skip
  const AD_TAIL = 0.45;        // seconds of the ad left to play normally at the end
  const SEEK_FAILS = 3;        // consecutive seeks that did not move the clock before giving up

  const log = (...a) => { try { console.log('[AdVault]', ...a); } catch (e) {} };

  // -------------------------------------------------------------- watcher ----
  class Watcher {
    constructor(video) {
      this.v = video; this.id = nextId++;
      this.held = false; this.saved = null;
      this.siteAd = null;
      this.stats = { domSkips: 0, sbSkips: 0, skipped: 0 };
      this.sbId = null; this.sbSegs = [];
      this.sbHref = null; this.sbHrefId = null;    // cached location.href -> video id, so poll() need not re-parse
      this.dead = false; this.reportTimer = 0;
      this.ytRecover = 0; this.ytLastT = -1; this.ytStuckSince = 0;
      this.resetSeek();
      this.adStarted = 0; this.adSeeked = 0; this.adSawSkip = false;

      video.addEventListener('ratechange', () => { if (this.held) this.apply(); });
      // a new piece of media in the same element (YouTube reuses one <video> for ad and
      // programme, and an ad pod loads each ad in turn) starts the seek bookkeeping over
      video.addEventListener('loadedmetadata', () => this.resetSeek());
      video.addEventListener('emptied', () => this.resetSeek());
      this.timer = setInterval(() => this.poll(), 200);
      this.report();
    }

    destroy() { this.dead = true; clearInterval(this.timer); this.held = false; this.restore(); }

    // ---- actuator ----
    hold() {
      if (!this.held) { this.saved = { rate: this.v.playbackRate, muted: this.v.muted }; this.held = true; }
      this.apply();
    }
    apply() {
      const v = this.v, r = IS_YT ? ytRate(v, FAST) : FAST;
      if (v.playbackRate !== r) v.playbackRate = r;
      if (!v.muted) v.muted = true;
    }
    restore() {
      if (!this.saved) return;
      const v = this.v, s = this.saved;
      this.saved = null;
      v.playbackRate = (s.rate >= FAST || !(s.rate > 0)) ? 1 : s.rate;   // never hand a fast-forward rate back
      v.muted = s.muted;
    }

    resetSeek() { this.lastSeek = 0; this.seekFrom = -1; this.seekFails = 0; this.seekOff = false; }

    /** Called every poll while an ad is flagged. Jumps to the end of the buffered data the ad has
     *  already downloaded, so a non-skippable ad clears at download speed instead of playing out.
     *  -> seconds skipped by this call, 0 if it did nothing. */
    adAdvance() {
      const v = this.v, now = performance.now();
      if (this.seekOff || v.seeking || v.readyState < 2) return 0;
      if (now - this.lastSeek < SEEK_GAP) return 0;

      // Judge the previous jump before issuing another: if the clock did not move, seeking is not
      // working on this stream and hammering it is exactly the old bug. Give up, keep the rate.
      if (this.seekFrom >= 0) {
        if (v.currentTime > this.seekFrom + 0.3) {
          this.seekFails = 0;
        } else if (++this.seekFails >= SEEK_FAILS) {
          this.seekOff = true;
          log('seeking is not moving this ad along - backing off to fast-forward only');
          return 0;
        }
        this.seekFrom = -1;
      }

      const d = v.duration;
      if (!isFinite(d) || d <= 0) return 0;

      // the end of the buffered range the playhead is actually inside
      let end = -1;
      try {
        const b = v.buffered, t = v.currentTime;
        for (let i = 0; i < b.length; i++) {
          if (t >= b.start(i) - 0.25 && t <= b.end(i)) { end = b.end(i); break; }
        }
      } catch (e) { return 0; }
      if (end < 0) return 0;                                     // playhead is not in downloaded data

      const from = v.currentTime;
      const target = Math.min(end - 0.1, d - AD_TAIL);
      if (!(target > from + SEEK_MIN)) return 0;                 // nothing worth jumping over yet

      this.seekFrom = from; this.lastSeek = now;
      try { v.currentTime = target; } catch (e) { this.seekOff = true; return 0; }
      return target - from;
    }

    // ---- poll ----
    poll() {
      const v = this.v;
      if (!document.contains(v) && !v.isConnected) { this.destroy(); watchers.delete(v); return; }
      if (!settings.active) {
        if (this.held) { this.held = false; this.restore(); }
        this.siteAd = null;
        return;
      }
      if (settings.sponsorblock) this.sponsorblock();

      if (settings.dom) {
        const kind = S.detect(v);
        if (kind) {
          if (!this.siteAd) {
            this.siteAd = kind; this.stats.domSkips++;
            this.adStarted = performance.now(); this.adSeeked = 0; this.adSawSkip = false;
            this.resetSeek();
            this.report();
          }
          this.hold();
          const did = S.skip(v, kind);
          if (did === 'skip-button' || did === 'skip-text') this.adSawSkip = true;
          // Clicking Skip ends the ad outright, so there is nothing left to seek past. Otherwise
          // get through it at download speed rather than at playback speed.
          if (!this.adSawSkip) this.adSeeked += this.adAdvance();
        } else if (this.siteAd) {
          /* One line per ad, so a complaint about a slow ad can be told apart from an ad that was
           * never detected. "skipButton=no" with a long wall time is a non-skippable ad; no line
           * at all means the player never flagged it and nothing here ran. */
          const secs = (performance.now() - this.adStarted) / 1000;
          log(`player ad cleared (${this.siteAd}) in ${secs.toFixed(1)}s wall` +
              ` - skipButton=${this.adSawSkip ? 'clicked' : 'no'}` +
              ` seekedThrough=${this.adSeeked.toFixed(1)}s` +
              ` seeking=${this.seekOff ? 'off' : 'on'}`);
          this.siteAd = null;
          this.held = false; this.restore();
          if (IS_YT) { this.ytRecover = performance.now() + YT_RECOVER_MS; this.ytLastT = -1; this.ytStuckSince = 0; }
          this.report();
        }
      } else if (this.siteAd) {                    // switch turned off mid-ad
        this.siteAd = null; this.held = false; this.restore(); this.report();
      }

      if (IS_YT && this.ytRecover) this.ytUnstick();
      if (this.held) this.apply();
    }

    /** YouTube, first seconds after an ad: if the programme sits still while it should be playing,
     *  nudge it -- into the next buffered range when it is parked in a gap, else a tiny re-seek so
     *  the player refetches. At most one nudge per YT_STALL_MS; stops after YT_RECOVER_MS or when
     *  another ad starts. */
    ytUnstick() {
      const v = this.v, now = performance.now();
      if (this.siteAd || now > this.ytRecover) { this.ytRecover = 0; return; }
      if (v.paused || v.ended || v.seeking) { this.ytStuckSince = 0; this.ytLastT = v.currentTime; return; }
      if (!this.held && v.playbackRate >= FAST) v.playbackRate = 1;          // leftover fast-forward
      const t = v.currentTime;
      const moving = this.ytLastT >= 0 && Math.abs(t - this.ytLastT) > 0.01;
      this.ytLastT = t;
      if (moving && v.readyState >= 3) { this.ytStuckSince = 0; return; }
      if (!this.ytStuckSince) { this.ytStuckSince = now; return; }
      if (now - this.ytStuckSince < YT_STALL_MS) return;
      this.ytStuckSince = now;
      let to = t + 0.01;
      try {
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) {
          if (t >= b.start(i) && t < b.end(i) - 0.2) break;                   // inside data: re-seek in place
          if (b.start(i) > t && b.start(i) - t < 3) { to = b.start(i) + 0.05; break; }   // parked in a gap
        }
        v.currentTime = to;
      } catch (e) { /* not seekable yet */ }
    }

    // ---- SponsorBlock (YouTube) ----
    sponsorblock() {
      if (!IS_YT || this.siteAd) return;
      // the href only changes on navigation; parsing it five times a second was wasted work
      let id;
      if (location.href === this.sbHref) {
        id = this.sbHrefId;
      } else {
        const u = new URL(location.href);
        id = u.searchParams.get('v') || (/^\/(shorts|live|embed)\/([\w-]{11})/.exec(u.pathname) || [])[2] || null;
        this.sbHref = location.href; this.sbHrefId = id;
      }
      if (id !== this.sbId) {
        this.sbId = id; this.sbSegs = [];
        if (id) {
          try {
            chrome.runtime.sendMessage({ type: 'sb', id }, r => {
              void chrome.runtime.lastError;
              if (this.sbId === id && r && r.segs) this.sbSegs = r.segs.map(s => ({ ...s, counted: false }));
            });
          } catch (e) { /* extension reloaded */ }
        }
      }
      if (!this.sbSegs || !this.sbSegs.length || this.v.paused) return;
      const t = this.v.currentTime;
      for (const s of this.sbSegs) {
        if (t >= s.s - 0.05 && t < s.e - 0.3) {
          this.v.currentTime = s.e;
          if (!s.counted) { s.counted = true; this.stats.sbSkips++; this.stats.skipped += s.e - s.s; this.report(); }
          break;
        }
      }
    }

    // ---- status for the popup / badge ----
    report() {
      clearTimeout(this.reportTimer);
      this.reportTimer = setTimeout(() => {
        const msg = {
          type: 'stats', id: this.id,
          stats: {
            host: location.hostname,
            state: this.siteAd ? 'player ad: ' + this.siteAd : 'watching',
            domSkips: this.stats.domSkips, sbSkips: this.stats.sbSkips,
            skipped: Math.round(this.stats.skipped), site: this.siteAd || '',
          },
        };
        try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) { /* reloaded */ }
      }, 250);
    }
  }

  // ------------------------------------------------------------ discovery ----
  const watchers = new Map();

  /* Finding videos used to mean querySelectorAll('*') over the document and every shadow root
   * every two seconds. On a YouTube watch page that is tens of thousands of nodes plus a few
   * hundred Polymer shadow roots, 30 times a minute. The cheap pass below (a tag query on the
   * document and on shadow roots already known to exist) finds the same elements; the deep walk
   * that discovers *new* shadow hosts runs every 15 s, and not at all on YouTube, which keeps its
   * <video> in the light DOM. The capturing 'play' listener catches anything either pass missed,
   * at the moment it matters. */
  const shadowRoots = new Set();
  let lastDeep = 0;

  function deepWalk(root) {
    for (const el of root.querySelectorAll('*')) {
      if (!el.shadowRoot || shadowRoots.has(el.shadowRoot)) continue;
      shadowRoots.add(el.shadowRoot);
      deepWalk(el.shadowRoot);
    }
  }
  function collect(out) {
    for (const v of document.querySelectorAll('video')) out.push(v);
    for (const r of shadowRoots) {
      if (!r.host || !r.host.isConnected) { shadowRoots.delete(r); continue; }
      for (const v of r.querySelectorAll('video')) out.push(v);
    }
    return out;
  }
  function scan() {
    if (!settings.active) return;
    const now = Date.now();
    if (!IS_YT && now - lastDeep >= 15000) { lastDeep = now; try { deepWalk(document); } catch (e) { /* ignore */ } }
    for (const v of collect([])) if (!watchers.has(v)) watchers.set(v, new Watcher(v));
  }
  /* Arming is held behind the start gate (see the note at the end of src/settings.js). On YouTube
   * nothing below runs until 3 s after the page has finished loading, so no Watcher exists while
   * the player is still initialising and nothing here sets playbackRate, muted or currentTime on a
   * half-wired <video> -- that was the black screen. Every other site arms immediately, exactly as
   * before. Once armed, this behaves as it always has, including across YouTube's in-page
   * navigations, which is why ads later in the timeline are still caught. */
  self.AdGuardSettings.gate(() => {
    document.addEventListener('play', e => {
      if (e.target instanceof HTMLVideoElement && !watchers.has(e.target) && settings.active) {
        watchers.set(e.target, new Watcher(e.target));
      }
    }, true);

    self.AdGuardSettings.onChange(() => {
      if (settings.active) scan();
      watchers.forEach(w => w.report());
    });
    scan();
    setInterval(scan, 2000);
  });
})();
