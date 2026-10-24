/* =========================================================================
 * WASEL ER Command Dashboard · 40-bridge.js
 * Bridge to the satellite staff screens (kiosk, commander, supply, equipment,
 * admin), per CHANNELS.md §4–§5: a de-identified state snapshot every 2 s on
 * BroadcastChannel('wasel-state'), and whitelisted commands from 'wasel-command'.
 *
 * Privacy (UAE PDPL, HIPAA minimum necessary): the snapshot is built field by field
 * from an allow-list; patients appear by encounter / patient id only, never a name,
 * MRN, Emirates ID or image. Audit text for the admin screen is also scrubbed of
 * patient names and MRNs. Staff names are not patient data and are sent.
 * Security: a command needs a valid shape and id, must come from the one screen
 * allowed to send its action, and carries typed arguments. Commands are de-duplicated
 * by id, rate-limited, and audited whether accepted or rejected.
 * Robustness: every entry point is wrapped, so a bridge fault never stops the
 * dashboard; optional helpers are checked with typeof. Concatenated last (after 30-ui.js).
 * ========================================================================= */

/* ---------- Tuning and whitelists ---------- */
const BRIDGE_CFG = {
  stateMs: 2000,                     // snapshot cadence (CHANNELS.md §4)
  auditRows: 40,                     // audit rows sent to the admin screen
  ackRows: 20,                       // recent command results, so a screen can confirm its tap
  seenIds: 500,                      // command ids remembered for de-duplication
  rateWindowMs: 10000, rateMax: 20,  // at most 20 commands per 10 s from all screens together
  secondQty: 20,                     // supply requests this large need a second approver
  cleaningMin: 20,                   // a returned device is cleaned for 20 sim-minutes
  doctorsOnDuty: 6,                  // roster feed: physicians are not simulated one by one
  oncallEtaMin: 25,
};
// Screen id → the role written to the audit log (the sender's own `role` text is not trusted)
const BRIDGE_SCREENS = { kiosk: 'Lobby kiosk', commander: 'Incident commander', supply: 'Supply officer', equipment: 'Equipment (biomed)', admin: 'IT / Admin' };
// CHANNELS.md §5: action → the only screen allowed to send it
const BRIDGE_ACTIONS = {
  kioskCheckin: 'kiosk', declareMci: 'commander', divert: 'commander', callIn: 'commander', approveRequest: 'supply',
  secondApprove: 'supply', killSwitch: 'admin', reviewBreakGlass: 'admin', assetState: 'equipment',
};
const BRIDGE_DOWNTIME_OK = ['killSwitch', 'reviewBreakGlass'];   // still accepted while read-only
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BRIDGE_FAULT = 'Failed self-test';
const BRIDGE_ASSET_STATES = ['free', 'cleaning', 'out-of-service'];
const BRIDGE_KIOSK = {
  token: /^[A-Z]{1,2}-\d{1,4}$/,
  idMethod: ['emirates-id', 'temporary'],
  // complaint → COND key; 'injury' (null) is a wrist fracture or a laceration
  complaint: { chestPain: 'chestPain', abdoPain: 'abdoPain', dyspnea: 'dyspnea', fever: 'fever', injury: null, other: 'abdoPain' },
  ageBand: { child: [1, 15], adult: [18, 64], elderly: [65, 90] },
  vitals: { hr: [30, 190], sbp: [50, 220], rr: [6, 45], spo2: [70, 100], temp: [34, 41] },   // engine limits
};
// Portable devices parked in the corridors of the zones they serve: [id, type, location, zone]
const BRIDGE_PORTABLE = [
  ...ZONES.map((z, i) => ['D-0' + (i + 1), 'defibrillator', 'Corridor ' + z.id, z.id]),
  ['C-01', 'crash cart', 'Resus bay', 'R'], ['C-02', 'crash cart', 'Corridor T', 'T'], ['C-03', 'crash cart', 'Corridor A', 'A'],
  ['U-01', 'ultrasound', 'Resus bay', 'R'], ['U-02', 'ultrasound', 'Corridor A', 'A'],
];

const BRIDGE = {
  started: false, stateCh: null, cmdCh: null, lastS: null,
  seen: new Set(), rate: { start: 0, n: 0, warned: 0 }, acks: [],
  vent: new Map(), mon: new Map(),   // patient id → device id, so a patient keeps the same device
  overlay: new Map(),                // device id → {state, until?} set by the equipment screen
  req: new Map(),                    // supply card id → {item, title, why, level, qty, approvals, status}
  glass: new WeakMap(), glassSeq: 0, // break-glass audit entry → {i, reviewed}
};

