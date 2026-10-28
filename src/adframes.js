/* Ad iframe and empty ad-container detection, for every site except YouTube.
 *
 * Catches what the selector lists miss because the markup is randomised: an <iframe> whose source
 * is an ad server, or whose id/name is an ad-slot name, is hidden; then up to three wrappers above
 * it are hidden too when they look like ad slots (ad-ish id/class or IAB-sized) and hold nothing
 * else visible. When the network layer blocked the frame's request this removes the empty box
 * left behind.
 *
 * Conservative by design: a frame is never hidden on its size alone, and a wrapper is only hidden
 * when everything it contains is the ad. Follows enabled / per-site off / cosmetic / uboRules.
 * Never runs in a YouTube frame or in a frame below one. */
(() => {
  'use strict';
  const Sx = self.AdGuardSettings;
  if (!Sx || self.__agAdFrames) return;
  self.__agAdFrames = true;

  const RE_YT = /(^|\.)(youtube(-nocookie|kids|education)?\.[a-z.]+|youtu\.be|ytimg\.com|googlevideo\.com)$/;
  try {
    if (RE_YT.test(location.hostname)) return;
    const ao = location.ancestorOrigins;
    if (ao) for (let i = 0; i < ao.length; i++) if (RE_YT.test(new URL(ao[i]).hostname)) return;
  } catch (e) { /* ignore */ }

  // ad servers / exchanges / native-ad widgets that render inside an iframe
  const AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'pubmatic.com', 'rubiconproject.com',
    'openx.net', 'casalemedia.com', 'taboola.com', 'outbrain.com', 'mgid.com', 'revcontent.com',
    'adform.net', 'smartadserver.com', 'teads.tv', 'sharethrough.com', 'media.net', '33across.com',
    '3lift.com', 'yieldmo.com', 'exoclick.com', 'exosrv.com', 'juicyads.com', 'trafficjunky.net',
    'propellerads.com', 'popads.net', 'adsterra.com', 'adcash.com', 'hilltopads.net', 'bidvertiser.com',
    'zedo.com', 'yahoo-ads.com', 'serving-sys.com', 'flashtalking.com', 'innovid.com', 'spotxchange.com',
    'springserve.com', 'adsafeprotected.com', 'moatads.com', 'doubleverify.com',
  ];   // imasdk.googleapis.com is left out on purpose: src/sites.js drives the IMA player's skip button
  const RE_AD_NAME = /^(google_ads_iframe|aswift_|ad_?i?frame|adframe|ebDiv|div-gpt-ad|gpt_unit|ad_unit|adunit|ads?-?slot|banner_?ad|sponsor)/i;
  const RE_AD_TOKEN = /(^|[\s_-])(ads?|adv|advert|advertisement|adslot|adunit|ad-?container|ad-?wrapper|ad-?box|banner-?ad|dfp|gpt|sponsor(ed)?|promo-?ad|leaderboard|skyscraper|mrec)([\s_-]|\d|$)/i;
  const IAB = [[300, 250], [728, 90], [160, 600], [300, 600], [320, 50], [320, 100], [970, 90], [970, 250],
    [336, 280], [468, 60], [120, 600], [250, 250], [200, 200], [300, 50], [300, 100]];
  const MARK = 'data-ag-adframe';

  let on = false, sheet = null, observer = null, timer = 0;
  let marked = new Set();

  function ensureSheet() {
    const body = '{display:none!important}';
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(`[${MARK}]${body}`);
    } catch (e) { sheet = null; }
  }

  function hostOf(src) {
    try { return new URL(src, location.href).hostname.toLowerCase(); } catch (e) { return ''; }
  }
  function adHost(h) {
    if (!h) return false;
    for (const d of AD_HOSTS) if (h === d || h.endsWith('.' + d)) return true;
    return false;
  }
  function attrText(el) {
    return (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' +
      (el.getAttribute('data-ad-slot') !== null || el.getAttribute('data-adunit') !== null ? 'ad' : '');
  }
  function iabSized(el) {
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    return IAB.some(([iw, ih]) => Math.abs(w - iw) <= 2 && Math.abs(h - ih) <= 2);
  }

  function isAdFrame(f) {
    if (f.hasAttribute(MARK)) return false;
    const src = f.getAttribute('src') || f.getAttribute('data-src') || '';
    if (src && adHost(hostOf(src))) return true;
    if (RE_AD_NAME.test(f.id || '') || RE_AD_NAME.test(f.name || '')) return true;
    // about:blank / srcdoc frames written by an ad script: only when the slot itself says "ad"
    if ((!src || src === 'about:blank') && f.parentElement &&
        RE_AD_TOKEN.test(attrText(f.parentElement)) && iabSized(f)) return true;
    return false;
  }

  // a wrapper is hideable when it is ad-labelled (or ad-sized) and nothing visible is left in it
  function onlyAd(el) {
    if (el === document.body || el === document.documentElement) return false;
    if ((el.innerText || '').replace(/\s+/g, ' ').trim().replace(/^(advertisement|ad|ads|sponsored|anzeige|publicité|publicidad|pubblicità)$/i, '').length > 0) return false;
    for (const m of el.querySelectorAll('img,video,canvas,svg,picture,iframe,embed,object,input,button,a[href]')) {
      if (m.hasAttribute(MARK) || m.closest('[' + MARK + ']')) continue;
      const r = m.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) return false;
    }
    return true;
  }

  function mark(el) {
    el.setAttribute(MARK, '');
    marked.add(el);
  }

  function handle(f) {
    if (!isAdFrame(f)) return;
    mark(f);
    let el = f.parentElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
      if (!(RE_AD_TOKEN.test(attrText(el)) || iabSized(el))) break;
      if (!onlyAd(el)) break;
      mark(el);
    }
  }

  function scan(root) {
    if (!on) return;
    const frames = root.nodeName === 'IFRAME' ? [root] : (root.querySelectorAll ? root.querySelectorAll('iframe') : []);
    for (const f of frames) handle(f);
  }

  let queue = [];
  function flush() {
    timer = 0;
    const batch = queue.splice(0, 200);
    for (const n of batch) if (n.isConnected) scan(n);
    if (queue.length) timer = setTimeout(flush, 250);
  }

  function start() {
    ensureSheet();
    scan(document);
    if (!observer) {
      observer = new MutationObserver(muts => {
        for (const m of muts) {
          if (m.type === 'attributes') { if (m.target.nodeName === 'IFRAME') queue.push(m.target); continue; }
          for (const n of m.addedNodes) if (n.nodeType === 1) queue.push(n);
        }
        if (queue.length && !timer) timer = setTimeout(flush, 250);
      });
    }
    try {
      observer.observe(document.documentElement || document, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'id', 'name'],
      });
    } catch (e) { /* no document yet */ }
    document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
    setTimeout(() => scan(document), 2500);        // late-filled, size-dependent slots
  }

  function stop() {
    if (observer) { observer.takeRecords(); observer.disconnect(); }
    if (timer) { clearTimeout(timer); timer = 0; }
    queue = [];
    for (const el of marked) el.removeAttribute(MARK);
    marked = new Set();
    if (sheet) try { sheet.replaceSync(''); } catch (e) { /* ignore */ }
  }

  Sx.onChange(cur => {
    const want = !!(cur.active && cur.cosmetic && cur.uboRules !== false);
    if (want && !on) { on = true; start(); }
    else if (!want && on) { on = false; stop(); }
  });
})();
