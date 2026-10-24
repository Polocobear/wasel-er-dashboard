/* =========================================================================
 * ER Crisis Command Center · 10-engine.js
 * Live simulation of the ED and the 10 source systems that feed it:
 * arrivals (EMS + walk-in), physiology, beds, staff, equipment, supplies,
 * disposition, and the five crisis scenarios.
 *
 * Pure state transitions on S plus feed messages via emit(); no DOM access.
 * Time is simulated seconds (S.t). step(dt) advances in chunks of <= 10 s and
 * hands control to the AI layer (assessAll/aiPlan) after every chunk.
 * ========================================================================= */

/* ---------- Tuning ---------- */
const SIM_CFG = {
  maxChunkSec: 10,            // largest single advance() so vitals/arrivals stay smooth
  walkInPerMin: 1 / 7,        // baseline walk-in arrival rate
  cleaningMin: 8,             // bed turnaround after a patient leaves
  ctScanMin: 7,
  labEverySec: 150,           // one LIS result message
  keepD2bSec: 2 * 3600,
  keepDoneSec: 2 * 3600,
  keepSupLogSec: 3600,
  dropArrivedSec: 120,        // arrived ambulances linger briefly on the inbound board
  dropDivertedSec: 180,
  pruneOffNurseSec: 2 * 3600,
};

// Adult age bands per condition (NEWS2 is validated for patients aged 16+)
const AGE_BAND = {
  chestPain: [42, 86], stroke: [52, 90], sepsis: [36, 91], dyspnea: [34, 88],
  asthma: [16, 48], ankle: [16, 46], whiplash: [18, 64], fever: [16, 72],
};

/* ---------- Laboratory results (HL7 v2 ORU^R01, LOINC-coded) ---------- */
const LAB_TESTS = {
  hgb:  { code: '718-7',   name: 'Hemoglobin',        unit: 'g/dL',    dp: 1, lo: 12,  hi: 17.5, critLo: 8 },
  lact: { code: '2524-7',  name: 'Lactate',           unit: 'mmol/L',  dp: 1, lo: 0.5, hi: 2,    critHi: 4 },
  trop: { code: '10839-9', name: 'Troponin I',        unit: 'ng/mL',   dp: 2, lo: 0,   hi: 0.04, critHi: 0.5 },
  cohb: { code: '20563-3', name: 'Carboxyhemoglobin', unit: '%',       dp: 0, lo: 0,   hi: 3,    critHi: 15 },
  wbc:  { code: '6690-2',  name: 'Leukocytes',        unit: '10*3/uL', dp: 1, lo: 4,   hi: 11,   critHi: 30 },
  glu:  { code: '2345-7',  name: 'Glucose',           unit: 'mg/dL',   dp: 0, lo: 70,  hi: 140,  critLo: 50, critHi: 400 },
};
// Most informative first result per condition: [test, min, max]
const LAB_BY_COND = {
  polytrauma: ['hgb', 6.8, 9.6], abdo: ['hgb', 7.4, 10.5], femur: ['hgb', 9.5, 12.5], pneumo: ['hgb', 11, 14],
  burnMod: ['hgb', 15, 18.5], burnMajor: ['lact', 2.2, 4.8], sepsis: ['lact', 2.4, 5.4], chestPain: ['trop', 0.01, 0.9],
  smokeMild: ['cohb', 4, 12], smokeSev: ['cohb', 12, 28], fever: ['wbc', 11, 19], abdoPain: ['wbc', 7, 16],
};

const countPts = n => n + (n === 1 ? ' pt' : ' pts');
const occupiesBed = p => p.stage === 'treatment' || p.stage === 'boarding';