/* ---------- Small helpers ---------- */
const bridgeObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const bridgeHas = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const bridgeOk = text => ({ ok: true, text });
const bridgeFail = error => ({ ok: false, error });
const bridgeRound2 = x => Math.round(x * 100) / 100;
const bridgeInField = a => a.status === 'onscene' || a.status === 'enroute';
// Printable single-line text from an untrusted value: control characters removed, length capped
function bridgeText(x, max) {
  if (typeof x !== 'string' && typeof x !== 'number') return '';
  return String(x).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function bridgeSafe(fn, fallback) {
  try { return fn(); } catch (err) {
    if (typeof console !== 'undefined' && console.error) console.error('WASEL bridge:', err);
    return fallback === undefined ? null : fallback;
  }
}
// A reset (init) replaces S: bridge-local maps keyed by patient or card id start over
function bridgeSync() {
  if (BRIDGE.lastS === S) return;
  BRIDGE.lastS = S;
  for (const m of [BRIDGE.vent, BRIDGE.mon, BRIDGE.overlay, BRIDGE.req]) m.clear();
}
function bridgeAudit(role, text) {   // same shape and cap as audit() in 00-core.js, with the screen as the role
  S.audit.unshift({ t: S.t, role, text });
  if (S.audit.length > 150) S.audit.pop();
}

/* ---------- State snapshot (CHANNELS.md §4) ---------- */
function bridgeSnapshot() {
  if (!S) return null;
  bridgeSync();
  const part = bridgeSafe, assets = part(bridgeAssets, []), scrub = bridgeScrubber();
  const stale = !!(S.bedsOffline && !S.bedsFallback && Array.isArray(S.bedsSnapshot));   // as the bed board shows it
  const beds = stale ? S.bedsSnapshot : S.beds, freeOf = type => assets.filter(a => a.type === type && a.state === 'free').length;
  return {
    type: 'state', v: 1, ts: Date.now(), simClock: fmtClock(S.t),
    hospital: typeof WASEL_HOSPITAL === 'string' ? WASEL_HOSPITAL : 'Demo General Hospital',
    mode: S.mode || 'steady', modeReason: S.modeReason || '', downtime: !!S.downtime,
    incidents: part(() => S.incidents.filter(i => i.closedAt == null).map(i =>
      ({ id: i.id, name: i.name, place: i.place, est: i.est, kind: i.kind, unconfirmed: !!i.unconfirmed })), []),
    inbound: part(bridgeInbound, []),
    beds: part(() => bridgeBeds(beds, stale), null),
    bedList: part(() => beds.map(b => ({ id: b.id, zone: b.zone, status: b.status, esi: b.pid && P(b.pid) ? P(b.pid).esi : null, held: !!b.hold })), []),
    waiting: part(bridgeWaiting, []),
    capacity: part(() => bridgeCapacity(beds, freeOf('ventilator'), freeOf('monitor')), null),
    supplies: part(bridgeSupplies, []),
    requests: part(bridgeRequests, []),
    staff: part(bridgeStaff, null),
    tasks: part(bridgeTasks, []),
    family: part(() => typeof familyBoard !== 'function' ? [] : familyBoard().map(r =>
      ({ enc: r.enc, initials: r.initials, status: r.status, since: r.since == null ? null : fmtClock(r.since) })), []),
    assets,
    audit: part(() => S.audit.slice(0, BRIDGE_CFG.auditRows).map(e => ({ t: fmtClock(e.t), role: e.role, text: scrub(e.text) })), []),
    breakGlass: part(() => bridgeBreakGlass(scrub), []),
    devices: part(bridgeDevices, []),
    acks: BRIDGE.acks.slice(),         // additive field: results of recent commands, newest first
  };
}

function bridgeBeds(beds, stale) {
  const out = { total: beds.length, free: 0, cleaning: 0, reserved: 0, occupied: 0, held: 0, stale, byZone: {} };
  for (const z of ZONES) out.byZone[z.id] = { free: 0, total: 0 };
  for (const b of beds) {
    const z = out.byZone[b.zone] || (out.byZone[b.zone] = { free: 0, total: 0 });
    z.total++;
    if (b.status === 'free' && b.hold) out.held++;            // held for a pending one-tap placement
    else if (b.status === 'free') { out.free++; z.free++; }
    else if (b.status === 'cleaning' || b.status === 'reserved' || b.status === 'occupied') out[b.status]++;
  }
  return out;
}

function bridgeInbound() {
  const rows = [];
  for (const p of S.patients) {
    const a = p.amb ? amb(p.amb) : null;
    if (p.stage !== 'inbound' || (a && !bridgeInField(a))) continue;
    const pr = bridgeObj(p.fieldPriority) ? p.fieldPriority : p.start ? { system: 'START', level: p.start } : { system: 'ESI', level: p.esi };
    rows.push({
      enc: p.enc || p.id, amb: a ? a.id : null, status: a ? a.status : 'enroute', etaMin: a ? Math.max(0, Math.round((a.eta - S.t) / 60)) : null,
      priority: { system: pr.system, level: pr.level }, esi: p.esi, label: COND[p.cond] ? COND[p.cond].label : String(p.cond),
      identity: p.identity ? p.identity.status : 'temporary', bed: p.reservedBed || null, team: a && a.team ? a.team : null,
      readiness: bridgeSafe(() => bridgeReadiness(p)),
    });
  }
  return rows.sort((x, y) => (x.etaMin == null ? 999 : x.etaMin) - (y.etaMin == null ? 999 : y.etaMin));
}
// 16-readiness.js is optional: only its documented fields are copied
function bridgeReadiness(p) {
  const r = typeof readiness === 'function' ? readiness(p) : null;
  if (!bridgeObj(r) || !Array.isArray(r.items)) return null;
  const items = r.items.slice(0, 10).map(i => ({ k: bridgeText(i && i.k, 24), label: bridgeText(i && i.label, 60), ok: !!(i && i.ok), detail: bridgeText(i && i.detail, 120) }));
  return { score: items.filter(i => i.ok).length, of: items.length, items };
}

function bridgeWaiting() {
  const lwbsMin = typeof WASEL_CFG === 'object' && WASEL_CFG.lwbsMin ? WASEL_CFG.lwbsMin : 60;
  const rank = typeof priority === 'function' ? priority : p => 6 - p.esi;
  return S.patients.filter(p => p.stage === 'waiting').map(p => [p, rank(p)]).sort((a, b) => b[1] - a[1]).map(([p]) => {
    const waitMin = p.arrivedAt == null ? 0 : Math.max(0, Math.round((S.t - p.arrivedAt) / 60));
    return { id: p.id, enc: p.enc || p.id, token: p.token || null, esi: p.esi, suggestedEsi: p.kiosk ? p.kioskEsi : null, news: p.news, waitMin,
      kiosk: !!p.kiosk, lwbsRisk: p.esi >= 4 && !p.clinicOffer && waitMin >= lwbsMin, flag: p.flag ? p.flag.text : null };
  });
}

function bridgeCapacity(beds, ventsFree, monitorsFree) {
  const cap = typeof capacitySnapshot === 'function' ? bridgeSafe(() => capacitySnapshot()) : null;
  const free = z => beds.filter(b => b.status === 'free' && !b.hold && (!z || b.zone === z)).length, diverting = S.diversionUntil > S.t;
  return {
    edBedsFree: cap ? cap.edBedsFree : free(), resusFree: cap ? cap.resusFree : free('R'), traumaFree: cap ? cap.traumaFree : free('T'),
    icuFree: Math.max(0, S.icu.cap - S.icu.used), orFree: Math.max(0, S.or.cap - S.or.used), ctOnline: ctOnline(), ctQueue: S.eq.ctQueue.length,
    ventsFree, ventsTotal: S.eq.vents, monitorsFree, diversion: diverting, diversionMinLeft: diverting ? Math.ceil((S.diversionUntil - S.t) / 60) : 0,
  };
}

function bridgeSupplies() {
  return Object.keys(S.sup).map(key => {
    const sp = S.sup[key], used = sp.log.reduce((n, e) => n + (e.t >= S.t - 30 * 60 ? e.n : 0), 0);   // same window as minutesLeft()
    return { key, label: sp.label, unit: sp.unit, qty: sp.qty, par: Math.round(sp.cap * 0.4), cap: sp.cap, perHour: used * 2,
      minutesLeft: typeof minutesLeft === 'function' ? minutesLeft(key) : null, pending: !!sp.pending };
  });
}

// Open supply cards with their approval state, plus approved ones until the delivery arrives
function bridgeRequests() {
  for (const [id, r] of BRIDGE.req) {
    const delivering = r.status === 'approved' && S.sup[r.item] && S.sup[r.item].pending;
    if (!delivering && !S.sugg.some(s => s.id === id)) BRIDGE.req.delete(id);
  }
  const row = (id, r) => ({ id, item: r.item, title: r.title, why: r.why || '', level: r.level, qty: r.qty,
    needsSecond: r.qty >= BRIDGE_CFG.secondQty, approvals: r.approvals.slice(), status: r.status });
  const rows = S.sugg.filter(s => s.type === 'supply' && S.sup[s.item]).map(s => row(s.id, bridgeReq(s)));
  for (const [id, r] of BRIDGE.req) if (r.status === 'approved') rows.push(row(id, r));
  return rows;
}
function bridgeReq(s) {
  if (!BRIDGE.req.has(s.id)) BRIDGE.req.set(s.id, { item: s.item, approvals: [], status: 'pending' });
  return Object.assign(BRIDGE.req.get(s.id), { title: s.title, why: s.why, level: s.level, qty: S.sup[s.item].restock });
}

function bridgeStaff() {
  const load = typeof aiLoads === 'function' ? aiLoads().load : {}, fatigue = n => typeof fatigueLevel === 'function' ? fatigueLevel(n) : 'ok';
  const on = S.nurses.filter(n => n.status === 'on'), active = on.filter(n => !n.handover);
  const avg = active.length ? active.reduce((sum, n) => sum + (load[n.id] || 0), 0) / active.length : 0;
  return {
    onDuty: on.length, avgLoad: bridgeRound2(avg), fatigued: on.filter(n => fatigue(n) !== 'ok').length,
    incoming: S.nurses.filter(n => n.status === 'incoming').length, doctors: BRIDGE_CFG.doctorsOnDuty,
    nurses: S.nurses.map(n => ({ id: n.id, name: n.name, hours: Math.round(n.hours * 10) / 10, load: bridgeRound2(load[n.id] || 0),
      status: n.status, handover: !!n.handover, fatigue: fatigue(n) })),
  };
}

function bridgeTasks() {
  return S.sugg.map(s => {
    const c = typeof waselTaskClock === 'function' ? waselTaskClock(s) : { openSec: Math.max(0, S.t - s.at), escalatesInSec: null };
    return { id: s.id, type: s.type, title: s.title, owner: s.owner || 'Charge nurse', openSec: Math.round(c.openSec),
      escalatesInSec: c.escalatesInSec == null ? null : Math.round(c.escalatesInSec), escalated: s.escalated || 0, level: s.level };
  }).sort((a, b) => a.level - b.level || b.openSec - a.openSec);
}

// Admin screen only: a break-glass entry gets a stable number the first time it is sent
function bridgeBreakGlass(scrub) {
  return S.audit.filter(e => typeof e.text === 'string' && e.text.startsWith('BREAK-GLASS')).map(e => {
    if (!BRIDGE.glass.has(e)) BRIDGE.glass.set(e, { i: BRIDGE.glassSeq++, reviewed: false });
    const g = BRIDGE.glass.get(e);
    return { i: g.i, t: fmtClock(e.t), role: e.role, text: scrub(e.text), reviewed: g.reviewed };
  });
}

// Audit text is written with ids only; this removes a patient name or MRN typed into a free-text reason
function bridgeScrubber() {
  const words = [];
  for (const p of S.patients) words.push(String(p.mrn || ''), p.first && p.last ? p.first + ' ' + p.last : '');
  const list = words.filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = list.length ? new RegExp('\\b(?:' + list.join('|') + ')\\b', 'gi') : null;
  return text => re ? String(text).replace(re, '[redacted]') : String(text);
}

function bridgeDevices() {
  const beat = k => 1 + (Math.floor(Date.now() / 1000) + k) % 5;   // simulated heartbeat age, 1–5 s
  const rows = S.ambulances.filter(bridgeInField).map((a, i) => ({ id: 'TAB-' + a.id, kind: 'Responder tablet', status: 'online', lastSeenSec: beat(i) }));
  rows.push({ id: 'KIOSK-1', kind: 'Lobby kiosk', status: 'online', lastSeenSec: beat(7) }, { id: 'WALL-1', kind: 'Wall board', status: 'online', lastSeenSec: beat(3) });
  return rows;
}

/* ---------- Equipment: deterministic RTLS view plus the equipment screen's overlay ---------- */
function bridgeAssets() {
  const ov = BRIDGE.overlay, out = [];
  for (const [id, o] of ov) if (o.until != null && o.until <= S.t) ov.delete(id);   // cleaning finished
  const block = id => { const o = ov.get(id); return !o ? 0 : o.state === 'cleaning' ? 1 : 2; };
  const ids = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + pad2(i + 1));
  // Ventilators: engine faults are V-03 and V-08 first (as the RTLS feed reports), never one in use
  const ventUsers = S.patients.filter(p => p.vent), vIds = ids('V-', S.eq.vents);
  bridgeRelease(BRIDGE.vent, ventUsers);
  const inUse = new Set(BRIDGE.vent.values()), faulty = new Set();
  for (const id of ['V-03', 'V-08'].concat(vIds)) if (faulty.size < S.eq.ventFaulty && vIds.includes(id) && !inUse.has(id)) faulty.add(id);
  const ventAt = bridgeAssign(BRIDGE.vent, ventUsers, vIds, id => faulty.has(id) ? 2 : block(id));
  for (const id of vIds) out.push(bridgeRow(id, 'ventilator', ventAt.get(id), faulty.has(id), 'Store B', 'Store'));
  const monUsers = S.patients.filter(p => p.monitor), mIds = ids('M-', S.eq.monitors);
  bridgeRelease(BRIDGE.mon, monUsers);
  const monAt = bridgeAssign(BRIDGE.mon, monUsers, mIds, block);
  for (const id of mIds) out.push(bridgeRow(id, 'monitor', monAt.get(id), false, 'Store A', 'Store'));
  for (const [id, type, loc, zone] of BRIDGE_PORTABLE) out.push(bridgeRow(id, type, null, false, loc, zone));
  return out;
}
// A device whose patient no longer needs it goes for cleaning
function bridgeRelease(map, users) {
  const live = new Set(users.map(p => p.id));
  for (const [pid, id] of map) {
    if (live.has(pid)) continue;
    map.delete(pid);
    BRIDGE.overlay.set(id, { state: 'cleaning', until: S.t + BRIDGE_CFG.cleaningMin * 60 });
  }
}
// Lowest free id first; failing that, a device still being cleaned beats none on the board.
// Returns device id → patient.
function bridgeAssign(map, users, ids, block) {
  const taken = new Set(map.values()), at = new Map();
  for (const p of users.slice().sort((a, b) => (a.bedAt || 0) - (b.bedAt || 0))) {
    if (!map.has(p.id)) {
      const id = ids.find(x => !taken.has(x) && block(x) === 0) || ids.find(x => !taken.has(x) && block(x) === 1);
      if (id) { map.set(p.id, id); taken.add(id); BRIDGE.overlay.delete(id); }
    }
    if (map.has(p.id)) at.set(map.get(p.id), p);
  }
  return at;
}
function bridgeRow(id, type, p, fault, loc, zone) {
  const o = BRIDGE.overlay.get(id), b = p && p.bed ? bed(p.bed) : null;
  if (p) return { id, type, state: 'in-use', loc: p.bed || 'ED', zone: b ? b.zone : 'ED' };
  if (fault) return { id, type, state: 'out-of-service', loc, zone, note: BRIDGE_FAULT };
  if (o && o.state === 'cleaning') return { id, type, state: 'cleaning', loc, zone, note: 'Ready ~' + fmtClock(o.until) };
  if (o && o.state === 'out-of-service') return { id, type, state: 'out-of-service', loc, zone, note: 'Marked out of service' };
  return { id, type, state: 'free', loc, zone };
}

