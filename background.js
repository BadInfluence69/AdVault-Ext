/* Ad Guard service worker.
 *
 * 1. Network layer: the three declarativeNetRequest ad/badware rulesets, always on, plus the
 *    per-site allow rules for sites you have turned off. This is the layer that matters for
 *    no-click malvertising -- a blocked request never reaches the page, so its script never
 *    runs. Hiding alone cannot do that, which is why this has no switch: it is the point of
 *    the extension, not an option.
 * 2. Cosmetic databases: holds the EasyList selector tables and answers per-frame lookups,
 *    so the big JSON files never have to be injected into a page.
 * 3. Per-tab status reports from the content scripts, kept in session storage (this worker
 *    sleeps), shown on the icon badge.
 * 4. SponsorBlock lookups. Only the first 4 hex digits of the video id's SHA-256 leave the
 *    browser (SponsorBlock's k-anonymity API); the match happens here.
 */

// ----------------------------------------------------------------- network layer
const OFF_RULE_BASE = 1;                       // dynamic rule ids 1..n are the per-site allowances
const AD_RULESETS = ['core', 'ads', 'ads_extra'];   // every converted ad/badware rule -- all three together
const DEFAULTS = { enabled: true, offSites: [] };

/* chrome.storage.sync is network-backed: on a cold profile, right after the browser starts, when
 * the profile is signed out, or while the sync quota is in backoff, a read can take seconds or
 * reject. Every function in this worker gated on a settings read would then do nothing -- which
 * left the rulesets at whatever the manifest declared and the extension half-applied until it was
 * toggled off and on. src/settings.js mirrors the settings into storage.local on every change;
 * this reads that mirror when sync will not answer, and falls back to the defaults after that. */
async function readSettings(defaults) {
  const keys = Object.keys(defaults);
  const pick = src => {
    const out = Object.assign({}, defaults);
    for (const k of keys) if (src && src[k] !== undefined) out[k] = src[k];
    return out;
  };
  const timeout = ms => new Promise(r => setTimeout(() => r(null), ms));
  try {
    const o = await Promise.race([chrome.storage.sync.get(defaults), timeout(1500)]);
    if (o) return pick(o);
  } catch (e) { /* sync unavailable */ }
  try {
    const m = await chrome.storage.local.get({ __agMirror: null });
    if (m && m.__agMirror) return pick(m.__agMirror);
  } catch (e) { /* local unavailable too */ }
  return Object.assign({}, defaults);
}

async function syncRulesets() {
  const o = await readSettings(DEFAULTS);
  const live = !!o.enabled;
  const want = live ? AD_RULESETS : [];
  const have = await chrome.declarativeNetRequest.getEnabledRulesets();
  const enable = want.filter(id => !have.includes(id));
  const disable = have.filter(id => !want.includes(id));
  let error = '';
  if (enable.length || disable.length) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
    } catch (e) { error = String(e && e.message || e); }
  }
  // What actually ended up live, so the popup can show drift rather than hide it. Chrome enables
  // rulesets up to the static-rule budget it has left -- a budget shared with every other
  // declarativeNetRequest extension in the profile -- and silently skips the rest. With another
  // blocker installed, which set survives can differ from one browser start to the next, and that
  // is what "it works, then it doesn't" looks like from the outside.
  let final = [];
  try { final = await chrome.declarativeNetRequest.getEnabledRulesets(); } catch (e) { /* ignore */ }
  const missing = want.filter(id => !final.includes(id));
  if (missing.length && !error) error = 'Chrome did not enable: ' + missing.join(', ') + ' (static rule budget)';
  await chrome.storage.session.set({ rulesetError: error, rulesetsLive: final });
  await syncOffSites(o.offSites || []);
}

async function syncOffSites(hosts) {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = old.map(r => r.id);
  const addRules = hosts.slice(0, 4000).map((h, i) => ({
    id: OFF_RULE_BASE + i,
    priority: 1000,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: [h], resourceTypes: ['main_frame', 'sub_frame'] },
  })).filter(r => /^[a-z0-9]([a-z0-9\-_]*\.)*[a-z0-9\-_]+$/.test(r.condition.requestDomains[0]));
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) { /* a malformed hostname in the list: leave the previous set alone */ }
}

