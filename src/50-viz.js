/* =========================================================================
 * WASEL ER Command Dashboard · 50-viz.js
 * Data views drawn from recorded board state only (nothing is fabricated):
 *   1. System status strip in the footer: 10 sources × 15 four-minute bars
 *   2. Unit squares on journey steps 2–6: one square = one patient or bed
 *   3. Arrivals heat row under the occupancy chart: 12 five-minute cells
 *   4. Status page at the top of the Data map dialog: 30 two-minute bars
 *
 * Hooks render() and dataMapModal() by wrapping whatever they are at load,
 * so 30-ui.js and 40-bridge.js stay untouched. A failing view is caught and
 * logged once; the board keeps running. History lives here, never in S, and
 * is cleared when the simulation restarts. Concatenated last.
 * ========================================================================= */

/* ---------- Tuning ---------- */
const VIZ_CFG = {
  sampleSec: 120,    // status samples are kept in 2-min buckets (status page bars)
  stripBars: 15,     // footer strip: 15 × 4 min (two sample buckets each) = 60 min
  pageBars: 30,      // status page: 30 × 2 min = 60 min
  heatSec: 300,      // arrivals: 5-min cells
  heatCells: 12,     // 12 × 5 min = 60 min
  dispoSec: 3600,    // dispositions shown on step 6: last 60 min
  maxUnits: 40,      // squares per tile before "+N"
};
const VIZ_CHART_PAD = { l: 36, r: 12 };   // renderChart() padding; UI.geo.pad wins once the chart has drawn
const VIZ_STATES = ['ok', 'warn', 'down'];
const VIZ_START = ['red', 'yellow', 'green'];
const VIZ_BED = [['occupied', 'occ', 'occupied'], ['reserved', 'resv', 'reserved'], ['cleaning', 'clean', 'cleaning'], ['free', 'free', 'free']];
// Disposition keys used by the engine (00-core COND.dispo, 16-readiness transfer) → square class
const VIZ_DISPO = [['discharge', 'dis-home', 'home'], ['ward', 'dis-ward', 'ward'], ['icu', 'dis-icu', 'ICU'], ['or', 'dis-or', 'OR'], ['transfer', 'dis-xfer', 'transfer']];
const vizStartOf = typeof wslStart === 'function' ? wslStart : (esi => (esi <= 2 ? 'red' : esi === 3 ? 'yellow' : 'green'));

/* ---------- Labels (English / Arabic) ---------- */
const VIZ_I18N = {
  en: {
    systems: 'Systems', ok: 'Operational', warn: 'Degraded (backup sensors)', down: 'Offline',
    uptime: p => p + ' uptime', last60: 'last 60 min', comma: ', ',
    heat: 'Arrivals / 5 min', ago: (a, z) => a + '–' + z + ' min ago',
    arrivals: n => n + (n === 1 ? ' arrival' : ' arrivals'), none: 'no data',
    now: 'Now', ago60: '60 min ago',
  },
  ar: {
    systems: 'الأنظمة', ok: 'يعمل', warn: 'أداء منخفض (حساسات احتياطية)', down: 'متوقف',
    uptime: p => 'نسبة التشغيل ' + p, last60: 'آخر 60 دقيقة', comma: '، ',
    heat: 'الوصول / 5 دقائق', ago: (a, z) => 'قبل ' + a + '–' + z + ' دقيقة',
    arrivals: n => 'حالات الوصول: ' + n, none: 'لا بيانات',
    now: 'الآن', ago60: 'قبل 60 دقيقة',
  },
};
const vizL = () => VIZ_I18N[typeof UI !== 'undefined' && UI.lang === 'ar' ? 'ar' : 'en'];

/* ---------- History (module state, reset with the simulation) ---------- */
const VIZ_STATE = {
  S: null,               // the state object the history belongs to
  lastT: null,           // sim time of the last status sample
  sig: '',               // source states at the last sample
  startT: 0,             // sim time the history started (earlier slots are "no data")
  samples: new Map(),    // 2-min bucket → { srcId: [ok, warn, down] sample counts }
  seen: new Set(),       // patient ids already counted as arrivals
  arrivals: new Map(),   // 5-min bucket → arrivals
  heatW: -1,             // chart width the heat row was laid out for
  errs: new Set(),       // fault messages already logged
};
const VIZ_UNITS_CACHE = new WeakMap();   // .units element → markup it holds

// A restart is init() assigning a new S, or sim time running backwards
function vizSync() {
  const H = VIZ_STATE;
  if (H.S === S && !(H.lastT != null && S.t < H.lastT)) return;
  H.S = S; H.lastT = null; H.sig = ''; H.startT = S.t;
  H.samples.clear(); H.seen.clear(); H.arrivals.clear();
}