/* ---------- Commands (CHANNELS.md §5) ---------- */
// null for traffic that is not a command, else {ok, text} | {ok: false, error} (also kept as an ack)
function bridgeHandleCommand(msg) {
  if (!bridgeObj(msg) || msg.type !== 'command') return null;
  const id = typeof msg.id === 'string' && BRIDGE_ID.test(msg.id) ? msg.id : null;
  if (id && BRIDGE.seen.has(id)) return { ok: true, duplicate: true };      // re-sent: already handled
  if (id) BRIDGE.seen.add(id);
  if (BRIDGE.seen.size > BRIDGE_CFG.seenIds) BRIDGE.seen.delete(BRIDGE.seen.values().next().value);
  if (!S) return bridgeFail('dashboard not started');
  bridgeSync();
  const label = bridgeHas(BRIDGE_SCREENS, msg.from) ? BRIDGE_SCREENS[msg.from] : 'Unknown screen', action = bridgeText(msg.action, 40) || '(no action)';
  if (!bridgeRateOk()) return bridgeRecord(id, label, action, bridgeFail('rate limit exceeded'), BRIDGE.rate.warned++ > 0);
  const problem = bridgeCheck(msg, id);
  const r = problem ? bridgeFail(problem) : bridgeSafe(() => BRIDGE_EFFECTS[msg.action](msg.args || {}), bridgeFail('internal error'));
  return bridgeRecord(id, label, action, r, false);
}
function bridgeCheck(msg, id) {
  if (msg.v !== 1) return 'unsupported message version';
  if (!id) return 'missing or malformed command id';
  if (!bridgeHas(BRIDGE_SCREENS, msg.from)) return 'unknown screen';
  if (!bridgeHas(BRIDGE_ACTIONS, msg.action)) return 'unknown action';
  if (BRIDGE_ACTIONS[msg.action] !== msg.from) return 'not allowed from the ' + msg.from + ' screen';
  if (msg.args != null && !bridgeObj(msg.args)) return 'args must be an object';
  if (S.downtime && !BRIDGE_DOWNTIME_OK.includes(msg.action)) return 'downtime mode: the dashboard is read-only';
  return null;
}
function bridgeRateOk() {
  const now = Date.now(), r = BRIDGE.rate;
  if (now - r.start > BRIDGE_CFG.rateWindowMs) Object.assign(r, { start: now, n: 0, warned: 0 });
  return ++r.n <= BRIDGE_CFG.rateMax;
}
// Audit (unless quiet), keep an ack for the screens, and post the new state at once
function bridgeRecord(id, label, action, r, quiet) {
  if (quiet) return r;
  bridgeAudit(label, r.ok ? `Command from ${label}: ${action}${r.text ? ' · ' + r.text : ''}` : `Rejected command from ${label}: ${action} · ${r.error}`);
  BRIDGE.acks.unshift({ id, action, ok: r.ok, text: r.ok ? r.text || '' : r.error, ts: Date.now() });
  if (BRIDGE.acks.length > BRIDGE_CFG.ackRows) BRIDGE.acks.pop();
  bridgeTick();
  return r;
}