// A failed sync leaves the network layer in whatever state the manifest declared, so it is worth
// one retry rather than waiting for the next event (or for the user to toggle the extension).
function syncRulesetsSafe(retry) {
  return syncRulesets().catch(e => {
    chrome.storage.session.set({ rulesetError: String(e && e.message || e) }).catch(() => {});
    if (retry !== false) setTimeout(() => syncRulesetsSafe(false), 2000);
  });
}

chrome.runtime.onInstalled.addListener(() => syncRulesetsSafe());
chrome.runtime.onStartup.addListener(() => syncRulesetsSafe());
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'sync') return;
  if (['enabled', 'offSites'].some(k => k in ch)) syncRulesetsSafe();
});
syncRulesetsSafe();                             // also covers a worker wake-up after a crash

// id -> rule lookup for the ytMatched diagnostic below. Loaded on demand and kept, since the
// only caller is a human reading the console.
const RULESET_PATH = {
  core: 'rules/net_core.json', ads: 'rules/net_ads.json', ads_extra: 'rules/net_ads_extra.json',
};
const ruleTables = new Map();
async function ruleTable(id, path) {
  if (ruleTables.has(id)) return ruleTables.get(id);
  const list = await fetch(chrome.runtime.getURL(path)).then(r => r.json());
  const t = new Map();
  for (const r of list) t.set(r.id, r);
  ruleTables.set(id, t);
  return t;
}

// ----------------------------------------------------------------- cosmetic databases
let cosGen = null, cosSite = null, cosLoading = null;

async function cosLoad() {
  if (cosGen && cosSite) return;
  if (!cosLoading) {
    cosLoading = (async () => {
      const [g, s] = await Promise.all([
        fetch(chrome.runtime.getURL('data/cosmetic-generic.json')).then(r => r.json()),
        fetch(chrome.runtime.getURL('data/cosmetic-sites.json')).then(r => r.json()),
      ]);
      cosGen = g;
      cosSite = { s: s.s || {}, x: s.x || {}, nohide: new Set(s.nohide || []) };
    })().catch(() => { cosGen = { c: {}, i: {}, o: [] }; cosSite = { s: {}, x: {}, nohide: new Set() }; });
  }
  return cosLoading;
}

function suffixes(host) {
  const out = [];
  if (!host) return out;
  const parts = String(host).toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}
function excludedFor(host) {
  const out = new Set();
  for (const d of suffixes(host)) for (const s of cosSite.x[d] || []) out.add(s);
  return out;
}
function genericBlockedFor(host) {
  return suffixes(host).some(d => cosSite.nohide.has(d));
}

// ----------------------------------------------------------------- uBO general-site layer
// data/ubo-cosmetic.json and ubo/scriptlets-*.js are built by tools/port_ubo.py from the uBO Lite
// tree. All of it is for non-YouTube sites: nothing here answers for a YouTube page or a frame
// inside one, so the YouTube handling above and in src/ stays the only logic there.
const RE_YT = /(^|\.)(youtube(-nocookie|kids|education)?\.[a-z.]+|youtu\.be|ytimg\.com|googlevideo\.com)$/;
const YT_MATCHES = ['youtube.com', 'youtube-nocookie.com', 'youtubekids.com', 'youtubeeducation.com',
  'youtu.be', 'ytimg.com', 'googlevideo.com'].flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
let ubo = null, uboLoading = null;

async function uboLoad() {
  if (ubo) return;
  if (!uboLoading) {
    uboLoading = fetch(chrome.runtime.getURL('data/ubo-cosmetic.json')).then(r => r.json())
      .then(d => { ubo = d; })
      .catch(() => { ubo = { sel: [], s: {}, x: {}, rx: [], g: { c: {}, i: {}, o: [] }, gx: {} }; });
  }
  return uboLoading;
}

