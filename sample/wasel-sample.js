/**
 * WASEL ER Crisis Command Center: sample code
 * --------------------------------------------
 * A self-contained excerpt of the dashboard's engine:
 *   1. a real-time simulation that reacts to a sudden influx of patients (multi-vehicle pile-up),
 *   2. rule-based clinical scoring (NEWS2, RCP 2017) and ESI v4 triage: explainable, no AI,
 *   3. operating modes with hysteresis (Steady → Strain → Surge → MCI) so the ED escalates early
 *      and does not flap back and forth,
 *   4. security by design: whitelisted input validation, HTML escaping, role checks, an
 *      append-only audit log and de-identified output for shared screens.
 *
 * Run:  node wasel-sample.js      (or paste into any browser console)
 * Full source: https://github.com/Polocobear/wasel-er-dashboard  ·  Live: https://wasel-er-dashboard.pages.dev
 */
'use strict';
const log = typeof console !== 'undefined' ? console.log : print;

/* ---------- 1. Security helpers ---------- */

// Every dynamic value is escaped before it reaches the page: blocks HTML/script injection (XSS).
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC_MAP[c]);

// Role-based access: least privilege. The wall display can see, never act.
const ROLES = { wall: [], nurse: ['place'], charge: ['place', 'divert', 'callIn'], physician: ['place'] };
const canAct = (role, action) => (ROLES[role] || []).includes(action);

// Append-only audit log: who did what, when and why (ADHICS / ISO 27001 A.8.15). Entries are frozen.
const AUDIT = [];
function audit(who, what, why) { AUDIT.push(Object.freeze({ t: clock(), who, what, why })); }

// Incoming pre-alerts from paramedics are untrusted: whitelist every field, reject anything else.
const PREALERT = { encounter: /^T-\d{1,6}$/, initials: /^(?:[A-Z]\.){1,4}$/, maxEtaMin: 240 };
function validatePreAlert(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== 'prealert' || msg.v !== 1) return { ok: false, error: 'not a v1 pre-alert' };
  if (!PREALERT.encounter.test(msg.encounter)) return { ok: false, error: 'bad encounter id' };
  const esi = msg.priority && msg.priority.level;
  if (!Number.isInteger(esi) || esi < 1 || esi > 5) return { ok: false, error: 'priority must be ESI 1–5' };
  if (typeof msg.etaMin !== 'number' || msg.etaMin < 0 || msg.etaMin > PREALERT.maxEtaMin) return { ok: false, error: 'bad ETA' };
  // Initials only: a full name or ID number in this field is dropped, never stored (UAE PDPL data minimisation)
  const display = PREALERT.initials.test(msg.display || '') ? msg.display : null;
  return { ok: true, data: { encounter: msg.encounter, esi, etaMin: Math.round(msg.etaMin), display } };
}

/* ---------- 2. Clinical rules (explainable, published scores) ---------- */

// NEWS2 (Royal College of Physicians, 2017): early-warning score from routine vital signs.
function news2(v) {
  let s = 0;
  s += v.rr <= 8 ? 3 : v.rr <= 11 ? 1 : v.rr <= 20 ? 0 : v.rr <= 24 ? 2 : 3;
  s += v.spo2 <= 91 ? 3 : v.spo2 <= 93 ? 2 : v.spo2 <= 95 ? 1 : 0;
  s += v.sbp <= 90 ? 3 : v.sbp <= 100 ? 2 : v.sbp <= 110 ? 1 : v.sbp <= 219 ? 0 : 3;
  s += v.hr <= 40 ? 3 : v.hr <= 50 ? 1 : v.hr <= 90 ? 0 : v.hr <= 110 ? 1 : v.hr <= 130 ? 2 : 3;
  s += v.avpu === 'A' ? 0 : 3;
  return s;
}

// Who goes first: ESI level, then NEWS2, then time waited. Every decision carries its reason.
const priority = p => p.esi * 100 - news2(p.v) * 10 - p.waitMin / 10;

/* ---------- 3. Operating modes with hysteresis ---------- */

const MODE_RULES = { order: ['Steady', 'Strain', 'Surge', 'MCI'], strainOccupancyPct: 80, criticalWaitMin: 15, mciCasualties: 10, stepDownMin: 10 };
function modeCheck(S) {
  const occupancy = Math.round(100 * S.beds.filter(b => b.pid).length / S.beds.length);
  const criticalWaiting = S.waiting.filter(p => p.esi <= 2 && p.waitMin > MODE_RULES.criticalWaitMin).length;
  if (S.incidentCasualties >= MODE_RULES.mciCasualties) return { mode: 'MCI', why: `incident with ${S.incidentCasualties} casualties` };
  const strain = [occupancy >= MODE_RULES.strainOccupancyPct && `beds ${occupancy}% full`, criticalWaiting && `${criticalWaiting} critical waiting`].filter(Boolean);
  if (strain.length >= 2) return { mode: 'Surge', why: strain.join(' + ') };
  if (strain.length === 1) return { mode: 'Strain', why: strain[0] };
  return { mode: 'Steady', why: 'all indicators within limits' };
}
function updateMode(S) {
  const next = modeCheck(S), cur = MODE_RULES.order.indexOf(S.mode), want = MODE_RULES.order.indexOf(next.mode);
  if (want === cur) { S.lowerSince = null; return; }
  if (want < cur) {                                   // step down only after 10 calm minutes: no flapping
    if (S.lowerSince == null) S.lowerSince = S.min;
    if (S.min - S.lowerSince < MODE_RULES.stepDownMin) return;
  }
  log(`  [${clock()}] MODE ${S.mode} → ${next.mode}: ${next.why}`);
  audit('system', `mode ${next.mode}`, next.why);
  S.mode = next.mode; S.lowerSince = null;
}

