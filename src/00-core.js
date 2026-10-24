'use strict';
/* =========================================================================
 * ER Crisis Command Center · 00-core.js
 * Shared foundation: utilities, clinical reference data, state factory.
 *
 * Standards used across the system:
 *   ESI v4 triage (5 levels) · NEWS2 early-warning score (RCP, 2017)
 *   LOINC vital-sign codes · ICD-10-CM condition codes
 *   HL7 FHIR R4 / HL7 v2.5 / IEEE 11073 SDC feeds · WCAG 2.2 AA
 *
 * Module rules: 10-engine.js and 20-ai.js never touch the DOM (they also
 * run headless in Node for testing). 30-ui.js is the only renderer.
 * ========================================================================= */

/* ---------- Brand ---------- */
const APP_NAME = 'WASEL';
const APP_SUB = 'ER Command Dashboard';

/* ---------- Utilities ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r0 = v => Math.round(v);
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Every dynamic value that reaches innerHTML goes through esc() (XSS-safe rendering).
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC_MAP[c]);
function weighted(entries) {               // entries: [[key, weight], ...]
  const total = entries.reduce((s, e) => s + e[1], 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries[entries.length - 1][0];
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const mins = sec => Math.max(0, Math.round(sec / 60));
const pad2 = n => String(n).padStart(2, '0');
function simDate(t) { return new Date(S.clock0 + t * 1000); }
function fmtClock(t) { const d = simDate(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fmtClockS(t) { const d = simDate(t); return fmtClock(t) + ':' + pad2(d.getSeconds()); }
const pct = x => Math.round(x * 100) + '%';
function median(xs) {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ---------- Triage (ESI v4) ---------- */
const ESI_LABEL = { 1: 'Resuscitation', 2: 'Emergent', 3: 'Urgent', 4: 'Less urgent', 5: 'Non-urgent' };
// Nursing workload weight per patient by ESI (1.0 = one nurse fully occupied)
const W_ESI = { 1: 1, 2: 0.5, 3: 0.34, 4: 0.25, 5: 0.2 };

/* ---------- Vital signs (LOINC) ---------- */
const LOINC = {
  hr:   { code: '8867-4',  name: 'Heart rate',               unit: '/min' },
  rr:   { code: '9279-1',  name: 'Respiratory rate',         unit: '/min' },
  spo2: { code: '59408-5', name: 'Oxygen saturation (SpO2)', unit: '%' },
  sbp:  { code: '8480-6',  name: 'Systolic blood pressure',  unit: 'mm[Hg]' },
  temp: { code: '8310-5',  name: 'Body temperature',         unit: 'Cel' },
};
function fmtV(key, v) { return key === 'temp' ? v.toFixed(1) : String(Math.round(v)); }

/* ---------- NEWS2 (Royal College of Physicians, 2017; SpO2 scale 1) ---------- */
function news2(v, onO2) {
  const rr = r0(v.rr), sp = r0(v.spo2), sbp = r0(v.sbp), hr = r0(v.hr), t = Math.round(v.temp * 10) / 10;
  let s = 0;
  s += rr <= 8 ? 3 : rr <= 11 ? 1 : rr <= 20 ? 0 : rr <= 24 ? 2 : 3;
  s += sp <= 91 ? 3 : sp <= 93 ? 2 : sp <= 95 ? 1 : 0;
  s += onO2 ? 2 : 0;
  s += sbp <= 90 ? 3 : sbp <= 100 ? 2 : sbp <= 110 ? 1 : sbp <= 219 ? 0 : 3;
  s += hr <= 40 ? 3 : hr <= 50 ? 1 : hr <= 90 ? 0 : hr <= 110 ? 1 : hr <= 130 ? 2 : 3;
  s += v.avpu === 'A' ? 0 : 3;
  s += t <= 35.0 ? 3 : t <= 36.0 ? 1 : t <= 38.0 ? 0 : t <= 39.0 ? 1 : 2;
  return s;
}
// Per-parameter NEWS2 points (patient detail breakdown)
function news2Parts(v, onO2) {
  const rr = r0(v.rr), sp = r0(v.spo2), sbp = r0(v.sbp), hr = r0(v.hr), t = Math.round(v.temp * 10) / 10;
  return {
    rr: rr <= 8 ? 3 : rr <= 11 ? 1 : rr <= 20 ? 0 : rr <= 24 ? 2 : 3,
    spo2: sp <= 91 ? 3 : sp <= 93 ? 2 : sp <= 95 ? 1 : 0,
    o2: onO2 ? 2 : 0,
    sbp: sbp <= 90 ? 3 : sbp <= 100 ? 2 : sbp <= 110 ? 1 : sbp <= 219 ? 0 : 3,
    hr: hr <= 40 ? 3 : hr <= 50 ? 1 : hr <= 90 ? 0 : hr <= 110 ? 1 : hr <= 130 ? 2 : 3,
    avpu: v.avpu === 'A' ? 0 : 3,
    temp: t <= 35.0 ? 3 : t <= 36.0 ? 1 : t <= 38.0 ? 0 : t <= 39.0 ? 1 : 2,
  };
}

