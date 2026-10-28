/* Runs in the PAGE's own world (manifest "world": "MAIN") on YouTube only.
 *
 * This is the hands of src/yt-recover.js. That watchdog runs in the isolated world, where it can
 * read the DOM but cannot touch #movie_player's player object -- getPlayerResponse(),
 * loadVideoById() and the rest live on the page's side of the fence. So it asks here, by
 * postMessage, and this answers.
 *
 *   __adguardYtProbe -> __adguardYtState   what the player itself says: its state, the
 *                                          playabilityStatus YouTube returned, the video id.
 *                                          This is the thing to read in devtools: a status of
 *                                          ERROR / UNPLAYABLE / LOGIN_REQUIRED is YouTube
 *                                          refusing; anything else with a dead picture is the
 *                                          player having stalled.
 *   __adguardYtFix                         re-ask YouTube for this video at the same position
 *                                          (loadVideoById). Repaints a stalled player without
 *                                          reloading the tab -- what the Reload button in
 *                                          YouTube's own error screen does.
 *
 * This file used to also carry the HLS/DASH manifest rewriter and the YouTube player-JSON prune,
 * which monkey-patched window.fetch, XMLHttpRequest.prototype and JSON.parse on every page. Both
 * are gone: the manifest rewriter's XHR gate was one of the things breaking YouTube, and neither
 * earned the risk of patching three globals site-wide. Nothing here touches a page global. */
(() => {
  'use strict';
  if (!/(^|\.)youtube(-nocookie|kids|education)?\.com$/.test(location.hostname)) return;
  if (window.__adguardYtHelper) return;
  window.__adguardYtHelper = true;

  const ytPlayer = () => {
    const p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    return p && typeof p.getPlayerState === 'function' ? p : null;
  };

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;

    if (e.data.__adguardYtProbe) {
      const out = { id: null, state: null, status: null, reason: null, player: false };
      try {
        const p = ytPlayer();
        if (p) {
          out.player = true;
          out.state = p.getPlayerState();
          const d = p.getVideoData && p.getVideoData();
          out.id = (d && d.video_id) || null;
          const r = (p.getPlayerResponse && p.getPlayerResponse()) || window.ytInitialPlayerResponse;
          const ps = r && r.playabilityStatus;
          if (ps) { out.status = ps.status || null; out.reason = ps.reason || null; }
        }
      } catch (err) { out.error = String(err && err.message || err); }
      try { window.postMessage({ __adguardYtState: out }, location.origin); } catch (err) { /* ignore */ }
      return;
    }

    if (e.data.__adguardYtFix) {
      const q = e.data.__adguardYtFix;
      let done = '';
      try {
        const p = ytPlayer();
        if (p && typeof p.loadVideoById === 'function') {
          const d = p.getVideoData && p.getVideoData();
          const id = (d && d.video_id) || q.id;
          let at = 0;
          try { at = Math.max(0, (p.getCurrentTime && p.getCurrentTime()) || 0); } catch (err) { /* ignore */ }
          if (id) { p.loadVideoById({ videoId: id, startSeconds: at }); done = 'loadVideoById'; }
        }
        if (!done && p && typeof p.playVideo === 'function') { p.playVideo(); done = 'playVideo'; }
      } catch (err) { done = 'failed: ' + String(err && err.message || err); }
      try { window.postMessage({ __adguardYtFixDone: { did: done } }, location.origin); } catch (err) { /* ignore */ }
    }
  });
})();