/* ---------- Session setup ---------- */
function init() {
  S = newState(S ? S.speed : 30);

  for (const z of ZONES) {
    for (let i = 1; i <= z.count; i++) S.beds.push({ id: z.id + i, zone: z.id, status: 'free', pid: null, until: 0, hold: null });
  }
  const hours = shuffle([11.7, 10.5, 8.2, 7.5, 6.9, 5.1, 4.4, 3.9, 3.2, 2.8, 2.1, 1.6, 1.2, 0.6]);
  NURSES.forEach((name, i) => S.nurses.push({
    id: 'N' + (i + 1), name, hours: hours[i], status: 'on', handover: false,
    arriveAt: null, covers: null, offReason: null, offAt: null,
  }));
  for (const s of SOURCES) S.src[s.id] = { status: 'live', last: 0 };

  // Baseline census: patients already in treatment (placed silently, no door-to-bed sample)
  const census = rint(16, 18);
  for (let i = 0; i < census; i++) {
    const p = makePatient(weighted(MIX.walkin), 'Walk-in');
    if (p.esi <= 2 && Math.random() < 0.6) p.src = 'EMS';
    const b = seedBedFor(p);
    if (!b) continue;
    p.stage = 'waiting';
    p.arrivedAt = -rnd(20, 200) * 60;
    if (p.src === 'EMS') waselSeedEms(p);   // WASEL: T- encounter + ATMIST for ambulance arrivals
    S.patients.push(p);
    place(p, b, bestNurse(p), 'baseline', true);
    p.bedAt = p.arrivedAt + rnd(4, 20) * 60;
    p.treatEnd = S.t + rnd(8, 120) * 60;
    // Vitals reflect the treatment already received since bedAt
    const inBedMin = (S.t - p.bedAt) / 60;
    relaxVitals(p, 1 - Math.pow(0.93, inBedMin));
    if (Math.random() < Math.min(1, 0.02 * inBedMin)) p.v.avpu = 'A';
    seedHistory(p);
  }

  // Waiting room: an early sepsis that starts to decline within minutes (shows the
  // early-warning loop without any scenario) plus two routine walk-ins
  ['sepsis', weighted(MIX.walkin), weighted(MIX.walkin)].forEach((key, i) => {
    const p = makePatient(key, 'Walk-in');
    if (i === 0) { p.det = true; p.detStart = S.t + rnd(2, 5) * 60; }
    p.stage = 'waiting';
    p.arrivedAt = -rnd(3, 25) * 60;
    S.patients.push(p);
    seedHistory(p);
  });

  for (let i = 0; i < S.icu.used; i++) schedule(rnd(25, 220) * 60, icuStepDown);
  for (let i = 0; i < S.or.used; i++) schedule(rnd(15, 90) * 60, orFinish);

  // Last hour of occupancy: mean-reverting wander (±6 points) that ends at today's census
  const now = bedsBusy() / S.beds.length * 100;
  let w = rnd(-4, 4);
  for (let m = 60; m >= 1; m--) {
    w = clamp(w * 0.85 + rnd(-2, 2), -6, 6);
    S.occ.push({ t: S.t - m * 60, occ: clamp(now + w * Math.min(1, m / 8), 0, 100) });
  }
  for (let i = 0; i < 8; i++) S.d2b.push({ t: S.t - rnd(0, 55) * 60, m: rnd(4, 22) });
  S.d2b.sort((a, b) => a.t - b.t);
  // Encounters completed in the last hour, so the disposition stage has a baseline
  const recent = rint(5, 8);
  for (let i = 0; i < recent; i++) {
    S.done.push({ t: S.t - rnd(1, 59) * 60, dispo: weighted(Object.entries(COND[weighted(MIX.walkin)].dispo)) });
  }
  S.done.sort((a, b) => a.t - b.t);

  emit('ehr', 'FHIR', 'Gateway connected · ' + SOURCES.length + ' source systems streaming');
  audit('Session started (demo sign-in)');
  // First plan now, so the first frame (and every reset) shows scores, forecast and decisions
  assessAll();
  aiPlan();
}

// Random free bed in the first preferred zone that has one (baseline looks organic, not R1, R2, R3…)
function seedBedFor(p) {
  for (const z of ZONE_PREF[p.esi]) {
    const free = S.beds.filter(b => b.zone === z && b.status === 'free');
    if (free.length) return pick(free);
  }
  return null;
}