// ESI v4 suggestion: the complaint's usual acuity, tightened by NEWS2 (RCP 2017) and the ESI
// danger-zone vitals. Only a suggestion: a more urgent one becomes a one-tap re-triage card.
function bridgeKioskEsi(cond, v, band) {
  const base = COND[cond].esi[1], why = [];
  let esi = base;
  const up = (to, reason) => { if (to < esi) { esi = to; why.push(reason); } };
  if (band === 'child') up(3, 'child: NEWS2 is not validated under 16, nurse assessment');
  else {
    const news = news2(v, false), parts = news2Parts(v, false), red = Object.keys(parts).filter(k => parts[k] === 3);
    if (r0(v.spo2) < 85 || r0(v.sbp) < 80) up(1, `SpO₂ ${r0(v.spo2)}%, SBP ${r0(v.sbp)}: immediate intervention likely`);
    if (news >= 5 || red.length) up(2, `NEWS2 ${news}` + (red.length ? ` (red score: ${red.join(', ')})` : ' (≥ 5)'));
    if (r0(v.hr) > 100 || r0(v.rr) > 20 || r0(v.spo2) < 92) up(3, 'ESI danger-zone vital sign');
    if (band === 'elderly') up(3, 'age 65 or over');
  }
  return { base, esi, why };
}

