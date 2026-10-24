/* =========================================================================
 * WASEL ER Command Dashboard · test/v2-test.js
 * Headless test of the v2 (WASEL) layer on top of engine + AI. No DOM.
 *
 *   cat src/00-core.js src/10-engine.js src/15-wasel.js src/20-ai.js test/v2-test.js > /private/tmp/claude-v2test.js
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc /private/tmp/claude-v2test.js
 *
 * Part A: 7 scenarios × 3 seeds × 3 simulated hours, step(10), a simulated
 *         operator accepts ~70% of open cards every sim minute. v1 + v2
 *         invariants are asserted after every step.
 * Part B: one pile-up pass accepting nothing (task escalation).
 * Part C: unit tests for receivePreAlert, identity, LWBS, checkOrder,
 *         overrideOrder, familyBoard, sbar, modes.
 * Exits by throwing if any check fails.
 * ========================================================================= */
var console = { log: print };

const STEP = 10, STEPS = 3 * 3600 / STEP, P_ACCEPT = 0.7;
const SEEDS = [11, 22, 33];
const SCENARIOS = [
  { name: 'none', ids: [] },
  { name: 'pileup', ids: ['pileup'] },
  { name: 'fire', ids: ['fire'] },
  { name: 'staff', ids: ['staff'] },
  { name: 'equipment', ids: ['equipment'] },
  { name: 'outage', ids: ['outage'] },
  { name: 'combined', ids: ['pileup', 'fire', 'staff', 'equipment', 'outage'] },
];

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fresh(seed) {
  Math.random = mulberry32(seed);
  prefs.role = 'charge'; prefs.autoAccept = false;
  S = null;
  init();
}

/* ---------- Reporting ---------- */
const R = { pass: 0, fail: 0, failures: [] };
function ok(cond, name, detail) {
  if (cond) R.pass++;
  else { R.fail++; R.failures.push(name + (detail !== undefined ? ' :: ' + detail : '')); }
  return !!cond;
}
function runFail(run, kind, detail) {
  const e = run.errors[kind] || (run.errors[kind] = { n: 0, first: `+${(S.t / 60).toFixed(1)}m ${detail}` });
  e.n++;
}

/* ---------- Constants for checks ---------- */
const MODES = MODE_RULES.order;
const rank = m => MODES.indexOf(m);
const OWNERS = ['Receiving nurse', 'Charge nurse', 'Physician', 'ED coordinator'];
const OWNER0 = { placement: 'Receiving nurse', prearrival: 'Receiving nurse', identity: 'Receiving nurse', lwbs: 'Receiving nurse',
  retriage: 'Physician', needvent: 'Physician', trauma: 'Physician' };   // trauma: 16-readiness.js
const NEXT_OWNER = { 'Receiving nurse': 'Charge nurse', 'Charge nurse': 'ED coordinator', 'Physician': 'ED coordinator' };
const ownerAfter = (o, n) => { for (let i = 0; i < n && NEXT_OWNER[o]; i++) o = NEXT_OWNER[o]; return o; };
const ID_STATUS = ['confirmed', 'candidate', 'temporary'], ID_METHOD = ['face', 'fingerprint', 'nfc', 'emirates-id', 'none'];
const SAFETY_KEYS = ['allergies', 'anticoagulant', 'bloodType', 'source', 'asOf', 'restricted'];
const ATMIST_KEYS = ['age', 'time', 'mechanism', 'injuries', 'signs', 'treatment'];
const SIGN_KEYS = ['hr', 'sbp', 'rr', 'spo2', 'gcs'];
const FAMILY_STATUS = ['Arriving', 'Waiting', 'In treatment', 'In surgery', 'ICU', 'Admitted to ward', 'Discharged', 'Transferred'];
const FAMILY_KEYS = ['enc', 'initials', 'status', 'since'];
const START_COL = ['red', 'yellow', 'green', 'black'];
const WASEL_TYPES = ['identity', 'lwbs', 'surge'];
const fin = x => typeof x === 'number' && Number.isFinite(x);
const subset = (keys, allowed) => keys.every(k => allowed.includes(k));
const MED_WORDS = Object.values(COND).map(c => c.label).concat(Object.values(COND).map(c => c.icd), WASEL_ALLERGENS, ['ESI', 'NEWS', 'Warfarin', 'Apixaban']);