/* ---------- 4. Real-time simulation ---------- */

// Seeded random numbers so every run is identical and testable.
let seed = 26;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const S = { min: 0, mode: 'Steady', lowerSince: null, incidentCasualties: 0, nextId: 1, waiting: [],
  beds: Array.from({ length: 12 }, (_, i) => ({ id: 'A' + (i + 1), pid: null, freeAt: 0 })) };
const clock = () => `${String(14 + Math.floor(S.min / 60)).padStart(2, '0')}:${String(S.min % 60).padStart(2, '0')}`;

function arrive(esi, source) {
  const sick = esi <= 2;
  const p = { id: 'P-' + S.nextId++, esi, waitMin: 0, source,
    v: { hr: sick ? 118 + rnd() * 20 : 80 + rnd() * 15, sbp: sick ? 92 + rnd() * 15 : 125 + rnd() * 15,
         rr: sick ? 24 + rnd() * 6 : 15 + rnd() * 3, spo2: sick ? 90 + rnd() * 4 : 97 + rnd() * 2, avpu: sick && rnd() < 0.3 ? 'V' : 'A' } };
  S.waiting.push(p);
}

function placeWaiting() {
  S.waiting.sort((a, b) => priority(a) - priority(b));          // sickest first, with reasons
  for (const bed of S.beds) {
    if (bed.pid || !S.waiting.length) continue;
    const p = S.waiting.shift();
    bed.pid = p.id; bed.freeAt = S.min + (p.esi <= 2 ? 90 : 40);
    if (p.esi <= 2) log(`  [${clock()}] ${p.id} (ESI ${p.esi}, NEWS2 ${news2(p.v)}) → bed ${bed.id}  · waited ${p.waitMin} min`);
  }
}

function tick() {                                                // one simulated minute
  S.min++;
  if (rnd() < 0.25) arrive(rnd() < 0.2 ? 2 : 3 + Math.floor(rnd() * 2), 'walk-in');
  if (S.min === 10) {                                            // INFLUX: multi-vehicle pile-up, 14 casualties
    S.incidentCasualties = 14;
    log(`  [${clock()}] INCIDENT: pile-up on E11, 14 casualties inbound`);
    for (let i = 0; i < 14; i++) arrive(i < 4 ? 1 : i < 9 ? 2 : 3, 'ambulance');
  }
  if (S.min === 40) S.incidentCasualties = 0;                    // incident closed by the commander
  for (const b of S.beds) if (b.pid && S.min >= b.freeAt) b.pid = null;
  for (const p of S.waiting) {
    p.waitMin++;
    if (p.esi <= 2) { p.v.spo2 -= 0.1; p.v.hr += 0.3; }          // untreated critical patients deteriorate
    if (p.esi <= 2 && p.waitMin === 15) audit('system', `escalate ${p.id}`, `ESI ${p.esi} waiting 15 min, NEWS2 ${news2(p.v)}`);
  }
  placeWaiting();
  updateMode(S);
}

/* ---------- Run: 90 simulated minutes ---------- */

log('WASEL sample run · 12 acute beds · pile-up at 14:10');
for (let i = 0; i < 4; i++) arrive(3 + (i % 2), 'walk-in');
for (let m = 0; m < 90; m++) tick();

// A paramedic pre-alert, then two tampered ones: only the valid one gets through.
const good = validatePreAlert({ type: 'prealert', v: 1, encounter: 'T-832', priority: { level: 2 }, etaMin: 12, display: 'G.J.' });
const badName = validatePreAlert({ type: 'prealert', v: 1, encounter: 'T-833', priority: { level: 2 }, etaMin: 9, display: 'Githu Jacob 784-2005-1234567-3' });
const injected = validatePreAlert({ type: 'prealert', v: 1, encounter: '<script>alert(1)</script>', priority: { level: 1 }, etaMin: 5 });
log('\nPre-alert checks:');
log('  valid      →', JSON.stringify(good));
log('  full name  →', JSON.stringify(badName), '(name and ID dropped, initials only)');
log('  injection  →', JSON.stringify(injected));
log('  escaped    →', esc('<img src=x onerror=alert(1)>'));
log('  wall display may place a patient?', canAct('wall', 'place'), '· charge nurse may divert?', canAct('charge', 'divert'));
log(`\nAudit log: ${AUDIT.length} entries, e.g. ${JSON.stringify(AUDIT[0])}`);
log(`End state: mode ${S.mode} · ${S.waiting.length} waiting · ${S.beds.filter(b => b.pid).length}/12 beds in use`);