/* ---------- Patients ---------- */
function makePatient(condKey, src) {
  const c = COND[condKey];
  const sex = Math.random() < 0.5 ? 'M' : 'F';
  const band = AGE_BAND[condKey] || [18, 82];
  const v = {
    hr: c.v.hr + rnd(-4, 4), sbp: c.v.sbp + rnd(-6, 6), rr: c.v.rr + rnd(-1.5, 1.5),
    spo2: Math.min(100, c.v.spo2 + rnd(-1, 1)), temp: c.v.temp + rnd(-0.2, 0.2),
    avpu: Math.random() < (c.avpu || 0) ? 'V' : 'A',
  };
  return waselEnrich({                 // WASEL: encounter id, identity, safety summary (15-wasel.js)
    id: 'P-' + S.nextPid++, mrn: String(rint(1000000, 9999999)),
    first: pick(sex === 'M' ? NAMES.m : NAMES.f), last: pick(NAMES.last), sex, age: rint(band[0], band[1]),
    cond: condKey, src, esi: rint(c.esi[0], c.esi[1]), v, onO2: false,
    det: Math.random() < (c.det || 0),
    detStart: S.t + (c.delay ? rnd(c.delay[0], c.delay[1]) : 0) * 60,
    stage: 'inbound', amb: null, arrivedAt: null, reservedBed: null,
    bed: null, nurse: null, bedAt: null, treatEnd: null, dispo: null, boardSince: null, boardUntil: null,
    monitor: false, vent: false, needsVent: false, retriaged: false, diverted: false,
    hist: [], news: news2(v, false), trend: 0, flag: null,
  });
}

// Ten per-minute samples before now, so trends and sparklines have context from the first frame
function seedHistory(p) {
  const v = p.v;
  p.hist = [];
  for (let k = 10; k >= 1; k--) {
    const s = {
      hr: v.hr + rnd(-2.5, 2.5), sbp: v.sbp + rnd(-4, 4), rr: v.rr + rnd(-1, 1),
      spo2: Math.min(100, v.spo2 + rnd(-0.8, 0.8)), temp: v.temp, avpu: v.avpu,
    };
    p.hist.push({ t: S.t - k * 60, hr: r0(s.hr), sbp: r0(s.sbp), rr: r0(s.rr), spo2: r0(s.spo2), news: news2(s, p.onO2) });
  }
}

function arrive(p) {
  const c = COND[p.cond];
  p.stage = 'waiting';
  p.arrivedAt = S.t;
  sample(p);
  emit('adt', 'HL7 v2', `ADT^A04 registered ${p.id} · triage ESI ${p.esi} · ${c.label} (ICD-10-CM ${c.icd})`);
  if (typeof readinessOnArrive === 'function') readinessOnArrive(p);   // NFC wristband tap at the bay (16-readiness.js)
  if (!p.reservedBed) return;
  const b = bed(p.reservedBed);
  if (b && b.status === 'reserved' && b.pid === p.id) place(p, b, bestNurse(p), 'pre-arrival');
  else p.reservedBed = null;
}

// Put a patient in a bed and start the encounter. Returns false if the bed is not
// available to this patient, so a stale decision can never double-book a bed.
function place(p, b, n, how, silent) {
  if (!p || !b || p.bed || p.stage === 'done') return false;
  const ownReservation = b.status === 'reserved' && b.pid === p.id;
  if (b.status !== 'free' && !ownReservation) return false;
  if (p.reservedBed && p.reservedBed !== b.id) {
    const rb = bed(p.reservedBed);
    if (rb && rb.status === 'reserved' && rb.pid === p.id) { rb.status = 'free'; rb.pid = null; }
  }

  const c = COND[p.cond], needs = c.needs || {};
  b.status = 'occupied'; b.pid = p.id; b.hold = null;
  p.stage = 'treatment'; p.bed = b.id; p.nurse = n ? n.id : null; p.reservedBed = null;
  p.bedAt = S.t; p.treatEnd = S.t + rnd(c.treat[0], c.treat[1]) * 60;
  p.placedHow = how;
  p.det = false;               // treatment stops untreated deterioration
  if (!silent && p.arrivedAt != null) {
    S.d2b.push({ t: S.t, m: (S.t - p.arrivedAt) / 60 });
    S.d2b = S.d2b.filter(e => e.t >= S.t - SIM_CFG.keepD2bSec);
  }

  // Equipment and supplies the encounter takes on arrival in the bed
  const issued = [];
  if (p.esi <= 3 && monitorsFree() > 0) p.monitor = true;
  if (needs.vent && (Math.random() < needs.vent || p.v.spo2 < 90)) {
    if (ventsFree() > 0) p.vent = true; else p.needsVent = true;
  }
  if (needs.o2 && Math.random() < needs.o2) { p.onO2 = true; useSup('o2', 1); }
  for (const key of ['blood', 'burn']) {
    if (!needs[key]) continue;
    const k = rint(needs[key][0], needs[key][1]);
    if (k > 0) { useSup(key, k); issued.push([key, k]); }
  }
  if (needs.ct && Math.random() < needs.ct && !S.eq.ctQueue.includes(p.id)) S.eq.ctQueue.push(p.id);

  if (!silent) {
    emit('beds', 'FHIR', `Location ${b.id} → occupied (${p.id})`);
    for (const [key, k] of issued) emit('pharm', 'GS1', `Dispensed ${S.sup[key].label} × ${k} → ${p.id} (barcode scan)`);
  }
  return true;
}