/* ---------- Invariants (after every step) ---------- */
function invariants(run) {
  const f = (k, d) => runFail(run, k, d);
  const live = S.patients.filter(p => p.stage !== 'done');
  // v1: beds, holds, vitals, supplies
  const bedOwner = {};
  for (const p of live) {
    for (const k of ['hr', 'sbp', 'rr', 'spo2', 'temp']) if (!fin(p.v[k])) f('NaN vital', `${p.id} ${k}=${p.v[k]}`);
    if (!fin(p.news)) f('NaN NEWS2', p.id);
    if (p.stage === 'treatment' || p.stage === 'boarding') {
      const b = bed(p.bed);
      if (!b || b.status !== 'occupied' || b.pid !== p.id) f('treatment patient without bed', `${p.id} ${p.stage} bed=${p.bed}`);
    } else if (p.bed) f('untreated patient holds a bed', `${p.id} ${p.stage} ${p.bed}`);
    if (p.bed) { if (bedOwner[p.bed]) f('double-booked bed', `${p.bed}: ${bedOwner[p.bed]} + ${p.id}`); bedOwner[p.bed] = p.id; }
  }
  for (const b of S.beds) {
    if (b.status === 'occupied') { const p = P(b.pid); if (!p || p.bed !== b.id) f('occupied bed not owned back', `${b.id} pid=${b.pid}`); }
    if (b.hold) {
      const s = S.sugg.find(x => x.id === b.hold);
      if (!s) f('bed hold without live suggestion', `${b.id} hold=${b.hold}`);
      else if (s.bed !== b.id) f('bed hold points at another bed', `${b.id} → ${s.id}/${s.bed}`);
      if (b.status !== 'free') f('held bed not free', `${b.id} ${b.status}`);
    }
  }
  for (const k in S.sup) { const q = S.sup[k].qty; if (!fin(q) || q < 0) f('supply below 0', `${k}=${q}`); }

  // v2: mode
  if (!MODES.includes(S.mode)) f('invalid mode', S.mode);
  if (typeof S.modeReason !== 'string' || !S.modeReason) f('missing modeReason', S.modeReason);

  // v2: encounters, identity, safety, ATMIST
  const encs = {};
  for (const p of live) {
    if (encs[p.enc]) f('duplicate encounter id', `${p.enc}: ${encs[p.enc]} + ${p.id}`);
    encs[p.enc] = p.id;
    const id = p.identity, sf = p.safety;
    if (!id || !ID_STATUS.includes(id.status) || !ID_METHOD.includes(id.method)) { f('bad identity', `${p.id} ${JSON.stringify(id)}`); continue; }
    // candidate: a match score; temporary: none; confirmed may keep the score of the match the nurse confirmed
    if (id.status === 'candidate' ? !(fin(id.confidence) && id.confidence >= 0 && id.confidence <= 1) : id.status === 'temporary' ? id.confidence != null : !(id.confidence == null || (fin(id.confidence) && id.confidence <= 1)))
      f('identity confidence', `${p.id} ${JSON.stringify(id)}`);
    if (!sf || !subset(Object.keys(sf), SAFETY_KEYS) || SAFETY_KEYS.some(k => !(k in sf))) { f('bad safety shape', `${p.id} ${JSON.stringify(sf)}`); continue; }
    if (sf.allergies !== null && !Array.isArray(sf.allergies)) f('allergies not array|null', p.id);
    if (!p.preAlert) {
      const unknownOk = id.status === 'temporary' || sf.restricted;
      if ((sf.allergies === null) !== !!unknownOk) f('allergies null iff temporary/restricted', `${p.id} ${p.src} id=${id.status} restricted=${sf.restricted} allergies=${JSON.stringify(sf.allergies)}`);
    }
    if (p.src === 'EMS') {
      if (!/^T-\d+$/.test(p.enc || '')) f('EMS patient without T- encounter', `${p.id} enc=${p.enc} stage=${p.stage}`);
      const a = p.atmist;
      if (!a || !subset(Object.keys(a), ATMIST_KEYS) || ATMIST_KEYS.some(k => a[k] == null || a[k] === '')) f('EMS patient without ATMIST', `${p.id} ${JSON.stringify(a)}`);
      else {
        if (!subset(Object.keys(a.signs), SIGN_KEYS) || SIGN_KEYS.some(k => !fin(a.signs[k]))) f('ATMIST signs', `${p.id} ${JSON.stringify(a.signs)}`);
        else if (!(a.signs.gcs === 15 || (a.signs.gcs >= 3 && a.signs.gcs <= 13))) f('ATMIST GCS', `${p.id} gcs=${a.signs.gcs}`);
      }
      if (!p.preAlert && p.incident && p.stage === 'inbound') {
        // sim field patients: candidate face 0.86–0.98, confirmed nfc, temporary none
        const okId = (id.status === 'candidate' && id.method === 'face' && id.confidence >= 0.86 && id.confidence <= 0.98)
          || (id.status === 'confirmed' && id.method === 'nfc') || (id.status === 'temporary' && id.method === 'none');
        if (!okId) f('field identity distribution shape', `${p.id} ${JSON.stringify(id)}`);
      }
      if (S.mode === 'mci' && p.stage === 'inbound' && !START_COL.includes(p.start)) f('MCI inbound patient without START colour', `${p.id} ${p.enc} start=${p.start}`);
    } else {
      if (p.enc !== p.id) f('walk-in enc != id', `${p.id} enc=${p.enc}`);
      if (!(id.status === 'confirmed' && id.method === 'emirates-id')) f('walk-in identity', `${p.id} ${JSON.stringify(id)}`);
    }
    // identity card for every candidate past the door
    if (p.stage !== 'inbound' && id.status === 'candidate' && !S.sugg.some(s => s.key === 'identity:' + p.id) && !(S.dismissed['identity:' + p.id] > S.t))
      f('candidate without identity card', `${p.id} ${p.enc} ${p.stage}`);
    if (p.stage === 'inbound' && S.sugg.some(s => s.key === 'identity:' + p.id)) f('identity card before arrival', p.id);
    // LWBS card for long-waiting ESI 4–5
    if (p.stage === 'waiting' && p.esi >= 4 && !p.clinicOffer && S.t - p.arrivedAt > WASEL_CFG.lwbsMin * 60
      && !S.sugg.some(s => s.key === 'lwbs:' + p.id) && !(S.dismissed['lwbs:' + p.id] > S.t)) {
      f('long-waiting ESI 4-5 without lwbs card', `${p.id} ESI ${p.esi} waited ${mins(S.t - p.arrivedAt)} min`);
    }
  }

  // v2: tasks (owner, clock, escalation)
  for (const s of S.sugg) {
    if (!OWNERS.includes(s.owner)) f('suggestion without owner', `${s.id} ${s.type} owner=${s.owner}`);
    if (![1, 2, 3].includes(s.level)) f('suggestion level', `${s.id} ${s.level}`);
    if (s.escalatesAt != null && S.t > s.escalatesAt) f('overdue task not escalated', `${s.id} ${s.type} t=${S.t} esc=${s.escalatesAt}`);
    let seen = run.seen.get(s.id);
    if (!seen) {
      seen = { type: s.type, level0: s.level, owner0: s.owner, esc0: s.escalated || 0 };
      run.seen.set(s.id, seen);
      if (seen.esc0 === 0 && s.owner !== (OWNER0[s.type] || 'Charge nurse')) f('wrong initial owner', `${s.type} → ${s.owner}`);
      if (seen.esc0 === 0 && s.escalatesAt !== s.at + escWindow(s.level)) f('wrong escalatesAt', `${s.id} ${s.type} at=${s.at} esc=${s.escalatesAt}`);
      run.created[s.type] = (run.created[s.type] || 0) + 1;
    }
    const e = (s.escalated || 0) - seen.esc0;
    if (e > 0) {
      run.maxEsc = Math.max(run.maxEsc, s.escalated);
      if (s.owner !== ownerAfter(seen.owner0, e)) f('escalation owner chain', `${s.id} ${seen.owner0} ×${e} → ${s.owner}`);
      if (s.level !== Math.max(1, seen.level0 - e)) f('escalation level', `${s.id} L${seen.level0} ×${e} → L${s.level}`);
      if (s.owner === 'ED coordinator' && s.escalatesAt != null) f('top owner still escalates', s.id);
    }
  }
  for (const b of S.beds) if (b.hold && !S.sugg.some(s => s.id === b.hold)) f('hold leak', b.id);
}

function checkFamily(run) {
  const rows = familyBoard();
  for (const r of rows) {
    if (!subset(Object.keys(r), FAMILY_KEYS) || FAMILY_KEYS.some(k => !(k in r))) runFail(run, 'familyBoard row keys', JSON.stringify(r));
    if (!FAMILY_STATUS.includes(r.status)) runFail(run, 'familyBoard status', r.status);
    if (!/^(—|(?:[A-Z]\.){1,4})$/.test(r.initials)) runFail(run, 'familyBoard initials', r.initials);
    const txt = JSON.stringify(r);
    for (const w of MED_WORDS) if (txt.includes(w)) runFail(run, 'familyBoard medical detail', `${w} in ${txt}`);
  }
  const live = S.patients.filter(p => p.incident && p.stage !== 'done');
  for (const p of live) if (!rows.some(r => r.enc === p.enc)) runFail(run, 'familyBoard misses incident patient', p.enc);
  run.familyDone = Math.max(run.familyDone, rows.filter(r => ['In surgery', 'ICU', 'Admitted to ward', 'Discharged'].includes(r.status)).length);
}

/* ---------- Operator: accepts ~70% of open cards each sim minute ---------- */
function operator(run) {
  for (const s of S.sugg.slice()) {
    if (!S.sugg.includes(s) || Math.random() >= P_ACCEPT) continue;
    const valid = stillValid(s), p = s.pid ? P(s.pid) : null;
    const icu0 = S.icu.cap, inc0 = S.nurses.filter(n => n.status === 'incoming').length, feed0 = S.feed.length ? S.feed[0] : null;
    const r = accept(s, 'manual');
    if (r) run.accepted[s.type] = (run.accepted[s.type] || 0) + 1;
    if (!WASEL_TYPES.includes(s.type)) continue;
    if (valid && !r) runFail(run, `accept(${s.type}) refused while valid`, s.title);
    if (!r) continue;
    const newFeed = S.feed.slice(0, Math.max(0, S.feed.indexOf(feed0))).map(x => x.text).join(' | ');
    if (s.type === 'identity') {
      if (p.identity.status !== 'confirmed') runFail(run, 'identity accept did not confirm', p.id);
      if (!newFeed.includes(`Identity confirmed ${p.enc}`)) runFail(run, 'identity accept no ehr emit', newFeed);
    } else if (s.type === 'surge') {
      if (S.icu.cap !== icu0 + 2) runFail(run, 'surge accept icu cap', `${icu0} → ${S.icu.cap}`);
      if (S.nurses.filter(n => n.status === 'incoming').length !== inc0 + 2) runFail(run, 'surge accept call-in', '');
      if (!/Blood bank standby/.test(newFeed)) runFail(run, 'surge accept no blood bank emit', newFeed);
    } else if (s.type === 'lwbs') {
      if (!(p.clinicOffer || (p.stage === 'treatment' && bed(p.bed).zone === 'F'))) runFail(run, 'lwbs accept outcome', `${p.id} ${p.stage}`);
    }
  }
}