function bridgeKioskCheckin(a) {
  const K = BRIDGE_KIOSK;
  if (typeof a.token !== 'string' || !K.token.test(a.token)) return bridgeFail('token must look like A-017');
  if (!K.idMethod.includes(a.idMethod)) return bridgeFail('idMethod must be emirates-id or temporary');
  if (!bridgeHas(K.complaint, a.complaint)) return bridgeFail('unknown complaint');
  if (a.vitals != null && !bridgeObj(a.vitals)) return bridgeFail('vitals must be an object');
  if (S.patients.some(p => p.token === a.token)) return bridgeFail('token ' + a.token + ' is already checked in');
  const cond = K.complaint[a.complaint] || pick(['wrist', 'laceration']);
  const p = makePatient(cond, 'Kiosk'), band = bridgeHas(K.ageBand, a.ageBand) ? a.ageBand : 'adult', vit = a.vitals || {};
  p.age = rint(K.ageBand[band][0], K.ageBand[band][1]);
  const sex = typeof a.sex === 'string' ? a.sex.charAt(0).toUpperCase() : '';
  if ((sex === 'M' || sex === 'F') && sex !== p.sex) { p.sex = sex; p.first = pick(sex === 'M' ? NAMES.m : NAMES.f); }
  let measured = 0;
  for (const k in K.vitals) {
    if (typeof vit[k] !== 'number' || !Number.isFinite(vit[k])) continue;   // not measured: typical value kept
    p.v[k] = clamp(vit[k], K.vitals[k][0], K.vitals[k][1]);
    measured++;
  }
  p.v.avpu = 'A';                      // checked in unaided at the kiosk
  Object.assign(p, { kiosk: true, token: a.token, lang: a.lang === 'ar' ? 'ar' : 'en', ageBand: band });
  // An Emirates ID read at the kiosk is a candidate until a nurse compares it with the patient (identity card)
  p.identity = a.idMethod === 'emirates-id' ? { status: 'candidate', method: 'emirates-id', confidence: null } : { status: 'temporary', method: 'none', confidence: null };
  if (p.identity.status === 'temporary' && typeof wslLinkRecord === 'function') wslLinkRecord(p);   // no record: all Unknown
  const sug = bridgeKioskEsi(cond, p.v, band), key = 'retriage:' + p.id;
  p.esi = sug.base; p.kioskEsi = sug.esi;
  S.patients.push(p);
  arrive(p);
  if (typeof assess === 'function') assess(p);
  if (sug.esi < p.esi && typeof addSugg === 'function' && !blocked(key)) {
    addSugg({ key, type: 'retriage', level: sug.esi <= 2 ? 1 : 2, pid: p.id, to: sug.esi,
      title: `Re-triage ${p.id} (kiosk ${p.token}) from ESI ${p.esi} to ESI ${sug.esi}`,
      why: `${COND[cond].label} · ${sug.why.join(' · ')}. Suggested at the kiosk: confirm at the bedside.` });
  }
  emit('adt', 'HL7 v2', `Kiosk check-in token ${p.token} · NEWS2 ${p.news} · suggested ESI ${sug.esi} (nurse to confirm)`
    + (measured < 5 ? ` · ${measured} of 5 vital signs measured` : ''));
  return bridgeOk(`token ${p.token} → ${p.id}, suggested ESI ${sug.esi}`);
}