function useSup(key, n) {
  const sp = S.sup[key];
  if (!sp || !(n > 0)) return;
  sp.qty = Math.max(0, sp.qty - n);
  sp.log.push({ t: S.t, n });
  while (sp.log.length && sp.log[0].t < S.t - SIM_CFG.keepSupLogSec) sp.log.shift();
}

function leave(p, text) {
  const b = bed(p.bed);
  if (b && b.pid === p.id) { b.status = 'cleaning'; b.until = S.t + SIM_CFG.cleaningMin * 60; b.pid = null; b.hold = null; }
  p.stage = 'done';
  p.monitor = false; p.vent = false; p.needsVent = false;
  S.done.push({ t: S.t, dispo: p.dispo });
  waselOnLeave(p);                     // family reunification board keeps incident patients
  S.eq.ctQueue = S.eq.ctQueue.filter(id => id !== p.id);
  emit('adt', 'HL7 v2', (p.dispo === 'discharge' ? 'ADT^A03' : 'ADT^A02') + ' ' + p.id + ' · ' + text);
}

/* ---------- Disposition and exit block (ward, ICU, OR capacity) ---------- */
function disposition(p) {
  p.dispo = weighted(Object.entries(COND[p.cond].dispo));
  if (p.dispo === 'discharge') { leave(p, 'Discharged home'); return; }
  p.stage = 'boarding';
  p.boardSince = S.t;
  if (p.dispo === 'ward') p.boardUntil = S.t + rnd(8, 35) * 60;
  tryLeave(p);
}

function tryLeave(p) {
  if (p.dispo === 'ward') {
    if (S.t >= p.boardUntil) leave(p, 'Admitted to ward');
  } else if (p.dispo === 'icu') {
    if (S.icu.used < S.icu.cap) {
      S.icu.used++;
      schedule(rnd(90, 240) * 60, icuStepDown);
      leave(p, 'Admitted to ICU');
    }
  } else if (p.dispo === 'or') {
    if (S.or.used < S.or.cap) {
      S.or.used++;
      schedule(rnd(60, 120) * 60, orFinish);
      leave(p, 'Taken to operating room');
    }
  }
}

function icuStepDown() {
  S.icu.used = Math.max(0, S.icu.used - 1);
  emit('ehr', 'FHIR', `ICU patient stepped down to ward · ICU ${S.icu.cap - S.icu.used}/${S.icu.cap} beds free`);
}

function orFinish() {
  S.or.used = Math.max(0, S.or.used - 1);
  emit('ehr', 'FHIR', `Operating room case completed · ${S.or.cap - S.or.used}/${S.or.cap} theatres free`);
}

/* ---------- EMS ---------- */
function dispatchAmb(inc, mixKey, n) {
  const a = {
    id: 'AMB-' + S.nextAmb++, incident: inc.id, pts: [], dispatchedAt: S.t,
    sceneUntil: S.t + rnd(3, 8) * 60, eta: 0, status: 'onscene', arrivedAt: null, divertedAt: null,
    prepared: false, prepBed: null, team: null,
  };
  a.eta = a.sceneUntil + rnd(5, 12) * 60;
  for (let i = 0; i < n; i++) {
    const p = makePatient(weighted(MIX[mixKey]), 'EMS');
    p.amb = a.id;
    waselFieldReport(p, inc);          // temporary encounter id, field identity, ATMIST pre-alert
    // En-route care keeps casualties compensated; untreated decline (e.g. a silent
    // abdominal bleed) starts after handover, in the waiting room where the AI must catch it.
    p.detStart += a.eta - S.t;
    a.pts.push(p.id);
    S.patients.push(p);
  }
  S.ambulances.push(a);
  emit('ems', 'CAD', `${a.id} on scene · ${countPts(n)} field-triaged · worst ESI ${ambEsi(a)}`);
  if (S.diversionUntil > S.t && ambEsi(a) >= 4) divert(a);
  return a;
}