/* ---------- One simulated run ---------- */
function simulate(sc, seed, acceptNothing, steps) {
  fresh(seed);
  const run = { sc: sc.name, seed, errors: {}, seen: new Map(), created: {}, accepted: {}, modes: [[0, S.mode]], maxEsc: 0,
    familyDone: 0, emsSeen: new Set(), peakMode: S.mode };
  for (const id of sc.ids) runScenario(id);
  invariants(run);
  for (let i = 1; i <= (steps || STEPS); i++) {
    const before = S.mode;
    step(STEP);
    for (const p of S.patients) if (p.src === 'EMS') run.emsSeen.add(p.id);
    if (S.mode !== before) {
      run.modes.push([S.t, S.mode]);
      if (rank(S.mode) > rank(run.peakMode)) run.peakMode = S.mode;
      const L = MODE_RULES.label;
      if (!S.feed.some(x => x.src === 'ems' && x.std === 'NCEMA' && x.text.startsWith(`Mode ${L[before]} → ${L[S.mode]}`))) runFail(run, 'mode change not emitted', `${before}→${S.mode}`);
      if (!S.audit.some(x => x.text.startsWith(`Mode changed to ${L[S.mode]}`))) runFail(run, 'mode change not audited', S.mode);
      if (S.modeSince !== S.t) runFail(run, 'modeSince not updated', `${S.modeSince} vs ${S.t}`);
    }
    invariants(run);
    if (i % 6 === 0) {
      checkFamily(run);
      if (!acceptNothing) { operator(run); invariants(run); }
    }
  }
  run.finalMode = S.mode;
  return run;
}

/* =========================== Part A: scenarios =========================== */
console.log('WASEL v2 test · ' + SCENARIOS.length + ' scenarios × ' + SEEDS.length + ' seeds × 3 sim-hours, step(10), accept ~70%/min');
const allRuns = [];
for (const sc of SCENARIOS) {
  for (const seed of SEEDS) {
    let run;
    try { run = simulate(sc, seed, false); }
    catch (e) { ok(false, `${sc.name}/${seed} threw`, e && e.stack || e); continue; }
    allRuns.push(run);
    const errs = Object.keys(run.errors);
    ok(errs.length === 0, `${sc.name}/seed ${seed} invariants`, errs.map(k => `${k} ×${run.errors[k].n} (first ${run.errors[k].first})`).join('; '));
    const modeSeq = run.modes.map(m => m[1]);
    // Mode progression
    if (sc.ids.includes('pileup') || sc.ids.includes('fire')) {
      const firstMci = modeSeq.indexOf('mci');
      ok(firstMci > 0, `${sc.name}/${seed} reaches MCI from a calmer mode`, modeSeq.join('→'));
      ok(modeSeq.slice(0, firstMci + 1).every((m, i, a) => i === 0 || rank(m) > rank(a[i - 1])), `${sc.name}/${seed} escalates monotonically up to MCI`, modeSeq.join('→'));
      ok(rank(run.finalMode) < rank('mci'), `${sc.name}/${seed} steps down from MCI after the incident`, modeSeq.join('→'));
      ok(run.created.surge > 0, `${sc.name}/${seed} silent surge card`, JSON.stringify(run.created));
      ok(run.familyDone > 0, `${sc.name}/${seed} family board keeps patients who left`, run.familyDone);
    }
    if (sc.name === 'none') ok(!modeSeq.includes('mci'), `none/${seed} never MCI`, modeSeq.join('→'));
    const line = `  ${(sc.name + '/' + seed).padEnd(14)} modes ${modeSeq.map(m => m[0].toUpperCase() + m.slice(1, 3)).join('→').padEnd(28)}`
      + ` EMS ${String(run.emsSeen.size).padStart(3)} · cards ${Object.entries(run.created).filter(e => WASEL_TYPES.includes(e[0])).map(e => e[0] + ' ' + e[1]).join(', ') || '—'}`
      + ` · accepted id/lwbs/surge ${run.accepted.identity || 0}/${run.accepted.lwbs || 0}/${run.accepted.surge || 0}`
      + ` · max esc ${run.maxEsc}` + (errs.length ? '  ✗ ' + errs.join(', ') : '  ✓');
    console.log(line); for (const k of errs) console.log("      " + k + " ×" + run.errors[k].n + " first " + run.errors[k].first);
  }
}
const sumCreated = k => allRuns.reduce((n, r) => n + (r.created[k] || 0), 0);
ok(sumCreated('identity') > 0, 'identity cards appear across runs');
ok(allRuns.reduce((n, r) => n + (r.accepted.identity || 0), 0) > 0, 'identity cards accepted across runs');

/* ====================== Part B: escalation, accept nothing ====================== */
{
  const run = simulate({ name: 'pileup', ids: ['pileup'] }, 7, true, 2 * 3600 / STEP);
  const errs = Object.keys(run.errors);
  ok(errs.length === 0, 'escalation pass invariants', errs.map(k => `${k} ×${run.errors[k].n} (first ${run.errors[k].first})`).join('; '));
  let esc1 = 0, esc2 = 0, toCharge = 0, toCoord = 0;
  for (const [, s] of run.seen) void s;
  const live = [...run.seen.keys()];
  // Count from the feed + audit (cards may be gone by the end)
  const escFeed = S.feed.filter(x => x.src === 'roster' && x.text.startsWith('Escalated: '));
  const escAudit = S.audit.filter(x => x.text.startsWith('Escalated: '));
  toCharge = escAudit.filter(x => x.text.endsWith('→ Charge nurse')).length;
  toCoord = escAudit.filter(x => x.text.endsWith('→ ED coordinator')).length;
  for (const s of S.sugg) { if (s.escalated >= 1) esc1++; if (s.escalated >= 2) esc2++; }
  ok(run.maxEsc >= 2, 'tasks escalate at least twice when left open', 'max ' + run.maxEsc);
  ok(escFeed.length > 0, 'escalation paged on roster feed');
  ok(toCharge > 0 && toCoord > 0, 'owners move up to Charge nurse and ED coordinator', `charge ${toCharge}, coordinator ${toCoord}`);
  console.log(`  escalation pass (pileup, nothing accepted, 2 h): ${live.length} cards seen · max escalated ×${run.maxEsc}`
    + ` · open cards escalated ≥1: ${esc1}, ≥2: ${esc2} · audit → Charge nurse ${toCharge}, → ED coordinator ${toCoord} · final mode ${S.mode}`);
}

/* ============================ Part C: unit tests ============================ */
const SAMPLE = enc => ({
  type: 'prealert', v: 1, encounter: enc,
  identity: { status: 'candidate', method: 'face', confidence: 0.94, display: 'F.K.' },
  atmist: { age: '45', time: '19:12', mechanism: 'Driver, frontal collision at ~100 km/h',
    injuries: 'Chest wall tenderness, open left femur fracture',
    signs: { hr: 124, sbp: 96, rr: 26, spo2: 92, gcs: 14 }, treatment: 'Pelvic binder, 1 L saline, 10 mg morphine IV' },
  priority: { system: 'ESI', level: 2 }, etaMin: 12,
  safety: { allergies: ['Penicillin'], anticoagulant: false, bloodType: 'O+', source: 'Riayati', asOf: '2026-03-14' },
});
const byEnc = enc => S.patients.filter(p => p.enc === enc);
const clone = o => JSON.parse(JSON.stringify(o));