async function uboOn() {
  const o = await readSettings({ enabled: true, cosmetic: true, uboRules: true });
  return !!o.enabled && !!o.cosmetic && !!o.uboRules;
}

function hostOfUrl(u) {
  try { return new URL(u).hostname; } catch (e) { return ''; }
}
// true for a YouTube frame, or any frame in a YouTube tab
function ytContext(host, sender) {
  return RE_YT.test(host || '') || RE_YT.test(hostOfUrl(sender && sender.tab && sender.tab.url));
}

// uBO hostname keys: every suffix, plus the "entity" forms (example.* / www.example.*)
function uboKeys(host) {
  const parts = String(host || '').toLowerCase().split('.');
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('.'));
  const n = parts.length - 1;
  for (let i = 0; i < n; i++) for (let j = n; j > i; j--) out.push(parts.slice(i, j).join('.') + '.*');
  return out;
}

// {sel: Set, exc: Set} of selector strings (plain and procedural) for a hostname
function uboSpecific(host) {
  const sel = new Set(), exc = new Set();
  for (const k of uboKeys(host)) {
    for (const i of ubo.s[k] || []) sel.add(ubo.sel[i]);
    for (const i of ubo.x[k] || []) exc.add(ubo.sel[i]);
  }
  for (const r of ubo.rx) {
    if (!host.includes(r[0])) continue;
    if (typeof r[1] === 'string') { try { r[1] = new RegExp(r[1]); } catch (e) { r[1] = /$^/; } }
    if (!r[1].test(host)) continue;
    for (const i of r[2]) sel.add(ubo.sel[i]);
    for (const i of r[3]) exc.add(ubo.sel[i]);
  }
  for (const s of exc) sel.delete(s);
  return { sel, exc };
}
function uboGenericExc(host) {
  const out = new Set();
  for (const k of uboKeys(host)) for (const s of ubo.gx[k] || []) out.add(s);
  return out;
}

// uBO scriptlets (set-constant, json-prune, abort-on-property-read, ...) for every site but YouTube.
// The bundles gate themselves by hostname, the same way uBO Lite registers them.
const SCRIPTLET_IDS = ['ubo-scriptlets-main', 'ubo-scriptlets-isolated'];
let scriptletChain = Promise.resolve();
function syncScriptlets() {
  scriptletChain = scriptletChain.then(async () => {
    const o = await readSettings({ enabled: true, uboRules: true, offSites: [] });
    const have = (await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPTLET_IDS })).map(s => s.id);
    if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have });
    if (!o.enabled || !o.uboRules) return;
    const off = (o.offSites || []).filter(h => /^[a-z0-9.-]+$/i.test(h)).slice(0, 500).map(h => `*://${h}/*`);
    const base = {
      matches: ['<all_urls>'], excludeMatches: YT_MATCHES.concat(off), allFrames: true,
      matchOriginAsFallback: true, runAt: 'document_start', persistAcrossSessions: true,
    };
    await chrome.scripting.registerContentScripts([
      Object.assign({ id: SCRIPTLET_IDS[0], js: ['ubo/scriptlets-main.js'], world: 'MAIN' }, base),
      Object.assign({ id: SCRIPTLET_IDS[1], js: ['ubo/scriptlets-isolated.js'], world: 'ISOLATED' }, base),
    ]);
  }).catch(e => chrome.storage.session.set({ scriptletError: String(e && e.message || e) }).catch(() => {}));
  return scriptletChain;
}
chrome.runtime.onInstalled.addListener(syncScriptlets);
chrome.runtime.onStartup.addListener(syncScriptlets);
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'sync' && ['enabled', 'uboRules', 'offSites'].some(k => k in ch)) syncScriptlets();
});

// ----------------------------------------------------------------- stats + SponsorBlock
const key = tabId => 't' + tabId;
const SB_API = 'https://sponsor.ajay.app/api/skipSegments/';
const SB_CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];
let chain = Promise.resolve();      // serialise read-modify-write so reports do not overwrite each other
const sbCache = new Map();