function vizState(id) {
  const st = S.src && S.src[id];
  if (st && st.status === 'live') return 'ok';
  if (id === 'beds' && S.bedsOffline && S.bedsFallback) return 'warn';
  return 'down';
}

// One sample per sim-time step, plus one whenever a state changes within the same step (paused board adds nothing)
function vizSample() {
  vizSync();
  const H = VIZ_STATE;
  const states = SOURCES.map(s => vizState(s.id));
  const sig = states.join();
  if (S.t === H.lastT && sig === H.sig) return;
  H.lastT = S.t; H.sig = sig;
  const b = Math.floor(S.t / VIZ_CFG.sampleSec);
  let row = H.samples.get(b);
  if (!row) { row = {}; H.samples.set(b, row); }
  SOURCES.forEach((s, i) => { (row[s.id] || (row[s.id] = [0, 0, 0]))[VIZ_STATES.indexOf(states[i])]++; });
  const keep = b - 2 * VIZ_CFG.stripBars;   // both windows reach at most 30 buckets back
  for (const k of H.samples.keys()) if (k < keep) H.samples.delete(k);
}

// [ok, warn, down] sample counts of one source over 2-min buckets lo..hi
function vizCounts(id, lo, hi) {
  const c = [0, 0, 0];
  for (let k = lo; k <= hi; k++) {
    const row = VIZ_STATE.samples.get(k), x = row && row[id];
    if (x) { c[0] += x[0]; c[1] += x[1]; c[2] += x[2]; }
  }
  return c;
}
const vizWorst = c => (c[2] ? 'down' : c[1] ? 'warn' : c[0] ? 'ok' : 'none');
// Rounded down, so any downtime never reads as 100.0%
const vizUptime = c => (c[2] ? (Math.floor((c[0] + c[1]) / (c[0] + c[1] + c[2]) * 1000) / 10).toFixed(1) + '%' : '100%');
const vizBars = states => html`${states.map(st => html`<i data-s="${st}"></i>`)}`;

function vizAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/* ---------- 1 · System status strip (footer) ---------- */
function vizStrip() {
  const foot = $('footer.foot');
  if (!foot) return;
  let box = $('#sysstatus');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sysstatus';
    box.className = 'sys';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Source systems, last 60 minutes');
    box.innerHTML = '<span class="sys-title"></span><div class="sys-list" role="list"></div>';
    foot.insertBefore(box, foot.firstChild);
  }
  const titleEl = box.querySelector('.sys-title'), list = box.querySelector('.sys-list');
  if (!titleEl || !list) return;
  const L = vizL(), n = VIZ_CFG.stripBars;
  const cur = Math.floor(S.t / (2 * VIZ_CFG.sampleSec));          // 4-min bucket = two 2-min sample buckets
  const lo = 2 * (cur - n + 1), hi = 2 * cur + 1;

  // Items are built once; afterwards only changed attributes and bar rows are written
  setHTML(list, html`${SOURCES.map(s => html`<div class="sys-item" role="listitem"><span class="sys-name">${s.short}</span><span class="sys-bars" aria-hidden="true"></span></div>`)}`);
  let up = 0;
  SOURCES.forEach((s, i) => {
    const el = list.children[i];
    if (!el) return;
    const now = vizState(s.id);
    if (now !== 'down') up++;
    const label = s.name + ' · ' + s.std + ' · ' + L[now] + ' · ' + L.uptime(vizUptime(vizCounts(s.id, lo, hi))) + L.comma + L.last60;
    vizAttr(el, 'data-s', now);
    vizAttr(el, 'title', label);
    vizAttr(el, 'aria-label', label);
    const bars = [];
    for (let j = 0; j < n; j++) { const b = cur - n + 1 + j; bars.push(vizWorst(vizCounts(s.id, 2 * b, 2 * b + 1))); }
    setHTML(el.querySelector('.sys-bars'), vizBars(bars));
  });
  setHTML(titleEl, html`${L.systems} <b>${up}/${SOURCES.length}</b>`);
}