// --- receivePreAlert: create, update, malformed, forbidden fields ---
fresh(101);
{
  const n0 = S.patients.length, a0 = S.ambulances.length, i0 = S.incidents.length;
  const r = receivePreAlert(SAMPLE('T-904'));
  ok(r.ok === true && r.encounter === 'T-904', 'prealert accepted', JSON.stringify(r));
  const ps = byEnc('T-904'), p = ps[0];
  ok(ps.length === 1 && S.patients.length === n0 + 1, 'prealert creates exactly one patient');
  ok(S.ambulances.length === a0 + 1, 'prealert creates one ambulance');
  ok(S.incidents.length === i0 + 1 && S.incidents[S.incidents.length - 1].name === 'Responder pre-alert', 'prealert opens a Responder pre-alert incident');
  const a = amb(p.amb);
  ok(a && a.status === 'enroute' && a.sceneUntil === S.t && a.eta === S.t + 12 * 60, 'prealert ambulance enroute, eta = t + etaMin·60', JSON.stringify(a));
  ok(p.esi === 2 && p.cond === 'femur' && p.src === 'EMS' && p.stage === 'inbound', 'prealert ESI 2 → femur', `${p.esi} ${p.cond}`);
  ok(p.v.hr === 124 && p.v.sbp === 96 && p.v.rr === 26 && p.v.spo2 === 92 && p.v.avpu === 'A', 'prealert vitals from atmist.signs (GCS 14 = alert)', JSON.stringify(p.v));
  ok(p.identity.status === 'candidate' && p.identity.method === 'face' && p.identity.confidence === 0.94, 'prealert identity', JSON.stringify(p.identity));
  ok(JSON.stringify(p.safety.allergies) === '["Penicillin"]' && p.safety.source === 'Riayati', 'prealert safety', JSON.stringify(p.safety));
  ok(p.atmist && p.atmist.mechanism.startsWith('Driver') && p.atmist.signs.gcs === 14 && p.age === 45, 'prealert atmist', JSON.stringify(p.atmist));
  ok(S.feed.some(x => x.src === 'ems' && x.std === 'FHIR' && x.text === 'Pre-alert T-904 received from responder app · identity candidate (face 94%)'), 'prealert emit text', S.feed[0].text);
  ok(S.audit.some(x => x.text === 'Pre-alert received: T-904'), 'prealert audit', S.audit[0].text);
  ok(S.nextEnc > 904, 'local encounter counter moves past responder ids', S.nextEnc);

  // repeat = update vitals + ETA only
  const m2 = SAMPLE('T-904'); m2.etaMin = 5; m2.atmist.signs = { hr: 140, sbp: 88, rr: 30, spo2: 89, gcs: 12 };
  m2.priority = { system: 'ESI', level: 1 }; m2.safety.allergies = []; m2.identity = { status: 'confirmed', method: 'nfc' };
  const r2 = receivePreAlert(m2);
  ok(r2.ok && r2.encounter === 'T-904' && r2.updated === true, 'repeat prealert updates', JSON.stringify(r2));
  ok(byEnc('T-904').length === 1 && S.patients.length === n0 + 1 && S.ambulances.length === a0 + 1, 'repeat prealert creates no duplicate');
  ok(amb(p.amb).eta === S.t + 5 * 60 && p.v.hr === 140 && p.atmist.signs.hr === 140, 'repeat prealert updates ETA + vitals');
  ok(p.esi === 2 && p.identity.status === 'candidate' && p.safety.allergies.length === 1, 'repeat prealert changes nothing but vitals/ETA');

  // a second encounter reuses the open incident
  const r3 = receivePreAlert(Object.assign(SAMPLE('T-905'), { priority: { system: 'START', level: 'yellow' }, identity: undefined, safety: { allergies: null } }));
  const q = byEnc('T-905')[0];
  ok(r3.ok && S.incidents.length === i0 + 1 && q.incident === p.incident, 'second prealert joins the open incident');
  ok(q.esi === 3 && q.start === 'yellow' && q.cond === 'abdo', 'START yellow → ESI 3, abdo', `${q.esi} ${q.start} ${q.cond}`);
  ok(q.identity.status === 'temporary' && q.identity.confidence === null, 'missing identity → temporary', JSON.stringify(q.identity));
  ok(q.safety.allergies === null, 'allergies null stays Unknown');
  for (const [lvl, esi, cond] of [['red', 1, 'polytrauma'], ['green', 4, 'wrist'], ['black', 5, 'whiplash']]) {
    const e = 'T-9' + (10 + esi);
    receivePreAlert(Object.assign(SAMPLE(e), { priority: { system: 'START', level: lvl } }));
    const x = byEnc(e)[0];
    ok(x && x.esi === esi && x.cond === cond && x.start === lvl, `START ${lvl} → ESI ${esi} ${cond}`, x && `${x.esi} ${x.cond} ${x.start}`);
  }
  receivePreAlert(Object.assign(SAMPLE('T-920'), { priority: { system: 'ESI', level: 5 } }));
  ok(byEnc('T-920')[0].cond === 'whiplash', 'ESI 5 → whiplash');

  // malformed
  const good = SAMPLE('T-930');
  const bad = [
    null, undefined, 'prealert', 42, [], {},
    Object.assign(clone(good), { v: 2 }), Object.assign(clone(good), { type: 'alert' }),
    Object.assign(clone(good), { encounter: undefined }), Object.assign(clone(good), { encounter: 'P-1001' }),
    Object.assign(clone(good), { encounter: 'T-' }), Object.assign(clone(good), { encounter: 104 }),
    Object.assign(clone(good), { encounter: 'T-930<script>' }),
    Object.assign(clone(good), { priority: undefined }), Object.assign(clone(good), { priority: { system: 'ESI', level: 0 } }),
    Object.assign(clone(good), { priority: { system: 'ESI', level: 6 } }), Object.assign(clone(good), { priority: { system: 'ESI', level: '2' } }),
    Object.assign(clone(good), { priority: { system: 'START', level: 'blue' } }), Object.assign(clone(good), { priority: { system: 'XYZ', level: 1 } }),
    Object.assign(clone(good), { etaMin: undefined }), Object.assign(clone(good), { etaMin: -1 }),
    Object.assign(clone(good), { etaMin: '8' }), Object.assign(clone(good), { etaMin: NaN }), Object.assign(clone(good), { etaMin: 1e6 }),
  ];
  const nP = S.patients.length, nA = S.ambulances.length, nAud = S.audit.length;
  let rejected = 0;
  for (const m of bad) {
    let r;
    try { r = receivePreAlert(m); } catch (e) { r = { threw: String(e) }; }
    if (r && r.ok === false && typeof r.error === 'string' && r.error) rejected++;
    else ok(false, 'malformed prealert rejected', JSON.stringify(m) + ' → ' + JSON.stringify(r));
  }
  ok(rejected === bad.length, `malformed prealerts rejected (${rejected}/${bad.length})`);
  ok(S.patients.length === nP && S.ambulances.length === nA && S.audit.length === nAud, 'malformed prealerts change nothing');

  // fields outside the contract are never stored
  const NAME = 'Zqxwv Bnmlk', IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgQQQ', EID = '784-1990-7654321-9';
  const evil = clone(good);
  evil.encounter = 'T-940';
  Object.assign(evil, { name: NAME, image: IMG, photo: IMG, faceTemplate: [1, 2, 3], emiratesId: EID, patient: { name: NAME } });
  Object.assign(evil.identity, { name: NAME, image: IMG, emiratesId: EID, template: 'abc' });
  evil.identity.display = NAME;                       // a full name in the initials field
  Object.assign(evil.atmist, { name: NAME, image: IMG });
  evil.atmist.signs.photo = IMG;
  Object.assign(evil.safety, { name: NAME, mrn: '1234567', emiratesId: EID, image: IMG });
  Object.assign(evil.priority, { name: NAME });
  const re = receivePreAlert(evil);
  ok(re.ok === true, 'prealert with extra fields still accepted (care is never delayed)', JSON.stringify(re));
  const pe = byEnc('T-940')[0];
  const keys = [];
  (function walk(o) { if (o && typeof o === 'object') for (const k of Object.keys(o)) { keys.push(k); walk(o[k]); } })({ p: pe, a: amb(pe.amb) });
  const FORBIDDEN_KEYS = ['name', 'image', 'photo', 'faceTemplate', 'template', 'emiratesId', 'patient', 'mrnExternal'];
  ok(!keys.some(k => FORBIDDEN_KEYS.includes(k)), 'no undocumented field keys stored', keys.filter(k => FORBIDDEN_KEYS.includes(k)).join(','));
  const dump = JSON.stringify(S);
  ok(!dump.includes(NAME) && !dump.includes('Zqxwv') && !dump.includes(IMG) && !dump.includes(EID), 'no name / image / Emirates ID value anywhere in state');
  ok(pe.identity.display === null && subset(Object.keys(pe.identity), ['status', 'method', 'confidence', 'display']), 'identity keeps contract keys only', JSON.stringify(pe.identity));
  ok(subset(Object.keys(pe.safety), SAFETY_KEYS) && subset(Object.keys(pe.atmist), ATMIST_KEYS) && subset(Object.keys(pe.atmist.signs), SIGN_KEYS), 'safety/atmist keep contract keys only');
  ok(pe.mrn !== '1234567', 'external mrn ignored');

  // invalid clinical field → Unknown, reported, still accepted
  const odd = clone(good); odd.encounter = 'T-941'; odd.identity = { status: 'merged' }; odd.safety.allergies = 'Penicillin';
  const ro = receivePreAlert(odd), po = byEnc('T-941')[0];
  ok(ro.ok && po.identity.status === 'temporary' && po.safety.allergies === null && /ignored invalid/.test(S.audit[0].text), 'invalid identity/allergies become Unknown and are audited', S.audit[0].text);

  // pre-alert patients travel and arrive normally; repeat after arrival creates nothing
  const fast = SAMPLE('T-950'); fast.etaMin = 0;
  receivePreAlert(fast);
  step(20);
  const pf = byEnc('T-950')[0];
  ok(pf && pf.stage !== 'inbound', 'etaMin 0 pre-alert arrives on the next step', pf && pf.stage);
  const nBefore = S.patients.length, rr = receivePreAlert(SAMPLE('T-950'));
  ok(rr.ok && rr.updated === false && S.patients.length === nBefore && byEnc('T-950').length === 1, 'repeat after arrival: no duplicate', JSON.stringify(rr));

  // identity card on arrival, accept confirms
  const card = S.sugg.find(s => s.key === 'identity:' + pf.id);
  ok(card && card.type === 'identity' && card.level === 2 && card.owner === 'Receiving nurse'
    && card.title === 'Confirm identity of T-950 (face match 94%)'
    && card.why === 'Compare with patient, relative or documents. A candidate never merges charts.', 'identity card on arrival', card && JSON.stringify(card));
  ok(!S.sugg.some(s => s.key === 'identity:' + p.id), 'no identity card while still inbound');
  ok(accept(card, 'manual') === true && pf.identity.status === 'confirmed', 'accept identity confirms');
  ok(S.feed.some(x => x.src === 'ehr' && x.text === 'Identity confirmed T-950 · chart linked via Riayati'), 'identity confirm emits ehr', S.feed[0].text);
  aiPlan();
  ok(!S.sugg.some(s => s.key === 'identity:' + pf.id), 'confirmed identity gets no new card');

  // sbar: strings, no names
  const sb = sbar(pf);
  ok(['s', 'b', 'a', 'r'].every(k => typeof sb[k] === 'string' && sb[k].length > 10), 'sbar returns s/b/a/r strings');
  ok(!JSON.stringify(sb).includes(pf.first + ' ' + pf.last), 'sbar carries no patient name');
  ok(sb.b.includes('Driver, frontal collision') && /ALLERGY: Penicillin/.test(sb.b), 'sbar background from atmist + allergies', sb.b);
}

