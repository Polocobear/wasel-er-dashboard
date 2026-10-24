/* =========================================================================
 * WASEL ER Command Dashboard · 15-wasel.js
 * The v2 layer from the team's WASEL design doc, on top of engine + AI:
 *   operating modes (Steady → Strain → Surge → MCI) and the silent surge
 *   encounters and identity: a face match is only ever a *candidate*
 *   the safety summary (allergies, anticoagulant, blood type, history)
 *   ATMIST field reports and live pre-alerts from the responder app
 *   task owners, clocks and escalation · lobby leave-without-being-seen risk
 *   medication safety checks · SBAR handover · family reunification board
 *
 * Privacy (UAE PDPL, biometrics are sensitive data): identities arrive as a
 * match result plus initials only, never names, images or ID numbers;
 * records the patient restricted are never loaded; the family board shows
 * status only, no medical details.
 * Naming: spec'd API is unprefixed (updateMode, receivePreAlert, checkOrder,
 * overrideOrder, sbar, familyBoard, DRUGS, ESC_MIN); engine/AI hooks and
 * extra helpers are wasel*, internals wsl*. No DOM access (runs headless).
 * ========================================================================= */

/* ---------- Tuning ---------- */
const WASEL_CFG = {
  lwbsMin: 60,             // ESI 4–5 lobby wait before leave-without-being-seen risk
  surgeNurses: 2,          // silent surge: on-call nurses recalled
  surgeBeds: 2,            // silent surge: recovery-room beds opened as critical-care overflow
  oncallEtaMin: 25,
  reunifyMax: 300,         // family board entries kept for patients who have left
  maxReasonLen: 200,       // free-text override / break-glass reasons
};

/* ---------- Synthetic record data (fictional) ---------- */
const WASEL_ALLERGENS = ['Penicillin', 'Sulfonamides', 'NSAIDs', 'Latex', 'Contrast media', 'Morphine'];
const WASEL_CHRONIC = ['Type 2 diabetes', 'Hypertension', 'Asthma', 'CKD stage 3', 'Atrial fibrillation'];
// ABO/Rh mix typical of the UAE population (weights in percent)
const WASEL_BLOOD = [['O+', 38], ['A+', 25], ['B+', 23], ['AB+', 6], ['O-', 3.5], ['A-', 2.5], ['B-', 1.5], ['AB-', 0.5]];
// UAE health information exchanges: Riayati (MOHAP), Malaffi (Abu Dhabi), NABIDH (Dubai)
const WASEL_HIE = [['Riayati', 50], ['Malaffi', 30], ['NABIDH', 20]];

// ATMIST field findings and en-route care per condition: [injuries, treatment]
const WASEL_FIELD = {
  polytrauma: ['Chest and pelvic injuries, reduced consciousness', 'Pelvic binder, 1 L saline, oxygen 15 L/min'],
  pneumo:     ['Left chest wall tenderness, reduced air entry', 'Oxygen 15 L/min, vented chest seal'],
  abdo:       ['Seatbelt bruising, abdominal tenderness', '1 L saline'],
  femur:      ['Deformed right thigh, suspected femur fracture', 'Traction splint, 10 mg morphine IV'],
  headinj:    ['Scalp laceration, brief loss of consciousness', 'Cervical collar, oxygen 15 L/min'],
  ribs:       ['Right chest wall tenderness, painful breathing', 'Oxygen 15 L/min, 1 g paracetamol IV'],
  wrist:      ['Deformed left wrist', 'Splint'],
  whiplash:   ['Neck pain, no neurological deficit', 'Cervical collar'],
  laceration: ['Forehead laceration, bleeding controlled', 'Pressure dressing'],
  smokeMild:  ['Cough, soot in nostrils', 'Oxygen 15 L/min'],
  smokeSev:   ['Hoarse voice, singed nasal hair, stridor', 'Oxygen 15 L/min, airway watch'],
  burnMinor:  ['Partial-thickness burns to one hand', 'Burns dressings, cooled 20 min'],
  burnMod:    ['Burns to arms and chest (~15% TBSA)', 'Burns dressings, 1 L Hartmann\'s'],
  burnMajor:  ['Full-thickness burns (~35% TBSA)', 'Burns dressings, 1 L Hartmann\'s, oxygen 15 L/min'],
};
const WASEL_MECHANISM = {
  pileup: ['Driver, frontal collision ~100 km/h', 'Rear passenger, rollover', 'Front passenger, side impact',
    'Driver, rear-ended in stationary traffic', 'Motorcyclist thrown ~15 m', 'Pedestrian struck at ~40 km/h'],
  fire: ['Trapped on 9th floor, smoke exposure 20 min', 'Evacuated via smoke-filled stairwell, ~10 min exposure',
    'Burned escaping apartment fire, 6th floor', 'Rescued from 12th-floor balcony, smoke exposure 25 min'],
};

/* ---------- Small helpers ---------- */
const wslObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const wslHas = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const wslCap = s => s.charAt(0).toUpperCase() + s.slice(1);
const wslEncNum = enc => parseInt(String(enc).replace(/\D/g, ''), 10) || 0;
const wslModeRank = m => MODE_RULES.order.indexOf(m);
// START field-triage colour for an ESI level (red = immediate, yellow = delayed, green = minor)
const wslStart = esi => esi <= 2 ? 'red' : esi === 3 ? 'yellow' : 'green';
const WASEL_METHOD_LABEL = { face: 'face', fingerprint: 'fingerprint', nfc: 'NFC', 'emirates-id': 'Emirates ID', none: 'none' };