function bridgeDeclareMci(a) {
  if (typeof a.on !== 'boolean') return bridgeFail('on must be true or false');
  if (typeof waselDeclareMci === 'function') waselDeclareMci(a.on);
  else { S.mciDeclared = a.on; if (typeof updateMode === 'function') updateMode(); }
  return bridgeOk(a.on ? 'MCI declared' : 'MCI stood down');
}

// Same effect as the dashboard's diversion card: ESI 4–5 units go elsewhere, critical ones keep coming
function bridgeDivert(a) {
  const m = a.minutes;
  if (!Number.isInteger(m) || m < 0 || m > 240) return bridgeFail('minutes must be a whole number 0–240');
  if (m === 0) {
    S.diversionUntil = Math.min(S.diversionUntil, S.t);
    emit('ems', 'CAD', 'Diversion ended by the incident commander');
    return bridgeOk('diversion ended');
  }
  S.diversionUntil = S.t + m * 60;
  const low = S.ambulances.filter(x => bridgeInField(x) && ambEsi(x) >= 4);
  for (const x of low) divert(x);
  emit('ems', 'CAD', `Diversion until ${fmtClock(S.diversionUntil)} (incident commander): ESI 4–5 ambulances go to nearby EDs`
    + (low.length ? ` · ${low.length} en route redirected` : ''));
  return bridgeOk(m + ' min');
}

