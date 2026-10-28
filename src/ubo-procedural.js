/* uBO procedural cosmetic filtering, for every site except YouTube.
 *
 * Ported from uBlock Origin Lite's css-procedural.js + css-procedural-api.js (GPLv3,
 * https://github.com/gorhill/uBlock). Handles the filters plain CSS cannot express:
 * :has-text(), :upward(), :xpath(), :matches-css(), :matches-attr(), :others(), :shadow() ...,
 * plus the style / remove / remove-attr / remove-class actions and @media-scoped rules.
 *
 * Differences from uBOL: rules come from the background worker ('uboProc', backed by
 * data/ubo-cosmetic.json built by tools/port_ubo.py) instead of chrome.storage, and CSS goes into
 * this frame's own constructable stylesheet instead of chrome.scripting.insertCSS. Follows the
 * extension's switches (enabled / per-site off / cosmetic / uboRules).
 *
 * Never runs in a YouTube frame or in a frame below one: YouTube is the extension's own logic. */
(() => {
  'use strict';
  const Sx = self.AdGuardSettings;
  if (!Sx || self.__agUboProc) return;
  self.__agUboProc = true;

  const RE_YT = /(^|\.)(youtube(-nocookie|kids|education)?\.[a-z.]+|youtu\.be|ytimg\.com|googlevideo\.com)$/;
  function underYouTube() {
    if (RE_YT.test(location.hostname)) return true;
    try {
      const ao = location.ancestorOrigins;
      if (ao) for (let i = 0; i < ao.length; i++) if (RE_YT.test(new URL(ao[i]).hostname)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  if (underYouTube()) return;

  // ------------------------------------------------------------ stylesheet ----
  let sheet = null;
  const cssRules = [];                               // texts currently wanted in the sheet
  function sheetInsert(text) {
    cssRules.push(text);
    if (!sheet) {
      try {
        sheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      } catch (e) { sheet = null; return; }
    }
    try { sheet.insertRule(text, sheet.cssRules.length); } catch (e) { /* a rule Chrome rejects */ }
  }
  function sheetClear() {
    cssRules.length = 0;
    if (sheet) try { sheet.replaceSync(''); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ helpers ----
  const nonVisualElements = { head: true, link: true, meta: true, script: true, style: true };

  const regexFromString = (s, exact = false) => {
    if (s === '') return /^/;
    const match = /^\/(.+)\/([imu]*)$/.exec(s);
    if (match !== null) return new RegExp(match[1], match[2] || undefined);
    const reStr = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(exact ? `^${reStr}$` : reStr);
  };

  const randomToken = () => {
    const n = Math.random();
    return String.fromCharCode(n * 25 + 97) +
      Math.floor((0.25 + n * 0.75) * Number.MAX_SAFE_INTEGER).toString(36).slice(-8);
  };

  // ------------------------------------------------------------ tasks ----
  class PSelectorTask {
    destructor() {}
    begin() {}
    end() {}
  }

  class PSelectorVoidTask extends PSelectorTask {
    transpose() {}
  }

  class PSelectorHasTextTask extends PSelectorTask {
    constructor(filterer, task) { super(); this.needle = regexFromString(task[1]); }
    transpose(node, output) { if (this.needle.test(node.textContent)) output.push(node); }
  }

  class PSelectorIfTask extends PSelectorTask {
    constructor(filterer, task) { super(); this.pselector = new PSelector(filterer, task[1]); this.target = true; }
    transpose(node, output) { if (this.pselector.test(node) === this.target) output.push(node); }
  }
  class PSelectorIfNotTask extends PSelectorIfTask {
    constructor(filterer, task) { super(filterer, task); this.target = false; }
  }

  class PSelectorMatchesAttrTask extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.reAttr = regexFromString(task[1].attr, true);
      this.reValue = regexFromString(task[1].value, true);
    }
    transpose(node, output) {
      if (typeof node.getAttributeNames !== 'function') return;
      for (const attr of node.getAttributeNames()) {
        if (this.reAttr.test(attr) === false) continue;
        if (this.reValue.test(node.getAttribute(attr)) === false) continue;
        output.push(node);
      }
    }
  }

  class PSelectorMatchesCSSTask extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.name = task[1].name;
      this.pseudo = task[1].pseudo ? `::${task[1].pseudo}` : null;
      let arg0 = task[1].value, arg1;
      if (Array.isArray(arg0)) { arg1 = arg0[1]; arg0 = arg0[0]; }
      this.value = new RegExp(arg0, arg1);
    }
    transpose(node, output) {
      const style = window.getComputedStyle(node, this.pseudo);
      if (style !== null && this.value.test(style[this.name])) output.push(node);
    }
  }
  class PSelectorMatchesCSSAfterTask extends PSelectorMatchesCSSTask {
    constructor(filterer, task) { super(filterer, task); this.pseudo = '::after'; }
  }
  class PSelectorMatchesCSSBeforeTask extends PSelectorMatchesCSSTask {
    constructor(filterer, task) { super(filterer, task); this.pseudo = '::before'; }
  }

  class PSelectorMatchesMediaTask extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.filterer = filterer;
      this.mql = window.matchMedia(task[1]);
      if (this.mql.media === 'not all') return;
      this.boundHandler = () => { if (this.filterer) this.filterer.domChanged(); };
      this.mql.addEventListener('change', this.boundHandler);
    }
    destructor() { if (this.boundHandler) this.mql.removeEventListener('change', this.boundHandler); }
    transpose(node, output) { if (this.mql.matches) output.push(node); }
  }

  class PSelectorMatchesPathTask extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.needle = regexFromString(task[1].replace(/\P{ASCII}/gu, s => encodeURIComponent(s)));
    }
    transpose(node, output) {
      if (this.needle.test(self.location.pathname + self.location.search)) output.push(node);
    }
  }

  class PSelectorMatchesPropTask extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.props = task[1].attr.split('.');
      this.reValue = task[1].value !== '' ? regexFromString(task[1].value, true) : null;
    }
    transpose(node, output) {
      let value = node;
      for (const prop of this.props) {
        if (value === undefined || value === null) return;
        value = value[prop];
      }
      if (this.reValue === null) { if (value === undefined) return; }
      else if (this.reValue.test(value) === false) return;
      output.push(node);
    }
  }

  class PSelectorMinTextLengthTask extends PSelectorTask {
    constructor(filterer, task) { super(); this.min = task[1]; }
    transpose(node, output) { if (node.textContent.length >= this.min) output.push(node); }
  }

  class PSelectorOthersTask extends PSelectorTask {
    constructor() { super(); this.targets = new Set(); }
    begin() { this.targets.clear(); }
    end(output) {
      const toKeep = new Set(this.targets);
      const toDiscard = new Set();
      const body = document.body, head = document.head;
      let discard = null;
      for (let keep of this.targets) {
        while (keep !== null && keep !== body && keep !== head) {
          toKeep.add(keep);
          toDiscard.delete(keep);
          for (discard = keep.previousElementSibling; discard !== null; discard = discard.previousElementSibling) {
            if (nonVisualElements[discard.localName] !== true && toKeep.has(discard) === false) toDiscard.add(discard);
          }
          for (discard = keep.nextElementSibling; discard !== null; discard = discard.nextElementSibling) {
            if (nonVisualElements[discard.localName] !== true && toKeep.has(discard) === false) toDiscard.add(discard);
          }
          keep = keep.parentElement;
        }
      }
      for (discard of toDiscard) output.push(discard);
      this.targets.clear();
    }
    transpose(candidate) {
      for (const target of this.targets) {
        if (target.contains(candidate)) return;
        if (candidate.contains(target)) this.targets.delete(target);
      }
      this.targets.add(candidate);
    }
  }

  const openOrClosedShadowRoot = (typeof chrome === 'object' && chrome && chrome.dom &&
    typeof chrome.dom.openOrClosedShadowRoot === 'function')
    ? n => chrome.dom.openOrClosedShadowRoot(n)
    : n => n.openOrClosedShadowRoot || n.shadowRoot || null;

  class PSelectorShadowTask extends PSelectorTask {
    constructor(filterer, task) { super(); this.selector = task[1]; }
    transpose(node, output) {
      const root = openOrClosedShadowRoot(node);
      if (!root) return;
      output.push(...root.querySelectorAll(this.selector));
    }
  }

  // Prepend `:scope ` if needed (AdguardTeam/ExtendedCss#31).
  class PSelectorSpathTask extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.spath = task[1];
      this.nth = /^(?:\s*[+~]|:)/.test(this.spath);
      if (this.nth) return;
      if (/^\s*>/.test(this.spath)) this.spath = `:scope ${this.spath.trim()}`;
    }
    transpose(node, output) {
      const nodes = this.nth ? PSelectorSpathTask.qsa(node, this.spath) : node.querySelectorAll(this.spath);
      for (const n of nodes) output.push(n);
    }
    static qsa(node, selector) {
      const parent = node.parentElement;
      if (parent === null) return [];
      let pos = 1;
      for (let n = node.previousElementSibling; n !== null; n = n.previousElementSibling) pos += 1;
      return parent.querySelectorAll(`:scope > :nth-child(${pos})${selector}`);
    }
  }

  class PSelectorUpwardTask extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.i = 0; this.s = '';
      if (typeof task[1] === 'number') this.i = task[1]; else this.s = task[1];
    }
    transpose(node, output) {
      if (this.s !== '') {
        const parent = node.parentElement;
        if (parent === null) return;
        node = parent.closest(this.s);
        if (node === null) return;
      } else {
        let nth = this.i;
        for (;;) {
          node = node.parentElement;
          if (node === null) return;
          nth -= 1;
          if (nth <= 0) break;
        }
      }
      output.push(node);
    }
  }

  class PSelectorWatchAttrs extends PSelectorTask {
    constructor(filterer, task) {
      super();
      this.filterer = filterer;
      this.observer = null;
      this.observed = new WeakSet();
      this.observerOptions = { attributes: true, subtree: true };
      if (Array.isArray(task[1]) && task[1].length !== 0) this.observerOptions.attributeFilter = task[1];
    }
    destructor() {
      if (this.observer) { this.observer.takeRecords(); this.observer.disconnect(); this.observer = null; }
    }
    transpose(node, output) {
      output.push(node);
      if (!this.filterer || this.observed.has(node)) return;
      if (this.observer === null) this.observer = new MutationObserver(() => this.filterer.domChanged());
      this.observer.observe(node, this.observerOptions);
      this.observed.add(node);
    }
  }

  class PSelectorXpathTask extends PSelectorTask {
    constructor(filterer, task) { super(); this.xpe = document.createExpression(task[1], null); this.xpr = null; }
    transpose(node, output) {
      this.xpr = this.xpe.evaluate(node, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, this.xpr);
      let j = this.xpr.snapshotLength;
      while (j--) {
        const n = this.xpr.snapshotItem(j);
        if (n.nodeType === 1) output.push(n);
      }
    }
  }

  // ------------------------------------------------------------ selectors ----
  class PSelector {
    constructor(filterer, o) {
      this.selector = o.selector;
      this.tasks = [];
      if (Array.isArray(o.tasks) === false) return;
      for (const task of o.tasks) {
        const Ctor = OPERATORS.get(task[0]) || PSelectorVoidTask;
        this.tasks.push(new Ctor(filterer, task));
      }
    }
    destructor() { for (const t of this.tasks) t.destructor(); }
    prime(input) {
      const root = input || document;
      if (this.selector === '') return [root];
      if (input && input !== document) {
        const c0 = this.selector.charCodeAt(0);
        if (c0 === 0x2B /* + */ || c0 === 0x7E /* ~ */) return Array.from(PSelectorSpathTask.qsa(input, this.selector));
        if (c0 === 0x3E /* > */) return Array.from(input.querySelectorAll(`:scope ${this.selector}`));
      }
      return Array.from(root.querySelectorAll(this.selector));
    }
    exec(input) {
      let nodes = this.prime(input);
      for (const task of this.tasks) {
        if (nodes.length === 0) break;
        const transposed = [];
        task.begin();
        for (const node of nodes) task.transpose(node, transposed);
        task.end(transposed);
        nodes = transposed;
      }
      return nodes;
    }
    test(input) {
      for (const node of this.prime(input)) {
        let output = [node];
        for (const task of this.tasks) {
          const transposed = [];
          task.begin();
          for (const n of output) task.transpose(n, transposed);
          task.end(transposed);
          output = transposed;
          if (output.length === 0) break;
        }
        if (output.length !== 0) return true;
      }
      return false;
    }
  }

  const OPERATORS = new Map([
    ['has', PSelectorIfTask], ['has-text', PSelectorHasTextTask], ['if', PSelectorIfTask],
    ['if-not', PSelectorIfNotTask], ['matches-attr', PSelectorMatchesAttrTask],
    ['matches-css', PSelectorMatchesCSSTask], ['matches-css-after', PSelectorMatchesCSSAfterTask],
    ['matches-css-before', PSelectorMatchesCSSBeforeTask], ['matches-media', PSelectorMatchesMediaTask],
    ['matches-path', PSelectorMatchesPathTask], ['matches-prop', PSelectorMatchesPropTask],
    ['min-text-length', PSelectorMinTextLengthTask], ['not', PSelectorIfNotTask],
    ['others', PSelectorOthersTask], ['shadow', PSelectorShadowTask], ['spath', PSelectorSpathTask],
    ['upward', PSelectorUpwardTask], ['watch-attr', PSelectorWatchAttrs], ['xpath', PSelectorXpathTask],
  ]);

  class PSelectorRoot extends PSelector {
    constructor(filterer, o) {
      super(filterer, o);
      this.budget = 200;                             // ms of work allowed per selector, refilled over time
      this.raw = o.raw;
      this.lastAllowanceTime = 0;
      this.action = o.action;
    }
    prime(input) { try { return super.prime(input); } catch (e) { return []; } }
    exec(input) { try { return super.exec(input); } catch (e) { return []; } }
  }

  // ------------------------------------------------------------ filterer ----
  class ProceduralFilterer {
    constructor(hideStyle) {
      this.selectors = [];
      this.styleTokenMap = new Map();
      this.styledNodes = new Set();
      this.timer = undefined;
      this.hideStyle = hideStyle;
      this.observer = new MutationObserver(muts => {
        for (const m of muts) {
          for (const n of m.addedNodes) if (n.nodeType === 1) return this.domChanged();
          for (const n of m.removedNodes) if (n.nodeType === 1) return this.domChanged();
        }
      });
      this.observer.observe(document, { childList: true, subtree: true });
    }
    destroy() {
      this.observer.takeRecords();
      this.observer.disconnect();
      if (this.timer !== undefined) { cancelAnimationFrame(this.timer); this.timer = undefined; }
      for (const p of this.selectors) p.destructor();
      this.selectors.length = 0;
      for (const token of this.styleTokenMap.values()) for (const el of this.styledNodes) el.removeAttribute(token);
      this.styleTokenMap.clear();
      this.styledNodes.clear();
    }
    addSelectors(list) {
      for (const o of list) {
        const p = new PSelectorRoot(this, o);
        if (p.action === undefined) this.styleTokenFromStyle(this.hideStyle);
        else if (p.action[0] === 'style') this.styleTokenFromStyle(p.action[1]);
        this.selectors.push(p);
      }
      this.commit();
    }
    commit() {
      if (this.timer !== undefined) { cancelAnimationFrame(this.timer); this.timer = undefined; }
      // be ready to unhide nodes which no longer match (uBlock-issues#341)
      const toUnstyle = this.styledNodes;
      this.styledNodes = new Set();
      let t0 = Date.now();
      for (const p of this.selectors) {
        const allowance = Math.floor((t0 - p.lastAllowanceTime) / 2000);
        if (allowance >= 1) {
          p.budget = Math.min(200, p.budget + allowance * 50);
          p.lastAllowanceTime = t0;
        }
        if (p.budget <= 0) continue;
        const nodes = p.exec();
        const t1 = Date.now();
        p.budget += t0 - t1;
        if (p.budget < -500) p.budget = -0x7FFFFFFF;   // too slow on this page: retire it
        t0 = t1;
        if (nodes.length !== 0) this.processNodes(nodes, p.action);
      }
      const tokens = Array.from(this.styleTokenMap.values());
      for (const node of toUnstyle) {
        if (this.styledNodes.has(node)) continue;
        for (const token of tokens) node.removeAttribute(token);
      }
    }
    styleTokenFromStyle(style) {
      if (style === undefined) return;
      let token = this.styleTokenMap.get(style);
      if (token !== undefined) return token;
      token = randomToken();
      this.styleTokenMap.set(style, token);
      sheetInsert(`[${token}]{${style}}`);
      return token;
    }
    processNodes(nodes, action) {
      const op = (action && action[0]) || '';
      const arg = op !== '' ? action[1] : '';
      switch (op) {
        case '':
        case 'style': {
          const token = this.styleTokenFromStyle(arg === '' ? this.hideStyle : arg);
          for (const node of nodes) { node.setAttribute(token, ''); this.styledNodes.add(node); }
          break;
        }
        case 'remove':
          for (const node of nodes) { node.remove(); node.textContent = ''; }
          break;
        case 'remove-attr': {
          const re = regexFromString(arg, true);
          for (const node of nodes) for (const name of node.getAttributeNames()) if (re.test(name)) node.removeAttribute(name);
          break;
        }
        case 'remove-class': {
          const re = regexFromString(arg, true);
          for (const node of nodes) for (const name of Array.from(node.classList)) if (re.test(name)) node.classList.remove(name);
          break;
        }
        default:
          break;
      }
    }
    domChanged() {
      if (this.timer !== undefined) return;
      this.timer = requestAnimationFrame(() => { this.timer = undefined; this.commit(); });
    }
  }

  // Declarative procedurals (pure style / @media) become plain CSS -- same as uBOL's cssRuleFromProcedural.
  function cssFromDeclarative(d, hideBody) {
    const { tasks, action } = d;
    let mq, selector, style;
    if (Array.isArray(tasks)) {
      if (tasks[0][0] !== 'matches-media') return;
      mq = tasks[0][1];
      if (tasks.length > 2) return;
      if (tasks.length === 2) {
        if (tasks[1][0] !== 'spath') return;
        selector = tasks[1][1];
      }
    }
    if (Array.isArray(action)) {
      if (action[0] !== 'style') return;
      selector = selector || d.selector;
      style = action[1];
    }
    if (mq === undefined && style === undefined && selector === undefined) return;
    if (mq === undefined) return `${selector}{${style}}`;
    if (style === undefined) return `@media ${mq}{${selector || d.selector}{${hideBody}}}`;
    return `@media ${mq}{${selector}{${style}}}`;
  }

  // ------------------------------------------------------------ wiring ----
  let filterer = null, rules = null, applied = false;

  function ask(msg) {
    return new Promise(res => {
      try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || null); }); }
      catch (e) { res(null); }
    });
  }

  async function loadRules() {
    if (rules) return rules;
    const r = await ask({ type: 'uboProc', host: location.hostname });
    rules = [];
    for (const raw of (r && r.proc) || []) {
      try { const o = JSON.parse(raw); o.raw = raw; rules.push(o); } catch (e) { /* malformed entry */ }
    }
    return rules;
  }

  // One hiding style now that the stealth mode is gone (see the note at the top of cosmetic.js).
  function hideStyleFor() {
    return 'display:none!important;';
  }

  function teardown() {
    if (filterer) { filterer.destroy(); filterer = null; }
    sheetClear();
    applied = false;
  }

  async function apply(cur) {
    const list = await loadRules();
    if (!wanted(Sx.cur)) return;                   // switched off while we were waiting
    teardown();
    applied = true;
    if (!list.length) return;
    const hide = hideStyleFor(cur);
    for (const d of list) {
      if (!d.cssable) continue;
      const css = cssFromDeclarative(d, hide);
      if (css) sheetInsert(css);
    }
    const procedurals = list.filter(d => d.cssable === undefined);
    if (procedurals.length) {
      filterer = new ProceduralFilterer(hide);
      filterer.addSelectors(procedurals);
    }
  }

  const wanted = cur => !!(cur.active && cur.cosmetic && cur.uboRules !== false);
  Sx.onChange(cur => {
    if (wanted(cur)) {
      if (!applied) apply(cur);
    } else if (applied) {
      teardown();
    }
  });
})();