function divert(a) {
  if (!a || a.status === 'arrived' || a.status === 'diverted') return;
  const esi = ambEsi(a);
  const pts = a.pts.map(P).filter(p => p && p.stage === 'inbound');
  a.status = 'diverted';
  a.divertedAt = S.t;
  for (const p of pts) {
    p.stage = 'done';
    p.diverted = true;
    const rb = p.reservedBed ? bed(p.reservedBed) : null;
    if (rb && rb.status === 'reserved' && rb.pid === p.id) { rb.status = 'free'; rb.pid = null; }
    p.reservedBed = null;
  }
  emit('ems', 'CAD', `${a.id} diverted to nearest available ED · ${countPts(pts.length)} · worst ESI ${esi}`);
}

/* ---------- Staff ---------- */
function callIn(etaMin) {
  const n = {
    id: 'N' + S.nextNurse++, name: ONCALL[S.nextOnCall++ % ONCALL.length], hours: 0, status: 'incoming',
    handover: false, arriveAt: S.t + etaMin * 60, covers: null, offReason: null, offAt: null,
  };
  S.nurses.push(n);
  emit('roster', 'REST API', `On-call nurse ${n.name} called in · ETA ${Math.round(etaMin)} min`);
  return n;
}

function nurseArrives(n) {
  n.status = 'on';
  emit('roster', 'REST API', `On-call nurse ${n.name} arrived · on duty`);
  const old = n.covers ? nurse(n.covers) : null;
  if (!old) return;
  const pts = S.patients.filter(p => p.nurse === old.id && occupiesBed(p));
  for (const p of pts) p.nurse = n.id;
  if (old.status === 'on') { old.status = 'off'; old.offReason = 'Handed over'; old.offAt = S.t; }
  old.handover = false;
  emit('roster', 'I-PASS', `Structured handover: ${old.name} → ${n.name} (${pts.length} patient${pts.length === 1 ? '' : 's'})`);
}

/* ---------- Clock ---------- */
function step(dt) {
  if (!S || !(dt > 0)) return;
  let left = dt;
  while (left > 1e-6) {
    const d = Math.min(SIM_CFG.maxChunkSec, left);
    advance(d);
    left -= d;
  }
}

function advance(d) {
  const dm = d / 60;
  S.t += d;
  runSchedule();
  advanceAmbulances();
  advanceWalkIns(dm);
  for (const p of S.patients) {
    updateVitals(p, dm);
    if (p.stage === 'treatment' && S.t >= p.treatEnd) disposition(p);
    else if (p.stage === 'boarding') tryLeave(p);
  }
  S.patients = S.patients.filter(p => p.stage !== 'done');
  advanceBeds();
  advanceCt();
  advanceStaff(d);
  advanceTelemetry(d);
  if (S.bedsOffline && S.t >= S.outageUntil) restoreBeds();
  resolveBanners();
  // AI layer (20-ai.js) re-reads the whole state after every change
  assessAll();
  aiPlan();
}

function advanceAmbulances() {
  for (const a of S.ambulances) {
    if (a.status === 'onscene' && S.t >= a.sceneUntil) {
      a.status = 'enroute';
      emit('ems', 'CAD', `${a.id} departed scene · ${countPts(a.pts.length)} · ETA ${mins(a.eta - S.t)} min`);
    }
    if (a.status === 'enroute' && S.t >= a.eta) {
      a.status = 'arrived';
      a.arrivedAt = S.t;
      const pts = a.pts.map(P).filter(p => p && p.stage === 'inbound');
      emit('ems', 'CAD', `${a.id} arrived · handover of ${countPts(pts.length)} received`);
      for (const p of pts) arrive(p);
    }
  }
  S.ambulances = S.ambulances.filter(a =>
    !(a.status === 'arrived' && S.t - a.arrivedAt > SIM_CFG.dropArrivedSec) &&
    !(a.status === 'diverted' && S.t - a.divertedAt > SIM_CFG.dropDivertedSec));
}