function bridgeCallIn(a) {
  if (!Number.isInteger(a.count) || a.count < 1 || a.count > 6) return bridgeFail('count must be a whole number 1–6');
  const skill = bridgeText(a.skill, 30) || 'nurse';
  for (let i = 0; i < a.count; i++) callIn(BRIDGE_CFG.oncallEtaMin);
  emit('roster', 'REST API', `Incident commander call-in: ${a.count} on-call staff (${skill}) · ETA ${BRIDGE_CFG.oncallEtaMin} min`);
  return bridgeOk(`${a.count} × ${skill}`);
}

// Two-person rule: a large request (qty ≥ 20) needs a second, different approver
function bridgeApprove(a, second) {
  const who = bridgeText(a.approver, 40);
  if (who.length < 2) return bridgeFail('approver is required');
  const s = S.sugg.find(x => x.id === a.id && x.type === 'supply' && S.sup[x.item]);
  if (!s) return bridgeFail('no open supply request ' + bridgeText(a.id, 12));
  const r = bridgeReq(s);
  if (!second) {
    if (r.approvals.length) return bridgeFail(`already approved by ${r.approvals[0]}: needs a second approver`);
    r.approvals.push(who);
    if (r.qty >= BRIDGE_CFG.secondQty) {
      r.status = 'awaiting-second';
      return bridgeOk(`${s.id} first approval by ${who} · ${r.qty} ${S.sup[s.item].unit} needs a second approver`);
    }
  } else {
    if (r.status !== 'awaiting-second') return bridgeFail(s.id + ' is not awaiting a second approval');
    if (who.toLowerCase() === r.approvals[0].toLowerCase()) return bridgeFail('the second approver must be a different person');
    r.approvals.push(who);
  }
  if (!accept(s, who)) return bridgeFail(s.id + ' is no longer valid');
  r.status = 'approved';
  return bridgeOk(`${s.id} approved by ${r.approvals.join(' + ')} · ${S.sup[s.item].label} × ${r.qty} requested`);
}

function bridgeKillSwitch(a) {
  if (typeof a.on !== 'boolean') return bridgeFail('on must be true or false');
  if (a.on === !!S.downtime) return bridgeOk(a.on ? 'already in downtime mode' : 'already live');
  S.downtime = a.on;
  S.downtimeSince = a.on ? S.t : null;
  bridgeSyncDowntime();
  emit('ehr', 'FHIR', a.on ? 'Downtime procedure started: dashboard read-only, use paper and voice' : 'Downtime ended: dashboard live again');
  return bridgeOk(a.on ? 'downtime mode on' : 'downtime mode off');
}

function bridgeReviewBreakGlass(a) {
  if (!Number.isInteger(a.i) || a.i < 0) return bridgeFail('i must be a break-glass entry number');
  const e = S.audit.find(x => BRIDGE.glass.has(x) && BRIDGE.glass.get(x).i === a.i);
  if (!e) return bridgeFail('no break-glass entry #' + a.i);
  const g = BRIDGE.glass.get(e), done = g.reviewed;
  g.reviewed = true;
  return bridgeOk('break-glass entry #' + a.i + (done ? ' already reviewed' : ' reviewed'));
}