// --- MCI: START colour on every field patient, pre-alerts included ---
fresh(102);
{
  waselDeclareMci(true);
  ok(S.mode === 'mci' && S.mciDeclared, 'Declare MCI → mode mci immediately', S.mode);
  ok(S.sugg.some(s => s.type === 'surge' && s.level === 1 && s.owner === 'Charge nurse'), 'entering MCI proposes silent surge');
  receivePreAlert(SAMPLE('T-960'));
  const p = byEnc('T-960')[0];
  ok(START_COL.includes(p.start), 'ESI pre-alert in MCI carries a START colour', p.start);
  const inc = incident('Test crash', 'Here', 'test', 3, 'pileup');
  const a = dispatchAmb(inc, 'pileup', 3);
  ok(a.pts.map(P).every(x => START_COL.includes(x.start) && x.start === (x.esi <= 2 ? 'red' : x.esi === 3 ? 'yellow' : 'green')), 'dispatched field patients in MCI carry START by ESI');
  waselDeclareMci(false);
  ok(S.mode === 'mci', 'stand-down does not drop the mode at once (no flicker)');
  step(MODE_RULES.stepDownMin * 60 + 120);
  ok(rank(S.mode) < rank('mci'), 'mode steps down after stepDownMin', S.mode + ' · ' + S.modeReason);
}

// --- LWBS ---
fresh(103);
{
  for (const b of S.beds) if (b.zone === 'F' || b.zone === 'A') { if (b.status === 'free') { b.status = 'cleaning'; b.until = S.t + 99 * 3600; } }
  aiPlan();
  const mk = (cond, waitMin) => { const p = makePatient(cond, 'Walk-in'); S.patients.push(p); arrive(p); p.arrivedAt = S.t - waitMin * 60; p.esi = COND[cond].esi[0]; assess(p); return p; };
  const a = mk('ankle', 72), y = mk('wrist', 59), c = mk('abdoPain', 120);
  aiPlan();
  const s = S.sugg.find(x => x.key === 'lwbs:' + a.id);
  ok(s && s.type === 'lwbs' && s.level === 3 && s.owner === 'Receiving nurse', 'lwbs card for ESI 5 waiting 72 min', s && JSON.stringify(s));
  ok(s && s.title.startsWith(`${a.enc} at risk of leaving without being seen (72 min): offer fast-track or the partner clinic (live wait `), 'lwbs title', s && s.title);
  ok(!S.sugg.some(x => x.key === 'lwbs:' + y.id), 'no lwbs at 59 min');
  ok(!S.sugg.some(x => x.key === 'lwbs:' + c.id), 'no lwbs for ESI 3');
  ok(accept(s, 'manual') && a.clinicOffer === true && a.stage === 'waiting', 'lwbs accept with no fast-track bed → clinic offer');
  ok(S.feed.some(x => x.text.includes(a.enc) && /partner urgent-care clinic/.test(x.text)), 'lwbs clinic offer emitted');
  aiPlan();
  ok(!S.sugg.some(x => x.key === 'lwbs:' + a.id), 'no new lwbs card after clinic offer');

  // free one fast-track bed: accept places the patient there, own placement card released
  let fb = S.beds.find(b => b.zone === 'F' && b.status === 'cleaning');
  if (!fb) {                                   // every fast-track bed occupied: discharge one occupant
    fb = S.beds.find(b => b.zone === 'F');
    const occ = P(fb.pid);
    if (occ) { occ.dispo = 'discharge'; leave(occ, 'test'); S.patients = S.patients.filter(x => x.stage !== 'done'); }
  }
  fb.status = 'free'; fb.until = 0;
  // w is the only ESI 4–5 patient in the lobby, so the freed bed is not promised to anyone else
  S.patients = S.patients.filter(x => !(x.stage === 'waiting' && x.esi >= 4));
  aiPlan();
  const w = mk('whiplash', 80);
  aiPlan();
  const s2 = S.sugg.find(x => x.key === 'lwbs:' + w.id);
  ok(!!s2, 'lwbs card for ESI 4–5 waiting 80 min');
  if (s2) {
    ok(s2.title.includes('(80 min)') && S.sugg.some(x => x.key === 'placement:' + w.id && x.bed === fb.id), 'free fast-track bed held for the lobby patient');
    ok(accept(s2, 'manual') && w.stage === 'treatment' && w.bed === fb.id, 'lwbs accept with free fast-track bed places the patient', `${w.stage} ${w.bed}`);
    ok(!S.sugg.some(x => x.key === 'placement:' + w.id), 'lwbs accept releases the patient\'s own placement card');
    ok(S.beds.every(b => !b.hold || S.sugg.some(x => x.id === b.hold && x.bed === b.id)), 'no orphan holds after lwbs placement');
  }
  // a patient re-triaged to ESI 2 must not keep a clinic-offer card
  const z = mk('laceration', 90);
  aiPlan();
  const s3 = S.sugg.find(x => x.key === 'lwbs:' + z.id);
  z.esi = 2;
  ok(!!s3 && !stillValid(s3), 'lwbs card invalid once the patient is ESI 1–3', s3 && 'still valid');
}