/* ---------- Conditions (ICD-10-CM) ----------
 * esi: [min,max] triage range · v: presenting vitals · avpu: P(not alert)
 * det: P(deteriorates while untreated) · delay: [min,max] minutes before drift starts
 * drift: change per minute while deteriorating · needs: resources on placement
 *   (blood/burn: [min,max] units; ct/o2/vent: probability)
 * treat: [min,max] minutes in an ED bed · dispo: outcome weights        */
const COND = {
  // Road traffic collision / trauma
  polytrauma: { label: 'Multiple injuries (polytrauma)', icd: 'T07.XXXA', esi: [1, 1], v: { hr: 132, sbp: 84, rr: 28, spo2: 90, temp: 36.2 }, avpu: 0.4, det: 0.6, delay: [0, 2], drift: { hr: 1.5, sbp: -1.2, rr: 0.3, spo2: -0.2 }, needs: { blood: [4, 6], ct: 1, o2: 1, vent: 0.3 }, treat: [40, 80], dispo: { or: 0.7, icu: 0.3 }, team: 'trauma team' },
  pneumo:     { label: 'Traumatic pneumothorax', icd: 'S27.0XXA', esi: [1, 2], v: { hr: 122, sbp: 104, rr: 28, spo2: 88, temp: 36.8 }, det: 0.5, delay: [1, 4], drift: { hr: 1.2, sbp: -0.6, rr: 0.4, spo2: -0.4 }, needs: { ct: 1, o2: 1 }, treat: [40, 90], dispo: { icu: 0.5, ward: 0.5 }, team: 'trauma team' },
  abdo:       { label: 'Intra-abdominal injury', icd: 'S36.90XA', esi: [3, 3], v: { hr: 92, sbp: 122, rr: 18, spo2: 97, temp: 36.9 }, det: 0.9, delay: [3, 7], drift: { hr: 2.2, sbp: -1.8, rr: 0.4, spo2: -0.15 }, needs: { blood: [2, 4], ct: 1 }, treat: [50, 100], dispo: { or: 0.8, icu: 0.2 }, team: 'trauma team' },
  femur:      { label: 'Fracture of femur', icd: 'S72.90XA', esi: [2, 2], v: { hr: 106, sbp: 124, rr: 20, spo2: 97, temp: 36.9 }, det: 0.15, delay: [2, 8], drift: { hr: 0.8, sbp: -0.6, rr: 0.2, spo2: 0 }, needs: { blood: [0, 2], ct: 0.5 }, treat: [60, 120], dispo: { or: 0.7, ward: 0.3 }, team: 'trauma team' },
  headinj:    { label: 'Head injury', icd: 'S09.90XA', esi: [2, 3], v: { hr: 88, sbp: 146, rr: 16, spo2: 96, temp: 37.0 }, avpu: 0.3, det: 0.3, delay: [3, 10], drift: { hr: -0.5, sbp: 1.0, rr: -0.2, spo2: -0.1 }, needs: { ct: 1 }, treat: [60, 120], dispo: { icu: 0.35, ward: 0.5, discharge: 0.15 }, team: 'trauma team' },
  ribs:       { label: 'Multiple rib fractures', icd: 'S22.49XA', esi: [2, 3], v: { hr: 104, sbp: 128, rr: 24, spo2: 94, temp: 36.9 }, det: 0.25, delay: [3, 10], drift: { hr: 0.6, sbp: -0.3, rr: 0.3, spo2: -0.2 }, needs: { ct: 1, o2: 1 }, treat: [60, 120], dispo: { ward: 0.8, icu: 0.2 }, team: 'trauma team' },
  wrist:      { label: 'Fracture of distal radius', icd: 'S52.509A', esi: [4, 4], v: { hr: 90, sbp: 132, rr: 16, spo2: 99, temp: 36.8 }, treat: [30, 60], dispo: { discharge: 0.85, ward: 0.15 } },
  whiplash:   { label: 'Sprain of cervical spine', icd: 'S13.4XXA', esi: [4, 5], v: { hr: 84, sbp: 130, rr: 16, spo2: 99, temp: 36.8 }, treat: [20, 40], dispo: { discharge: 1 } },
  laceration: { label: 'Open wound of head', icd: 'S01.90XA', esi: [4, 4], v: { hr: 88, sbp: 128, rr: 16, spo2: 99, temp: 36.8 }, treat: [25, 45], dispo: { discharge: 1 } },
  // Building fire
  smokeMild:  { label: 'Smoke inhalation', icd: 'T59.811A', esi: [3, 3], v: { hr: 98, sbp: 132, rr: 22, spo2: 93, temp: 37.0 }, det: 0.2, delay: [3, 10], drift: { hr: 0.6, sbp: 0, rr: 0.3, spo2: -0.25 }, needs: { o2: 1 }, treat: [40, 90], dispo: { discharge: 0.6, ward: 0.4 }, team: 'burn team' },
  smokeSev:   { label: 'Smoke inhalation, airway burn', icd: 'T59.811A', esi: [2, 2], v: { hr: 116, sbp: 118, rr: 28, spo2: 89, temp: 37.4 }, det: 0.7, delay: [1, 5], drift: { hr: 1.0, sbp: -0.4, rr: 0.5, spo2: -0.4 }, needs: { o2: 1, vent: 0.6 }, treat: [50, 100], dispo: { icu: 0.8, ward: 0.2 }, team: 'burn team' },
  burnMinor:  { label: 'Burn, <10% body surface', icd: 'T31.0', esi: [4, 4], v: { hr: 96, sbp: 130, rr: 18, spo2: 98, temp: 37.0 }, needs: { burn: [1, 1] }, treat: [30, 60], dispo: { discharge: 0.9, ward: 0.1 } },
  burnMod:    { label: 'Burn, 10–19% body surface', icd: 'T31.10', esi: [2, 2], v: { hr: 112, sbp: 122, rr: 22, spo2: 96, temp: 37.2 }, det: 0.3, delay: [3, 10], drift: { hr: 0.8, sbp: -0.5, rr: 0.2, spo2: -0.1 }, needs: { burn: [2, 3], o2: 0.5 }, treat: [60, 120], dispo: { ward: 0.8, icu: 0.2 }, team: 'burn team' },
  burnMajor:  { label: 'Burn, 30–39% body surface', icd: 'T31.30', esi: [1, 1], v: { hr: 128, sbp: 96, rr: 26, spo2: 91, temp: 36.4 }, det: 0.6, delay: [0, 3], drift: { hr: 1.0, sbp: -0.8, rr: 0.3, spo2: -0.3 }, needs: { burn: [3, 4], o2: 1, vent: 0.5, blood: [0, 2] }, treat: [60, 120], dispo: { icu: 1 }, team: 'burn team' },
  // Everyday ED
  chestPain:  { label: 'Chest pain', icd: 'R07.9', esi: [2, 2], v: { hr: 98, sbp: 150, rr: 18, spo2: 97, temp: 36.9 }, det: 0.15, delay: [3, 12], drift: { hr: 0.8, sbp: -1, rr: 0.2, spo2: -0.1 }, treat: [60, 150], dispo: { ward: 0.5, discharge: 0.4, icu: 0.1 }, team: 'cardiac team' },
  abdoPain:   { label: 'Abdominal pain', icd: 'R10.9', esi: [3, 3], v: { hr: 92, sbp: 128, rr: 18, spo2: 98, temp: 37.6 }, treat: [60, 150], dispo: { discharge: 0.6, ward: 0.3, or: 0.1 } },
  dyspnea:    { label: 'Shortness of breath', icd: 'R06.00', esi: [3, 3], v: { hr: 102, sbp: 138, rr: 24, spo2: 93, temp: 37.1 }, det: 0.2, delay: [3, 12], drift: { hr: 0.6, sbp: 0, rr: 0.3, spo2: -0.2 }, needs: { o2: 1 }, treat: [60, 140], dispo: { ward: 0.5, discharge: 0.5 } },
  asthma:     { label: 'Asthma exacerbation', icd: 'J45.901', esi: [3, 3], v: { hr: 108, sbp: 130, rr: 26, spo2: 93, temp: 37.0 }, needs: { o2: 1 }, treat: [40, 90], dispo: { discharge: 0.8, ward: 0.2 } },
  sepsis:     { label: 'Sepsis', icd: 'A41.9', esi: [3, 3], v: { hr: 104, sbp: 112, rr: 22, spo2: 95, temp: 38.6 }, det: 0.8, delay: [4, 10], drift: { hr: 1.2, sbp: -1.2, rr: 0.3, spo2: -0.15 }, treat: [60, 120], dispo: { icu: 0.4, ward: 0.6 } },
  stroke:     { label: 'Acute ischaemic stroke', icd: 'I63.9', esi: [1, 2], v: { hr: 88, sbp: 178, rr: 18, spo2: 96, temp: 37.0 }, avpu: 0.5, needs: { ct: 1 }, treat: [40, 80], dispo: { icu: 0.5, ward: 0.5 }, team: 'stroke team' },
  fever:      { label: 'Fever', icd: 'R50.9', esi: [4, 4], v: { hr: 100, sbp: 124, rr: 18, spo2: 98, temp: 38.7 }, treat: [30, 60], dispo: { discharge: 1 } },
  ankle:      { label: 'Ankle sprain', icd: 'S93.409A', esi: [5, 5], v: { hr: 82, sbp: 126, rr: 15, spo2: 99, temp: 36.8 }, treat: [20, 40], dispo: { discharge: 1 } },
};

