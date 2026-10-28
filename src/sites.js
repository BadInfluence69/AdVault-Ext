/* Player-level ad hints: when the page's own player says "an ad is playing", say so, and click
 * its Skip / close buttons. Exact, not a guess -- but these are the players' own class names, so
 * they drift over time; keep the lists short and current.
 *
 * Getting *through* an ad that cannot be clicked away is content.js's job (adAdvance), not this
 * file's. See the note at the end of skip(). */
(function (root) {
  'use strict';

  // [selector the <video> sits inside (or the document contains), kind]
  const FLAGS = [
    ['.html5-video-player.ad-showing', 'youtube'],
    ['.html5-video-player.ad-interrupting', 'youtube'],
    ['.jw-flag-ads', 'jwplayer'],
    ['.vjs-ad-playing', 'videojs'],
    ['.plyr--ad-playing, .plyr.plyr--ads-playing', 'plyr'],
    ['.bmpui-ui-adcontrols, .bitmovinplayer-container .bmpui-ads', 'bitmovin'],
    ['[data-a-target="video-ad-label"]', 'twitch'],
    ['[data-test-selector="ad-banner-default-text"]', 'twitch'],
    // generic player conventions (IMA SDK, Video.js ads plugins, many custom players)
    ['.ima-ad-container:not([style*="display: none"]) > div:not(:empty)', 'ima'],
    ['.video-ads:not(:empty)', 'generic'],
    ['[class*="ad-playing"], [class*="ad-showing"], [class*="adPlaying"], [class*="ad-active"]', 'generic'],
    ['[data-ad-playing="true"], [data-playing-ad="true"], [data-is-ad="true"]', 'generic'],
  ];

  const SKIP_SELECTORS = [
    '.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container button', '.videoAdUiSkipButton',
    '.jw-skip', '.vjs-skip-button', '.bmpui-ui-skip-button',
    '.videoAdUiSkipButton', '[class*="skip-ad"] button', 'button[class*="skip-ad"]', 'button[class*="ad-skip"]',
  ];
  const CLOSE_SELECTORS = ['.ytp-ad-overlay-close-button', '.ytp-ad-overlay-close-container'];
  const SKIP_TEXT = /^\s*skip\s*(the\s*)?ads?\s*(>+|»)?\s*$/i;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  // YouTube flags its own ads with two exact classes on the player root. The generic
  // [class*="ad-playing"] style entries below are attribute-substring selectors with no index:
  // running all thirteen against YouTube's ~30k-node document five times a second was pure
  // main-thread cost for a result the first two entries already give. Same answer, far cheaper.
  const YT_FLAGS = FLAGS.filter(f => f[1] === 'youtube');
  const RE_YT_HOST = /(^|\.)youtube(-nocookie|kids|education)?\.com$/;

  /** -> kind string when the page's player reports an ad playing in/around this video, else null
   *
   * The document-wide fallback used to accept a flagged player anywhere on the page. A YouTube
   * watch page has more than one: thumbnail hover-previews are their own .html5-video-player
   * instances, so an ad flag on one of those marked the *main* video as an ad -- fast-forwarded,
   * muted and seeked. The fallback now has to actually contain this video. */
  function detect(video) {
    const list = (typeof location !== 'undefined' && RE_YT_HOST.test(location.hostname)) ? YT_FLAGS : FLAGS;
    for (const [sel, kind] of list) {
      try {
        if (video.closest(sel)) return kind;
        const el = document.querySelector(sel);
        if (el && (el.contains(video) || !el.querySelector('video'))) return kind;
      } catch (e) { continue; }
    }
    return null;
  }

  function click(el) {
    try {
      el.click();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }

  /** Called every poll while an ad is flagged. -> what it did, for the log */
  function skip(video, kind) {
    for (const sel of SKIP_SELECTORS) {
      const b = document.querySelector(sel);
      if (b && visible(b) && click(b)) return 'skip-button';
    }
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (SKIP_TEXT.test((b.getAttribute('aria-label') || b.textContent || '').trim()) && visible(b) && click(b)) return 'skip-text';
    }
    for (const sel of CLOSE_SELECTORS) {
      const b = document.querySelector(sel);
      if (b && visible(b)) click(b);
    }
    /* There used to be a last resort here: seek to duration - 0.1 and let the ad play out.
     * That branch was the black-screen player. skip() is called from content.js's poll(), five
     * times a second for as long as the ad flag is up, and it re-issued the same seek every time
     * without checking whether the previous one took. Traced against a real element: eleven
     * identical seeks in 2.2 s, the clock snapping back between each. On an MSE-backed player
     * that resets the video decoder five times a second, so no frame is ever presented -- a black
     * picture -- while the audio pipeline keeps draining its buffer, so the sound carries on.
     * Hammered like that the player paints its own error overlay, which is opaque and swallows
     * mouse clicks, while the spacebar still works because the keyboard handler is on the
     * document. That was the whole symptom.
     *
     * Getting through an ad is now content.js's adAdvance(), for every site rather than just the
     * ones this branch dared to touch. It seeks to the end of data that has ALREADY downloaded,
     * which always lands, instead of to a point that may not have arrived; it is rate-limited,
     * bounded, leaves the ad's last fraction of a second to play out so the player's own ad-end
     * logic fires, and gives up for the rest of the ad if a seek fails to move the clock. This
     * file now does what its name says and nothing else: read the player's ad flag, click its
     * buttons. */
    return 'wait';
  }

  const api = { detect, skip, FLAGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AdGuardSites = api;
})(typeof self !== 'undefined' ? self : this);