function bridgeAssetState(a) {
  if (typeof a.id !== 'string' || !BRIDGE_ASSET_STATES.includes(a.state)) return bridgeFail('id and state free|cleaning|out-of-service are required');
  const row = bridgeAssets().find(x => x.id === a.id);
  if (!row) return bridgeFail('unknown asset ' + bridgeText(a.id, 12));
  if (row.state === 'in-use') return bridgeFail(`${row.id} is in use at ${row.loc}`);
  if (row.note === BRIDGE_FAULT) return bridgeFail(`${row.id} failed self-test: it returns after repair or loan`);
  if (a.state === 'free') BRIDGE.overlay.delete(row.id);
  else BRIDGE.overlay.set(row.id, a.state === 'cleaning' ? { state: 'cleaning', until: S.t + BRIDGE_CFG.cleaningMin * 60 } : { state: 'out-of-service' });
  return bridgeOk(`${row.id} → ${a.state}`);
}

const BRIDGE_EFFECTS = {
  kioskCheckin: bridgeKioskCheckin, declareMci: bridgeDeclareMci, divert: bridgeDivert, callIn: bridgeCallIn,
  approveRequest: a => bridgeApprove(a, false), secondApprove: a => bridgeApprove(a, true),
  killSwitch: bridgeKillSwitch, reviewBreakGlass: bridgeReviewBreakGlass, assetState: bridgeAssetState,
};

/* ---------- Downtime mode: read-only overlay, the simulation keeps running ---------- */
const BRIDGE_DOWNTIME_CSS = '#wasel-downtime{position:fixed;top:0;left:0;right:0;z-index:80;display:flex;align-items:center;'
  + 'justify-content:center;min-height:48px;padding:8px 16px;background:var(--critical,#d70015);color:var(--on-fill,#fff);'
  + 'font:700 var(--t-title,15px)/1.3 var(--font,system-ui,sans-serif);text-align:center}'
  + 'body.wasel-downtime{padding-top:48px}body.wasel-downtime :is([data-act],#pause){pointer-events:none;opacity:.5}'
  + '#wasel-downtime [data-act]{pointer-events:auto;opacity:1}';
const bridgeLocked = el => !!(S && S.downtime && el && el.closest && el.closest('[data-act], [data-enter], #pause') && !el.closest('#wasel-downtime'));

function bridgeSyncDowntime() {
  if (typeof document === 'undefined' || !document.body) return;
  const on = !!(S && S.downtime);
  let el = document.getElementById('wasel-downtime');
  if (on && !el) {
    if (!document.getElementById('wasel-downtime-css')) {
      const st = document.createElement('style');
      st.id = 'wasel-downtime-css';
      st.textContent = BRIDGE_DOWNTIME_CSS;
      (document.head || document.body).appendChild(st);
    }
    el = document.createElement('div');
    el.id = 'wasel-downtime';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }
  if (on) {
    const text = `DOWNTIME MODE — read-only snapshot since ${fmtClock(S.downtimeSince == null ? S.t : S.downtimeSince)} · use paper and voice procedures`;
    if (el.textContent !== text) el.textContent = text;
  } else if (el) el.remove();
  document.body.classList.toggle('wasel-downtime', on);
}
// Keyboard paths (Enter / Space on a focused control) are blocked too, not just the pointer
function bridgeBlock(e) {
  if (!bridgeLocked(e.target) || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  e.stopPropagation();
}

/* ---------- Start-up ---------- */
function bridgeTick() {
  bridgeSafe(() => {
    bridgeSyncDowntime();
    if (BRIDGE.stateCh && S) BRIDGE.stateCh.postMessage(bridgeSnapshot());
  });
}
function bridgeStart() {
  if (BRIDGE.started) return;
  BRIDGE.started = true;
  bridgeSafe(() => {
    if (typeof BroadcastChannel !== 'function') return;   // e.g. some file:// contexts: the dashboard still runs
    BRIDGE.stateCh = new BroadcastChannel('wasel-state');
    BRIDGE.cmdCh = new BroadcastChannel('wasel-command');
    BRIDGE.cmdCh.onmessage = e => bridgeSafe(() => bridgeHandleCommand(e.data));
  });
  bridgeSafe(() => {
    for (const type of ['click', 'pointerdown', 'keydown']) window.addEventListener(type, bridgeBlock, true);
    // window.WASEL is frozen by 30-ui.js: publish a new frozen object that keeps its members
    const prev = bridgeObj(window.WASEL) ? window.WASEL : {};
    window.WASEL = Object.freeze(Object.assign({}, prev, { bridge: Object.freeze({ snapshot: () => bridgeSafe(bridgeSnapshot) }) }));
  });
  setInterval(bridgeTick, BRIDGE_CFG.stateMs);
  bridgeTick();
}
// Registered after 30-ui.js's own boot handler, so the dashboard has started first
if (typeof document !== 'undefined' && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bridgeSafe(bridgeStart));
else bridgeSafe(bridgeStart);