const MIX = {
  walkin:    [['chestPain', 3], ['abdoPain', 4], ['dyspnea', 3], ['asthma', 2], ['sepsis', 1.2], ['stroke', 0.6], ['fever', 4], ['ankle', 3], ['laceration', 2], ['wrist', 1.5]],
  pileup:    [['polytrauma', 1.5], ['pneumo', 2], ['abdo', 2.5], ['femur', 3], ['headinj', 3], ['ribs', 2], ['wrist', 3], ['whiplash', 4], ['laceration', 3]],
  fire:      [['smokeMild', 5], ['smokeSev', 3], ['burnMinor', 3], ['burnMod', 2], ['burnMajor', 1.5]],
  minor:     [['wrist', 3], ['whiplash', 4], ['laceration', 4], ['ankle', 2]],
  fireMinor: [['smokeMild', 3], ['burnMinor', 3]],
};

const DISPO_LABEL = { discharge: 'discharge home', ward: 'ward bed', icu: 'ICU bed', or: 'operating room' };

/* ---------- ED layout ---------- */
const ZONES = [
  { id: 'R', name: 'Resus', count: 4 },
  { id: 'T', name: 'Trauma', count: 6 },
  { id: 'A', name: 'Acute', count: 12 },
  { id: 'F', name: 'Fast track', count: 8 },
];
const ZONE_PREF = { 1: ['R', 'T', 'A'], 2: ['T', 'A', 'R'], 3: ['A', 'T'], 4: ['F', 'A'], 5: ['F', 'A'] };
const zoneName = id => (ZONES.find(z => z.id === id) || { name: id }).name;