/* ---------- 2 · Unit squares on journey steps 2–6 ---------- */
// "2 red, 3 yellow": count per kind in the given order, zero counts left out
function vizMix(classes, kinds) {
  return kinds.map(([cls, word]) => [word, classes.filter(c => c === cls).length])
    .filter(x => x[1] > 0).map(x => x[1] + ' ' + x[0]).join(', ');
}
function vizUnitsHTML(classes, label) {
  if (!classes.length) return html`<div class="units" aria-hidden="true"></div>`;
  const shown = classes.slice(0, VIZ_CFG.maxUnits), more = classes.length - shown.length;
  return html`<div class="units" role="img" aria-label="${label}">${shown.map(c => html`<i class="u ${c}"></i>`)}${more > 0 ? html`<span class="units-more">+${more}</span>` : ''}</div>`;
}
// Field patients by START colour (red first) for ambulances in one status
function vizField(status) {
  const kinds = VIZ_START.map(c => ['st-' + c, c]);
  const order = Object.fromEntries(kinds.map((k, i) => [k[0], i]));
  const classes = S.ambulances.filter(a => a.status === status)
    .flatMap(a => a.pts.map(P).filter(Boolean))
    .map(p => 'st-' + vizStartOf(p.esi)).filter(c => c in order)
    .sort((a, b) => order[a] - order[b]);
  return { classes, kinds };
}
function vizTiles() {
  const out = [];   // [classes, aria summary] for steps 2..6

  const scene = vizField('onscene');
  out.push([scene.classes, scene.classes.length + ' on scene: ' + vizMix(scene.classes, scene.kinds)]);
  const road = vizField('enroute');
  out.push([road.classes, road.classes.length + ' en route: ' + vizMix(road.classes, road.kinds)]);

  const esiKinds = [1, 2, 3, 4, 5].map(e => ['e' + e, 'ESI ' + e]);
  const waiting = S.patients.filter(p => p.stage === 'waiting' && p.esi >= 1 && p.esi <= 5)
    .sort((a, b) => a.esi - b.esi).map(p => 'e' + p.esi);
  out.push([waiting, waiting.length + ' waiting: ' + vizMix(waiting, esiKinds)]);

  // The bed board's own view: the stale snapshot during an outage without backup sensors
  const view = bedView();
  const bedKinds = VIZ_BED.map(([, cls, word]) => [cls, word]);
  const beds = VIZ_BED.flatMap(([st, cls]) => view.beds.filter(b => b.status === st).map(() => cls));
  out.push([beds, beds.length + ' beds' + (view.stale ? ' (snapshot, feed offline)' : '') + ': ' + vizMix(beds, bedKinds)]);

  const recent = S.done.filter(d => d.t >= S.t - VIZ_CFG.dispoSec && d.t <= S.t);
  const known = VIZ_DISPO.map(x => x[0]);
  const dispoKinds = VIZ_DISPO.map(([, cls, word]) => [cls, word]).concat([['dis-other', 'other']]);
  const dispo = VIZ_DISPO.flatMap(([key, cls]) => recent.filter(d => d.dispo === key).map(() => cls))
    .concat(recent.filter(d => !known.includes(d.dispo)).map(() => 'dis-other'));
  out.push([dispo, dispo.length + (dispo.length === 1 ? ' disposition' : ' dispositions') + ', last 60 min: ' + vizMix(dispo, dispoKinds)]);
  return out;
}
// renderJourney() rewrites the tiles whenever its markup changes, which drops the squares: re-add them then
function vizPutUnits(tile, content) {
  const markup = content.s;
  let el = tile.lastElementChild;
  if (!el || !el.classList.contains('units')) el = tile.querySelector(':scope > .units');
  if (el && VIZ_UNITS_CACHE.get(el) === markup) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = markup;
  const fresh = tmp.firstElementChild;
  if (!fresh) return;
  VIZ_UNITS_CACHE.set(fresh, markup);
  if (el) el.replaceWith(fresh);
  else tile.appendChild(fresh);
}
function vizUnits() {
  const journey = $('#journey');
  if (!journey) return;
  const tiles = journey.querySelectorAll(':scope > .jt');
  if (tiles.length < 2) return;
  vizTiles().forEach(([classes, label], i) => {
    const tile = tiles[i + 1];
    if (tile) vizPutUnits(tile, vizUnitsHTML(classes, label));
  });
}

