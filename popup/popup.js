/* Popup: five switches, the master switch, and what is happening on this tab.
 *
 * BOOLS is the whole settings surface. If a switch is not in this list it does not exist -- the
 * feature behind it is either permanently on (request blocking, YouTube player recovery) or
 * removed from the extension. See the README for which is which. */
const DEFAULTS = {
  enabled: true,
  cosmetic: true, cosmeticLists: true, uboRules: true,
  dom: true, sponsorblock: true, dvrSkip: true,
  offSites: [],
};
const BOOLS = ['enabled', 'cosmetic', 'cosmeticLists', 'uboRules', 'dom', 'sponsorblock', 'dvrSkip'];
const $ = id => document.getElementById(id);
let host = '', offSites = [], tabId = null;

const ask = msg => new Promise(res => {
  try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || null); }); }
  catch (e) { res(null); }
});

chrome.storage.sync.get(DEFAULTS, o => {
  for (const k of BOOLS) {
    $(k).checked = !!o[k];
    $(k).addEventListener('change', () => chrome.storage.sync.set({ [k]: $(k).checked }));
  }
  offSites = o.offSites || [];
  paintSite();
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab) return;
  tabId = tab.id;
  try { host = new URL(tab.url).hostname; } catch (e) { host = ''; }
  $('site').disabled = !host;
  paintSite();
  refreshShield();
});

function paintSite() {
  $('site').textContent = offSites.includes(host)
    ? 'Turn back on for ' + host
    : 'Turn off on ' + (host || 'this site');
}
$('site').addEventListener('click', () => {
  offSites = offSites.includes(host) ? offSites.filter(h => h !== host) : [...offSites, host];
  chrome.storage.sync.set({ offSites });
  paintSite();
});

// --------------------------------------------------------------- network status
const RULE_COUNTS = { core: 20307, ads: 20000, ads_extra: 16979 };

async function refreshShield() {
  const h = await ask({ type: 'health' });
  if (h) {
    const live = h.rulesets || [];
    $('rs').textContent = live.length ? live.join(', ') : 'none';
    const n = live.reduce((t, id) => t + (RULE_COUNTS[id] || 0), 0);
    $('rn').textContent = n ? n.toLocaleString() : '0';
    // The row to look at if blocking ever seems to come and go: Chrome enables rule sets only
    // while its static-rule budget lasts, and that budget is shared with every other blocker in
    // the profile, so the set that survives can differ from one browser start to the next.
    $('rerr').textContent = h.error ? h.error : 'none';
    $('rerr').style.color = h.error ? '#f2a65a' : '';
    $('rsnote').textContent = h.error
      ? 'Chrome refused part of the rule set. Its static-rule budget is shared with your other '
        + 'blockers, so running fewer of them is the fix, not more rules.'
      : '';
  }
  if (tabId != null) {
    const b = await ask({ type: 'blocked', tabId });
    $('bl').textContent = b && b.supported ? (b.n + ' in the last 5 min') : 'not counted';
    const c = await new Promise(res => {
      try { chrome.tabs.sendMessage(tabId, { type: 'cosCount' }, r => { void chrome.runtime.lastError; res(r); }); }
      catch (e) { res(null); }
    });
    $('cos').textContent = c && typeof c.n === 'number' ? String(c.n) : '–';
  }
}

// --------------------------------------------------------------- video status
async function refresh() {
  if (tabId == null) return;
  const all = Object.values((await chrome.storage.session.get('t' + tabId))['t' + tabId] || {});
  const sum = f => all.reduce((n, s) => n + (s[f] || 0), 0);
  $('state').textContent = !all.length ? 'no video on this page'
    : all.some(s => s.site) ? 'handling a player ad' : 'watching';
  $('dom_n').textContent = sum('domSkips');
  $('sb').textContent = sum('sbSkips');
  $('dvr').textContent = sum('dvrSkips');
  $('skipped').textContent = sum('skipped') + ' s';
}
refresh();
setInterval(refresh, 1000);
setInterval(refreshShield, 3000);