/* ---------- The 10 source systems the command center unifies ---------- */
const SOURCES = [
  { id: 'ehr',    name: 'EHR',                      short: 'EHR',       std: 'HL7 FHIR R4',          feeds: 'Patient, Encounter, Condition (ICD-10-CM)', panel: 'Patient list, patient record' },
  { id: 'adt',    name: 'Registration (ADT)',       short: 'ADT',       std: 'HL7 v2.5 ADT',         feeds: 'Arrivals (A04), transfers (A02), discharges (A03)', panel: 'Journey strip, patient list' },
  { id: 'beds',   name: 'Bed management',           short: 'Beds',      std: 'FHIR Location',        feeds: 'Bed status, cleaning, reservations', panel: 'Bed board' },
  { id: 'lis',    name: 'Laboratory (LIS)',         short: 'Lab',       std: 'HL7 v2 ORU · LOINC',   feeds: 'Lab results, critical values', panel: 'Patient record' },
  { id: 'ris',    name: 'Radiology (RIS/PACS)',     short: 'Radiology', std: 'DICOM · HL7 v2 ORM',   feeds: 'CT scanner status and queue', panel: 'Equipment' },
  { id: 'pharm',  name: 'Pharmacy & blood bank',    short: 'Pharmacy',  std: 'FHIR · GS1 barcodes',  feeds: 'Blood units, medication and supply stock', panel: 'Supplies' },
  { id: 'rtls',   name: 'Asset tracking (RTLS)',    short: 'RTLS',      std: 'BLE / RFID tags',      feeds: 'Location of ventilators and monitors; backup bed sensors', panel: 'Equipment, bed board' },
  { id: 'mon',    name: 'Monitors & wearables',     short: 'Monitors',  std: 'IEEE 11073 SDC',       feeds: 'HR, BP, RR, SpO2, temperature (LOINC-coded)', panel: 'Patient list, NEWS2' },
  { id: 'ems',    name: 'Ambulance dispatch (EMS)', short: 'EMS',       std: 'FHIR · CAD feed',      feeds: 'Incidents, ambulance ETAs, field triage', panel: 'Journey strip, inbound' },
  { id: 'roster', name: 'Staff rostering',          short: 'Roster',    std: 'REST API · OAuth 2.0', feeds: 'Shifts, hours on duty, on-call list', panel: 'Staff' },
];

