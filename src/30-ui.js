/* =========================================================================
 * ER Crisis Command Center · 30-ui.js
 * The only module that touches the DOM. It owns the real-time loop, wires
 * user input, enforces role-based display rules and renders state `S`.
 *
 * Security model in this layer:
 *   - Escape by default: markup is built with the `html` tagged template,
 *     which HTML-escapes every interpolated value via esc() unless the value
 *     is itself markup produced by `html`. setHTML() refuses raw strings.
 *   - Minimum necessary: names and MRNs are masked per role (pname/pmrn).
 *   - Access checks + audit: record views and blocked attempts are logged.
 *   - Automatic logoff after 5 minutes without input for clinical roles.
 * ========================================================================= */

/* ---------- Escape-by-default HTML builder ---------- */
class SafeHTML {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
function htmlFragment(v) {
  if (v instanceof SafeHTML) return v.s;
  if (Array.isArray(v)) return v.map(htmlFragment).join('');
  if (v === false || v == null) return '';
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += htmlFragment(vals[i]) + strings[i + 1];
  return new SafeHTML(out);
}

// Writes markup only when it changed: keeps buttons clickable, scroll and focus stable.
const UI_HTML_CACHE = new WeakMap();
function setHTML(el, content) {
  if (!el) return false;
  const markup = content instanceof SafeHTML ? content.s : esc(content);
  if (UI_HTML_CACHE.get(el) === markup) return false;
  const active = document.activeElement;
  let keep = null;
  if (active && active !== el && el.contains(active) && active.dataset && active.dataset.act) {
    keep = { act: active.dataset.act, id: active.dataset.id };
  }
  el.innerHTML = markup;
  UI_HTML_CACHE.set(el, markup);
  if (keep) {
    let sel = '[data-act="' + CSS.escape(keep.act) + '"]';
    if (keep.id != null) sel += '[data-id="' + CSS.escape(keep.id) + '"]';
    const again = el.querySelector(sel);
    if (again) again.focus({ preventScroll: true });
  }
  return true;
}
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
function showEl(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

/* ---------- UI state & constants ---------- */
const UI_LOCK_MS = 5 * 60 * 1000;      // automatic logoff for clinical roles
const UI_CHART_MS = 1500;              // occupancy chart redraw throttle
const UI_THEME_KEY = 'ercc.theme';
const UI_MINUS = '−';
const UI_SRC_BY_ID = Object.fromEntries(SOURCES.map(s => [s.id, s]));
const UI = {
  tab: 'feed', modal: null, lastFocus: null,
  lastTick: Date.now(), lastInput: Date.now(), lastPointer: 'mouse',
  theme: 'dark', toastTimer: 0,
  chartAt: 0, chartW: 0, chartH: 0, geo: null, hoverPx: null,
};

/* ---------- Small helpers ---------- */
const nounCount = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const agoText = t => { const m = mins(S.t - t); return m < 1 ? 'just now' : m + ' min ago'; };
const isActiveCare = p => p.stage === 'treatment' || p.stage === 'boarding';
const condInfo = p => COND[p.cond] || { label: String(p.cond), icd: '' };
const unitText = u => (u === 'mm[Hg]' ? 'mmHg' : u === 'Cel' ? '°C' : u);
const LEVEL_ICON = { critical: '▲', serious: '●', warning: '●', good: '✓', info: '●' };
const LEVEL_WORD = { critical: 'critical', serious: 'needs attention', warning: 'watch', good: 'normal' };

function chipHTML(level, text, size) {
  return html`<span class="chip${size ? ' ' + size : ''} ${level}">${text}</span>`;
}
function esiBadge(esi) {
  return html`<span class="esi e${esi}" title="ESI ${esi} · ${ESI_LABEL[esi]}"><b>${esi}</b><small>ESI</small></span>`;
}
function esiMini(esi) {
  return html`<span class="esi mini e${esi}">ESI ${esi}</span>`;
}
function approverLabels(type) {
  const labels = Object.values(ROLES).filter(r => r.act.includes(type)).map(r => r.label);
  return labels.length ? labels.join(' or ') : 'an authorised role';
}
// During a bed-feed outage (without backup sensors) the board shows the last snapshot, flagged stale.
function bedView() {
  const stale = S.bedsOffline && !S.bedsFallback && Array.isArray(S.bedsSnapshot);
  return { beds: stale ? S.bedsSnapshot : S.beds, stale };
}
function byPriority(list) {
  return list.map(p => [p, priority(p)]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

/* ---------- Privacy: name & MRN masking by role (minimum necessary) ---------- */
function pname(p) {
  const mode = ROLES[prefs.role].names;
  if (mode === 'full') return p.first + ' ' + p.last;
  if (mode === 'partial') return p.first.charAt(0) + '. ' + p.last;
  return p.first.charAt(0) + '.' + p.last.charAt(0) + '.';
}
function pmrn(p) {
  return prefs.role === 'physician' || prefs.role === 'charge' ? String(p.mrn) : '•••' + String(p.mrn).slice(-4);
}

/* ---------- Toast & screen-reader announcements ---------- */
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  showEl(el, true);
  el.classList.add('show');
  clearTimeout(UI.toastTimer);
  UI.toastTimer = setTimeout(() => { el.classList.remove('show'); showEl(el, false); }, 3500);
}
function renderAnnouncements() {
  if (!Array.isArray(S.announce) || !S.announce.length) return;
  const msgs = S.announce.splice(0, S.announce.length);
  const sr = $('#sr');
  if (!sr) return;
  const shown = msgs.slice(-3);
  const text = 'New critical decision: ' + shown.join('. ') + (msgs.length > 3 ? '. And ' + (msgs.length - 3) + ' more.' : '.');
  sr.textContent = '';
  setTimeout(() => { sr.textContent = text; }, 60);
}

/* ---------- Header ---------- */
function renderHeader() {
  setText($('#clock'), fmtClock(S.t));
  setText($('#clockSub'), S.running ? 'SIM ' + S.speed + '×' : 'PAUSED');
  const items = S.banners.slice(-2).map(b => chipHTML(b.level, (b.level === 'critical' ? '▲ ' : '● ') + b.text));
  if (S.diversionUntil > S.t) {
    items.push(chipHTML('warning', '● Diverting ESI 4–5 ambulances · ' + mins(S.diversionUntil - S.t) + ' min left'));
  }
  setHTML($('#banner'), items.length ? html`${items}` : chipHTML('good', '● Normal operations'));
  const pb = $('#pause');
  if (pb) {
    setText(pb, S.running ? 'Pause' : 'Resume');
    pb.setAttribute('aria-pressed', String(!S.running));
  }
}

/* ---------- Journey strip: detection → disposition ---------- */
function journeyTile(n, label, level, value, unit, subs) {
  return html`<div class="jt ${level}" role="group" aria-label="Step ${n}, ${label}: ${LEVEL_WORD[level]}"><div class="jl">${LEVEL_ICON[level]} ${n} · ${label}</div><div class="jv">${value}<span> ${unit}</span></div>${subs.filter(Boolean).map(s => html`<div class="js">${s}</div>`)}</div>`;
}
function renderJourney() {
  const t = S.t, pts = S.patients;

  // 1 Detection
  const inc = S.incidents[S.incidents.length - 1];
  const boost = S.walkBoost && t < S.walkBoost.until ? S.walkBoost.rate : 0;
  const every = 1 / (1 / 7 + boost);
  const walk = 'Walk-ins ~1 per ' + (every >= 2 ? Math.round(every) : every.toFixed(1)) + ' min' + (boost ? ' (surge)' : '');
  const t1 = journeyTile(1, 'Detection', inc ? 'critical' : 'good', S.incidents.length,
    S.incidents.length === 1 ? 'incident' : 'incidents',
    inc ? [inc.name + ' · ' + inc.place, 'via ' + inc.via] : ['No active incident', walk]);

  // 2 First responders
  const onScene = S.ambulances.filter(a => a.status === 'onscene');
  const scenePts = onScene.flatMap(a => a.pts.map(P).filter(Boolean));
  const esiMix = [1, 2, 3, 4, 5].map(e => [e, scenePts.filter(p => p.esi === e).length]).filter(x => x[1] > 0)
    .map(([e, k]) => k + '× ESI ' + e).join(' · ');
  const t2 = journeyTile(2, 'First responders',
    scenePts.some(p => p.esi === 1) ? 'critical' : onScene.length ? 'serious' : 'good',
    onScene.length, onScene.length === 1 ? 'unit on scene' : 'units on scene',
    onScene.length ? [nounCount(scenePts.length, 'patient') + ' field-triaged', esiMix] : ['No units on scene', 'EMS dispatch standing by']);

  // 3 En route
  const enroute = S.ambulances.filter(a => a.status === 'enroute');
  const enPts = enroute.reduce((s, a) => s + a.pts.length, 0);
  const nextEta = enroute.length ? Math.min(...enroute.map(a => a.eta)) : null;
  const diverted = S.ambulances.filter(a => a.status === 'diverted').length;
  const nextMin = nextEta == null ? null : mins(nextEta - t);
  const t3 = journeyTile(3, 'En route',
    enroute.some(a => ambEsi(a) <= 2) ? 'serious' : enroute.length ? 'warning' : 'good',
    enPts, enPts === 1 ? 'patient inbound' : 'patients inbound',
    enroute.length
      ? [nounCount(enroute.length, 'ambulance'), nextMin < 1 ? 'Next arrival now' : 'Next arrival in ' + nextMin + ' min', diverted ? diverted + ' diverted' : '']
      : ['No ambulances en route', diverted ? diverted + ' diverted' : '']);

  // 4 Waiting
  const waiting = pts.filter(p => p.stage === 'waiting');
  const urgent = waiting.filter(p => p.esi <= 2).length;
  const longest = waiting.length ? Math.max(...waiting.map(p => mins(t - p.arrivedAt))) : 0;
  const t4 = journeyTile(4, 'Waiting',
    urgent ? 'critical' : waiting.length > 5 ? 'serious' : waiting.length ? 'warning' : 'good',
    waiting.length, 'waiting',
    [urgent + ' ESI 1–2 waiting', waiting.length ? 'Longest wait ' + longest + ' min' : 'No queue']);

  // 5 In treatment
  const inCare = pts.filter(isActiveCare).length;
  const { beds, stale } = bedView();
  const free = beds.filter(b => b.status === 'free').length;
  const d2b = median(S.d2b.filter(d => d.t >= t - 3600).map(d => d.m));
  const t5 = journeyTile(5, 'In treatment',
    free === 0 ? 'critical' : free <= 3 ? 'serious' : free <= 6 ? 'warning' : 'good',
    inCare, 'of ' + S.beds.length + ' beds',
    [nounCount(free, 'bed') + ' free' + (stale ? ' (stale data)' : ''), 'Door-to-bed median ' + (d2b == null ? '—' : Math.round(d2b) + ' min')]);

  // 6 Disposition
  const recent = S.done.filter(d => d.t >= t - 3600);
  const cnt = k => recent.filter(d => d.dispo === k).length;
  const boarding = pts.filter(p => p.stage === 'boarding').length;
  const icuFree = Math.max(0, S.icu.cap - S.icu.used);
  const t6 = journeyTile(6, 'Disposition',
    icuFree === 0 && boarding ? 'critical' : boarding > 3 ? 'serious' : boarding ? 'warning' : 'good',
    recent.length, 'done · last 60 min',
    [cnt('discharge') + ' home · ' + cnt('ward') + ' ward · ' + cnt('icu') + ' ICU · ' + cnt('or') + ' OR',
     boarding + ' boarding · ICU ' + icuFree + ' free']);

  setHTML($('#journey'), html`${[t1, t2, t3, t4, t5, t6]}`);
}

/* ---------- Inbound ambulances ---------- */
function ambCard(a) {
  const inc = S.incidents.find(i => i.id === a.incident);
  if (a.status === 'diverted') {
    return html`<div class="amb diverted"><div class="amb-top"><b>${a.id}</b><span class="muted">${inc ? inc.id : ''}</span><span class="eta">Diverted</span></div><div class="amb-prep">${nounCount(a.pts.length, 'patient')} (ESI 4–5) sent to a nearby ED · ${agoText(a.divertedAt)}</div></div>`;
  }
  const span = Math.max(1, a.eta - a.dispatchedAt);
  const progress = clamp((S.t - a.dispatchedAt) / span * 100, 0, 100);
  const etaMin = mins(a.eta - S.t);
  const state = a.status === 'onscene' ? 'On scene' : 'En route';
  const pts = a.pts.map(P).filter(Boolean).sort((x, y) => x.esi - y.esi);
  let prep = '';
  if (a.prepared) {
    const pb = bed(a.prepBed);
    prep = html`<div class="amb-prep">✓ ${pb ? zoneName(pb.zone) + ' ' : ''}${a.prepBed} reserved · ${a.team || 'resus team'} paged</div>`;
  } else if (S.sugg.some(s => s.type === 'prearrival' && s.amb === a.id)) {
    prep = html`<div class="amb-prep muted">Prep suggested — see decision queue</div>`;
  }
  return html`<div class="amb"><div class="amb-top"><b>${a.id}</b><span class="muted">${state}${inc ? ' · ' + inc.id : ''}</span><span class="eta">${etaMin < 1 ? 'Arriving' : 'ETA ' + etaMin + ' min'}</span></div><div class="bar" aria-hidden="true"><i style="width:${Math.round(progress)}%"></i></div><div class="amb-pts">${pts.map(p => html`<span>${esiMini(p.esi)} ${condInfo(p).label}</span> `)}</div>${prep}</div>`;
}
function renderInbound() {
  const list = S.ambulances.filter(a => a.status !== 'arrived')
    .sort((a, b) => (a.status === 'diverted') - (b.status === 'diverted') || a.eta - b.eta);
  const active = list.filter(a => a.status !== 'diverted');
  const nPts = active.reduce((s, a) => s + a.pts.length, 0);
  setText($('#inboundMeta'), active.length ? nounCount(nPts, 'patient') + ' · ' + nounCount(active.length, 'ambulance') : 'None inbound');
  const emsLive = S.src.ems && S.src.ems.status === 'live';
  setHTML($('#inbound'), list.length
    ? html`${list.map(ambCard)}`
    : html`<p class="empty">No ambulances inbound. EMS dispatch feed ${emsLive ? 'live' : 'offline'}.</p>`);
}

/* ---------- Staff (nurse workload & fatigue) ---------- */
function nurseRow(n) {
  const load = nurseLoad(n), loadPct = Math.round(load * 100);
  const k = S.patients.filter(x => x.nurse === n.id && isActiveCare(x)).length;
  const cls = load > 1 ? 'critical' : load > 0.85 ? 'warning' : 'good';
  const fat = fatigueLevel(n);
  const hrs = n.hours.toFixed(1) + ' h';
  let hours = hrs;
  if (n.status === 'on' && fat === 'over') hours = html`<span class="chip sm critical" title="Over 12 h on shift: fatigue risk">▲ ${hrs}</span>`;
  else if (n.status === 'on' && fat === 'tired') hours = html`<span class="chip sm warning" title="Over 10 h on shift">● ${hrs}</span>`;
  let note = '';
  if (n.status === 'incoming') {
    const covered = n.covers ? nurse(n.covers) : null;
    note = 'incoming · ETA ' + mins(n.arriveAt - S.t) + ' min' + (covered ? ' · relieves ' + covered.name : '');
  } else if (n.status === 'off') {
    note = 'off · ' + (n.offReason || 'off shift');
  } else if (n.handover) {
    const cover = S.nurses.find(x => x.covers === n.id && x.status === 'incoming');
    note = 'handover pending' + (cover ? ' → ' + cover.name : '');
  } else if (fat === 'over') {
    note = 'over 12 h on shift';
  } else if (fat === 'tired') {
    note = 'over 10 h on shift';
  }
  return html`<div class="nurse${n.status === 'on' ? '' : ' muted'}"><span class="nn">${n.name}${note ? html`<small> · ${note}</small>` : ''}</span><span class="nh">${hours}</span><span class="nbar" aria-hidden="true"><i class="${cls}" style="width:${Math.min(100, loadPct)}%"></i></span><span class="nl">${loadPct}%${load > 1 ? ' ▲' : ''} · ${nounCount(k, 'pt')}</span></div>`;
}
function renderStaff() {
  const t = S.t;
  const on = S.nurses.filter(n => n.status === 'on');
  const active = on.filter(n => !n.handover);
  const avg = active.length ? active.reduce((s, n) => s + nurseLoad(n), 0) / active.length : 0;
  const tired = on.filter(n => fatigueLevel(n) !== 'ok').length;
  setText($('#staffMeta'), on.length + ' on duty · avg load ' + Math.round(avg * 100) + '% · ' + tired + ' fatigued · 6 doctors');
  const list = S.nurses
    .filter(n => n.status !== 'off' || t - (n.offAt || 0) <= 1800)
    .map(n => [n, nurseLoad(n)])
    .sort((a, b) => b[1] - a[1] || b[0].hours - a[0].hours)
    .map(x => x[0]);
  const orph = orphans();
  const alert = orph.length
    ? html`<p class="chip critical">▲ ${nounCount(orph.length, 'patient')} without an assigned nurse</p>`
    : '';
  setHTML($('#staff'), html`${alert}${list.map(nurseRow)}`);
}

/* ---------- Patients ---------- */
function vitalsHTML(p) {
  const hr = r0(p.v.hr), sbp = r0(p.v.sbp), spo2 = r0(p.v.spo2), rr = r0(p.v.rr);
  const items = [
    ['HR', hr, '', hr > 110 ? '▲' : hr < 50 ? '▼' : ''],
    ['SBP', sbp, '', sbp <= 100 ? '▼' : sbp >= 200 ? '▲' : ''],
    ['SpO₂', spo2, '%', spo2 <= 93 ? '▼' : ''],
    ['RR', rr, '', rr >= 25 ? '▲' : rr <= 8 ? '▼' : ''],
  ];
  return html`${items.map(([k, val, u, arrow]) => arrow
    ? html`<b class="abn">${k} ${val}${u}${arrow}</b> `
    : html`<span>${k} ${val}${u}</span> `)}`;
}
function locationText(p) {
  if (p.stage === 'waiting') return 'Waiting ' + mins(S.t - p.arrivedAt) + ' min';
  if (p.stage === 'inbound') return 'Inbound' + (p.amb ? ' · ' + p.amb : '');
  if (p.stage === 'boarding') {
    return p.bed + ' · awaiting ' + (DISPO_LABEL[p.dispo] || 'transfer') + ' ' + mins(S.t - p.boardSince) + ' min';
  }
  const n = p.nurse ? nurse(p.nurse) : null;
  return p.bed + ' · ' + (n && n.status === 'on' ? n.name : '⚠ no nurse');
}
function trendText(trend) {
  return trend > 0 ? ' ↑' + trend : trend < 0 ? ' ↓' + (-trend) : '';
}
function patientRow(p) {
  const c = condInfo(p), f = p.flag;
  const news = p.news != null ? p.news : news2(p.v, p.onO2);
  const newsCls = news >= 7 ? ' critical' : news >= 5 ? ' serious' : '';
  const loc = locationText(p);
  const label = pname(p) + ', ' + p.id + ', ESI ' + p.esi + ', ' + c.label + ', NEWS2 ' + news +
    (p.trend > 0 ? ' rising' : p.trend < 0 ? ' falling' : '') + ', ' + loc +
    (f ? ', alert: ' + f.text : '') + '. Open record.';
  return html`<button type="button" class="prow${f ? ' f-' + f.level : ''}" data-act="patient" data-id="${p.id}" aria-label="${label}">${esiBadge(p.esi)}<span class="pid"><b>${pname(p)}</b> <small>${p.id} · ${p.age} ${p.sex}${p.retriaged ? ' · re-triaged' : ''}</small></span><span class="pcond">${c.label} <small>ICD-10-CM ${c.icd}</small></span><span class="pvit">${vitalsHTML(p)}</span><span class="pnews${newsCls}">NEWS2 ${news}${trendText(p.trend)}</span><span class="ploc">${loc}</span>${f ? html`<span class="pflag">${f.level === 'critical' ? '▲' : '●'} ${f.text}${f.hint ? ' · ' + f.hint : ''}</span>` : ''}</button>`;
}
function renderPatients() {
  const waiting = byPriority(S.patients.filter(p => p.stage === 'waiting'));
  const inCare = byPriority(S.patients.filter(isActiveCare));
  const flagged = waiting.concat(inCare).filter(p => p.flag).length;
  setText($('#patientsMeta'), waiting.length + ' waiting · ' + inCare.length + ' in treatment · ' + flagged + ' flagged');
  setHTML($('#patients'), html`<div class="sect" role="heading" aria-level="3">Waiting for a bed · ${waiting.length}</div>${waiting.length ? waiting.map(patientRow) : html`<p class="empty">Nobody waiting for a bed.</p>`}<div class="sect" role="heading" aria-level="3">In treatment · ${inCare.length}</div>${inCare.length ? inCare.map(patientRow) : html`<p class="empty">No patients in treatment.</p>`}`);
}

/* ---------- Bed board ---------- */
function bedTile(b) {
  let cls = 's-' + b.status, sub = '', tip = b.id + ' · ' + b.status;
  if (b.status === 'occupied') {
    const p = P(b.pid);
    sub = p ? 'ESI ' + p.esi : 'occ';
    if (p) { cls += ' e' + p.esi; tip += ' · ' + p.id; }
  } else if (b.status === 'free') {
    sub = b.hold ? 'hold' : 'free';
    if (b.hold) { cls += ' held'; tip += ' · held for suggestion ' + b.hold; }
  } else if (b.status === 'cleaning') {
    sub = 'clean';
  } else {
    sub = 'resv';
    if (b.pid) tip += ' · ' + b.pid;
  }
  return html`<div class="bed ${cls}" title="${tip}"><b>${b.id}</b><small>${sub}</small></div>`;
}
function renderBeds() {
  const { beds, stale } = bedView();
  const free = beds.filter(b => b.status === 'free').length;
  const cleaning = beds.filter(b => b.status === 'cleaning').length;
  let meta = free + '/' + beds.length + ' free · ' + cleaning + ' cleaning';
  if (stale) meta = 'Feed offline · snapshot from ' + fmtClock(S.bedsSnapAt);
  else if (S.bedsOffline && S.bedsFallback) meta = free + '/' + beds.length + ' free · via backup RTLS bed sensors';
  setText($('#bedsMeta'), meta);
  const zones = ZONES.map(z => {
    const zb = beds.filter(b => b.zone === z.id);
    const zf = zb.filter(b => b.status === 'free').length;
    return html`<div class="zone"><div class="zh">${z.name} · ${zf}/${zb.length} free</div><div class="beds">${zb.map(bedTile)}</div></div>`;
  });
  const overlay = stale
    ? html`<div class="stale" role="status"><b>STALE</b> · last update ${fmtClock(S.bedsSnapAt)} · feed offline</div>`
    : '';
  const legend = [['s-free', 'Free'], ['s-occupied', 'Occupied'], ['s-cleaning', 'Cleaning'], ['s-reserved', 'Reserved'], ['held', 'Held for AI suggestion']];
  setHTML($('#beds'), html`<div class="bedwrap">${zones}${overlay}</div><div class="legend">${legend.map(([c, l]) => html`<span><i class="sw ${c}" aria-hidden="true"></i> ${l}</span> `)}</div>`);
}

/* ---------- Equipment & supplies (bars show what is LEFT) ---------- */
function eqRow(label, value, frac, level, note, status) {
  return html`<div class="eq"><div class="eq-top"><span>${label}</span><span class="eq-v">${value}${status ? html` ${status}` : ''}</span></div><div class="bar ${level}" aria-hidden="true"><i style="width:${Math.round(clamp(frac, 0, 1) * 100)}%"></i></div>${note ? html`<div class="eq-note">${note}</div>` : ''}</div>`;
}
const fracLevel = f => (f > 0.3 ? 'good' : f > 0.1 ? 'warning' : 'critical');
function renderEquipment() {
  const rows = [];
  let alerts = 0;

  const mf = monitorsFree(), mt = S.eq.monitors;
  const mLvl = fracLevel(mf / Math.max(1, mt));
  if (mLvl !== 'good') alerts++;
  rows.push(eqRow('Cardiac monitors', mf + '/' + mt + ' free', mf / Math.max(1, mt), mLvl, ''));

  const vAvail = Math.max(0, S.eq.vents - S.eq.ventFaulty), vf = ventsFree();
  const needV = S.patients.filter(p => p.needsVent && !p.vent).length;
  const ids = [];
  for (let i = 1; i <= S.eq.vents; i++) if (!(S.eq.ventFaulty && (i === 3 || i === 8))) ids.push(i);
  const nearest = ids.length ? 'V-' + pad2(ids[Math.min(ids.length - 1, ventsInUse())]) : '';
  const vNotes = [];
  if (S.eq.ventFaulty) vNotes.push(S.eq.ventFaulty + ' failed self-test' + (S.ventLoan ? ' · loan from anaesthesia on the way' : ''));
  if (needV) vNotes.push('▲ ' + nounCount(needV, 'patient') + ' waiting for a ventilator');
  vNotes.push(vf ? 'nearest free ' + nearest + ' · ICU store (RTLS)' : 'none free');
  const vLvl = needV ? 'critical' : fracLevel(vf / Math.max(1, vAvail));
  if (vLvl !== 'good' || S.eq.ventFaulty) alerts++;
  rows.push(eqRow('Ventilators', vf + ' free of ' + vAvail, vf / Math.max(1, vAvail), vLvl, vNotes.join(' · ')));

  const ctTot = S.eq.ct.length, ctOn = ctOnline(), queue = S.eq.ctQueue.length, wait = ctWait();
  const ctLvl = ctOn === ctTot ? (wait != null && wait > 20 ? 'warning' : 'good') : ctOn ? 'warning' : 'critical';
  if (ctLvl !== 'good') alerts++;
  const offline = S.eq.ct.filter(u => !u.online).map(u => u.id + ' (' + u.loc + ') offline');
  const ctNote = offline.length ? offline.join(' · ') + (S.ctRepair ? ' · engineer on site' : '') : '';
  rows.push(eqRow('CT scanners', ctOn + '/' + ctTot + ' online · queue ' + queue + (wait != null ? ' · ~' + wait + ' min wait' : ' · no scanner online'),
    ctOn / Math.max(1, ctTot), ctLvl, ctNote));

  for (const key of Object.keys(S.sup)) {
    const sp = S.sup[key], left = minutesLeft(key), need = committed(key);
    const crit = sp.qty <= sp.cap * 0.1 || (left != null && left < 20) || need > sp.qty;
    const low = !crit && (sp.qty <= sp.cap * 0.25 || (left != null && left < 45));
    if (crit || low) alerts++;
    const status = crit ? chipHTML('critical', '▲ Critical', 'sm') : low ? chipHTML('warning', '● Low', 'sm') : chipHTML('good', '✓ OK', 'sm');
    const notes = [];
    if (sp.pending) notes.push('Restock ordered · arrives within 15 min');
    if (need > 0) notes.push('Waiting + inbound patients likely need ~' + need);
    rows.push(eqRow(sp.label, sp.qty + ' ' + sp.unit + ' · ' + (left == null ? 'stable' : '~' + left + ' min left'),
      sp.qty / Math.max(1, sp.cap), crit ? 'critical' : low ? 'warning' : 'good', notes.join(' · '), status));
  }
  setText($('#equipMeta'), alerts ? nounCount(alerts, 'item') + ' need attention' : 'All within limits');
  setHTML($('#equipment'), html`${rows}`);
}

/* ---------- AI decision queue ---------- */
function decisionCard(s) {
  const lvl = s.level === 1 ? 'critical' : s.level === 2 ? 'serious' : 'info';
  const actions = canAct(s.type)
    ? html`<button type="button" class="btn primary sm" data-act="accept" data-id="${s.id}" aria-label="Accept: ${s.title}">Accept</button><button type="button" class="btn ghost sm" data-act="dismiss" data-id="${s.id}" aria-label="Dismiss: ${s.title}">Dismiss</button>`
    : html`<span class="muted">Needs ${approverLabels(s.type)} sign-in</span>`;
  return html`<article class="card l${s.level}"><div class="ctype"><span class="chip sm ${lvl}">${s.level === 1 ? '▲' : '●'} ${LEVEL_LABEL[s.level]}</span> ${SUGG_LABEL[s.type] || s.type} · ${agoText(s.at)}</div><h3>${s.title}</h3><p>${s.why}</p><div class="cact">${actions}</div></article>`;
}
function renderDecisions() {
  const list = S.sugg.slice().sort((a, b) => a.level - b.level || a.at - b.at);
  const crit = list.filter(s => s.level === 1).length;
  const auto = prefs.autoAccept ? ' · auto-accept on' : '';
  setText($('#decMeta'), list.length ? list.length + ' pending · ' + crit + ' critical' + auto : 'Up to date' + auto);
  const nPlace = list.filter(s => s.type === 'placement').length;
  const btn = $('#acceptAll');
  if (btn) {
    showEl(btn, nPlace > 0 && canAct('placement'));
    setText(btn, 'Accept all placements (' + nPlace + ')');
  }
  setHTML($('#decisions'), list.length
    ? html`<div class="cards">${list.map(decisionCard)}</div>`
    : html`<p class="empty">No pending decisions. Watching ${S.patients.length} patients, ${S.beds.length} beds, ${SOURCES.length} data feeds.</p>`);
}

/* ---------- Integration feed / audit log ---------- */
function renderFeed() {
  document.querySelectorAll('#feedTabs [data-act="tab"]').forEach(b => {
    const sel = String(b.dataset.id === UI.tab);
    if (b.getAttribute('aria-selected') !== sel) b.setAttribute('aria-selected', sel);
  });
  const el = $('#feed');
  if (UI.tab === 'audit') {
    if (!ROLES[prefs.role].audit) {
      setHTML(el, html`<p class="empty">Restricted: sign in as IT / Admin to view the audit log.</p>`);
      return;
    }
    setHTML(el, S.audit.length
      ? html`${S.audit.slice(0, 60).map(a => html`<div class="fr"><time datetime="${simDate(a.t).toISOString()}">${fmtClockS(a.t)}</time><span class="tag">${a.role}</span><span>${a.text}</span></div>`)}`
      : html`<p class="empty">No audit entries yet.</p>`);
    return;
  }
  setHTML(el, S.feed.length
    ? html`${S.feed.slice(0, 40).map(f => {
      const src = UI_SRC_BY_ID[f.src];
      return html`<div class="fr"><time datetime="${simDate(f.t).toISOString()}">${fmtClockS(f.t)}</time><span class="tag" title="${src ? src.name : f.src}">${src ? src.short : f.src} · ${f.std}</span><span>${f.text}</span></div>`;
    })}`
    : html`<p class="empty">Waiting for the first message from the integration gateway.</p>`);
}

/* ---------- Occupancy chart: 60 min history + 30 min forecast ---------- */
function chartParts() {
  const box = $('#chart');
  if (!box) return null;
  let svg = box.querySelector('svg.occ');
  if (!svg) {
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    setHTML(box, html`<svg class="occ" role="img" aria-label="Bed occupancy chart" style="display:block;width:100%;height:100%"></svg><div class="xh" aria-hidden="true" style="display:none"></div><div class="tip" aria-hidden="true" style="display:none"></div>`);
    svg = box.querySelector('svg.occ');
  }
  return { box, svg };
}
function renderChart(force) {
  const parts = chartParts();
  if (!parts) return;
  const { box, svg } = parts;
  const W = Math.round(box.clientWidth), H = Math.round(box.clientHeight);
  const now = Date.now();
  if (!force && W === UI.chartW && H === UI.chartH && now - UI.chartAt < UI_CHART_MS) return;
  UI.chartAt = now; UI.chartW = W; UI.chartH = H;

  const fc = S.fc || { pts: [], fullIn: null };
  const status = fc.fullIn == null ? chipHTML('good', '✓ No overflow forecast', 'sm')
    : fc.fullIn === 0 ? chipHTML('critical', '▲ At capacity now', 'sm')
    : chipHTML(fc.fullIn <= 20 ? 'critical' : 'serious', (fc.fullIn <= 20 ? '▲' : '●') + ' Full in ~' + fc.fullIn + ' min', 'sm');
  setHTML($('#chartMeta'), html`${status} <span class="muted">solid recorded · dashed forecast</span>`);
  if (W < 80 || H < 60) { UI.geo = null; positionHover(); return; }

  const pad = { l: 36, r: 12, t: 12, b: 22 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const nowPt = { m: 0, v: bedsBusy() / Math.max(1, S.beds.length) * 100 };
  const hist = S.occ.map(o => ({ m: (o.t - S.t) / 60, v: o.occ })).filter(o => o.m >= -60.5 && o.m < 0).concat(nowPt);
  const fcp = (fc.pts || []).map(o => ({ m: o.m, v: o.occ }));
  const vmax = Math.max(100, ...hist.map(o => o.v), ...fcp.map(o => o.v));
  const yMax = Math.ceil(vmax / 25) * 25;
  const X = m => pad.l + (m + 60) / 90 * pw;
  const Y = v => pad.t + (1 - v / yMax) * ph;
  const f1 = n => n.toFixed(1);
  const path = pts => pts.map((o, i) => (i ? 'L' : 'M') + f1(X(o.m)) + ' ' + f1(Y(o.v))).join(' ');

  const grid = [];
  for (let v = 0; v <= yMax; v += 25) grid.push(v);
  const histArea = hist.length > 1
    ? path(hist) + ' L' + f1(X(0)) + ' ' + f1(Y(0)) + ' L' + f1(X(hist[0].m)) + ' ' + f1(Y(0)) + ' Z'
    : '';
  const overflow = fcp.some(o => o.v > 100)
    ? 'M' + fcp.map(o => f1(X(o.m)) + ' ' + f1(Y(Math.max(100, o.v)))).join(' L') +
      ' L' + f1(X(fcp[fcp.length - 1].m)) + ' ' + f1(Y(100)) + ' L' + f1(X(fcp[0].m)) + ' ' + f1(Y(100)) + ' Z'
    : '';
  const xTicks = [-60, -30, 0, 15, 30];
  const xLabel = m => (m === 0 ? 'now' : (m < 0 ? UI_MINUS + Math.abs(m) : '+' + m) + (m === -60 || m === 30 ? ' min' : ''));
  const axisStyle = 'fill:var(--muted);font-size:10px;font-variant-numeric:tabular-nums';

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const peak = fcp.length ? Math.round(Math.max(...fcp.map(o => o.v))) : null;
  svg.setAttribute('aria-label', 'Bed occupancy over the last 60 minutes and 30-minute forecast. Now ' + Math.round(nowPt.v) + '%.' +
    (peak != null ? ' Forecast peak ' + peak + '%.' : '') +
    (fc.fullIn == null ? ' No overflow forecast.' : fc.fullIn === 0 ? ' At capacity now.' : ' Full in about ' + fc.fullIn + ' minutes.'));
  setHTML(svg, html`${grid.map(v => html`<line x1="${pad.l}" x2="${W - pad.r}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" style="stroke:var(--grid);stroke-width:1"/><text x="${pad.l - 6}" y="${f1(Y(v) + 3.5)}" text-anchor="end" style="${axisStyle}">${v}%</text>`)}${xTicks.map(m => html`<text x="${f1(X(m))}" y="${H - 6}" text-anchor="${m === -60 ? 'start' : m === 30 ? 'end' : 'middle'}" style="${axisStyle}">${xLabel(m)}</text>`)}${histArea ? html`<path d="${histArea}" style="fill:var(--accent);opacity:.12"/>` : ''}${overflow ? html`<path d="${overflow}" style="fill:var(--critical-weak)"/>` : ''}<line x1="${pad.l}" x2="${W - pad.r}" y1="${f1(Y(100))}" y2="${f1(Y(100))}" style="stroke:var(--critical);stroke-width:1.5;stroke-dasharray:2 3"/><text x="${W - pad.r - 2}" y="${f1(Y(100) - 4)}" text-anchor="end" style="fill:var(--critical);font-size:10px;font-weight:600">100% capacity</text><line x1="${f1(X(0))}" x2="${f1(X(0))}" y1="${pad.t}" y2="${H - pad.b}" style="stroke:var(--text-2);stroke-width:1;stroke-dasharray:3 3"/><path d="${path(hist)}" style="fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>${fcp.length ? html`<path d="${path(fcp)}" style="fill:none;stroke:var(--accent);stroke-width:2;stroke-dasharray:5 4;stroke-linejoin:round"/>` : ''}<circle cx="${f1(X(0))}" cy="${f1(Y(nowPt.v))}" r="3.5" style="fill:var(--accent)"/>`);

  UI.geo = { X, Y, pad, pw, W, H, hist, fc: fcp };
  positionHover();
}
// Crosshair + tooltip live outside the SVG, so they survive redraws; recomputed from the latest geometry.
function positionHover() {
  const box = $('#chart');
  if (!box) return;
  const xh = box.querySelector('.xh'), tip = box.querySelector('.tip');
  if (!xh || !tip) return;
  const g = UI.geo;
  const hide = () => { xh.style.display = 'none'; tip.style.display = 'none'; };
  if (!g || UI.hoverPx == null) return hide();
  const m = clamp((UI.hoverPx - g.pad.l) / g.pw * 90 - 60, -60, 30);
  const pool = m <= 0 ? g.hist : g.fc;
  if (!pool.length) return hide();
  let best = pool[0];
  for (const o of pool) if (Math.abs(o.m - m) < Math.abs(best.m - m)) best = o;
  const x = g.X(best.m), y = g.Y(best.v), mm = Math.round(best.m), v = Math.round(best.v);
  xh.style.display = '';
  xh.style.left = x.toFixed(1) + 'px';
  xh.style.top = g.pad.t + 'px';
  xh.style.height = (g.H - g.pad.t - g.pad.b) + 'px';
  tip.textContent = best.m > 0 ? '+' + mm + ' min (forecast) · ' + v + '%'
    : mm === 0 ? 'Now · ' + v + '% occupied'
    : UI_MINUS + Math.abs(mm) + ' min · ' + v + '% occupied';
  tip.style.display = '';
  const tw = tip.offsetWidth || 120;
  tip.style.left = (x + 10 + tw > g.W ? x - 10 - tw : x + 10).toFixed(1) + 'px';
  tip.style.top = clamp(y - 30, 0, Math.max(0, g.H - 24)).toFixed(1) + 'px';
}

/* ---------- Source systems footer ---------- */
function srcChip(s) {
  const st = S.src[s.id] || { status: 'offline', last: 0 };
  const live = st.status === 'live';
  const backup = s.id === 'beds' && S.bedsOffline && S.bedsFallback;
  const title = s.name + ' · ' + s.std + ' · ' + (live ? 'live, last message ' + agoText(st.last) : backup ? 'offline, backup RTLS sensors in use' : 'offline');
  return html`<span class="src${live ? '' : ' offline'}" title="${title}"><span class="dot" aria-hidden="true">${live ? '●' : '○'}</span>${s.short}${live ? '' : html` <small>${backup ? 'backup' : 'offline'}</small>`}</span> `;
}
function renderSources() {
  const live = SOURCES.filter(s => S.src[s.id] && S.src[s.id].status === 'live').length;
  setHTML($('#sources'), html`<span class="muted">Data sources ${live}/${SOURCES.length} live · FHIR R4 gateway</span> ${SOURCES.map(srcChip)}`);
}

/* ---------- Modals: patient record, standards & security, data map ---------- */
const UI_STANDARDS = [
  ['HL7 FHIR R4', 'Interoperability API', 'Integration gateway; EHR, bed (Location), EMS and pharmacy feeds; patient record exported as a FHIR Bundle (Encounter, Condition, Observation)'],
  ['HL7 v2.5 ADT', 'Messaging', 'Registration events ADT^A04 (arrival), A02 (transfer), A03 (discharge) in the integration feed'],
  ['IEEE 11073 SDC', 'Medical device connectivity', 'Bedside monitors and wearable patches stream vital signs; device recorded on every Observation'],
  ['LOINC', 'Observation terminology', 'Vital signs coded 8867-4 HR, 8480-6 SBP, 9279-1 RR, 59408-5 SpO₂, 8310-5 temperature (record table, FHIR Observation, monitor feed)'],
  ['ICD-10-CM', 'Diagnosis coding', 'Every presenting condition: patient list, record, FHIR Condition, ADT messages'],
  ['SNOMED CT', 'Clinical terminology (mapping target)', 'Conditions carry ICD-10-CM today; the gateway maps them to SNOMED CT for problem-list exchange'],
  ['ESI v4', 'Triage acuity', 'ESI badge on every patient; drives bed-zone matching, nurse workload weights and AI re-triage suggestions'],
  ['NEWS2 (RCP 2017)', 'Early-warning score', 'Live score and 12-minute trend per patient; per-parameter points in the record; deterioration alerts'],
  ['ISO 9241-210', 'Human-centred design', 'Role-specific views; AI suggests and a human decides; one decision queue; low-clutter layout'],
  ['WCAG 2.2 AA', 'Accessibility', 'Real buttons with keyboard support, dialog focus management, live-region announcements, status as text + colour, light/dark themes'],
  ['HIPAA Security Rule + NIST SP 800-66 Rev. 2', 'Security safeguards', 'Access control, audit controls (§164.312(b)), automatic logoff (§164.312(a)(2)(iii)), minimum-necessary display'],
  ['ISO/IEC 27001', 'Information security management', 'Role-based access, event logging, degraded-mode handling of interface outages'],
  ['UAE Federal Law No. 2 of 2019', 'ICT in health fields', 'Health data stored and processed inside the UAE; confidentiality and logged access to patient data'],
  ['ADHICS', 'Abu Dhabi Healthcare Information & Cyber Security Standard', 'Access control, audit logging, session lock, incident handling for failed interfaces'],
  ['GS1', 'Supply identification', 'Blood units and supply restocks received with GS1 barcodes (pharmacy feed)'],
  ['I-PASS', 'Structured handover', 'Nurse handovers and reassignments sent as I-PASS summaries (roster feed)'],
];
const UI_CONTROLS = [
  'Role-based access with least privilege: four roles; each AI suggestion type can be approved only by the roles allowed to act on it.',
  'Minimum-necessary display: full names for Physician, initial + surname for Charge nurse, initials only on the wall display and for IT; MRN masked outside clinical roles.',
  'Patient records open only for clinical roles; every view and every blocked attempt is written to the audit log.',
  'Audit trail of sessions, role switches, record views, accepted, dismissed and auto-accepted suggestions and scenario starts; readable only by IT / Admin.',
  'Automatic logoff: clinical roles fall back to the wall display after 5 minutes without input.',
  'Output encoding: all dynamic text is HTML-escaped by default before rendering (XSS); no eval, no inline event handlers, no third-party scripts, fonts or CDNs.',
  'Human in the loop: AI only suggests; the single exception is opt-in auto-accept of bed placements, logged as policy.',
  'Fail-safe data: offline feeds are flagged; stale bed data is overlaid as STALE instead of being shown as current.',
  'Synthetic, fictional patients only; no data leaves the browser (only the theme choice is stored locally).',
];

function sparkline(p, key, label, unit) {
  const pts = (p.hist || []).filter(h => h.t >= S.t - 1800 && h[key] != null);
  if (pts.length < 2) return html`<div><div>${label}</div><div class="muted">collecting data…</div></div>`;
  const vals = pts.map(h => h[key]);
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  let lo = vMin, hi = vMax;
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
  const W = 160, H = 40, t0 = S.t - 1800;
  const d = pts.map((h, i) => (i ? 'L' : 'M') + ((h.t - t0) / 1800 * W).toFixed(1) + ' ' + (H - 3 - (h[key] - lo) / (hi - lo) * (H - 6)).toFixed(1)).join(' ');
  const last = r0(vals[vals.length - 1]);
  return html`<div><div>${label} <b>${last}${unit}</b> <span class="muted">range ${r0(vMin)}–${r0(vMax)}</span></div><svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label} over the last 30 minutes, from ${r0(vals[0])} to ${last}"><path d="${d}" style="fill:none;stroke:var(--accent);stroke-width:1.5;stroke-linejoin:round"/></svg></div>`;
}
function fhirBundle(p) {
  const c = condInfo(p), subject = { reference: 'Patient/' + p.id };
  const last = p.hist && p.hist.length ? p.hist[p.hist.length - 1] : null;
  const when = simDate(last ? last.t : S.t).toISOString();
  const value = k => (k === 'temp' ? Math.round(p.v.temp * 10) / 10 : r0(last && last[k] != null ? last[k] : p.v[k]));
  const encStatus = isActiveCare(p) ? 'in-progress' : p.stage === 'waiting' ? 'triaged' : 'planned';
  const observations = ['hr', 'sbp', 'rr', 'spo2', 'temp'].map(k => ({
    fullUrl: 'urn:uuid:obs-' + p.id + '-' + k,
    resource: {
      resourceType: 'Observation', id: 'obs-' + p.id + '-' + k, status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: LOINC[k].code, display: LOINC[k].name }] },
      subject, effectiveDateTime: when,
      valueQuantity: { value: value(k), unit: unitText(LOINC[k].unit), system: 'http://unitsofmeasure.org', code: LOINC[k].unit },
      device: { display: 'IEEE 11073 SDC wearable patch' },
    },
  }));
  return {
    resourceType: 'Bundle', id: 'ed-' + p.id, type: 'collection', timestamp: when,
    entry: [
      {
        fullUrl: 'urn:uuid:enc-' + p.id,
        resource: {
          resourceType: 'Encounter', id: 'enc-' + p.id, status: encStatus,
          class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'emergency' },
          priority: { text: 'ESI ' + p.esi + ' (' + ESI_LABEL[p.esi] + ')' }, subject,
        },
      },
      {
        fullUrl: 'urn:uuid:cond-' + p.id,
        resource: {
          resourceType: 'Condition', id: 'cond-' + p.id,
          clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
          code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: c.icd, display: c.label }], text: c.label },
          subject, encounter: { reference: 'Encounter/enc-' + p.id },
        },
      },
      ...observations,
    ],
  };
}
function kvList(rows) {
  return html`<dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}
function patientModal(id) {
  const p = P(id);
  if (!p) {
    return ['Patient ' + id, html`<p class="empty">Encounter closed: ${id} has left the emergency department, so the record is no longer live on this board.</p>`];
  }
  const c = condInfo(p);
  const news = news2(p.v, p.onO2), parts = news2Parts(p.v, p.onO2);
  const risk = news >= 7 ? 'high clinical risk' : news >= 5 ? 'medium clinical risk'
    : Object.values(parts).some(x => x === 3) ? 'low–medium risk (a single parameter scores 3)' : 'low clinical risk';
  const trend = p.trend > 0 ? 'rising +' + p.trend + ' in 12 min' : p.trend < 0 ? 'falling ' + p.trend + ' in 12 min' : 'stable';
  const n = p.nurse ? nurse(p.nurse) : null;
  const pb = p.bed ? bed(p.bed) : null;
  let where = locationText(p);
  if (isActiveCare(p)) where = 'Bed ' + p.bed + (pb ? ' (' + zoneName(pb.zone) + ')' : '') + ' · nurse ' + (n && n.status === 'on' ? n.name : 'not assigned') + (p.stage === 'boarding' ? ' · awaiting ' + (DISPO_LABEL[p.dispo] || 'transfer') : '');
  const resources = [p.monitor && 'Cardiac monitor', p.vent && 'Ventilator', p.needsVent && !p.vent && 'Needs ventilator (none free)',
    p.onO2 && 'Oxygen', S.eq.ctQueue.includes(p.id) && 'Queued for CT'].filter(Boolean).join(' · ') || 'None';
  const details = kvList([
    ['Triage', html`${esiMini(p.esi)} ${ESI_LABEL[p.esi]}${p.retriaged ? ' · re-triaged' : ''}`],
    ['Name', pname(p)],
    ['Patient ID', p.id],
    ['MRN', pmrn(p)],
    ['Age / sex', p.age + ' y · ' + (p.sex === 'F' ? 'Female' : 'Male')],
    ['Arrival', p.src + (p.amb ? ' · ' + p.amb : '') + (p.arrivedAt != null ? ' · arrived ' + fmtClock(p.arrivedAt) : ' · not yet arrived')],
    ['Location', where],
    ['Condition', c.label + ' · ICD-10-CM ' + c.icd],
    ['Resources', resources],
  ]);
  const vrow = k => html`<tr><td>${LOINC[k].name}</td><td><code>${LOINC[k].code}</code></td><td>${fmtV(k, p.v[k])} ${unitText(LOINC[k].unit)}</td><td>${parts[k]}</td></tr>`;
  const table = html`<table><thead><tr><th scope="col">Observation</th><th scope="col">LOINC</th><th scope="col">Value</th><th scope="col">NEWS2 pts</th></tr></thead><tbody>${['rr', 'spo2', 'sbp', 'hr', 'temp'].map(vrow)}<tr><td>Supplemental oxygen</td><td>—</td><td>${p.onO2 ? 'Yes' : 'No (room air)'}</td><td>${parts.o2}</td></tr><tr><td>Consciousness (ACVPU)</td><td>—</td><td>${p.v.avpu === 'A' ? 'Alert' : 'Responds to voice'}</td><td>${parts.avpu}</td></tr></tbody><tfoot><tr><th scope="row" colspan="3">NEWS2 total · ${trend}</th><td><b>${news}</b></td></tr></tfoot></table>`;
  const f = p.flag;
  const pending = S.sugg.filter(s => s.pid === p.id);
  const assessment = html`${f
    ? html`<p>${chipHTML(f.level, (f.level === 'critical' ? '▲ ' : '● ') + LEVEL_LABEL[f.level === 'critical' ? 1 : 2], 'sm')} ${f.text}</p>${f.hint ? html`<p>${f.hint}.</p>` : ''}`
    : html`<p>${chipHTML('good', '✓ Stable', 'sm')} No deterioration pattern detected over the last 12 minutes.</p>`}${pending.length ? html`<p>In decision queue: ${pending.map(s => s.title).join(' · ')}</p>` : ''}<p class="muted">NEWS2 ${news}: ${risk}. AI output is decision support only; the treating clinician decides.</p>`;
  const sparks = html`<div style="display:flex;flex-wrap:wrap;gap:16px">${sparkline(p, 'hr', 'Heart rate', '/min')}${sparkline(p, 'sbp', 'Systolic BP', ' mmHg')}${sparkline(p, 'spo2', 'SpO₂', '%')}</div>`;
  const body = html`<div class="mgrid"><section><h3>Patient</h3>${details}<h3>AI assessment</h3>${assessment}</section><section><h3>Vital signs · NEWS2 ${news}</h3>${table}<h3>Trends · last 30 min</h3>${sparks}</section></div><h3>FHIR R4 Bundle</h3><pre tabindex="0">${JSON.stringify(fhirBundle(p), null, 2)}</pre><p class="muted">This view was recorded in the audit log.</p>`;
  return [pname(p) + ' · ' + p.id, body];
}
function standardsModal() {
  const idleMin = Math.max(0, Math.ceil((UI_LOCK_MS - (Date.now() - UI.lastInput)) / 60000));
  const lockText = prefs.role === 'charge' || prefs.role === 'physician' ? 'auto-lock in ' + idleMin + ' min without input' : 'no clinical session to lock';
  return ['Standards & security', html`<p>Signed in as <b>${ROLES[prefs.role].label}</b> (demo sign-in) · ${lockText} · ${S.audit.length} audit entries this session.</p><table><thead><tr><th scope="col">Standard</th><th scope="col">Area</th><th scope="col">Where in this system</th></tr></thead><tbody>${UI_STANDARDS.map(([s, a, w]) => html`<tr><th scope="row">${s}</th><td>${a}</td><td>${w}</td></tr>`)}</tbody></table><h3>Security controls implemented in this build</h3><ul>${UI_CONTROLS.map(c => html`<li>${c}</li>`)}</ul><p class="muted">Production deployment: SSO with MFA (OIDC / SAML) replaces the demo role selector; TLS 1.2+ on every interface; AES-256 encryption at rest; UAE-hosted servers; audit log streamed to a SIEM.</p>`];
}
function dataMapModal() {
  const live = SOURCES.filter(s => S.src[s.id] && S.src[s.id].status === 'live').length;
  const rows = SOURCES.map(s => {
    const st = S.src[s.id] || { status: 'offline', last: 0 };
    const on = st.status === 'live';
    const status = on ? chipHTML('good', '● Live · ' + agoText(st.last), 'sm')
      : chipHTML('critical', s.id === 'beds' && S.bedsFallback ? '○ Offline · backup sensors' : '○ Offline', 'sm');
    return html`<tr><th scope="row">${s.name}</th><td>${s.std}</td><td>${s.feeds}</td><td>${s.panel}</td><td>${status}</td></tr>`;
  });
  return ['Data map · ' + live + '/' + SOURCES.length + ' sources live', html`<p>Ten hospital systems → integration gateway (normalised to HL7 FHIR R4, coded with LOINC and ICD-10-CM) → this command center. Nothing is entered twice; every panel cites its source.</p><table><thead><tr><th scope="col">Source system</th><th scope="col">Standard</th><th scope="col">Data received</th><th scope="col">Shown in</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table>`];
}
function renderModal() {
  if (!UI.modal) return;
  const { kind, id } = UI.modal;
  if (kind === 'patient' && !ROLES[prefs.role].detail) { closeModal(); return; }
  const [title, body] = kind === 'patient' ? patientModal(id) : kind === 'standards' ? standardsModal() : dataMapModal();
  setText($('#mtitle'), title);
  setHTML($('#mbody'), body);
}
function openModal(kind, id) {
  const m = $('#modal');
  if (!m) return;
  if (!UI.modal) {
    const a = document.activeElement;
    UI.lastFocus = a && a.dataset ? { el: a, act: a.dataset.act, id: a.dataset.id } : null;
  }
  UI.modal = { kind, id };
  renderModal();
  showEl(m, true);
  const close = m.querySelector('[data-act="close"]');
  if (close) setTimeout(() => close.focus(), 0);   // after the pointer's own focus handling
}
function closeModal() {
  const m = $('#modal');
  UI.modal = null;
  if (m) showEl(m, false);
  const last = UI.lastFocus;
  UI.lastFocus = null;
  if (!last) return;
  let target = last.el && last.el.isConnected ? last.el : null;
  if (!target && last.act) {
    target = document.querySelector('[data-act="' + CSS.escape(last.act) + '"]' + (last.id != null ? '[data-id="' + CSS.escape(last.id) + '"]' : ''));
  }
  if (target) target.focus({ preventScroll: true });
}
function enforceModalAccess() {
  if (UI.modal && UI.modal.kind === 'patient' && !ROLES[prefs.role].detail) {
    closeModal();
    toast('Patient record closed: ' + ROLES[prefs.role].label + ' has no clinical access.');
  }
}
function openPatient(id) {
  const p = P(id);
  if (!p) { toast('That patient is no longer in the department.'); return; }
  if (!ROLES[prefs.role].detail) {
    audit('Blocked: patient record ' + p.id + ' view attempt (' + ROLES[prefs.role].label + ' has no clinical access)');
    toast('Patient records need Charge nurse or Physician sign-in. Attempt logged.');
    return;
  }
  audit('Viewed patient record ' + p.id);
  openModal('patient', p.id);
}

/* ---------- Controls, theme, auto-lock ---------- */
function applyTheme(theme) {
  UI.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', UI.theme);
  const b = $('#theme');
  if (b) {
    // Icon-only button (shell): keep the glyph, describe the action for screen readers
    b.title = 'Switch to ' + (UI.theme === 'dark' ? 'light' : 'dark') + ' theme';
    b.setAttribute('aria-label', b.title);
  }
}
function toggleTheme() {
  applyTheme(UI.theme === 'dark' ? 'light' : 'dark');
  try { localStorage.setItem(UI_THEME_KEY, UI.theme); } catch (err) { /* storage blocked: theme applies to this session only */ }
}
function syncControls() {
  const sp = $('#speed');
  if (sp && document.activeElement !== sp && sp.value !== String(S.speed)) sp.value = String(S.speed);
  const rl = $('#role');
  if (rl && document.activeElement !== rl && rl.value !== prefs.role) rl.value = prefs.role;
  const au = $('#auto');
  if (au) {
    au.checked = !!prefs.autoAccept;
    au.disabled = !canAct('placement');
    au.title = au.disabled ? 'Policy can be changed by ' + approverLabels('placement') : '';
  }
  if (document.body && document.body.dataset.role !== prefs.role) document.body.dataset.role = prefs.role;
}
function checkAutoLock() {
  if (prefs.role !== 'charge' && prefs.role !== 'physician') return;
  if (Date.now() - UI.lastInput < UI_LOCK_MS) return;
  audit('Session auto-locked after 5 min inactivity');
  prefs.role = 'wall';
  const sel = $('#role');
  if (sel) sel.value = 'wall';
  enforceModalAccess();
  toast('Session locked after 5 min without input. Showing wall display.');
}

/* ---------- Actions ---------- */
function findSugg(id) { return S.sugg.find(s => s.id === id) || null; }
function handleAction(el) {
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  UI.lastInput = Date.now();
  const act = el.id === 'pause' ? 'pause' : el.id === 'theme' ? 'theme' : el.dataset.act;
  const id = el.dataset.id;
  switch (act) {
    case 'pause':
      S.running = !S.running;
      UI.lastTick = Date.now();
      break;
    case 'theme':
      toggleTheme();
      break;
    case 'scenario':
      if (!SCEN[id]) return;
      runScenario(id);
      toast('Scenario started: ' + ((SCEN_LABEL && SCEN_LABEL[id]) || id));
      break;
    case 'reset':
      if (UI.modal) closeModal();
      init();
      UI.lastTick = Date.now();
      UI.chartAt = 0;
      toast('Simulation reset');
      break;
    case 'accept': {
      const s = findSugg(id);
      if (!s) { toast('That suggestion is no longer valid.'); break; }
      if (!canAct(s.type)) {
        audit('Blocked: accept attempt on "' + s.title + '" (' + ROLES[prefs.role].label + ' lacks approval rights)');
        toast('Needs ' + approverLabels(s.type) + ' sign-in. Attempt logged.');
        break;
      }
      toast(accept(s, 'manual') ? 'Accepted: ' + s.title : 'Could not apply: ' + s.title);
      break;
    }
    case 'dismiss': {
      const s = findSugg(id);
      if (!s) { toast('That suggestion is no longer valid.'); break; }
      if (!canAct(s.type)) { toast('Needs ' + approverLabels(s.type) + ' sign-in.'); break; }
      dismiss(s);
      toast('Dismissed for 10 min: ' + s.title);
      break;
    }
    case 'acceptAll': {
      if (!canAct('placement')) { toast('Needs ' + approverLabels('placement') + ' sign-in.'); break; }
      let ok = 0;
      for (const s of S.sugg.filter(x => x.type === 'placement')) if (S.sugg.includes(s) && accept(s, 'bulk')) ok++;
      toast(ok ? 'Accepted ' + nounCount(ok, 'bed placement') : 'No placements could be applied.');
      break;
    }
    case 'patient':
      openPatient(id);
      break;
    case 'close':
      closeModal();
      break;
    case 'standards':
      openModal('standards');
      break;
    case 'datamap':
      openModal('datamap');
      break;
    case 'tab':
      if (id !== 'feed' && id !== 'audit') return;
      UI.tab = id;
      if (id === 'audit') audit(ROLES[prefs.role].audit ? 'Viewed audit log' : 'Blocked: audit log view attempt (' + ROLES[prefs.role].label + ')');
      break;
    default:
      return;
  }
  render();
}
function actionTarget(e) {
  return e.target && e.target.closest ? e.target.closest('[data-act], #pause, #theme') : null;
}
// Mouse/pen act on pointerdown (robust while panels re-render); touch waits for click so scrolling never triggers actions.
function onPointerDown(e) {
  UI.lastPointer = e.pointerType || 'mouse';
  if (e.button !== 0 || e.pointerType === 'touch') return;
  const el = actionTarget(e);
  if (!el) return;
  e.preventDefault();
  handleAction(el);
}
function onClick(e) {
  const modal = $('#modal');
  if (modal && e.target === modal && UI.modal) { closeModal(); return; }   // backdrop
  const keyboard = e.detail === 0;
  const touch = UI.lastPointer === 'touch' && !keyboard;
  if (!keyboard && !touch) return;
  const el = actionTarget(e);
  if (el) handleAction(el);
}
function onChange(e) {
  const t = e.target;
  UI.lastInput = Date.now();
  if (t.id === 'speed') {
    const v = Number(t.value);
    S.speed = [1, 10, 30, 60].includes(v) ? v : 30;
  } else if (t.id === 'role') {
    if (!ROLES[t.value]) { t.value = prefs.role; return; }
    prefs.role = t.value;
    audit('Role switched to ' + ROLES[prefs.role].label + ' (demo sign-in; production: SSO + MFA)');
    enforceModalAccess();
    toast('Signed in as ' + ROLES[prefs.role].label);
  } else if (t.id === 'auto') {
    if (!canAct('placement')) { t.checked = !!prefs.autoAccept; toast('Only ' + approverLabels('placement') + ' can change this policy.'); return; }
    prefs.autoAccept = !!t.checked;
    audit('Auto-accept of bed placements ' + (prefs.autoAccept ? 'enabled' : 'disabled'));
    toast(prefs.autoAccept ? 'Bed placements will be auto-accepted (logged as policy)' : 'Auto-accept turned off');
  } else {
    return;
  }
  render();
}
function trapFocus(e) {
  const m = $('#modal');
  if (!UI.modal || !m) return;
  const items = Array.from(m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(x => !x.disabled && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], active = document.activeElement;
  if (!m.contains(active)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
function onKeyDown(e) {
  if (e.key === 'Escape' && UI.modal) { e.preventDefault(); closeModal(); }
  else if (e.key === 'Tab') trapFocus(e);
}
function wireEvents() {
  const markInput = () => { UI.lastInput = Date.now(); };
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, markInput, { passive: true, capture: true }));
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeyDown);

  const box = $('#chart');
  if (box) {
    box.addEventListener('pointermove', e => { UI.hoverPx = e.clientX - box.getBoundingClientRect().left; positionHover(); });
    box.addEventListener('pointerleave', () => { UI.hoverPx = null; positionHover(); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => renderChart(true)).observe(box);
  }
  window.addEventListener('resize', () => renderChart(true));
}

/* ---------- Loop & render ---------- */
function render() {
  if (!S) return;
  renderHeader();
  renderJourney();
  renderInbound();
  renderStaff();
  renderPatients();
  renderBeds();
  renderEquipment();
  renderDecisions();
  renderFeed();
  renderChart(false);
  renderSources();
  renderAnnouncements();
  renderModal();
  syncControls();
}
function loop() {
  const now = Date.now();
  const realDt = Math.min(1, Math.max(0, (now - UI.lastTick) / 1000));
  UI.lastTick = now;
  if (S.running) step(realDt * S.speed);
  checkAutoLock();
  render();
}
function boot() {
  let theme = 'dark';
  try {
    const saved = localStorage.getItem(UI_THEME_KEY);
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (err) { /* storage unavailable (private mode / sandbox): keep default theme */ }
  applyTheme(theme);
  init();
  wireEvents();
  UI.lastTick = Date.now();
  UI.lastInput = Date.now();
  setInterval(loop, 500);
  render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