// --- checkOrder / overrideOrder ---
fresh(104);
{
  const mk = (allergies, anticoagulant, restricted) => {
    const p = makePatient('femur', 'Walk-in');
    p.safety = { allergies, anticoagulant, bloodType: 'O+', source: allergies ? 'Malaffi' : null, asOf: allergies ? '2026-01-10' : null, restricted: !!restricted };
    p.meds = anticoagulant ? ['Warfarin'] : [];
    return p;
  };
  ok(DRUGS.length === 9 && ['Amoxicillin', 'Ceftriaxone', 'Morphine', 'Ibuprofen', 'Ketorolac', 'Heparin', 'Tranexamic acid', 'Paracetamol', 'IV contrast'].every(n => DRUGS.some(d => d.name === n)), 'DRUGS list');
  const hs = (p, d) => { const r = checkOrder(p, d); return r.ok === false && r.hardStop === true && typeof r.reason === 'string'; };
  const pass = (p, d) => { const r = checkOrder(p, d); return r.ok === true && r.hardStop === false; };
  ok(hs(mk(['Penicillin'], false), 'Amoxicillin'), 'Penicillin allergy hard-stops Amoxicillin');
  ok(hs(mk(['Penicillin'], false), 'amoxicillin'), 'drug name is case-insensitive');
  ok(hs(mk(['NSAIDs'], false), 'Ibuprofen') && hs(mk(['NSAIDs'], false), 'Ketorolac'), 'NSAID allergy hard-stops Ibuprofen, Ketorolac');
  ok(hs(mk(['Contrast media'], false), 'IV contrast'), 'Contrast allergy hard-stops IV contrast');
  ok(hs(mk(['Morphine'], false), 'Morphine'), 'Morphine allergy hard-stops Morphine');
  ok(hs(mk(['Latex', 'Penicillin'], false), 'Amoxicillin'), 'second allergy on the list still hard-stops');
  ok(pass(mk(['Sulfonamides'], false), 'Amoxicillin') && !checkOrder(mk(['Sulfonamides'], false), 'Amoxicillin').warning, 'unrelated allergy passes');
  ok(pass(mk(['Penicillin'], false), 'Ceftriaxone') && checkOrder(mk(['Penicillin'], false), 'Ceftriaxone').warning, 'Ceftriaxone with Penicillin allergy warns, no hard stop');
  ok(hs(mk([], true), 'Heparin'), 'Heparin + anticoagulant hard-stops');
  ok(hs(mk(null, true), 'Heparin'), 'Heparin + anticoagulant hard-stops even with allergies unknown');
  ok(pass(mk([], false), 'Heparin'), 'Heparin without anticoagulant passes');
  const u = checkOrder(mk(null, null), 'Paracetamol');
  ok(u.ok === true && u.hardStop === false && u.reason.startsWith('Allergy status UNKNOWN') && /ask patient or family before giving/.test(u.reason), 'allergies null → UNKNOWN warning', JSON.stringify(u));
  const ua = checkOrder(mk(null, null), 'Amoxicillin');
  ok(ua.ok === true && ua.hardStop === false && ua.reason.startsWith('Allergy status UNKNOWN'), 'allergies null + Amoxicillin → UNKNOWN warning, not a pass', JSON.stringify(ua));
  const ur = checkOrder(mk(['Penicillin'], false, true), 'Paracetamol');
  ok(ur.ok === true && ur.hardStop === false && ur.reason.startsWith('Allergy status UNKNOWN'), 'restricted record treated as UNKNOWN', JSON.stringify(ur));
  const unk = checkOrder(mk([], false), 'Aspirin');
  ok(unk.ok === false && unk.hardStop === false, 'unknown drug is not ok', JSON.stringify(unk));
  ok(checkOrder(mk([], false), 'Paracetamol').warning === false, 'clean order has no warning');

  const p = mk(['Penicillin'], false); p.enc = 'T-777'; S.patients.push(p);
  const nA = S.audit.length, nF = S.feed.length;
  ok(overrideOrder(p, 'Amoxicillin', 'too short').ok === false, 'override needs ≥10 chars (9)');
  ok(overrideOrder(p, 'Amoxicillin', '   abc      ').ok === false, 'override reason is trimmed');
  ok(overrideOrder(p, 'Amoxicillin', null).ok === false, 'override without reason refused');
  ok(S.audit.length === nA && S.feed.length === nF, 'refused override writes nothing');
  const why = 'Allergy disputed by family; benefit outweighs risk';
  const ro = overrideOrder(p, 'Amoxicillin', why);
  ok(ro.ok === true, 'override with reason accepted', JSON.stringify(ro));
  ok(S.audit[0].text === `Override hard stop: Amoxicillin for T-777 · reason: ${why}`, 'override audited', S.audit[0].text);
  ok(S.feed.some(x => x.src === 'ehr' && x.text.startsWith('MedicationRequest Amoxicillin')), 'override emits ehr MedicationRequest', S.feed[0].text);
  ok(overrideOrder(p, 'Amoxicillin', '1234567890').ok === true, 'exactly 10 chars accepted');
}

// --- familyBoard: status only ---
fresh(105);
{
  runScenario('pileup');
  step(40 * 60);
  const rows = familyBoard();
  ok(rows.length > 0, 'familyBoard has rows during pileup', rows.length);
  ok(rows.every(r => Object.keys(r).length === 4 && subset(Object.keys(r), FAMILY_KEYS)), 'familyBoard rows carry enc/initials/status/since only', JSON.stringify(rows[0]));
  const txt = JSON.stringify(rows);
  ok(!MED_WORDS.some(w => txt.includes(w)), 'familyBoard has no medical words', MED_WORDS.filter(w => txt.includes(w)).join(','));
  ok(rows.every(r => FAMILY_STATUS.includes(r.status)), 'familyBoard statuses from the contract');
  ok(!S.patients.some(p => p.identity.status !== 'confirmed' && p.incident && rows.find(r => r.enc === p.enc && r.initials !== '—')), 'unconfirmed identities show no initials');
}

/* ============ Part D: v3 low-friction flow (CHANNELS.md) ============ */
const CALL = (id, extra) => Object.assign({ type: 'incident', v: 1, id, kind: 'rtc', place: 'E311 highway, km 42', casualties: 6,
  severity: 'major', trapped: true, hazards: ['fuel'], units: { ambulances: 3, rescue: 1, fire: 1 }, ts: 1729780000000 }, extra);
const callAmbs = id => S.ambulances.filter(a => a.incident === id);
const callPts = id => S.patients.filter(p => p.incident === id);