/* ---------- Roles (role-based access, minimum necessary) ----------
 * names: 'full' | 'partial' | 'none' (wall display & IT see initials only)
 * act: suggestion types this role may approve · detail: may open records  */
const ROLES = {
  wall:      { label: 'Wall display', names: 'none', detail: false, audit: false, act: [] },
  charge:    { label: 'Charge nurse', names: 'partial', detail: true, audit: false,
               act: ['placement', 'prearrival', 'retriage', 'supply', 'fatigue', 'callin', 'reassign', 'capacity', 'ct', 'vent', 'needvent', 'outage',
                     'identity', 'lwbs', 'surge'] },
  physician: { label: 'Physician', names: 'full', detail: true, audit: false, act: ['placement', 'prearrival', 'retriage', 'needvent', 'identity'] },
  // detail 'assigned': opens only charts of patients assigned to nurseId; others need break-glass
  nurse:     { label: 'Nurse (A. Haddad)', names: 'partial', detail: 'assigned', audit: false,
               act: ['placement', 'prearrival', 'identity', 'lwbs'], nurseId: 'N1' },
  admin:     { label: 'IT / Admin', names: 'none', detail: false, audit: true, act: ['outage'] },
};
const prefs = { role: 'charge', autoAccept: false };
function canAct(type) { return ROLES[prefs.role].act.includes(type); }

const SUGG_LABEL = {
  placement: 'Bed placement', prearrival: 'Pre-arrival prep', retriage: 'Re-triage', supply: 'Supplies',
  fatigue: 'Staffing', callin: 'Staffing', reassign: 'Staffing', capacity: 'Capacity',
  ct: 'Equipment', vent: 'Equipment', needvent: 'Equipment', outage: 'System',
  identity: 'Identity', lwbs: 'Lobby', surge: 'Surge',
};
const LEVEL_LABEL = { 1: 'Critical', 2: 'High', 3: 'Routine' };