async function sbSegments(id) {
  if (!/^[\w-]{11}$/.test(id)) return [];
  if (sbCache.has(id)) return sbCache.get(id);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  const prefix = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 4);
  const url = SB_API + prefix + '?categories=' + encodeURIComponent(JSON.stringify(SB_CATEGORIES)) +
    '&actionTypes=' + encodeURIComponent('["skip"]');
  const res = await fetch(url);
  let segs = [];
  if (res.ok) {
    const entry = (await res.json()).find(x => x.videoID === id);
    segs = entry ? entry.segments.map(s => ({ s: s.segment[0], e: s.segment[1], c: s.category })) : [];
  } else if (res.status !== 404) {
    return [];                       // transient failure: do not cache
  }
  if (sbCache.size > 200) sbCache.clear();
  sbCache.set(id, segs);
  return segs;
}

// ----------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || !m.type) return;

  if (m.type === 'sb') {
    sbSegments(m.id).then(segs => sendResponse({ segs })).catch(() => sendResponse({ segs: [] }));
    return true;
  }

  if (m.type === 'cosSite') {
    cosLoad().then(() => {
      const exc = excludedFor(m.host);
      const sel = [];
      for (const d of suffixes(m.host)) for (const s of cosSite.s[d] || []) if (!exc.has(s)) sel.push(s);
      const nohide = genericBlockedFor(m.host);
      const always = nohide ? [] : (cosGen.o || []).filter(s => !exc.has(s));
      if (ytContext(m.host, sender)) return sendResponse({ sel, always, nohide });
      // non-YouTube: add uBO's per-site hides and always-on generics, apply uBO's exceptions
      uboOn().then(async live => {
        if (!live) return sendResponse({ sel, always, nohide });
        await uboLoad();
        const u = uboSpecific(m.host);
        const out = new Set(sel.filter(s => !u.exc.has(s)));
        for (const s of u.sel) if (s.charCodeAt(0) !== 0x7B /* { procedural: src/ubo-procedural.js */) out.add(s);
        const gexc = uboGenericExc(m.host);
        const alw = new Set(always.filter(s => !gexc.has(s)));
        if (!nohide) for (const s of ubo.g.o) if (!exc.has(s) && !gexc.has(s)) alw.add(s);
        sendResponse({ sel: [...out], always: [...alw], nohide });
      }).catch(() => sendResponse({ sel, always, nohide }));
    }).catch(() => sendResponse({ sel: [], always: [], nohide: false }));
    return true;
  }

  if (m.type === 'uboProc') {                             // procedural rules for src/ubo-procedural.js
    if (ytContext(m.host, sender)) { sendResponse({ proc: [] }); return; }
    (async () => {
      if (!(await uboOn())) return sendResponse({ proc: [] });
      await uboLoad();
      const proc = [];
      for (const s of uboSpecific(m.host).sel) if (s.charCodeAt(0) === 0x7B) proc.push(s);
      sendResponse({ proc });
    })().catch(() => sendResponse({ proc: [] }));
    return true;
  }

  if (m.type === 'cosGeneric') {
    cosLoad().then(() => {
      if (genericBlockedFor(m.host)) return sendResponse({ sel: [] });
      const exc = excludedFor(m.host);
      const out = new Set();
      for (const t of m.c || []) for (const s of (cosGen.c || {})[t] || []) if (!exc.has(s)) out.add(s);
      for (const t of m.i || []) for (const s of (cosGen.i || {})[t] || []) if (!exc.has(s)) out.add(s);
      if (ytContext(m.host, sender)) return sendResponse({ sel: [...out] });
      uboOn().then(async live => {
        if (!live) return sendResponse({ sel: [...out] });
        await uboLoad();
        const gexc = uboGenericExc(m.host);
        for (const t of m.c || []) for (const s of ubo.g.c[t] || []) if (!exc.has(s)) out.add(s);
        for (const t of m.i || []) for (const s of ubo.g.i[t] || []) if (!exc.has(s)) out.add(s);
        for (const s of gexc) out.delete(s);
        sendResponse({ sel: [...out] });
      }).catch(() => sendResponse({ sel: [...out] }));
    }).catch(() => sendResponse({ sel: [] }));
    return true;
  }

  if (m.type === 'health') {
    (async () => {
      const out = { rulesets: [], counts: {}, available: null, error: '' };
      try { out.rulesets = await chrome.declarativeNetRequest.getEnabledRulesets(); } catch (e) {}
      try { out.available = await chrome.declarativeNetRequest.getAvailableStaticRuleCount(); } catch (e) {}
      try { out.error = (await chrome.storage.session.get('rulesetError')).rulesetError || ''; } catch (e) {}
      try { out.live = (await chrome.storage.session.get('rulesetsLive')).rulesetsLive || []; } catch (e) {}
      try { out.scriptletError = (await chrome.storage.session.get('scriptletError')).scriptletError || ''; } catch (e) {}
      sendResponse(out);
    })();
    return true;
  }

  /* Which of our own rules fired in this tab, with the filter text spelled out.
   * src/yt-recover.js asks for this the first time an error overlay shows on a YouTube page:
   * an overlay over a stream that is still playing almost always means the player's JS threw
   * after a request it wanted was blocked, and this names the rule that did it.
   * getMatchedRules only hands back ids, so the ruleset JSON is read to resolve them. */
  if (m.type === 'ytMatched') {
    (async () => {
      const out = { rules: [] };
      try {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) return sendResponse(out);
        const r = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
        const hits = ((r && r.rulesMatchedInfo) || []).map(x => x.rule).filter(Boolean);
        const bySet = new Map();
        for (const h of hits) {
          if (!h.rulesetId || h.rulesetId === '_dynamic') continue;
          if (!bySet.has(h.rulesetId)) bySet.set(h.rulesetId, new Set());
          bySet.get(h.rulesetId).add(h.ruleId);
        }
        for (const [set, ids] of bySet) {
          const path = RULESET_PATH[set];
          let table = null;
          if (path) {
            try { table = await ruleTable(set, path); } catch (e) { /* unreadable */ }
          }
          for (const rid of ids) {
            const def = table && table.get(rid);
            out.rules.push({
              ruleset: set, id: rid,
              filter: def ? (def.condition && (def.condition.urlFilter || def.condition.regexFilter ||
                        (def.condition.requestDomains || []).join(' ') || '')) : '',
              action: def ? (def.action && def.action.type) : '',
            });
          }
        }
      } catch (e) { out.why = String(e && e.message || e); }
      sendResponse(out);
    })();
    return true;
  }

  if (m.type === 'blocked') {
    (async () => {
      try {
        const r = await chrome.declarativeNetRequest.getMatchedRules({ tabId: m.tabId });
        const rules = (r && r.rulesMatchedInfo) || [];
        const n = rules.filter(x => x.rule && x.rule.rulesetId !== '_dynamic').length;
        sendResponse({ n, supported: true });
      } catch (e) {
        sendResponse({ n: 0, supported: false, why: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (m.type !== 'stats' || !sender.tab) return;
  const tabId = sender.tab.id, slot = sender.frameId + ':' + m.id;
  chain = chain.then(async () => {
    const cur = (await chrome.storage.session.get(key(tabId)))[key(tabId)] || {};
    cur[slot] = m.stats;
    await chrome.storage.session.set({ [key(tabId)]: cur });
    const total = Object.values(cur).reduce((n, s) => n + (s.breaks || 0) + (s.domSkips || 0) + (s.sbSkips || 0) + (s.dvrSkips || 0) + (s.manifestCuts || 0), 0);
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' });
    await chrome.action.setBadgeText({ tabId, text: total ? String(total) : '' });
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(key(tabId)));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    chrome.storage.session.remove(key(tabId));
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