// Printable single-line text from an untrusted value: control characters removed, length capped
function wslText(x, max) {
  if (typeof x !== 'string' && typeof x !== 'number') return '';
  return String(x).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}
// 'YYYY-MM-DD' for a sim date `days` before now
function wslDaysAgo(days) {
  const d = simDate(S.t - days * 86400);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// 'm:ss' for a duration in seconds
function wslMS(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + pad2(s % 60);
}
function wslIdentityText(id) {
  if (id.status === 'temporary') return 'temporary ID';
  const how = WASEL_METHOD_LABEL[id.method] || id.method;
  return `${id.status} (${how}${id.status === 'candidate' && id.confidence != null ? ' ' + pct(id.confidence) : ''})`;
}

/* ---------- Encounters, identity and the safety summary ---------- */
// Called by makePatient(): a patient starts as a registered walk-in, identity
// confirmed at the desk (Emirates ID) and the health record linked.
function waselEnrich(p) {
  p.enc = p.id;
  p.identity = { status: 'confirmed', method: 'emirates-id', confidence: null };
  p.incident = null; p.fieldAt = null; p.atmist = null; p.start = null;
  p.preAlert = false; p.clinicOffer = false; p.orders = [];
  wslLinkRecord(p);
  return p;
}

// Called by dispatchAmb(): temporary encounter id, field identity and the ATMIST pre-alert.
function waselFieldReport(p, inc) {
  p.enc = wslNextEncounter();
  p.incident = inc.id;
  p.fieldAt = S.t;
  const status = weighted([['candidate', 55], ['confirmed', 15], ['temporary', 30]]);
  p.identity = status === 'candidate' ? { status, method: 'face', confidence: Math.round(rnd(0.86, 0.98) * 100) / 100 }
    : status === 'confirmed' ? { status, method: 'nfc', confidence: null }
    : { status, method: 'none', confidence: null };
  wslLinkRecord(p);
  p.atmist = wslAtmist(p, inc);
  if (S.mode === 'mci') p.start = wslStart(p.esi);
}

// T-101, T-102, … never reusing an id that is still on the board
function wslNextEncounter() {
  let enc;
  do enc = 'T-' + S.nextEnc++; while (S.patients.some(p => p.enc === enc));
  return enc;
}

// Safety summary + chronic history from the linked record. A temporary identity has no
// record (all Unknown); a restricted record (patient opted out) is never loaded.
function wslLinkRecord(p) {
  const temporary = p.identity.status === 'temporary', restricted = !temporary && Math.random() < 0.03;
  p.history = [];
  if (temporary || restricted) {
    p.meds = null;
    p.safety = { allergies: null, anticoagulant: null, bloodType: null, source: null, asOf: null, restricted };
    return;
  }
  const r = Math.random();
  const allergies = r < 0.05 ? shuffle(WASEL_ALLERGENS).slice(0, 2) : r < 0.30 ? [pick(WASEL_ALLERGENS)] : [];
  const anticoagulant = Math.random() < 0.10;
  p.meds = anticoagulant ? [pick(['Warfarin', 'Apixaban'])] : [];
  p.safety = { allergies, anticoagulant, bloodType: weighted(WASEL_BLOOD), source: weighted(WASEL_HIE),
    asOf: wslDaysAgo(rint(3, 730)), restricted: false };
  // 0–2 chronic conditions; anticoagulation implies its indication (atrial fibrillation)
  const conds = shuffle(WASEL_CHRONIC).slice(0, weighted([[0, 55], [1, 30], [2, 15]]));
  if (anticoagulant && !conds.includes('Atrial fibrillation')) conds.splice(0, conds.length === 2 ? 1 : 0, 'Atrial fibrillation');
  p.history = conds.map(label => ({ label, source: weighted(WASEL_HIE), asOf: wslDaysAgo(rint(30, 3650)) }));
}

// ATMIST: Age, Time of injury, Mechanism, Injuries, Signs, Treatment (snapshot at dispatch)
function wslAtmist(p, inc) {
  const field = WASEL_FIELD[p.cond] || [COND[p.cond].label, 'Observations only'], v = p.v;
  return {
    age: String(p.age),
    time: fmtClock(inc.startedAt),
    mechanism: pick(WASEL_MECHANISM[inc.kind] || ['Found at scene']),
    injuries: field[0],
    signs: { hr: r0(v.hr), sbp: r0(v.sbp), rr: r0(v.rr), spo2: r0(v.spo2), gcs: v.avpu === 'A' ? 15 : rint(9, 13) },
    treatment: field[1],
  };
}

/* ---------- Operating modes (rules in MODE_RULES, 00-core.js) ---------- */
// Pure: the mode the rules call for right now, the deciding rule, and every rule that holds.
function waselModeCheck() {
  const R = MODE_RULES, strain = [], surge = [], mci = [];
  const occ = bedsBusy() / (S.beds.length || 1) * 100;
  if (occ >= R.strain.occupancyPct) strain.push(`occupancy ${r0(occ)}% (≥ ${R.strain.occupancyPct}%)`);
  let wait = 0, waitP = null, board = 0;
  for (const p of S.patients) {
    if (p.stage === 'waiting' && p.esi <= 2 && S.t - p.arrivedAt > wait) { wait = S.t - p.arrivedAt; waitP = p; }
    if (p.stage === 'boarding') board = Math.max(board, S.t - p.boardSince);
  }
  if (waitP && wait > R.strain.esi2WaitMin * 60) strain.push(`ESI ${waitP.esi} patient ${waitP.enc} waiting ${mins(wait)} min (> ${R.strain.esi2WaitMin})`);
  if (board > R.strain.boardingMin * 60) strain.push(`patient boarding ${mins(board)} min (> ${R.strain.boardingMin})`);

  if (strain.length >= R.surge.strainRules) surge.push(`${strain.length} strain rules hold: ${strain.join('; ')}`);
  const oneg = S.sup.blood.qty, vents = ventsFree();
  if (oneg <= R.surge.oNegUnits) surge.push(`O-negative blood ${oneg} units (≤ ${R.surge.oNegUnits})`);
  if (vents <= R.surge.ventsFree) surge.push(`${vents} ventilator${vents === 1 ? '' : 's'} free (≤ ${R.surge.ventsFree})`);

  if (S.mciDeclared) mci.push('MCI declared by the command team');
  for (const inc of S.incidents) {
    if (inc.closedAt == null && inc.est >= R.mci.incidentEst) mci.push(`${inc.id} ${inc.name}: est. ${inc.est} casualties (≥ ${R.mci.incidentEst})`);
  }
  const mode = mci.length ? 'mci' : surge.length ? 'surge' : strain.length ? 'strain' : 'steady';
  const reason = wslCap(mci[0] || surge[0] || strain[0] || 'all indicators within limits');
  return { mode, reason, rules: { strain, surge, mci } };
}

// Once per sim minute (engine telemetry tick). Escalation is immediate; stepping down
// waits until the calmer mode has held for MODE_RULES.stepDownMin, so it never flickers.
function updateMode() {
  const next = waselModeCheck(), cur = wslModeRank(S.mode), want = wslModeRank(next.mode);
  if (want === cur) { S.modeLowerSince = null; S.modeReason = next.reason; return; }
  if (want < cur) {
    if (S.modeLowerSince == null) S.modeLowerSince = S.t;
    if (S.t - S.modeLowerSince < MODE_RULES.stepDownMin * 60) return;
  }
  const from = MODE_RULES.label[S.mode], to = MODE_RULES.label[next.mode];
  const reason = want < cur ? `${next.reason} · ${from} rules clear for ${MODE_RULES.stepDownMin} min` : next.reason;
  S.mode = next.mode; S.modeSince = S.t; S.modeReason = reason; S.modeLowerSince = null;
  emit('ems', 'NCEMA', `Mode ${from} → ${to}: ${reason}`);
  audit(`Mode changed to ${to}: ${reason}`);
  if (want > cur && want >= wslModeRank('surge')) wslProposeSurge(reason);
  // START colours are carried by every field patient once the MCI is on
  if (S.mode === 'mci') for (const p of S.patients) if (p.stage === 'inbound' && p.atmist && !p.start) p.start = wslStart(p.esi);
}

// Toolbar "Declare MCI" (on) / stand-down (off); the mode follows immediately.
function waselDeclareMci(on) {
  S.mciDeclared = on !== false;
  audit(S.mciDeclared ? 'MCI declared' : 'MCI declaration stood down');
  updateMode();
}

// Silent surge: one card per escalation into Surge or MCI; an open card is refreshed, not duplicated
function wslProposeSurge(reason) {
  const why = `${MODE_RULES.label[S.mode]} mode: ${reason}. Adds staff, critical-care overflow and blood before the wave peaks`
    + ` · on-call ETA ~${WASEL_CFG.oncallEtaMin} min · no public announcement`;
  const open = S.sugg.find(s => s.type === 'surge');
  if (open) { open.why = why; return; }
  const key = 'surge:' + S.mode;
  if (blocked(key)) return;
  addSugg({ key, type: 'surge', level: 1, why,
    title: `Silent surge: recall ${WASEL_CFG.surgeNurses} on-call nurses, hold ${WASEL_CFG.surgeBeds} recovery beds, blood bank standby` });
}

/* ---------- External pre-alerts (face-ID responder app, FACE_ID_INTEGRATION.md v1) ---------- */
const PREALERT_RULES = {
  encounter: /^T-\d{1,6}$/,
  initials: /^(?:[A-Z]\.){1,4}$/,
  isoDate: /^\d{4}-\d{2}-\d{2}$/,
  clock: /^\d{1,2}:\d{2}$/,
  status: ['confirmed', 'candidate', 'temporary'],
  method: ['face', 'fingerprint', 'nfc', 'emirates-id', 'none'],
  startToEsi: { red: 1, yellow: 3, green: 4, black: 5 },
  esiCond: { 1: 'polytrauma', 2: 'femur', 3: 'abdo', 4: 'wrist', 5: 'whiplash' },
  signs: { hr: [20, 250], sbp: [40, 260], rr: [4, 70], spo2: [40, 100], gcs: [3, 15] },
  maxText: 160, maxAllergies: 10, maxEtaMin: 240,
};

// Live pre-alert from the responder app. Same encounter again = update vitals and ETA only.
// Returns {ok: true, encounter, updated?} or {ok: false, error}.
function receivePreAlert(msg) {
  if (!S) return { ok: false, error: 'Dashboard not started' };
  const parsed = wslParsePreAlert(msg);
  if (!parsed.ok) return parsed;
  const d = parsed.data, note = parsed.dropped.length ? ` · ignored invalid ${parsed.dropped.join(', ')}` : '';
  const known = S.patients.find(p => p.enc === d.encounter && p.stage !== 'done');
  if (known) return wslUpdatePreAlert(known, d, note);

  const inc = S.incidents.slice().reverse().find(i => i.closedAt == null)
    || incident('Responder pre-alert', 'Field (responder app)', 'responder app pre-alert', 1, 'prealert');
  const p = makePatient(PREALERT_RULES.esiCond[d.esi], 'EMS');
  wslMatchInitials(p, d.identity.display);
  Object.assign(p, { esi: d.esi, enc: d.encounter, incident: inc.id, fieldAt: S.t, preAlert: true, start: d.start,
    identity: d.identity, safety: d.safety, history: [], meds: d.safety.allergies === null ? null : [] });
  if (d.atmist) {
    wslApplySigns(p, d.atmist.signs);
    if (d.atmist.age !== null) p.age = d.atmist.age;
  }
  const v = p.v, a0 = d.atmist || {};
  p.atmist = {
    age: String(p.age), time: a0.time || fmtClock(S.t),
    mechanism: a0.mechanism || 'Not reported', injuries: a0.injuries || 'Not reported',
    signs: Object.assign({ hr: r0(v.hr), sbp: r0(v.sbp), rr: r0(v.rr), spo2: r0(v.spo2), gcs: v.avpu === 'A' ? 15 : 12 }, a0.signs),
    treatment: a0.treatment || 'Not reported',
  };
  // The responder app issues encounter ids too: keep the local counter ahead of them
  S.nextEnc = Math.max(S.nextEnc, wslEncNum(d.encounter) + 1);

  const a = {
    id: 'AMB-' + S.nextAmb++, incident: inc.id, pts: [p.id], dispatchedAt: S.t, sceneUntil: S.t,
    eta: S.t + d.etaMin * 60, status: 'enroute', arrivedAt: null, divertedAt: null,
    prepared: false, prepBed: null, team: null, preAlert: true,
  };
  p.amb = a.id;
  p.detStart += a.eta - S.t;           // en-route care keeps the casualty compensated, as in dispatchAmb
  S.patients.push(p);
  S.ambulances.push(a);
  emit('ems', 'FHIR', `Pre-alert ${p.enc} received from responder app · identity ${wslIdentityText(p.identity)}`);
  audit(`Pre-alert received: ${p.enc}${note}`);
  if (S.diversionUntil > S.t && ambEsi(a) >= 4) divert(a);
  return { ok: true, encounter: p.enc };
}

// The demo's "Simulate responder pre-alert": a realistic message with a fresh encounter id
function waselSamplePreAlert() {
  let n = S.nextEnc;
  while (S.patients.some(p => p.enc === 'T-' + n)) n++;
  return {
    type: 'prealert', v: 1, encounter: 'T-' + n,
    identity: { status: 'candidate', method: 'face', confidence: 0.94, display: 'F.K.' },
    atmist: {
      age: '45', time: fmtClock(S.t - 9 * 60), mechanism: 'Driver, frontal collision at ~100 km/h',
      injuries: 'Chest wall tenderness, open left femur fracture',
      signs: { hr: 124, sbp: 96, rr: 26, spo2: 92, gcs: 14 },
      treatment: 'Pelvic binder, 1 L saline, 10 mg morphine IV',
    },
    priority: { system: 'ESI', level: 2 },
    etaMin: 8,
    safety: { allergies: ['Penicillin'], anticoagulant: false, bloodType: 'O+', source: 'Riayati', asOf: wslDaysAgo(224) },
  };
}

function wslUpdatePreAlert(p, d, note) {
  // Already handed over: ED monitoring is now the source of truth, nothing to update
  if (p.stage !== 'inbound') return { ok: true, encounter: p.enc, updated: false };
  const a = amb(p.amb);
  if (a && (a.status === 'onscene' || a.status === 'enroute')) a.eta = Math.max(a.sceneUntil, S.t + d.etaMin * 60);
  if (d.atmist) {
    wslApplySigns(p, d.atmist.signs);
    if (p.atmist) p.atmist.signs = Object.assign({}, p.atmist.signs, d.atmist.signs);
  }
  emit('ems', 'FHIR', `Pre-alert ${p.enc} updated · ETA ${Math.round(d.etaMin)} min`);
  audit(`Pre-alert updated: ${p.enc}${note}`);
  return { ok: true, encounter: p.enc, updated: true };
}

function wslApplySigns(p, signs) {
  for (const k of ['hr', 'sbp', 'rr', 'spo2']) if (signs[k] != null) p.v[k] = signs[k];
  if (signs.gcs != null) p.v.avpu = signs.gcs <= 13 ? 'V' : 'A';
}

// Keeps the fictional record name consistent with the initials the responder sent
function wslMatchInitials(p, display) {
  if (!display) return;
  const [f, l] = display.split('.');
  const first = NAMES[p.sex === 'M' ? 'm' : 'f'].find(n => n[0] === f) || NAMES[p.sex === 'M' ? 'f' : 'm'].find(n => n[0] === f);
  if (first) { p.first = first; p.sex = NAMES.m.includes(first) ? 'M' : 'F'; }
  const last = l && NAMES.last.find(n => n[0] === l);
  if (last) p.last = last;
}

// Validates and normalises a message. The envelope (type, v, encounter, priority, etaMin) must be
// valid; an invalid clinical field becomes Unknown and is reported in `dropped`, because a bad
// field must never delay care. Undocumented fields are ignored: names and images have no way in.
function wslParsePreAlert(msg) {
  const R = PREALERT_RULES, fail = error => ({ ok: false, error });
  if (!wslObj(msg) || msg.type !== 'prealert' || msg.v !== 1) return fail('Not a v1 pre-alert message');
  if (typeof msg.encounter !== 'string' || !R.encounter.test(msg.encounter)) return fail('encounter must look like T-104');
  const pr = msg.priority;
  let esi = null, start = null;
  if (wslObj(pr) && pr.system === 'START' && typeof pr.level === 'string' && wslHas(R.startToEsi, pr.level)) {
    start = pr.level; esi = R.startToEsi[pr.level];
  } else if (wslObj(pr) && pr.system === 'ESI' && Number.isInteger(pr.level) && pr.level >= 1 && pr.level <= 5) {
    esi = pr.level;
  } else return fail('priority must be START red|yellow|green|black or ESI 1–5');
  if (typeof msg.etaMin !== 'number' || !(msg.etaMin >= 0 && msg.etaMin <= R.maxEtaMin)) return fail(`etaMin must be 0–${R.maxEtaMin}`);

  const dropped = [];
  return { ok: true, dropped, data: {
    encounter: msg.encounter, esi, start, etaMin: msg.etaMin,
    identity: wslParseIdentity(msg.identity, dropped),
    atmist: wslParseAtmist(msg.atmist, dropped),
    safety: wslParseSafety(msg.safety, dropped),
  } };
}

function wslParseIdentity(id, dropped) {
  const R = PREALERT_RULES, temporary = { status: 'temporary', method: 'none', confidence: null, display: null };
  if (id == null) return temporary;      // no match (yet): care continues on a temporary ID
  if (!wslObj(id) || !R.status.includes(id.status)) { dropped.push('identity'); return temporary; }
  let method = id.method == null ? 'none' : id.method;
  if (!R.method.includes(method)) { dropped.push('identity.method'); method = 'none'; }
  let confidence = null;
  if (id.status !== 'temporary' && id.confidence != null) {
    if (typeof id.confidence === 'number' && id.confidence >= 0 && id.confidence <= 1) confidence = Math.round(id.confidence * 100) / 100;
    else dropped.push('identity.confidence');
  }
  // Initials only: a full name or an ID number in this field is discarded, never stored
  const disp = typeof id.display === 'string' ? id.display.replace(/\s+/g, '') : '';
  if (disp && !R.initials.test(disp)) dropped.push('identity.display');
  return { status: id.status, method, confidence, display: R.initials.test(disp) ? disp : null };
}

function wslParseAtmist(a, dropped) {
  const R = PREALERT_RULES;
  if (a == null) return null;
  if (!wslObj(a)) { dropped.push('atmist'); return null; }
  const signs = {};
  if (wslObj(a.signs)) {
    for (const k in R.signs) {
      const x = a.signs[k], [lo, hi] = R.signs[k];
      if (x == null) continue;
      if (typeof x === 'number' && x >= lo && x <= hi) signs[k] = Math.round(x);
      else dropped.push('atmist.signs.' + k);
    }
  } else if (a.signs != null) dropped.push('atmist.signs');
  const age = parseInt(a.age, 10), time = wslText(a.time, 5);
  return {
    age: age >= 0 && age <= 120 ? age : null,
    time: R.clock.test(time) ? time : '',
    mechanism: wslText(a.mechanism, R.maxText), injuries: wslText(a.injuries, R.maxText),
    signs, treatment: wslText(a.treatment, R.maxText),
  };
}

function wslParseSafety(sf, dropped) {
  const R = PREALERT_RULES;
  const out = { allergies: null, anticoagulant: null, bloodType: null, source: null, asOf: null, restricted: false };
  if (sf == null) return out;            // no record lookup: everything Unknown
  if (!wslObj(sf)) { dropped.push('safety'); return out; }
  // null means Unknown, [] means confirmed none: an invalid list stays Unknown
  if (Array.isArray(sf.allergies) && sf.allergies.length <= R.maxAllergies && sf.allergies.every(x => typeof x === 'string' && x.trim())) {
    out.allergies = sf.allergies.map(x => wslText(x, 40));
  } else if (sf.allergies != null) dropped.push('safety.allergies');
  if (typeof sf.anticoagulant === 'boolean') out.anticoagulant = sf.anticoagulant;
  if (WASEL_BLOOD.some(b => b[0] === sf.bloodType)) out.bloodType = sf.bloodType;
  if (WASEL_HIE.some(h => h[0] === sf.source)) out.source = sf.source;
  if (typeof sf.asOf === 'string' && R.isoDate.test(sf.asOf)) out.asOf = sf.asOf;
  return out;
}

/* ---------- Tasks: every suggestion has an owner and a clock ---------- */
const ESC_MIN = { 1: 3, 2: 6, 3: 10 };   // minutes a task may stay open at each level before it escalates
const WASEL_OWNER = {
  placement: 'Receiving nurse', prearrival: 'Receiving nurse', identity: 'Receiving nurse', lwbs: 'Receiving nurse',
  retriage: 'Physician', needvent: 'Physician',
};                                        // every other type (staffing, capacity, supply, surge, outage, equipment): Charge nurse
const WASEL_ESCALATION = { 'Receiving nurse': 'Charge nurse', 'Physician': 'ED coordinator', 'Charge nurse': 'ED coordinator' };

// Called by addSugg()
function waselAssignOwner(s) {
  s.owner = WASEL_OWNER[s.type] || 'Charge nurse';
  s.escalated = 0;
  s.escalatesAt = s.at + ESC_MIN[s.level] * 60;
}

// Called by aiPlan(): an open task past its clock moves one step up the chain and gains urgency.
// The ED coordinator is the top: escalatesAt becomes null there (no further escalation).
function waselEscalate() {
  for (const s of S.sugg) {
    if (s.escalatesAt == null || S.t <= s.escalatesAt) continue;
    const next = WASEL_ESCALATION[s.owner];
    if (!next) { s.escalatesAt = null; continue; }
    s.escalated = (s.escalated || 0) + 1;
    s.owner = next;
    s.level = Math.max(1, s.level - 1);
    s.escalatesAt = WASEL_ESCALATION[next] ? S.t + ESC_MIN[s.level] * 60 : null;
    emit('roster', 'Paging', `Escalated: ${s.title} → ${s.owner}`);
    audit(`Escalated: ${s.title} → ${s.owner}`);
    if (s.level === 1) aiAnnounce('Escalated: ' + s.title);
  }
}

// Card clock: {openSec, escalatesInSec|null, open 'm:ss', escalatesIn 'm:ss'|null}
function waselTaskClock(s) {
  const open = Math.max(0, S.t - s.at), left = s.escalatesAt == null ? null : Math.max(0, s.escalatesAt - S.t);
  return { openSec: open, escalatesInSec: left, open: wslMS(open), escalatesIn: left == null ? null : wslMS(left) };
}

/* ---------- WASEL suggestions: identity at the door, lobby LWBS risk ---------- */
// Called by aiPlan() after the v1 steps
function waselPlan() {
  for (const p of S.patients) {
    if (p.stage === 'inbound' || p.stage === 'done') continue;
    if (p.identity && p.identity.status === 'candidate') wslProposeIdentity(p);
    if (p.stage === 'waiting' && p.esi >= 4 && !p.clinicOffer && S.t - p.arrivedAt > WASEL_CFG.lwbsMin * 60) wslProposeLwbs(p);
  }
}

function wslProposeIdentity(p) {
  const key = 'identity:' + p.id, id = p.identity;
  if (blocked(key)) return;
  const how = WASEL_METHOD_LABEL[id.method] || id.method;
  addSugg({ key, type: 'identity', level: 2, pid: p.id,
    title: `Confirm identity of ${p.enc} (${how} match${id.confidence != null ? ' ' + pct(id.confidence) : ''})`,
    why: 'Compare with patient, relative or documents. A candidate never merges charts.' });
}

function wslProposeLwbs(p) {
  const key = 'lwbs:' + p.id;
  if (blocked(key)) return;
  const fastFree = S.beds.filter(b => b.zone === 'F' && b.status === 'free' && !b.hold).length;
  const clinic = wslClinicWait();
  addSugg({ key, type: 'lwbs', level: 3, pid: p.id,
    title: `${p.enc} at risk of leaving without being seen (${mins(S.t - p.arrivedAt)} min): offer fast-track or the partner clinic (live wait ${clinic} min)`,
    why: `ESI ${p.esi} · ${COND[p.cond].label} · fast track ${fastFree} of ${ZONES.find(z => z.id === 'F').count} beds free`
      + ` · partner urgent-care clinic live wait ~${clinic} min · long lobby waits are the main driver of leaving unseen` });
}

// Partner clinic's published wait (simulated live feed: slow drift between ~8 and ~20 min)
function wslClinicWait() { return Math.round(14 + 6 * Math.sin(S.t / 1500)); }

// Called by stillValid()
function waselStillValid(s) {
  const p = s.pid ? P(s.pid) : null;
  switch (s.type) {
    case 'identity': return !!p && p.stage !== 'inbound' && p.stage !== 'done' && !!p.identity && p.identity.status === 'candidate';
    case 'lwbs': return !!p && p.stage === 'waiting' && !p.clinicOffer;
    case 'surge': return wslModeRank(S.mode) >= wslModeRank('surge');
    default: return false;
  }
}

// Called by accept() for the WASEL types; false leaves the card in place
function waselAccept(s, actor) {
  const p = s.pid ? P(s.pid) : null;
  switch (s.type) {
    case 'identity': {
      p.identity.status = 'confirmed';
      emit('ehr', 'FHIR', `Identity confirmed ${p.enc} · chart linked via ${(p.safety && p.safety.source) || 'Riayati'}`);
      return true;
    }
    case 'lwbs': {
      // Release this patient's own pending bed card first, then take any free fast-track bed
      const own = S.sugg.find(x => x.key === 'placement:' + p.id);
      if (own) dropSugg(own);
      const b = S.beds.find(x => x.zone === 'F' && x.status === 'free' && !x.hold);
      if (b) return place(p, b, bestNurse(p), actor);
      p.clinicOffer = true;
      emit('ehr', 'FHIR', `ServiceRequest: ${p.enc} offered partner urgent-care clinic · live wait ${wslClinicWait()} min`);
      return true;
    }
    case 'surge': {
      for (let i = 0; i < WASEL_CFG.surgeNurses; i++) callIn(WASEL_CFG.oncallEtaMin);
      S.icu.cap += WASEL_CFG.surgeBeds;
      emit('ehr', 'FHIR', `Recovery room opened as critical-care overflow · +${WASEL_CFG.surgeBeds} beds, ICU capacity ${S.icu.cap}`);
      emit('pharm', 'FHIR', 'Blood bank standby: O-negative units and massive-transfusion packs held for the ED');
      return true;
    }
    default: return false;
  }
}

/* ---------- Clinical safety: medication checks (pure, for the patient drawer) ---------- */
// WHO ATC codes. allergen: allergy class that hard-stops; crossReacts: allergy that only warns;
// anticoagulant: hard stop if already anticoagulated; bleeds / renal: soft warnings.
const DRUGS = [
  { name: 'Amoxicillin', atc: 'J01CA04', cls: 'penicillin', allergen: 'Penicillin' },
  { name: 'Ceftriaxone', atc: 'J01DD04', cls: 'cephalosporin', allergen: null, crossReacts: 'Penicillin' },
  { name: 'Morphine', atc: 'N02AA01', cls: 'opioid', allergen: 'Morphine' },
  { name: 'Ibuprofen', atc: 'M01AE01', cls: 'NSAID', allergen: 'NSAIDs', bleeds: true, renal: true },
  { name: 'Ketorolac', atc: 'M01AB15', cls: 'NSAID', allergen: 'NSAIDs', bleeds: true, renal: true },
  { name: 'Heparin', atc: 'B01AB01', cls: 'anticoagulant', allergen: null, anticoagulant: true },
  { name: 'Tranexamic acid', atc: 'B02AA02', cls: 'antifibrinolytic', allergen: null },
  { name: 'Paracetamol', atc: 'N02BE01', cls: 'analgesic', allergen: null },
  { name: 'IV contrast', atc: 'V08AB02', cls: 'iodinated contrast', allergen: 'Contrast media', renal: true },
];

// Drug by name (case-insensitive) or by DRUGS entry
function wslDrug(drug) {
  const name = String(drug && drug.name ? drug.name : drug || '').toLowerCase();
  return DRUGS.find(d => d.name.toLowerCase() === name) || null;
}
// 'NSAIDs' ~ 'nsaid', 'Penicillin' ~ 'penicillins'
function wslSameAllergen(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
  return !!a && !!b && norm(a) === norm(b);
}

// {ok, hardStop, warning, reason}: ok false = blocked unless overridden; warning = show amber.
function checkOrder(p, drug) {
  const d = wslDrug(drug);
  if (!p || !d) return { ok: false, hardStop: false, warning: false, reason: 'Unknown patient or medication' };
  const sf = p.safety || {}, known = Array.isArray(sf.allergies) && !sf.restricted;
  const src = sf.source ? ` (${sf.source}${sf.asOf ? ' ' + sf.asOf : ''})` : '';
  const stop = reason => ({ ok: false, hardStop: true, warning: false, reason });
  // 1. Hard stops on what the record does say
  if (known) {
    const hit = sf.allergies.find(x => wslSameAllergen(x, d.allergen) || wslSameAllergen(x, d.name));
    if (hit) return stop(`ALLERGY: ${hit}${src} · ${d.name} (${d.cls}) must not be given`);
  }
  if (d.anticoagulant && sf.anticoagulant === true) {
    return stop(`INTERACTION: already anticoagulated${p.meds && p.meds.length ? ' (' + p.meds.join(', ') + ')' : ''} · ${d.name} adds major bleeding risk`);
  }
  // 2. Unknown is never a silent pass
  if (!known) {
    return { ok: true, hardStop: false, warning: true,
      reason: `Allergy status UNKNOWN${sf.restricted ? ' (record restricted by patient)' : ''}: ask patient or family before giving` };
  }
  // 3. Soft warnings: give with care
  const warn = [];
  const cross = d.crossReacts && sf.allergies.find(x => wslSameAllergen(x, d.crossReacts));
  if (cross) warn.push(`${cross} allergy on record: low cross-reactivity with ${d.cls}s, give with monitoring`);
  if (d.bleeds && sf.anticoagulant === true) warn.push(`On ${(p.meds || []).join(', ') || 'an anticoagulant'}: ${d.cls} adds bleeding risk`);
  if (d.renal && (p.history || []).some(h => h.label === 'CKD stage 3')) warn.push('CKD stage 3 on record: check renal function first');
  if (warn.length) return { ok: true, hardStop: false, warning: true, reason: warn.join(' · ') };
  return { ok: true, hardStop: false, warning: false, reason: `No allergy or interaction found${src}` };
}

// Places an order that passed checkOrder (warnings acknowledged). Hard stops need overrideOrder().
function waselOrder(p, drug) {
  const r = checkOrder(p, drug), d = wslDrug(drug);
  if (!p || !d || r.hardStop) return Object.assign({ ordered: false }, r);
  wslRecordOrder(p, d, r.warning ? 'warning acknowledged' : null);
  audit(`Medication ordered: ${d.name} for ${p.enc}` + (r.warning ? ' · warning acknowledged' : ''));
  return Object.assign({ ordered: true }, r);
}

// Clinician override of a hard stop: needs a reason of 10+ characters, always audited.
function overrideOrder(p, drug, reason) {
  const d = wslDrug(drug), why = wslText(reason, WASEL_CFG.maxReasonLen).replace(/\s+/g, ' ');
  if (!p || !d) return { ok: false, error: 'Unknown patient or medication' };
  if (why.length < 10) return { ok: false, error: 'Give a reason of at least 10 characters' };
  audit(`Override hard stop: ${d.name} for ${p.enc} · reason: ${why}`);
  wslRecordOrder(p, d, 'hard stop overridden');
  return { ok: true };
}

function wslRecordOrder(p, d, note) {
  p.orders.push({ t: S.t, drug: d.name, note });
  emit('ehr', 'FHIR', `MedicationRequest ${d.name} (ATC ${d.atc}) for ${p.enc} · active` + (note ? ' · ' + note : ''));
}

/* ---------- SBAR handover ---------- */
// {s, b, a, r}: Situation, Background, Assessment, Recommendation. Encounter ids only, no names.
function sbar(p) {
  const c = COND[p.cond], v = p.v, sf = p.safety || {}, at = p.atmist;
  const situation = `${p.enc}, ${p.age}${p.sex}, ${c.label}, ESI ${p.esi}${p.start ? ' (START ' + p.start + ')' : ''} · ${wslWhere(p)}.`;

  const bg = [];
  if (at) bg.push(`${at.mechanism} at ${at.time}; ${at.injuries}`, `Field treatment: ${at.treatment}`);
  else bg.push(`${p.src === 'EMS' ? 'Arrived by ambulance' : 'Walk-in'}${p.arrivedAt != null ? ' at ' + fmtClock(p.arrivedAt) : ''}`);
  bg.push(wslHistoryText(p), wslAllergyText(sf));
  if (sf.anticoagulant === true) bg.push(`On ${(p.meds || []).join(', ') || 'an anticoagulant'}`);
  else if (sf.anticoagulant == null) bg.push('Anticoagulant status unknown');
  if (p.orders.length) bg.push('Ordered in ED: ' + p.orders.map(o => o.drug).join(', '));

  const trend = p.trend ? ` (${p.trend > 0 ? '↑' : '↓'}${Math.abs(p.trend)} in 12 min)` : '';
  const assessment = `NEWS2 ${p.news}${trend} · HR ${r0(v.hr)}, BP ${r0(v.sbp)} systolic, RR ${r0(v.rr)}, SpO₂ ${r0(v.spo2)}%`
    + `${p.onO2 ? ' on O₂' : ''}, ${v.avpu === 'A' ? 'alert' : 'responds to voice only'}`
    + (p.flag ? `. ${p.flag.text}. ${p.flag.hint}.` : '. No active alarms.');

  const rec = [];
  if (p.flag && p.flag.level === 'critical') rec.push('Urgent clinical review now');
  else if (p.flag && p.stage !== 'boarding') rec.push('Clinical review within 30 min');
  rec.push(wslPlanText(p));
  for (const s of S.sugg) if (s.pid === p.id) rec.push('Pending decision: ' + s.title);
  if (!Array.isArray(sf.allergies) || sf.restricted) rec.push('Confirm allergies with patient or family before any medication');
  if (p.identity && p.identity.status !== 'confirmed') rec.push('Confirm identity before linking the chart');

  return { s: situation, b: bg.join('. ') + '.', a: assessment, r: rec.join('. ') + '.' };
}

function wslWhere(p) {
  const b = p.bed ? bed(p.bed) : null, n = p.nurse ? nurse(p.nurse) : null;
  const inBed = b ? `${zoneName(b.zone)} ${b.id}${n ? ' with ' + n.name : ''}` : 'an ED bed';
  if (p.stage === 'inbound') { const a = amb(p.amb); return a ? `inbound on ${a.id}, ETA ${mins(a.eta - S.t)} min` : 'inbound'; }
  if (p.stage === 'waiting') return `waiting for a bed ${mins(S.t - p.arrivedAt)} min`;
  if (p.stage === 'boarding') return `in ${inBed}, boarding ${mins(S.t - p.boardSince)} min for ${DISPO_LABEL[p.dispo]}`;
  return `in ${inBed}`;
}

function wslPlanText(p) {
  if (p.stage === 'inbound') {
    const rb = p.reservedBed ? bed(p.reservedBed) : null, a = amb(p.amb);
    return rb ? `Receive in ${zoneName(rb.zone)} ${rb.id}${a && a.team ? ', ' + a.team + ' paged' : ''}`
      : `Prepare a ${zoneName(ZONE_PREF[p.esi][0])} bed before arrival`;
  }
  if (p.stage === 'waiting') return `Place in the next free ${zoneName(ZONE_PREF[p.esi][0])} bed`;
  if (p.stage === 'boarding') return `Admit to ${DISPO_LABEL[p.dispo]}; escalate the bed request`;
  return `Continue treatment in ${p.bed}; disposition review ~${fmtClock(p.treatEnd)}`;
}

function wslHistoryText(p) {
  if (p.history.length) return 'History: ' + p.history.map(h => `${h.label} (${h.source} ${h.asOf})`).join(', ');
  const sf = p.safety || {};
  if (sf.restricted) return 'History restricted by patient';
  if (p.preAlert) return 'History not included in pre-alert';
  return sf.source ? `No chronic conditions on record (${sf.source})` : 'History unknown (temporary ID)';
}

function wslAllergyText(sf) {
  if (sf.restricted) return 'Allergies UNKNOWN (record restricted by patient)';
  if (!Array.isArray(sf.allergies)) return 'Allergies UNKNOWN';
  const src = sf.source ? ` (${sf.source}${sf.asOf ? ' ' + sf.asOf : ''})` : '';
  return sf.allergies.length ? `ALLERGY: ${sf.allergies.join(', ')}${src}` : `No known allergies${src}`;
}

/* ---------- Family reunification (status only, no medical details) ---------- */
const WASEL_FAMILY_DISPO = { discharge: 'Discharged', ward: 'Admitted to ward', icu: 'ICU', or: 'In surgery' };

// Initials only once identity is confirmed: a candidate match is never shown to families
function wslInitials(p) {
  if (!p.identity || p.identity.status !== 'confirmed') return '—';
  return p.identity.display || `${p.first.charAt(0)}.${p.last.charAt(0)}.`;
}

// Called by leave(): incident patients keep a family-board row after they leave the ED
function waselOnLeave(p) {
  if (!p.incident) return;
  S.reunify.push({ enc: p.enc, initials: wslInitials(p), status: WASEL_FAMILY_DISPO[p.dispo] || 'Discharged', since: S.t, incident: p.incident });
  if (S.reunify.length > WASEL_CFG.reunifyMax) S.reunify.shift();
}

// [{enc, initials, status, since}] for every incident patient, in encounter order
function familyBoard() {
  const rows = [];
  for (const p of S.patients) {
    if (!p.incident || p.stage === 'done') continue;
    const [status, since] = p.stage === 'inbound' ? ['Arriving', p.fieldAt]
      : p.stage === 'waiting' ? ['Waiting', p.arrivedAt] : ['In treatment', p.bedAt];
    rows.push({ enc: p.enc, initials: wslInitials(p), status, since });
  }
  for (const r of S.reunify) rows.push({ enc: r.enc, initials: r.initials, status: r.status, since: r.since });
  return rows.sort((a, b) => wslEncNum(a.enc) - wslEncNum(b.enc));
}