/* ---------- Operating modes (WASEL; evaluated each sim minute by updateMode) ----------
 * strain: ANY one strain rule holds · surge: 2+ strain rules, OR O-neg blood or free
 * ventilators at their floor · mci: an active incident this large, OR MCI declared.
 * Escalation is immediate; stepping down waits stepDownMin so the mode never flickers. */
const MODE_RULES = {
  order: ['steady', 'strain', 'surge', 'mci'],
  label: { steady: 'Steady', strain: 'Strain', surge: 'Surge', mci: 'MCI' },
  strain: { occupancyPct: 80, esi2WaitMin: 15, boardingMin: 60 },   // ≥ 80% beds · ESI 1–2 waiting > 15 min · boarding > 60 min
  surge: { strainRules: 2, oNegUnits: 10, ventsFree: 2 },          // ≥ 2 strain rules · O-neg ≤ 10 units · ventilators free ≤ 2
  mci: { incidentEst: 10 },                                        // active incident with ≥ 10 expected casualties
  stepDownMin: 10,
};

/* ---------- Synthetic people (fictional) ---------- */
const NAMES = {
  m: ['Ahmed', 'Omar', 'Rahul', 'Jose', 'Yousef', 'Arjun', 'Khalid', 'John', 'Hassan', 'Ravi', 'Faisal', 'Imran', 'Mohammed', 'Vikram', 'Ali', 'Daniel', 'Tariq', 'Suresh'],
  f: ['Fatima', 'Aisha', 'Priya', 'Maria', 'Sara', 'Mariam', 'Anjali', 'Noura', 'Emily', 'Layla', 'Grace', 'Hind', 'Zainab', 'Reem', 'Joy', 'Meera', 'Huda', 'Ana'],
  last: ['Al Mansoori', 'Khan', 'Nair', 'Santos', 'Hassan', 'Al Hashimi', 'Sharma', 'Reyes', 'Ibrahim', 'Thomas', 'Al Zaabi', 'Fernandes', 'Haddad', 'Qureshi', 'Menon', 'Cruz', 'Saleh', 'Pillai', 'Abdullah', 'Rahman', 'George', 'Iyer'],
};
const NURSES = ['A. Haddad', 'S. Fernandes', 'R. Menon', 'L. Cruz', 'M. Saleh', 'J. Thomas', 'N. Al Zaabi', 'P. Nair', 'K. Qureshi', 'D. Reyes', 'H. Ibrahim', 'T. Pillai', 'F. Rahman', 'G. Santos'];
const ONCALL = ['B. Kurian', 'E. Morales', 'Y. Al Ali', 'C. Dsouza', 'W. Tan', 'R. Joseph', 'S. Mathew', 'A. Varghese'];

/* ---------- State ---------- */
let S = null;