// Poisson walk-ins; during an MCI the "worried well" and minor casualties self-present
function advanceWalkIns(dm) {
  if (S.walkBoost && S.t >= S.walkBoost.until) S.walkBoost = null;
  const boost = S.walkBoost;
  const rate = SIM_CFG.walkInPerMin + (boost ? boost.rate : 0);
  if (Math.random() >= rate * dm) return;
  const mix = boost && Math.random() < 0.6 ? boost.mix : 'walkin';
  const p = makePatient(weighted(MIX[mix]), 'Walk-in');
  S.patients.push(p);
  arrive(p);
}

function advanceBeds() {
  for (const b of S.beds) {
    if (b.status === 'cleaning' && S.t >= b.until) {
      b.status = 'free';
      b.until = 0;
      emit('beds', 'FHIR', `Location ${b.id} → available (cleaned)`);
    }
  }
}

function advanceCt() {
  for (const u of S.eq.ct) {
    if (!u.online || u.busyUntil > S.t) continue;
    let p = null;
    while (!p && S.eq.ctQueue.length) {
      const next = P(S.eq.ctQueue.shift());
      if (next && occupiesBed(next)) p = next;
    }
    if (!p) return;
    u.busyUntil = S.t + SIM_CFG.ctScanMin * 60;
    emit('ris', 'DICOM', `${u.id} (${u.loc}) scanning ${p.id}`);
  }
}

function advanceStaff(d) {
  for (const n of S.nurses) {
    if (n.status === 'on') n.hours += d / 3600;
    else if (n.status === 'incoming' && S.t >= n.arriveAt) nurseArrives(n);
  }
  S.nurses = S.nurses.filter(n => n.status !== 'off' || S.t - n.offAt < SIM_CFG.pruneOffNurseSec ||
    S.patients.some(p => p.nurse === n.id));
}

function advanceTelemetry(d) {
  if (S.t - S.lastSample >= 60) {
    S.lastSample = S.t;
    for (const p of S.patients) sample(p);
    S.occ.push({ t: S.t, occ: bedsBusy() / S.beds.length * 100 });
    if (S.occ.length > 60) S.occ.shift();
    updateMode();                      // WASEL operating mode, re-evaluated once per sim minute
    S.d2b = S.d2b.filter(e => e.t >= S.t - SIM_CFG.keepD2bSec);
    S.done = S.done.filter(e => e.t >= S.t - SIM_CFG.keepDoneSec);
  }
  if (S.t - S.lastBeat >= 30) {
    S.lastBeat = S.t;
    for (const id in S.src) if (S.src[id].status === 'live') S.src[id].last = S.t;
  }
  if (S.t - S.lastVitMsg >= 20) {
    S.lastVitMsg = S.t;
    emitVitalsMessage();
  }
  if (Math.floor(S.t / SIM_CFG.labEverySec) > Math.floor((S.t - d) / SIM_CFG.labEverySec)) emitLabResult();
}

function emitVitalsMessage() {
  const pool = S.patients.filter(p => p.stage !== 'inbound');
  if (!pool.length) return;
  const p = pick(pool), key = pick(['hr', 'hr', 'spo2', 'sbp', 'rr', 'temp']), L = LOINC[key];
  emit('mon', 'IEEE 11073', `Observation LOINC ${L.code} ${L.name} = ${fmtV(key, p.v[key])} ${L.unit} · ${p.id}`);
}

function emitLabResult() {
  const pool = S.patients.filter(p => p.stage === 'treatment');
  if (!pool.length) return;
  const p = pick(pool);
  const [key, lo, hi] = LAB_BY_COND[p.cond] || ['glu', 82, 176];
  const T = LAB_TESTS[key], val = rnd(lo, hi);
  // HL7 v2 OBX-8 abnormal flags: LL/HH critical, L/H outside reference range
  const flag = val < (T.critLo ?? -Infinity) ? 'LL' : val > (T.critHi ?? Infinity) ? 'HH'
    : val < T.lo ? 'L' : val > T.hi ? 'H' : '';
  const tail = flag ? ` [${flag}${flag.length === 2 ? ', critical' : ''}]` : '';
  emit('lis', 'HL7 v2', `ORU^R01 ${p.id} · LOINC ${T.code} ${T.name} = ${val.toFixed(T.dp)} ${T.unit}${tail}`);
}

