/* Ad Guard engine -- the Hub's ad detector (hub/services/ad_detect.py), re-cast for live playback.
 *
 * Same signature per media second as the Hub: 64-bin colour histogram, luma, motion,
 * spectral centroid / flatness / rolloff, RMS. Same distance, same robust z-scoring,
 * same test: a break is material that (a) departs sharply from the programme and
 * (b) is followed by the programme RESUMING -- "same before, same after, different inside".
 *
 * Difference from the Hub: the Hub reads ahead of the viewer and cuts chunks. A browser
 * cannot read ahead, so the engine works as a state machine over seconds as they play:
 *   watch --departure--> ad   (caller fast-forwards + mutes)
 *   ad --programme profile matches again--> watch   (caller seeks back to the resume point)
 *   ad --MAX_SUSPECT seconds without a return--> watch  (it was programme: caller rewinds)
 *
 * Pure logic, no DOM: feed(second, hist, scalars) returns events. */
(function (root) {
  'use strict';

  const C = {
    FW: 32, FH: 18,
    WIN: 3,               // seconds each side of a boundary probe (Hub: 6; shorter = reacts sooner)
    CTX: 25,              // seconds of programme compared before a departure
    MIN_LEN: 8,           // shortest break
    MAX_SUSPECT: 180,     // a "break" that lasts this long was programme after all
    MIN_HISTORY: 120,     // warm-up (Hub: 120 s): until then the average is not yet "the programme"
    CONTRAST_MIN: 0.70,   // same as the Hub
    OUTLIER_MIN: 0.2,     // same as the Hub
    PROBE_FLOOR: 0.35,    // same as the Hub
    MATCH_MAX: 0.45,      // distance to the programme profile that counts as "it is back"
    MAX_SHARE: 0.40,      // never skip more than this share of what has been played
    SHARE_FLOOR: 600,     // ...judged against at least this many seconds
    HISTORY: 1200,        // seconds kept
    COOLDOWN: 20,         // seconds after a break before the next departure is considered
  };
  const NH = 64, NS = 6;

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /* ------------------------------------------------------------ features ---- */
  /** RGBA pixels of an FWxFH frame -> {hist (64 bins, sums to 1), luma 0..1} */
  function frameFeatures(rgba) {
    const hist = new Float64Array(NH);
    let luma = 0;
    const n = rgba.length / 4;
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      hist[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)] += 1;
      luma += r * 3 + g * 6 + b;
    }
    for (let k = 0; k < NH; k++) hist[k] /= n;
    return { hist, luma: luma / (10 * n * 255) };
  }

  /** mean absolute difference of the red channel of two RGBA frames, 0..1 */
  function motion(a, b) {
    let s = 0;
    const n = a.length / 4;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]);
    return s / (n * 255);
  }

  /** One analyser reading -> [centroid(log10(1+Hz)), flatness, rolloff(log10(1+Hz)), rmsDb]
   *  freqDb: Float32 dB magnitudes (AnalyserNode.getFloatFrequencyData), td: time-domain samples. */
  function audioFeatures(freqDb, td, sampleRate) {
    const bins = freqDb.length, hz = sampleRate / 2 / bins;
    const top = Math.min(bins, Math.floor(8000 / hz));      // the Hub resamples to 16 kHz mono
    let sum = 0, wsum = 0, logsum = 0, cnt = 0;
    const p = new Float64Array(top);
    for (let k = 1; k < top; k++) {
      const m = Math.pow(10, (isFinite(freqDb[k]) ? freqDb[k] : -160) / 20);
      const pw = m * m + 1e-20;
      p[k] = pw; sum += pw; wsum += pw * k * hz; logsum += Math.log(pw); cnt++;
    }
    let centroid = 0, flat = 0, roll = 0;
    if (cnt > 0 && sum > 1e-18) {
      centroid = wsum / sum;
      flat = Math.exp(logsum / cnt) / (sum / cnt);
      let acc = 0;
      for (let k = 1; k < top; k++) { acc += p[k]; if (acc >= 0.85 * sum) { roll = k * hz; break; } }
    }
    let e = 0;
    for (let i = 0; i < td.length; i++) e += td[i] * td[i];
    const rms = td.length ? Math.sqrt(e / td.length) : 0;
    return [Math.log10(1 + centroid), clamp(flat, 0, 1), Math.log10(1 + roll), rms > 1e-5 ? 20 * Math.log10(rms) : -90];
  }

  /* -------------------------------------------------------------- series ---- */
  /** Per-second signatures with O(dims) window means via prefix sums (ad_detect._Series). */
  class Series {
    constructor() { this.clear(); }
    clear() {
      this.times = []; this.h = []; this.s = []; this.z = [];
      this.ph = [new Float64Array(NH)]; this.pz = [new Float64Array(NS)];
      this.stats = null; this.since = 0;
    }
    get n() { return this.times.length; }

    push(t, h, s) {
      this.times.push(t); this.h.push(h); this.s.push(s); this.since++;
      if (this.n > 2 * C.HISTORY) {
        const drop = this.n - C.HISTORY;
        this.times.splice(0, drop); this.h.splice(0, drop); this.s.splice(0, drop);
        this._rebuild();
      } else if (!this.stats || this.since >= 15 || this.n === 30 || this.n === 120) {
        this._rebuild();
      } else {
        const z = this._z(s);
        this.z.push(z);
        this._extend(h, z);
      }
    }

    _z(row) {
      const out = new Float64Array(NS);
      for (let k = 0; k < NS; k++) out[k] = clamp((row[k] - this.stats[k][0]) / this.stats[k][1], -4, 4);
      return out;
    }
    _extend(h, z) {
      const ph = new Float64Array(NH), pz = new Float64Array(NS);
      const lh = this.ph[this.ph.length - 1], lz = this.pz[this.pz.length - 1];
      for (let k = 0; k < NH; k++) ph[k] = lh[k] + h[k];
      for (let k = 0; k < NS; k++) pz[k] = lz[k] + z[k];
      this.ph.push(ph); this.pz.push(pz);
    }
    _rebuild() {
      this.since = 0;
      const rows = this.s.slice(-C.HISTORY), st = [];
      for (let k = 0; k < NS; k++) {
        const col = rows.map(r => r[k]), sorted = col.slice().sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1];
        const mad = col.map(x => Math.abs(x - med)).sort((a, b) => a - b)[col.length >> 1] * 1.4826;
        st.push([med, Math.max(mad, 0.05 * (sorted[sorted.length - 1] - sorted[0]), 1e-6)]);
      }
      this.stats = st;
      this.z = []; this.ph = [new Float64Array(NH)]; this.pz = [new Float64Array(NS)];
      for (let i = 0; i < this.n; i++) { const z = this._z(this.s[i]); this.z.push(z); this._extend(this.h[i], z); }
    }

    /** drop every sample whose time is >= t */
    truncateFrom(t) {
      let i = this.times.findIndex(x => x >= t);
      if (i < 0) return;
      this.times.length = this.h.length = this.s.length = this.z.length = i;
      this.ph.length = this.pz.length = i + 1;
    }
    /** remove samples [a, b) -- the break is stitched out of the history */
    cut(a, b) {
      a = Math.max(0, a); b = Math.min(this.n, b);
      if (b <= a) return;
      this.times.splice(a, b - a); this.h.splice(a, b - a); this.s.splice(a, b - a);
      if (this.n) this._rebuild(); else this.clear();
    }

    mean(a, b) {
      a = Math.max(0, a); b = Math.min(this.n, b);
      if (b <= a) return null;
      const w = b - a, h = new Float64Array(NH), z = new Float64Array(NS);
      for (let k = 0; k < NH; k++) h[k] = (this.ph[b][k] - this.ph[a][k]) / w;
      for (let k = 0; k < NS; k++) z[k] = (this.pz[b][k] - this.pz[a][k]) / w;
      return { h, z };
    }
    static dist(p, q) {
      if (!p || !q) return 0;
      let h = 0, s = 0;
      for (let k = 0; k < NH; k++) h += Math.abs(p.h[k] - q.h[k]);
      for (let k = 0; k < NS; k++) s += Math.abs(p.z[k] - q.z[k]);
      return 1.5 * (0.5 * h) + 0.5 * (s / NS);
    }
  }

  const median = arr => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

  /* -------------------------------------------------------------- engine ---- */
  class Engine {
    constructor(opts) {
      this.o = Object.assign({}, C, opts || {});
      this.ser = new Series();
      this.state = 'watch';
      this.last = null;            // media second of the latest sample
      this.suspended = false;
      this.probes = [];
      this.adStart = 0; this.adIdx = 0; this.prog = null;
      this.blockUntil = -Infinity;
      this.safe = [];              // [start, end] stretches judged to be programme: never re-trigger
      this.cuts = [];              // confirmed breaks [start, end]
      this.skipped = 0; this.played = 0;
    }

    suspend() { this.suspended = true; }
    resume() { this.suspended = false; this.last = null; }
    status() {
      return { state: this.state, breaks: this.cuts.length, skipped: Math.round(this.skipped), history: this.ser.n };
    }

    /** One media second of signatures. maxGap: largest forward step that still counts as playing on.
     *  -> [{type: 'enter'|'exit'|'abort'|'cancel', ...}] */
    feed(t, hist, scalars, maxGap) {
      const ev = [];
      if (this.suspended) return ev;
      const gap = maxGap || 3;
      if (this.last !== null) {
        if (t === this.last) return ev;
        if (t < this.last) {
          this.ser.truncateFrom(t);
          if (this.state === 'ad' && t <= this.adStart) { this.state = 'watch'; ev.push({ type: 'cancel', at: t }); }
        } else if (t - this.last > gap) {
          this.ser.clear(); this.probes = [];
          if (this.state === 'ad') { this.state = 'watch'; ev.push({ type: 'cancel', at: t }); }
        }
      }
      this.ser.push(t, hist, scalars);
      this.last = t; this.played++;
      const r = this.state === 'ad' ? this._inAd(t) : this._inProgramme(t);
      if (r) ev.push(r);
      return ev;
    }

    _inProgramme(t) {
      const o = this.o, ser = this.ser, n = ser.n, W = o.WIN;
      if (n < 2 * W + 2) return null;
      const b = n - W;
      const probe = Series.dist(ser.mean(b - W, b), ser.mean(b, n));
      this.probes.push(probe);
      if (this.probes.length > 600) this.probes.shift();
      if (ser.times[b] - ser.times[0] < o.MIN_HISTORY || ser.times[b] < this.blockUntil) return null;
      if (probe < Math.max(o.PROBE_FLOOR, 2 * median(this.probes))) return null;
      // the boundary is where the change is sharpest within the window just read
      let at = b, best = -1;
      for (let j = Math.max(W, b - W); j <= n - 2; j++) {
        const d = Series.dist(ser.mean(j - W, j), ser.mean(j, n));
        if (d > best) { best = d; at = j; }
      }
      const start = ser.times[at];
      if (this.safe.some(([a, z]) => start >= a - 3 && start <= z + 3)) return null;
      const pre = ser.mean(at - o.CTX, at), post = ser.mean(at, n), overall = ser.mean(0, n);
      if (!pre || at < 8 || Series.dist(pre, post) < o.CONTRAST_MIN) return null;
      if (Series.dist(post, overall) - Series.dist(pre, overall) < o.OUTLIER_MIN) return null;
      if (this.skipped > o.MAX_SHARE * Math.max(this.played, o.SHARE_FLOOR)) return null;
      this.state = 'ad'; this.adStart = start; this.adIdx = at; this.prog = pre;
      return { type: 'enter', start, at: t };
    }

    _inAd(t) {
      const o = this.o, ser = this.ser, n = ser.n, W = o.WIN;
      const len = t - this.adStart;
      if (len >= o.MIN_LEN && n > W && Series.dist(ser.mean(n - W, n), this.prog) <= o.MATCH_MAX) {
        // the programme is back: it began at the earliest recent second that already matches
        let r = n - W;
        for (let j = Math.max(this.adIdx + 1, n - 2 * W); j <= n - W; j++) {
          if (Series.dist(ser.mean(j, Math.min(n, j + W)), this.prog) <= o.MATCH_MAX) { r = j; break; }
        }
        const end = ser.times[r];
        this.state = 'watch';
        this.cuts.push([this.adStart, end]);
        this.skipped += end - this.adStart;
        ser.cut(this.adIdx, r);                       // stitch the break out of the history
        this.blockUntil = end + o.COOLDOWN;
        return { type: 'exit', start: this.adStart, end, at: t };
      }
      if (len >= o.MAX_SUSPECT) {
        this.state = 'watch';
        this.safe.push([this.adStart, t]);
        this.blockUntil = t + o.COOLDOWN;
        return { type: 'abort', start: this.adStart, at: t };
      }
      return null;
    }
  }

  const api = { C, Series, Engine, frameFeatures, motion, audioFeatures, NH, NS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AdGuardEngine = api;
})(typeof self !== 'undefined' ? self : this);
