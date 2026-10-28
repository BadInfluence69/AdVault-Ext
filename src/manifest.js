/* Manifest ad-break stripping (pure text -> text; no DOM, no network).
 *
 * Server-side ad insertion leaves marks in the stream manifest. For on-demand (VOD) titles this
 * removes the marked ad segments/periods before the player ever requests them, so the player
 * plays programme only -- the same outcome the Hub reaches by cutting chunks.
 *
 *   HLS  (#EXTM3U media playlists with #EXT-X-ENDLIST / PLAYLIST-TYPE:VOD)
 *        #EXT-X-CUE-OUT / CUE-OUT-CONT / CUE-IN spans, CUE-OUT with a duration but no CUE-IN,
 *        DATERANGE with SCTE35-OUT + a program-date-time, and HLS-interstitial DATERANGE tags.
 *   DASH (static MPD)
 *        <Period> elements whose id marks them as an ad; later periods are shifted back.
 *
 * Never touches encrypted media: only the manifest text changes. Live playlists are left alone
 * (removing segments from a sliding window breaks the player's sequence tracking).
 * Safety: if more than half the title would go, the manifest is returned untouched. */
(function (root) {
  'use strict';
  const MAX_SHARE = 0.5;
  const same = text => ({ text, removed: 0, cuts: 0 });

  function attr(line, name) {
    const m = new RegExp('(?:^|[,:])' + name + '=("([^"]*)"|[^,]*)').exec(line);
    return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
  }

  // ---------------------------------------------------------------- HLS ----
  function stripHls(text) {
    if (!/#EXTINF/.test(text) || !/#EXT-X-ENDLIST|#EXT-X-PLAYLIST-TYPE:VOD/.test(text)) return same(text);
    const lines = text.split(/\r?\n/).filter(l => l !== '');

    const ranges = [];                                   // [startMs, endMs] from SCTE-35 date ranges
    for (const l of lines) {
      if (l.startsWith('#EXT-X-DATERANGE:') && /SCTE35-OUT=/.test(l)) {
        const s = Date.parse(attr(l, 'START-DATE'));
        const d = parseFloat(attr(l, 'DURATION') || attr(l, 'PLANNED-DURATION'));
        if (isFinite(s) && d > 0) ranges.push([s, s + d * 1000]);
      }
    }

    const DROP_WITH_AD = /^#EXT-X-(KEY|MAP|SESSION-KEY|BYTERANGE|DISCONTINUITY|PROGRAM-DATE-TIME|GAP)|^#EXTINF:/;
    let inAd = false, adLeft = null, wasAd = false, needDisc = false, keptAny = false;
    let removed = 0, total = 0, cuts = 0, pdt = null, tagsDropped = 0;
    const out = [];
    let buf = [];

    for (const l of lines) {
      if (l.startsWith('#EXT-X-CUE-OUT-CONT')) {
        inAd = true;
        const m = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(l);
        if (m) adLeft = parseFloat(m[2]) - parseFloat(m[1]);
        continue;
      }
      if (l.startsWith('#EXT-X-CUE-OUT')) {
        inAd = true;
        const m = /(\d+(?:\.\d+)?)\s*$/.exec(l.split(':').slice(1).join(':'));
        adLeft = m ? parseFloat(m[1]) : null;
        continue;
      }
      if (l.startsWith('#EXT-X-CUE-IN')) { inAd = false; adLeft = null; continue; }
      if (/^#EXT-(OATCLS-SCTE35|X-SCTE35|X-SPLICEPOINT-SCTE35|X-ASSET)/.test(l) && inAd) continue;
      if (l.startsWith('#EXT-X-DATERANGE:') && (/CLASS="com\.apple\.hls\.interstitial"/.test(l) || /X-ASSET-(URI|LIST)=/.test(l))) { tagsDropped++; continue; }
      if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { pdt = Date.parse(l.slice(25)); buf.push(l); continue; }
      if (l.startsWith('#')) { buf.push(l); continue; }

      // a media URI: decide for the segment described by buf
      const inf = buf.find(x => x.startsWith('#EXTINF:'));
      const dur = inf ? parseFloat(inf.slice(8)) || 0 : 0;
      total += dur;
      const ad = inAd || (pdt !== null && ranges.some(([a, b]) => pdt >= a && pdt < b));
      if (pdt !== null) pdt += dur * 1000;
      if (ad) {
        removed += dur; needDisc = true;
        if (!wasAd) cuts++;
        wasAd = true;
        for (const t of buf) if (!DROP_WITH_AD.test(t)) out.push(t);     // header tags survive
        if (inAd && adLeft !== null) { adLeft -= dur; if (adLeft <= 0.05) { inAd = false; adLeft = null; } }
        buf = [];
        continue;
      }
      wasAd = false;
      if (needDisc && keptAny && !buf.includes('#EXT-X-DISCONTINUITY')) out.push('#EXT-X-DISCONTINUITY');
      needDisc = false; keptAny = true;
      out.push(...buf, l);
      buf = [];
    }
    out.push(...buf);

    if ((!removed && !tagsDropped) || removed > MAX_SHARE * total) return same(text);
    return { text: out.join('\n') + '\n', removed, cuts: cuts + tagsDropped };
  }

  // --------------------------------------------------------------- DASH ----
  function isoToSec(s) {
    const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s || '');
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return (parseFloat(m[1] || 0) * 3600) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0);
  }
  const secToIso = s => 'PT' + Math.max(0, s).toFixed(3) + 'S';
  const AD_ID = /(^|[^a-z0-9])ads?([^a-z]|$)/i;

  function stripMpd(text) {
    if (!/<MPD\b/.test(text) || /<MPD\b[^>]*\btype="dynamic"/.test(text)) return same(text);
    const re = /<Period\b[^>]*?(?:\/>|>[\s\S]*?<\/Period>)/g;
    const ps = [];
    let m;
    while ((m = re.exec(text))) {
      const head = /^<Period\b[^>]*>/.exec(m[0])[0];
      const g = n => { const x = new RegExp('\\b' + n + '="([^"]*)"').exec(head); return x ? x[1] : null; };
      ps.push({ s: m.index, e: m.index + m[0].length, raw: m[0], head, id: g('id'), start: isoToSec(g('start')), dur: isoToSec(g('duration')) });
    }
    if (ps.length < 2 || !ps.some(p => p.id && AD_ID.test(p.id)) || ps.every(p => p.id && AD_ID.test(p.id))) return same(text);

    // every removed period needs a known length, or the timeline cannot be repaired
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.ad = !!(p.id && AD_ID.test(p.id));
      if (p.dur === null && ps[i + 1] && p.start !== null && ps[i + 1].start !== null) p.dur = ps[i + 1].start - p.start;
      if (p.ad && p.dur === null) return same(text);
    }
    const adTotal = ps.filter(p => p.ad).reduce((n, p) => n + p.dur, 0);
    const all = ps.reduce((n, p) => n + (p.dur || 0), 0);
    if (all && adTotal > MAX_SHARE * all) return same(text);

    let out = '', pos = 0, shift = 0, cuts = 0, prevAd = false;
    for (const p of ps) {
      out += text.slice(pos, p.s);
      pos = p.e;
      if (p.ad) { shift += p.dur; if (!prevAd) cuts++; prevAd = true; continue; }
      prevAd = false;
      let raw = p.raw;
      if (shift > 0 && p.start !== null) raw = raw.replace(p.head, p.head.replace(/\bstart="[^"]*"/, 'start="' + secToIso(p.start - shift) + '"'));
      out += raw;
    }
    out += text.slice(pos);
    out = out.replace(/(<MPD\b[^>]*\bmediaPresentationDuration=")([^"]*)(")/, (all2, a, d, z) => {
      const s = isoToSec(d);
      return s === null ? all2 : a + secToIso(s - shift) + z;
    });
    return { text: out, removed: shift, cuts };
  }

  /** text of any manifest -> {text, removed (seconds), cuts (number of breaks)} */
  function rewrite(text) {
    if (typeof text !== 'string') return same(text);
    if (/^\s*#EXTM3U/.test(text)) return stripHls(text);
    if (/<MPD\b/.test(text)) return stripMpd(text);
    return same(text);
  }

  const api = { rewrite, stripHls, stripMpd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AdGuardManifest = api;
})(typeof self !== 'undefined' ? self : this);