/* ---------- Physiology ---------- */
function updateVitals(p, dm) {
  const v = p.v, c = COND[p.cond];
  if (occupiesBed(p)) {
    relaxVitals(p, 1 - Math.pow(0.93, dm));
    if (v.avpu !== 'A' && Math.random() < 0.02 * dm) v.avpu = 'A';
  } else if (p.det && c.drift && S.t >= p.detStart) {
    v.hr += c.drift.hr * dm;
    v.sbp += c.drift.sbp * dm;
    v.rr += c.drift.rr * dm;
    v.spo2 += c.drift.spo2 * dm;
  }
  v.hr += rnd(-1.5, 1.5) * dm;
  v.sbp += rnd(-1.5, 1.5) * dm;
  v.rr += rnd(-0.4, 0.4) * dm;
  v.spo2 += rnd(-0.3, 0.3) * dm;
  v.hr = clamp(v.hr, 30, 190);
  v.sbp = clamp(v.sbp, 50, 220);
  v.rr = clamp(v.rr, 6, 45);
  v.spo2 = clamp(v.spo2, 70, 100);
  v.temp = clamp(v.temp, 34, 41);
}

// Exponential return toward normal physiology while under treatment (k = fraction closed)
function relaxVitals(p, k) {
  const v = p.v;
  v.hr += (84 - v.hr) * k;
  v.sbp += (122 - v.sbp) * k;
  v.rr += (16 - v.rr) * k;
  v.spo2 += ((p.onO2 || p.vent ? 97 : 96) - v.spo2) * k;
  v.temp += (37 - v.temp) * k / 2;
}

function sample(p) {
  const v = p.v;
  p.hist.push({ t: S.t, hr: r0(v.hr), sbp: r0(v.sbp), rr: r0(v.rr), spo2: r0(v.spo2), news: news2(v, p.onO2) });
  if (p.hist.length > 90) p.hist.shift();
}

/* ---------- Crisis scenarios ---------- */
function incident(name, where, via, est, kind) {
  const inc = { id: 'INC-' + S.nextInc++, name, place: where, via, est, startedAt: S.t, kind };
  S.incidents.push(inc);
  emit('ems', 'CAD', `${inc.id} detected via ${via}: ${name}, ${where} · est. ${est} casualties`);
  return inc;
}