// --- receiveIncident: creates an unconfirmed incident, then staggered ambulances ---
fresh(201);
{
  const i0 = S.incidents.length, a0 = S.ambulances.length;
  const r = receiveIncident(CALL('CALL-4821'));
  ok(r.ok === true && r.id === 'CALL-4821' && r.dispatched === 3, 'incident accepted', JSON.stringify(r));
  const inc = S.incidents.find(i => i.id === 'CALL-4821');
  ok(S.incidents.length === i0 + 1 && inc && inc.name === 'Road traffic collision' && inc.place === 'E311 highway, km 42'
    && inc.via === '998 call · WASEL Dispatch' && inc.est === 6 && inc.kind === 'rtc' && inc.unconfirmed === true, 'incident shape', JSON.stringify(inc));
  ok(S.audit.some(x => x.text === 'Incident received from dispatch: CALL-4821'), 'incident audited', S.audit[0].text);
  ok(S.feed.some(x => x.src === 'ems' && x.std === 'CAD' && x.text.startsWith('CALL-4821 from WASEL Dispatch: Road traffic collision')), 'incident CAD line', S.feed[0].text);
  ok(S.ambulances.length === a0, 'ambulances are scheduled, not instant');
  step(70);
  ok(callAmbs('CALL-4821').length === 1 && inc.unconfirmed === false, 'first crew on scene confirms the incident');
  step(3 * 60);
  const ambs = callAmbs('CALL-4821');
  ok(ambs.length === 3 && ambs.every(a => a.pts.length === 2), '3 ambulances carry 2 casualties each', ambs.map(a => a.pts.length).join(','));
  const at = ambs.map(a => a.dispatchedAt).sort((x, y) => x - y);
  ok(at[1] - at[0] >= 50 && at[2] - at[1] >= 50 && at[1] - at[0] <= 70, 'ambulances staggered ~60 s apart', at.join(','));
  ok(callPts('CALL-4821').length === 6 && callPts('CALL-4821').every(p => p.src === 'EMS' && MIX.pileup.some(e => e[0] === p.cond)), 'rtc casualties drawn from the pile-up mix');
  ok(callPts('CALL-4821').every(p => /^T-\d+$/.test(p.enc) && p.atmist && WASEL_MECHANISM.rtc.includes(p.atmist.mechanism)), 'rtc casualties carry T- encounters and collision ATMIST');

  // same id = update, never a duplicate; extra ambulances carry only the new casualties
  const r2 = receiveIncident(CALL('CALL-4821', { casualties: 9, units: { ambulances: 4 } }));
  ok(r2.ok && r2.updated === true && r2.dispatched === 1 && S.incidents.filter(i => i.id === 'CALL-4821').length === 1, 'repeat id updates the incident', JSON.stringify(r2));
  ok(inc.est === 9 && inc.place === 'E311 highway, km 42' && inc.trapped === true, 'update refreshes est, keeps omitted fields');
  step(90);
  ok(callAmbs('CALL-4821').length === 4 && callAmbs('CALL-4821').reduce((n, a) => n + a.pts.length, 0) === 9, 'extra ambulance carries the 3 new casualties');
  const r3 = receiveIncident(CALL('CALL-4821', { casualties: 9, units: { ambulances: 4 } }));
  step(90);
  ok(r3.ok && r3.dispatched === 0 && callAmbs('CALL-4821').length === 4, 'identical repeat dispatches nothing more');

  // kind → mix, zero ambulances, a large call switches the mode at once
  receiveIncident(CALL('CALL-100', { kind: 'fire', casualties: 3, units: { ambulances: 1 } }));
  receiveIncident(CALL('CALL-101', { kind: 'chemical', casualties: 2, units: { ambulances: 0 } }));
  step(70);
  ok(callPts('CALL-100').length === 3 && callPts('CALL-100').every(p => MIX.fire.some(e => e[0] === p.cond)), 'fire casualties drawn from the fire mix');
  ok(callAmbs('CALL-101').length === 0 && S.incidents.find(i => i.id === 'CALL-101').name === 'Chemical exposure', 'zero ambulances: incident only');
  receiveIncident(CALL('CALL-102', { casualties: 14, units: { ambulances: 5 } }));
  ok(S.mode === 'mci' && /CALL-102/.test(S.modeReason), 'incident of 10+ casualties switches to MCI at once', S.mode + ' · ' + S.modeReason);

  // malformed: rejected, nothing changes
  const good = CALL('CALL-200');
  const bad = [null, undefined, 'incident', 7, [], {},
    Object.assign(clone(good), { type: 'prealert' }), Object.assign(clone(good), { v: 2 }),
    Object.assign(clone(good), { id: undefined }), Object.assign(clone(good), { id: 'INC-1' }), Object.assign(clone(good), { id: 'CALL-' }),
    Object.assign(clone(good), { id: 'CALL-12<script>' }), Object.assign(clone(good), { id: 4821 }),
    Object.assign(clone(good), { kind: 'flood' }), Object.assign(clone(good), { kind: undefined }),
    Object.assign(clone(good), { casualties: -1 }), Object.assign(clone(good), { casualties: '6' }), Object.assign(clone(good), { casualties: 1.5 }),
    Object.assign(clone(good), { casualties: 1e6 }), Object.assign(clone(good), { casualties: NaN }),
    Object.assign(clone(good), { units: undefined }), Object.assign(clone(good), { units: { ambulances: -1 } }),
    Object.assign(clone(good), { units: { ambulances: 'three' } }), Object.assign(clone(good), { units: { ambulances: 99 } }),
  ];
  const nI = S.incidents.length, nS = S.sched.length, nAud = S.audit.length;
  let rejected = 0;
  for (const m of bad) {
    let res;
    try { res = receiveIncident(m); } catch (e) { res = { threw: String(e) }; }
    if (res && res.ok === false && typeof res.error === 'string' && res.error) rejected++;
    else ok(false, 'malformed incident rejected', JSON.stringify(m) + ' → ' + JSON.stringify(res));
  }
  ok(rejected === bad.length, `malformed incidents rejected (${rejected}/${bad.length})`);
  ok(S.incidents.length === nI && S.sched.length === nS && S.audit.length === nAud, 'malformed incidents change nothing');

  // no caller identity is ever stored; invalid optional fields ignored and audited
  const CALLER = 'Qwxyz Caller', PHONE = '+971501234567';
  const ev = receiveIncident(CALL('CALL-300', { caller: CALLER, phone: PHONE, name: CALLER, severity: 'apocalyptic',
    hazards: ['fuel', 'zombies'], place: 'Al Wahda St\u0000 exit 3', trapped: 'yes', units: { ambulances: 1, fire: -2 } }));
  const ie = S.incidents.find(i => i.id === 'CALL-300');
  ok(ev.ok && ie.severity === null && ie.trapped === false && JSON.stringify(ie.hazards) === '["fuel"]' && ie.units.fire === 0
    && ie.place === 'Al Wahda St exit 3', 'invalid optional incident fields ignored', JSON.stringify(ie));
  ok(/ignored invalid severity, trapped, hazards, units\.fire/.test(S.audit[0].text), 'ignored incident fields audited', S.audit[0].text);
  const dumpI = JSON.stringify(S);
  ok(!dumpI.includes('Qwxyz') && !dumpI.includes(PHONE), 'no caller name or phone anywhere in state');
}

// --- capacitySnapshot: the §3 message, capacity only ---
fresh(202);
{
  const CAP_KEYS = ['type', 'v', 'hospital', 'mode', 'edBedsFree', 'resusFree', 'traumaFree', 'icuFree', 'oNeg', 'ctOnline', 'diversion', 'ts'];
  const c = capacitySnapshot(1729780000000);
  ok(JSON.stringify(Object.keys(c)) === JSON.stringify(CAP_KEYS), 'capacity carries exactly the contract keys', Object.keys(c).join(','));
  const freeIn = z => S.beds.filter(b => b.status === 'free' && !b.hold && (!z || b.zone === z)).length;
  ok(c.type === 'capacity' && c.v === 1 && c.hospital === 'Demo General Hospital' && c.mode === S.mode && c.ts === 1729780000000, 'capacity envelope');
  ok(c.edBedsFree === freeIn() && c.resusFree === freeIn('R') && c.traumaFree === freeIn('T') && c.icuFree === S.icu.cap - S.icu.used
    && c.oNeg === S.sup.blood.qty && c.ctOnline === 2 && c.diversion === false, 'capacity values match the board', JSON.stringify(c));
  ok(JSON.stringify(capacitySnapshot(5)) === JSON.stringify(capacitySnapshot(5)), 'capacitySnapshot is pure for a given ts');
  const txt = JSON.stringify(c);
  ok(!S.patients.some(p => txt.includes(p.id) || txt.includes(p.enc) || txt.includes(p.last)), 'capacity carries no patient data');
  runScenario('equipment');
  ok(capacitySnapshot(0).ctOnline === 1, 'capacity follows CT outage');
  waselDeclareMci(true);
  ok(capacitySnapshot(0).mode === 'mci', 'capacity follows the mode');
}