function newState(speed) {
  return {
    t: 0,                          // simulated seconds since start (may be negative for seeded history)
    clock0: Date.now(),            // wall-clock origin for displayed times
    speed: speed || 30,            // simulated seconds per real second
    running: true,
    banners: [],                   // [{text, level:'critical'|'serious'|'warning'|'good', key}]
    incidents: [],                 // see spec.md
    patients: [], ambulances: [], beds: [], nurses: [],
    eq: {
      monitors: 30, vents: 10, ventFaulty: 0,
      ct: [{ id: 'CT-1', loc: 'ED', online: true, busyUntil: 0 }, { id: 'CT-2', loc: 'Radiology', online: true, busyUntil: 0 }],
      ctQueue: [],                 // patient ids awaiting CT
    },
    sup: {
      blood: { label: 'O-negative blood', unit: 'units', qty: 22, cap: 40, restock: 20, ask: 'Request 20 units of O-negative blood from the regional blood bank', log: [], pending: false },
      burn:  { label: 'Burn dressing kits', unit: 'kits', qty: 16, cap: 40, restock: 20, ask: 'Request 20 burn dressing kits from central sterile supply', log: [], pending: false },
      o2:    { label: 'Portable O₂ cylinders', unit: 'cyl.', qty: 30, cap: 60, restock: 20, ask: 'Request 20 portable O₂ cylinders from the medical gas store', log: [], pending: false },
    },
    src: {},                       // id -> {status:'live'|'offline', last:t}
    sugg: [], dismissed: {},       // dismissed: key -> sim time until which it stays suppressed
    feed: [], audit: [],
    occ: [],                       // [{t, occ}] occupancy % sampled per sim minute (max 60)
    d2b: [],                       // [{t, m}] door-to-bed minutes
    done: [],                      // [{t, dispo}] completed encounters
    sched: [],                     // [{at, fn}]
    icu: { cap: 8, used: 6 }, or: { cap: 4, used: 2 },
    diversionUntil: 0, walkBoost: null,
    bedsOffline: false, bedsFallback: false, bedsSnapshot: null, bedsSnapAt: 0, outageUntil: 0,
    ctRepair: false, ventLoan: false,
    fc: { pts: [], fullIn: null }, // latest forecast (written by aiPlan)
    nextPid: 1001, nextAmb: 11, nextInc: 1, nextSugg: 1, nextOnCall: 0, nextNurse: 15,
    lastSample: -60, lastVitMsg: 0, lastBeat: 0,
    announce: [],                  // level-1 titles for the screen-reader live region (UI drains it)
    // WASEL (15-wasel.js)
    mode: 'steady', modeSince: 0,  // 'steady' | 'strain' | 'surge' | 'mci', see MODE_RULES
    modeReason: 'All indicators within limits',
    modeLowerSince: null,          // sim t since the rules first called for a calmer mode
    mciDeclared: false,
    nextEnc: 101,                  // temporary encounter ids T-101, T-102… for EMS patients
    reunify: [],                   // family board rows of incident patients who have left the ED
  };
}

/* ---------- Lookups ---------- */
const P = id => S.patients.find(p => p.id === id) || null;
const bed = id => S.beds.find(b => b.id === id) || null;
const nurse = id => S.nurses.find(n => n.id === id) || null;
const amb = id => S.ambulances.find(a => a.id === id) || null;
const ambEsi = a => Math.min(...a.pts.map(P).filter(Boolean).map(p => p.esi), 5);
const bedsBusy = () => S.beds.filter(b => b.status !== 'free').length;
const monitorsInUse = () => S.patients.filter(p => p.monitor).length;
const ventsInUse = () => S.patients.filter(p => p.vent).length;
const ventsFree = () => Math.max(0, S.eq.vents - S.eq.ventFaulty - ventsInUse());
const monitorsFree = () => Math.max(0, S.eq.monitors - monitorsInUse());
const ctOnline = () => S.eq.ct.filter(u => u.online).length;
const ctWait = () => ctOnline() ? Math.round(S.eq.ctQueue.length * 7 / ctOnline()) : null;

/* ---------- Event plumbing ---------- */
// Integration feed: one line per message received from a source system.
function emit(srcId, std, text) {
  if (srcId === 'beds' && S.bedsOffline) {
    if (!S.bedsFallback) return;   // feed is down: message never arrives
    std = 'RTLS backup';
  }
  S.feed.unshift({ t: S.t, src: srcId, std, text });
  if (S.feed.length > 80) S.feed.pop();
  if (S.src[srcId] && S.src[srcId].status === 'live') S.src[srcId].last = S.t;
}
// Audit trail (HIPAA §164.312(b) audit controls): who did what, under which role.
function audit(text) {
  S.audit.unshift({ t: S.t, role: ROLES[prefs.role].label, text });
  if (S.audit.length > 150) S.audit.pop();
}
function schedule(delaySec, fn) { S.sched.push({ at: S.t + delaySec, fn }); }
function runSchedule() {
  if (!S.sched.length) return;
  const due = S.sched.filter(e => e.at <= S.t);
  if (!due.length) return;
  S.sched = S.sched.filter(e => e.at > S.t);
  due.forEach(e => e.fn());
}
function addBanner(text, level, key) {
  S.banners = S.banners.filter(b => b.key !== key);
  S.banners.push({ text, level, key });
}
function clearBanner(key) { S.banners = S.banners.filter(b => b.key !== key); }