const SCEN = {
  pileup() {
    const inc = incident('Multi-vehicle collision', 'E311 highway, km 42', '998 call + smart traffic cameras', 22, 'pileup');
    [3, 3, 2, 3, 2, 3, 2, 2, 2].forEach((n, i) => schedule(i * 80, () => dispatchAmb(inc, 'pileup', n)));
    S.walkBoost = { until: S.t + 50 * 60, rate: 1 / 4, mix: 'minor' };
    addBanner('MCI active · Highway pile-up · 22 casualties expected', 'critical', 'mci-pileup');
  },
  fire() {
    const inc = incident('Residential tower fire', 'Tower B, Sector 4', '997 call + building fire-alarm link', 15, 'fire');
    [3, 2, 3, 2, 2, 3].forEach((n, i) => schedule(i * 90, () => dispatchAmb(inc, 'fire', n)));
    S.walkBoost = { until: S.t + 40 * 60, rate: 1 / 6, mix: 'fireMinor' };
    addBanner('MCI active · Residential tower fire · 15 casualties expected', 'critical', 'mci-fire');
  },
  staff() {
    const pool = S.nurses.filter(n => n.status === 'on' && !n.handover)
      .sort((a, b) => nurseLoad(b) - nurseLoad(a)).slice(0, 3);
    if (!pool.length) return;
    for (const n of pool) { n.status = 'off'; n.offReason = 'Redeployed to ICU'; n.offAt = S.t; }
    const ids = pool.map(n => n.id);
    const uncovered = S.patients.filter(p => occupiesBed(p) && ids.includes(p.nurse)).length;
    emit('roster', 'REST API', `${pool.map(n => n.name).join(', ')} redeployed to ICU · ${uncovered} ED patient${uncovered === 1 ? '' : 's'} without a nurse`);
    addBanner(`Staff shortage · ${pool.length} nurse${pool.length === 1 ? '' : 's'} redeployed to ICU`, 'serious', 'staff');
  },
  equipment() {
    const ct1 = S.eq.ct.find(u => u.id === 'CT-1');
    if (ct1) ct1.online = false;
    S.eq.ventFaulty = Math.min(S.eq.vents, S.eq.ventFaulty + 2);
    emit('ris', 'DICOM', 'CT-1 (ED) reported offline: gantry fault');
    emit('rtls', 'RTLS', 'Ventilators V-03, V-08 failed self-test');
    addBanner('Equipment failure · CT-1 offline · 2 ventilators out of service', 'serious', 'equip');
  },
  outage() {
    if (S.bedsOffline) { S.outageUntil = S.t + 25 * 60; return; }
    S.bedsOffline = true;
    S.bedsFallback = false;
    S.bedsSnapshot = S.beds.map(b => ({ ...b }));
    S.bedsSnapAt = S.t;
    S.outageUntil = S.t + 25 * 60;
    S.src.beds.status = 'offline';
    // emit() drops bed messages while the interface is down, so the timeout is logged directly
    S.feed.unshift({ t: S.t, src: 'beds', std: 'FHIR', text: 'Bed management interface not responding (timeout)' });
    if (S.feed.length > 80) S.feed.pop();
    addBanner('Bed management feed offline · bed board may be stale', 'serious', 'outage');
  },
};

const SCEN_LABEL = {
  pileup: 'Highway pile-up', fire: 'Residential tower fire', staff: 'Staff shortage',
  equipment: 'Equipment failure', outage: 'Bed system outage',
};

function runScenario(id) {
  // id comes from a DOM data attribute: only own keys of SCEN are runnable
  if (!Object.prototype.hasOwnProperty.call(SCEN, id)) return false;
  SCEN[id]();
  audit('Scenario started: ' + SCEN_LABEL[id]);
  return true;
}

function restoreBeds() {
  const snap = S.bedsSnapshot || [];
  const changed = S.beds.filter(b => {
    const was = snap.find(x => x.id === b.id);
    return !was || was.status !== b.status;
  }).length;
  S.bedsOffline = false;
  S.bedsFallback = false;
  S.bedsSnapshot = null;
  S.src.beds.status = 'live';
  S.src.beds.last = S.t;
  emit('beds', 'FHIR', `Bed management feed restored · ${changed} bed change${changed === 1 ? '' : 's'} reconciled`);
  clearBanner('outage');
}

// Banners reflect live conditions: they stand down once the underlying problem is resolved
function resolveBanners() {
  for (const inc of S.incidents) {
    if (inc.closedAt != null || S.t - inc.startedAt < 20 * 60) continue;
    const inField = S.ambulances.some(a => a.incident === inc.id && (a.status === 'onscene' || a.status === 'enroute'));
    // this incident's own casualties: an unrelated walk-in must not hold the MCI open (WASEL mode)
    const acuteWaiting = S.patients.some(p => p.stage === 'waiting' && p.esi <= 2 && p.incident === inc.id);
    if (inField || acuteWaiting) continue;
    inc.closedAt = S.t;
    emit('ems', 'CAD', `${inc.id} stand-down: scene cleared, all casualties transported`);
    if (!S.incidents.some(i => i.kind === inc.kind && i.closedAt == null)) clearBanner('mci-' + inc.kind);
  }
  if (S.banners.some(b => b.key === 'equip') && S.eq.ct.every(u => u.online) && S.eq.ventFaulty === 0) clearBanner('equip');
  if (S.banners.some(b => b.key === 'staff')) {
    const lastRedeploy = Math.max(-Infinity, ...S.nurses.filter(n => n.offReason === 'Redeployed to ICU').map(n => n.offAt));
    if (S.t - lastRedeploy >= 10 * 60 && !orphans().length) clearBanner('staff');
  }
}