// --- pre-alert triage sliders + destination (CHANNELS.md §2) ---
fresh(203);
{
  const TRIAGE = { avpu: 'V', breathing: 'laboured', bleeding: 'heavy-controlled', perfusion: 'weak-fast', pain: 7, regions: ['chest', 'pelvis'], burnsPct: 0, ageBand: 'adult' };
  const HERE = { hospital: 'Demo General Hospital', reason: 'Trauma bay free · O-neg 18 · 12 min', etaMin: 12 };
  const m = Object.assign(SAMPLE('T-970'), { priority: { system: 'START', level: 'yellow' }, triage: clone(TRIAGE), destination: clone(HERE) });
  m.triage.evil = '<img src=x>'; m.destination.name = 'Zqxwv Bnmlk';
  const r = receivePreAlert(m), p = byEnc('T-970')[0];
  ok(r.ok && !r.routed && p && p.stage === 'inbound', 'pre-alert with triage + destination accepted', JSON.stringify(r));
  ok(JSON.stringify(p.triage) === JSON.stringify(TRIAGE), 'triage stored, whitelisted keys only', JSON.stringify(p.triage));
  ok(JSON.stringify(p.destination) === JSON.stringify(HERE), 'destination stored, whitelisted keys only', JSON.stringify(p.destination));
  ok(p.fieldPriority.system === 'START' && p.fieldPriority.level === 'yellow', 'responder priority kept', JSON.stringify(p.fieldPriority));
  const why = waselTriageWhy(p.triage);
  ok(why[0] === 'responds to voice only' && why.includes('bleeding heavy, controlled') && why.includes('chest, pelvis') && !why.some(w => /adult|burns/.test(w)),
    'triage reasons, most urgent first', JSON.stringify(why));
  ok(waselTriageWhy(null).length === 0 && waselTriageWhy({ avpu: 'A', breathing: 'normal' }).length === 0, 'normal sliders give no reasons');
  const bt = Object.assign(SAMPLE('T-971'), { triage: { avpu: 'X', breathing: 'Laboured!', pain: 11, regions: 'chest', burnsPct: -3, bleeding: 'minor' }, destination: { reason: 'no hospital' } });
  const rb = receivePreAlert(bt), pb = byEnc('T-971')[0];
  ok(rb.ok && JSON.stringify(pb.triage) === '{"bleeding":"minor"}' && pb.destination === null && !rb.routed, 'invalid sliders dropped, no hospital = here', JSON.stringify(pb.triage));
  ok(/ignored invalid .*triage\.avpu.*destination/.test(S.audit[0].text), 'invalid sliders audited', S.audit[0].text);

  // update: sliders refreshed; a more urgent field priority is a one-tap re-triage card, never a silent change
  const u = Object.assign(clone(m), { priority: { system: 'START', level: 'red' }, triage: Object.assign(clone(TRIAGE), { avpu: 'U', breathing: 'absent' }) });
  const ru = receivePreAlert(u);
  ok(ru.ok && ru.updated && p.esi === 3 && p.triage.avpu === 'U' && p.fieldPriority.level === 'red', 'update refreshes sliders, keeps ED triage', `esi ${p.esi}`);
  const card = S.sugg.find(s => s.key === 'retriage:' + p.id);
  ok(card && card.type === 'retriage' && card.to === 1 && card.level === 1 && /T-970 from ESI 3 to ESI 1/.test(card.title) && /RED: unresponsive/.test(card.why), 'raised field priority → re-triage card', card && card.title + ' | ' + card.why);
  ok(accept(card, 'manual') === true && p.esi === 1, 'one tap applies the re-triage');

  // routed elsewhere: shown, but no patient, ambulance or bed here
  const nP = S.patients.length, nA = S.ambulances.length, freeB = S.beds.filter(b => b.status === 'free').length;
  const away = Object.assign(SAMPLE('T-980'), { triage: clone(TRIAGE), destination: { hospital: 'Al Noor Trauma Centre (demo)', reason: 'Neurosurgery on call', etaMin: 15 } });
  const ra = receivePreAlert(away);
  ok(ra.ok && ra.routed === true && S.patients.length === nP && S.ambulances.length === nA && S.beds.filter(b => b.status === 'free').length === freeB, 'routed elsewhere: no patient, ambulance or bed', JSON.stringify(ra));
  const row = waselRoutedAway().find(x => x.encounter === 'T-980');
  ok(row && row.destination.hospital === 'Al Noor Trauma Centre (demo)' && row.eta === S.t + 12 * 60 && !('identity' in row) && !('safety' in row) && !('atmist' in row), 'routed row keeps the minimum', JSON.stringify(row));
  ok(S.audit[0].text === 'Pre-alert received: T-980 · routed elsewhere', 'routed pre-alert audited', S.audit[0].text);
  receivePreAlert(Object.assign(clone(away), { etaMin: 4 }));
  ok(waselRoutedAway().filter(x => x.encounter === 'T-980').length === 1 && waselRoutedAway().find(x => x.encounter === 'T-980').eta === S.t + 4 * 60, 'repeat routed pre-alert updates, no duplicate');
  ok(receivePreAlert(Object.assign(clone(away), { destination: clone(HERE) })).ok && byEnc('T-980').length === 1 && !waselRoutedAway().some(x => x.encounter === 'T-980'), 'routed → here becomes a normal pre-alert');

  // an inbound pre-alert rerouted elsewhere releases the bed reserved here
  receivePreAlert(Object.assign(SAMPLE('T-990'), { priority: { system: 'ESI', level: 1 }, etaMin: 6 }));
  const q = byEnc('T-990')[0];
  aiPlan();
  const prep = S.sugg.find(s => s.type === 'prearrival' && s.pid === q.id);
  ok(prep && accept(prep, 'manual') && q.reservedBed && bed(q.reservedBed).status === 'reserved', 'pre-arrival bed reserved', prep && prep.title);
  const rbId = q.reservedBed;
  const rr = receivePreAlert(Object.assign(SAMPLE('T-990'), { priority: { system: 'ESI', level: 1 }, destination: { hospital: 'Al Noor Trauma Centre (demo)', reason: 'Closer', etaMin: 5 } }));
  ok(rr.ok && rr.routed && rr.updated && bed(rbId).status === 'free' && bed(rbId).pid === null && q.stage === 'done', 'reroute releases the reserved bed', `${bed(rbId).status} ${q.stage}`);
  ok(amb(q.amb).status === 'diverted' && amb(q.amb).routedTo === 'Al Noor Trauma Centre (demo)' && waselRoutedAway().some(x => x.encounter === 'T-990'), 'rerouted ambulance leaves the inbound flow');
  step(20 * 60);
  ok(!waselRoutedAway().length && !byEnc('T-990').length && !S.sugg.some(s => s.pid === q.id), 'routed notes expire after their ETA; nothing left behind');
}

/* ---------- Summary ---------- */
console.log('');
console.log(`checks passed ${R.pass} · failed ${R.fail}`);
for (const f of R.failures) console.log('  ✗ ' + f);
if (R.fail) throw new Error(R.fail + ' check(s) failed');
console.log('ALL GREEN');