/* ---------- 3 · Arrivals heat row (under the occupancy chart) ---------- */
// Each patient is counted once, in the 5-min bucket of p.arrivedAt (seeded patients carry negative times)
function vizCountArrivals() {
  const H = VIZ_STATE, size = VIZ_CFG.heatSec;
  for (const p of S.patients) {
    if (p.arrivedAt == null || H.seen.has(p.id)) continue;
    H.seen.add(p.id);
    const b = Math.floor(p.arrivedAt / size);
    H.arrivals.set(b, (H.arrivals.get(b) || 0) + 1);
  }
  const oldest = Math.floor(S.t / size) - VIZ_CFG.heatCells + 1;
  for (const k of H.arrivals.keys()) if (k < oldest) H.arrivals.delete(k);
  // Ids are never reused, so patients who left the board can be forgotten
  if (H.seen.size > S.patients.length + 500) {
    const here = new Set(S.patients.map(p => p.id));
    for (const id of H.seen) if (!here.has(id)) H.seen.delete(id);
  }
}
const vizLevel = n => (n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4);
function vizHeat() {
  const chart = $('#chart'), panel = $('#p-chart');
  if (!chart || !panel || !panel.contains(chart)) return;
  let box = $('#heat');
  if (!box) {
    box = document.createElement('div');
    box.id = 'heat';
    box.className = 'heat';
    box.setAttribute('role', 'img');
    box.innerHTML = '<div class="heat-cells"></div><span class="heat-label"></span>';
    chart.insertAdjacentElement('afterend', box);
    VIZ_STATE.heatW = -1;
  }
  const cellsEl = box.querySelector('.heat-cells'), labelEl = box.querySelector('.heat-label');
  if (!cellsEl || !labelEl) return;
  const H = VIZ_STATE, L = vizL(), size = VIZ_CFG.heatSec, n = VIZ_CFG.heatCells;
  const cur = Math.floor(S.t / size);
  const cells = [];
  for (let j = 0; j < n; j++) {
    const b = cur - n + 1 + j, k = H.arrivals.get(b) || 0;
    const noData = !k && (b + 1) * size <= H.startT;   // slot ended before the board started
    const when = L.ago(mins(S.t - b * size), mins(S.t - (b + 1) * size));
    cells.push({ l: vizLevel(k), k, noData, title: when + ' · ' + (noData ? L.none : L.arrivals(k)) });
  }
  setHTML(cellsEl, html`${cells.map(c => html`<i data-l="${c.l}" title="${c.title}"></i>`)}`);
  setText(labelEl, L.heat);
  const total = cells.reduce((s, c) => s + c.k, 0);
  vizAttr(box, 'aria-label', 'Arrivals per 5 minutes, last 60 minutes: ' +
    cells.map(c => (c.noData ? 'no data' : c.k)).join(', ') + ' (oldest first, ' + total + ' in total)');

  // Line the cells up with the chart's history area (x −60…0 of −60…+30 min); only when the width changes
  const W = Math.round(chart.clientWidth);
  if (W > 0 && W !== H.heatW) {
    H.heatW = W;
    const pad = typeof UI !== 'undefined' && UI.geo && UI.geo.pad ? UI.geo.pad : VIZ_CHART_PAD;
    cellsEl.style.width = Math.max(0, (W - pad.l - pad.r) * 60 / 90).toFixed(1) + 'px';
    box.style.paddingInlineStart = pad.l + 'px';
  }
}

/* ---------- 4 · Status page (Data map dialog) ---------- */
function vizStatusPage() {
  vizSample();
  const L = vizL(), n = VIZ_CFG.pageBars;
  const cur = Math.floor(S.t / VIZ_CFG.sampleSec);
  const rows = SOURCES.map(s => {
    const now = vizState(s.id);
    const bars = [];
    for (let j = 0; j < n; j++) { const b = cur - n + 1 + j; bars.push(vizWorst(vizCounts(s.id, b, b))); }
    const up = vizUptime(vizCounts(s.id, cur - n + 1, cur));
    return html`<div class="sp-row" data-s="${now}"><div class="sp-top"><b>${s.name}</b><span class="sp-state">${L[now]}</span></div><div class="sp-bars" aria-hidden="true">${vizBars(bars)}</div><div class="sp-foot"><span>${L.ago60}</span><span class="sp-rule"></span><span>${L.uptime(up)}</span><span class="sp-rule"></span><span>${L.now}</span></div></div>`;
  });
  return html`<section class="status-page">${rows}</section>`;
}

/* ---------- Hooks ---------- */
function vizFault(err) {
  const key = String(err && err.message || err);
  if (VIZ_STATE.errs.has(key)) return;
  VIZ_STATE.errs.add(key);
  console.error('WASEL viz: view failed', err);
}
function vizRun(fn) {
  try { fn(); } catch (err) { vizFault(err); }
}
function renderViz() {
  if (!S || typeof document === 'undefined') return;
  vizSample();
  vizCountArrivals();
  vizRun(vizStrip);
  vizRun(vizUnits);
  vizRun(vizHeat);
}

// loop() and every action call render by name, so reassigning the binding hooks them all
if (typeof render === 'function') {
  const vizBaseRender = render;
  render = function () {
    vizBaseRender.apply(this, arguments);
    try { renderViz(); } catch (err) { vizFault(err); }   // never let a view break the board
  };
}
// renderModal() calls dataMapModal() by name on every render: prepend the status page to its body
if (typeof dataMapModal === 'function') {
  const vizBaseDataMap = dataMapModal;
  dataMapModal = function () {
    const out = vizBaseDataMap.apply(this, arguments);
    try {
      if (S && Array.isArray(out) && out[1] instanceof SafeHTML) return [out[0], html`${vizStatusPage()}${out[1]}`];
    } catch (err) { vizFault(err); }
    return out;
  };
}
