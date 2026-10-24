/* =========================================================================
 * WASEL ER Command Dashboard · test/v4-readiness-test.js
 * Headless test of 16-readiness.js (readiness score, trauma activation rules,
 * burns transfers, NFC wristband) on top of engine + WASEL + AI. No DOM.
 *
 *   cat src/00-core.js src/10-engine.js src/15-wasel.js src/16-readiness.js src/20-ai.js test/v4-readiness-test.js > /private/tmp/claude-v4test.js
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc /private/tmp/claude-v4test.js
 *
 * Part A: pile-up, fire and combined × 3 seeds × 2 simulated hours, step(10); a charge
 *         nurse accepts ~70% of open cards every sim minute. Readiness, trauma-card and
 *         transfer invariants are asserted after every step.
 * Part B: unit tests: each trauma rule, senior confirmation, readiness items, the transfer
 *         flow (waiting and in a bed), the NFC wristband, labels and roles.
 * Exits by throwing if any check fails.
 * ========================================================================= */
var console = { log: print };

const STEP = 10, STEPS = 2 * 3600 / STEP, P_ACCEPT = 0.7;
const SEEDS = [11, 22, 33];
const SCENARIOS = [
  { name: 'pileup', ids: ['pileup'] },
  { name: 'fire', ids: ['fire'] },
  { name: 'combined', ids: ['pileup', 'fire', 'staff', 'equipment'] },
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

/* ---------- Contract ---------- */
const ITEM_KEYS = ['bed', 'team', 'airway', 'blood', 'ct'];
const ITEM_LABELS = ['Bed reserved', 'Team paged', 'Airway kit at bay', 'Blood on standby', 'CT available'];
const RULE_RE = /^(?:SBP \d+ < 90|GCS \d+ ≤ 13|AVPU [VPU], .+ \(GCS ≤ 13\)|RR \d+ (?:< 10|> 29)|burns ~?\d+% body surface ≥ 20%|penetrating mechanism \(".+"\)|amputation \(".+"\))$/;
const ACS = 'based on the ACS field triage guideline';
const TITLE_TRAUMA = /^Activate trauma team for T-\d+$/;
const TITLE_TRANSFER = /^Transfer T-\d+ to Burns Unit \(demo\) — accepted bed, ETA 25 min$/;
const TRANSFER_STATUS = ['requested', 'accepted', 'in-transport', 'completed'];
const TRAUMA_EMIT = 'Trauma team activated: trauma surgeon, anaesthetist, 2 nurses, CT + OR alerted · ';
const inEd = p => p.stage === 'waiting' || p.stage === 'treatment' || p.stage === 'boarding';
const feedHas = (re, src, std) => S.feed.some(x => re.test(x.text) && (!src || x.src === src) && (!std || x.std === std));

/* ---------- Readiness: shape and every item against the state it is derived from ---------- */
function checkReadiness(run, p) {
  const f = (k, d) => runFail(run, k, d), r = readiness(p);
  if (!r || r.of !== 5 || !Array.isArray(r.items) || r.items.length !== 5) return f('readiness shape', `${p.enc} ${JSON.stringify(r)}`);
  r.items.forEach((it, i) => {
    if (it.k !== ITEM_KEYS[i] || it.label !== ITEM_LABELS[i] || typeof it.ok !== 'boolean' || typeof it.detail !== 'string' || !it.detail) {
      f('readiness item shape', `${p.enc} ${JSON.stringify(it)}`);
    }
  });
  if (r.score !== r.items.filter(i => i.ok).length) f('readiness score != items ok', `${p.enc} ${r.score}`);
  const by = {};
  for (const it of r.items) by[it.k] = it.ok;
  const rb = p.reservedBed ? bed(p.reservedBed) : null, a = p.amb ? amb(p.amb) : null;
  const needs = COND[p.cond].needs || {}, most = Array.isArray(needs.blood) ? needs.blood[1] : 0;
  const want = {
    bed: !!(rb && rb.status === 'reserved' && rb.pid === p.id),
    team: !!p.traumaActivated || !!(a && a.prepared && a.team),
    airway: !(p.esi <= 2 || needs.vent) || ventsFree() > 0,
    blood: !(most > 0) || S.sup.blood.qty >= Math.max(most, committed('blood')),
    ct: !(needs.ct || p.traumaActivated) || (ctOnline() > 0 && ctWait() <= READINESS_CFG.ctMaxWaitMin),
  };
  for (const k of ITEM_KEYS) if (by[k] !== want[k]) f('readiness ' + k + ' inconsistent with state', `${p.enc} got ${by[k]} want ${want[k]}`);
  run.scores[r.score] = (run.scores[r.score] || 0) + 1;
}

/* ---------- Invariants (after every step) ---------- */
function invariants(run) {
  const f = (k, d) => runFail(run, k, d);
  for (const s of S.sugg) {
    if (s.type !== 'trauma' && s.type !== 'transfer') continue;
    const p = P(s.pid), first = !run.seen.has(s.id);
    if (first) run.seen.set(s.id, s.type);
    if (p && (s.title + s.why).includes(p.first + ' ' + p.last)) f('patient name in card text', s.id);
    if (s.type === 'trauma') {
      if (!TITLE_TRAUMA.test(s.title) || (p && !s.title.endsWith(p.enc))) f('trauma title', s.title);
      if (!s.why.includes(ACS)) f('trauma why does not cite the ACS guideline', s.why);
      if (!Array.isArray(s.rules) || !s.rules.length || !s.rules.every(x => RULE_RE.test(x))) f('trauma rule text', JSON.stringify(s.rules));
      else if (!s.rules.every(x => s.why.includes(x))) f('trauma why omits a rule', s.why);
      if (!p || p.src !== 'EMS' || (p.stage !== 'inbound' && p.stage !== 'waiting') || p.traumaActivated) f('trauma card for the wrong patient', `${s.title} ${p && p.stage}`);
      if (first) {
        run.trauma++;
        for (const x of s.rules || []) run.ruleKinds[x.split(' ')[0]] = (run.ruleKinds[x.split(' ')[0]] || 0) + 1;
        if (s.owner !== 'Physician' || s.level !== 1 || s.escalatesAt !== s.at + ESC_MIN[1] * 60) f('trauma owner/level/clock', `${s.owner} L${s.level}`);
        const now = p ? traumaRules(p).map(r => r.text) : [];
        if (!now.length || now.join('|') !== (s.rules || []).join('|')) f('trauma card rules differ from traumaRules()', `${now.join('|')} vs ${(s.rules || []).join('|')}`);
      }
    } else {
      if (!TITLE_TRANSFER.test(s.title) || (p && !s.title.includes(p.enc + ' '))) f('transfer title', s.title);
      if (!p || burnsPct(p) < 20 || !p.transfer || p.transfer.status !== 'accepted' || p.transfer.approved || !inEd(p)) f('transfer card for the wrong patient', s.title);
      if (first) {
        run.transfer++;
        if (s.owner !== 'Charge nurse' || s.level !== 2) f('transfer owner/level', `${s.owner} L${s.level}`);
      }
    }
  }
  for (const p of S.patients) {
    if (p.stage === 'done') { f('done patient left on the board after a step', `${p.enc} dispo=${p.dispo}`); continue; }
    if (p.src === 'EMS' && p.stage === 'inbound') { checkReadiness(run, p); run.readiness++; }
    // NFC wristband: every EMS patient that arrived during the session, never a walk-in
    if (p.src === 'EMS' && p.stage !== 'inbound' && p.arrivedAt >= 0 && p.wristband !== true) f('arrived EMS patient without wristband tap', p.enc);
    if (p.src !== 'EMS' && p.wristband) f('walk-in with an EMS wristband', p.id);
    // every rule that fires has a card (nothing is dismissed in this test)
    if (p.src === 'EMS' && (p.stage === 'inbound' || p.stage === 'waiting') && !p.traumaActivated
      && traumaRules(p).length && !S.sugg.some(s => s.key === 'trauma:' + p.id)) f('trauma rule fired without a card', `${p.enc} ${traumaRules(p).map(r => r.text).join('; ')}`);
    // burns ≥ 20%: enquiry sent, accepted within 3 sim-min, card once in the ED, gone once approved and waiting
    const tr = p.transfer;
    if (burnsPct(p) >= 20 && !tr) f('burns ≥ 20% without a transfer enquiry', p.enc);
    if (!tr) continue;
    run.burns.add(p.id);
    if (!TRANSFER_STATUS.includes(tr.status) || tr.to !== 'Burns Unit (demo)') f('transfer status', JSON.stringify(tr));
    if (tr.status === 'requested' && S.t - tr.requestedAt > 3 * 60 + STEP) f('partner acceptance overdue', p.enc);
    if (tr.status === 'accepted' && !tr.approved && inEd(p) && !S.sugg.some(s => s.key === 'transfer:' + p.id)) f('accepted transfer without a card', p.enc);
    if (tr.approved && p.stage === 'waiting') f('approved transfer still in the waiting room', p.enc);
    if (tr.status === 'in-transport' || tr.status === 'completed') f('transferred patient still on the board', p.enc);
  }
  for (const b of S.beds) if (b.hold && !S.sugg.some(s => s.id === b.hold)) f('bed hold leak', b.id);
}

/* ---------- Operator: accepts ~70% of open cards each sim minute ---------- */
function operator(run) {
  for (const s of S.sugg.slice()) {
    if (!S.sugg.includes(s) || Math.random() >= P_ACCEPT) continue;
    const valid = stillValid(s), p = s.pid ? P(s.pid) : null, wasWaiting = !!p && p.stage === 'waiting';
    const r = accept(s, 'manual');
    if (s.type !== 'trauma' && s.type !== 'transfer') continue;
    if (valid && !r) runFail(run, `accept(${s.type}) refused while valid`, s.title);
    if (!r) continue;
    if (s.type === 'trauma') {
      run.activated++;
      if (!p.traumaActivated || p.traumaActivatedBy !== 'Charge nurse') runFail(run, 'trauma accept did not activate', p.enc);
      if (!feedHas(new RegExp('^' + TRAUMA_EMIT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + p.enc), 'roster')) runFail(run, 'trauma accept: no roster page', p.enc);
      if (!S.audit.some(x => x.text.startsWith(`Trauma activation ${p.enc} confirmed by senior (Charge nurse)`))) runFail(run, 'trauma accept not audited with the senior', p.enc);
    } else {
      run.approved.add(p.id);
      if (!p.transfer.approved || p.transfer.approvedBy !== 'Charge nurse') runFail(run, 'transfer accept not recorded', p.enc);
      if (wasWaiting && (P(p.id) || p.transfer.status !== 'in-transport')) runFail(run, 'waiting patient did not leave on transfer', p.enc);
    }
  }
}

/* ---------- One simulated run ---------- */
function simulate(sc, seed) {
  fresh(seed);
  const run = { sc: sc.name, seed, errors: {}, seen: new Map(), trauma: 0, transfer: 0, activated: 0, readiness: 0,
    scores: {}, ruleKinds: {}, burns: new Set(), approved: new Set(), departed: 0, objs: new Map() };
  for (const id of sc.ids) runScenario(id);
  for (let i = 1; i <= STEPS; i++) {
    step(STEP);
    for (const p of S.patients) if (p.transfer) run.objs.set(p.id, p);
    invariants(run);
    if (i % 6 === 0) { operator(run); }
  }
  for (const p of run.objs.values()) if (p.transfer.status === 'in-transport' || p.transfer.status === 'completed') run.departed++;
  return run;
}

/* =========================== Part A: scenarios =========================== */
console.log('WASEL v4 readiness test · ' + SCENARIOS.length + ' scenarios × ' + SEEDS.length + ' seeds × 2 sim-hours, step(10), accept ~70%/min');
const runs = [];
for (const sc of SCENARIOS) {
  for (const seed of SEEDS) {
    let run;
    try { run = simulate(sc, seed); }
    catch (e) { ok(false, `${sc.name}/${seed} threw`, e && e.stack || e); continue; }
    runs.push(run);
    const errs = Object.keys(run.errors);
    ok(errs.length === 0, `${sc.name}/seed ${seed} invariants`, errs.map(k => `${k} ×${run.errors[k].n} (first ${run.errors[k].first})`).join('; '));
    if (sc.name !== 'fire') ok(run.trauma > 0 && run.activated > 0, `${sc.name}/${seed} trauma cards appear and are activated`, `${run.trauma}/${run.activated}`);
    ok(run.readiness > 0, `${sc.name}/${seed} readiness scored for inbound patients`, run.readiness);
    console.log(`  ${(sc.name + '/' + seed).padEnd(12)} trauma cards ${String(run.trauma).padStart(2)} (activated ${run.activated})`
      + ` · rules ${Object.entries(run.ruleKinds).map(e => e[0] + ' ' + e[1]).join(', ') || '—'}`
      + ` · burns ≥20% ${run.burns.size}, transfer cards ${run.transfer}, approved ${run.approved.size}, departed ${run.departed}`
      + ` · readiness scores ${Object.keys(run.scores).sort().map(k => k + '/5×' + run.scores[k]).join(' ')}` + (errs.length ? '  ✗ ' + errs.join(', ') : '  ✓'));
    for (const k of errs) console.log('      ' + k + ' ×' + run.errors[k].n + ' first ' + run.errors[k].first);
  }
}
const sum = (k, f) => runs.filter(f || (() => true)).reduce((n, r) => n + (typeof r[k] === 'number' ? r[k] : r[k].size), 0);
ok(sum('trauma', r => r.sc === 'fire') > 0, 'fire: trauma cards appear (burns or physiology)');
ok(sum('burns', r => r.sc !== 'pileup') > 0 && sum('transfer', r => r.sc !== 'pileup') > 0, 'fire: burns ≥ 20% get transfer cards', `${sum('burns')} / ${sum('transfer')}`);
ok(sum('departed') > 0, 'transfers leave the ED', sum('departed'));
ok(runs.some(r => r.ruleKinds.SBP) && runs.some(r => r.ruleKinds.GCS || r.ruleKinds.AVPU) && runs.some(r => r.ruleKinds.RR) && runs.some(r => r.ruleKinds.burns),
  'SBP, GCS, RR and burns rules all fire across runs', JSON.stringify(runs.map(r => r.ruleKinds)));
ok(runs.some(r => Object.keys(r.scores).length >= 2), 'readiness scores vary with state');

/* ============================ Part B: unit tests ============================ */
const SIGNS = { hr: 110, sbp: 120, rr: 18, spo2: 96, gcs: 15 };
function SAMPLE(enc, o) {
  o = o || {};
  return {
    type: 'prealert', v: 1, encounter: enc,
    identity: { status: 'candidate', method: 'face', confidence: 0.94, display: 'F.K.' },
    atmist: { age: '45', time: '19:12', mechanism: o.mechanism || 'Driver, frontal collision at ~100 km/h',
      injuries: o.injuries || 'Chest wall tenderness', signs: Object.assign({}, SIGNS, o.signs), treatment: 'Oxygen 15 L/min' },
    priority: { system: 'ESI', level: o.esi || 2 }, etaMin: o.etaMin == null ? 12 : o.etaMin,
    safety: { allergies: [], anticoagulant: false, bloodType: 'O+', source: 'Riayati', asOf: '2026-03-14' },
    triage: o.triage,
  };
}
const byEnc = enc => S.patients.find(p => p.enc === enc) || null;
const card = (type, p) => S.sugg.find(s => s.key === type + ':' + p.id) || null;

fresh(404);
{
  // --- no rule fires: no card ---
  receivePreAlert(SAMPLE('T-801'));
  aiPlan();
  const p1 = byEnc('T-801');
  ok(p1 && traumaRules(p1).length === 0 && !card('trauma', p1), 'normal field signs: no trauma rule, no card', JSON.stringify(p1 && traumaRules(p1)));

  // --- every physiological and anatomical rule, with its values ---
  receivePreAlert(SAMPLE('T-802', { esi: 1, signs: { hr: 130, sbp: 84, rr: 31, spo2: 90, gcs: 12 },
    mechanism: 'Stabbed in the chest at a market', injuries: 'Traumatic amputation of the left hand, chest wound' }));
  aiPlan();
  const p2 = byEnc('T-802'), c2 = card('trauma', p2);
  const want2 = ['SBP 84 < 90', 'GCS 12 ≤ 13', 'RR 31 > 29', 'penetrating mechanism ("Stabbed in the chest at a market")',
    'amputation ("Traumatic amputation of the left hand, chest wound")'];
  ok(traumaRules(p2).map(r => r.text).join('|') === want2.join('|'), 'trauma rules: SBP, GCS, RR, penetrating, amputation', traumaRules(p2).map(r => r.text).join('|'));
  ok(c2 && c2.title === 'Activate trauma team for T-802' && c2.level === 1 && c2.owner === 'Physician', 'trauma card: title, level 1, owner Physician', c2 && `${c2.title} L${c2.level} ${c2.owner}`);
  ok(c2 && c2.why.includes(ACS) && want2.every(x => c2.why.includes(x)), 'trauma card why: guideline + every rule with its values', c2 && c2.why);
  ok(c2 && c2.escalatesAt === c2.at + ESC_MIN[1] * 60, 'trauma card escalation clock');

  // --- RR < 10 and AVPU from the responder's sliders when GCS is not reported as ≤ 13 ---
  receivePreAlert(SAMPLE('T-803', { signs: { hr: 58, sbp: 112, rr: 8, spo2: 95 }, triage: { avpu: 'P' } }));
  aiPlan();
  const p3 = byEnc('T-803');
  ok(traumaRules(p3).map(r => r.text).join('|') === 'AVPU P, responds to pain only (GCS ≤ 13)|RR 8 < 10', 'trauma rules: AVPU P and RR < 10', traumaRules(p3).map(r => r.text).join('|'));
  ok(!!card('trauma', p3), 'RR/AVPU rules raise a card');
  ok(!traumaRules({ v: { sbp: 90, rr: 10, avpu: 'A' }, atmist: { signs: { gcs: 14 } } }).length
    && !traumaRules({ v: { sbp: 120, rr: 29, avpu: 'A' }, atmist: { signs: { gcs: 15 } } }).length, 'thresholds are strict: SBP 90, RR 10/29, GCS 14 do not fire');
  ok(traumaRules(null).length === 0, 'traumaRules(null) is empty');

  // --- senior confirmation ---
  prefs.role = 'nurse';
  ok(!canAct('trauma') && accept(c2, 'manual') === false && S.sugg.includes(c2) && !p2.traumaActivated, 'nurse cannot activate the trauma team; card stays');
  prefs.role = 'charge';
  ok(accept(c2, 'auto') === false && S.sugg.includes(c2), 'never activated by policy (auto)');
  prefs.role = 'physician';
  const a0 = S.audit.length;
  ok(accept(c2, 'manual') === true && p2.traumaActivated === true && p2.traumaActivatedBy === 'Physician', 'physician activates with one tap');
  ok(feedHas(/^Trauma team activated: trauma surgeon, anaesthetist, 2 nurses, CT \+ OR alerted · T-802/, 'roster', 'Paging'), 'roster page: trauma surgeon, anaesthetist, 2 nurses, CT + OR');
  const newAudit = S.audit.slice(0, S.audit.length - a0);
  ok(newAudit.some(x => x.role === 'Physician' && x.text.startsWith('Trauma activation T-802 confirmed by senior (Physician) · SBP 84 < 90'))
    && newAudit.some(x => x.role === 'Physician' && x.text === 'Accepted: Activate trauma team for T-802'), 'activation audited with the senior and the rules', newAudit.map(x => x.role + ': ' + x.text).join(' | '));
  aiPlan();
  ok(!card('trauma', p2), 'no second trauma card once activated');
  prefs.role = 'charge';

  // --- readiness items follow the state ---
  receivePreAlert(SAMPLE('T-804', { esi: 1, etaMin: 10 }));
  aiPlan();
  const p4 = byEnc('T-804'), item = k => readiness(p4).items.find(i => i.k === k);
  let r4 = readiness(p4);
  ok(r4.of === 5 && r4.items.map(i => i.k).join() === ITEM_KEYS.join() && r4.score === r4.items.filter(i => i.ok).length, 'readiness shape and score', JSON.stringify(r4));
  ok(!item('bed').ok && !item('team').ok, 'before prep: bed and team not ready', JSON.stringify(r4.items));
  const prep = S.sugg.find(s => s.type === 'prearrival' && s.pid === p4.id);
  ok(prep && /held: awaiting one-tap confirmation/.test(item('bed').detail), 'held bed shown as awaiting confirmation', item('bed').detail);
  ok(prep && accept(prep, 'manual') && item('bed').ok && item('team').ok, 'pre-arrival accepted: bed reserved and team paged', JSON.stringify(readiness(p4).items));
  ok(item('airway').ok && /ventilator/.test(item('airway').detail), 'ESI 1: airway kit ready while a ventilator is free', item('airway').detail);
  const vf = S.eq.ventFaulty;
  S.eq.ventFaulty = S.eq.vents;
  ok(!item('airway').ok && /No ventilator free/.test(item('airway').detail), 'no ventilator free: airway not ready', item('airway').detail);
  S.eq.ventFaulty = vf;
  const q0 = S.sup.blood.qty;
  ok(item('blood').ok === (q0 >= Math.max(6, committed('blood'))), 'blood ready iff O-neg covers this patient and the pipeline');
  S.sup.blood.qty = 3;
  ok(!item('blood').ok && /O-neg 3 units/.test(item('blood').detail), 'O-neg 3 units: blood not ready', item('blood').detail);
  S.sup.blood.qty = 40;
  ok(item('blood').ok, 'O-neg 40 units: blood ready');
  S.sup.blood.qty = q0;
  ok(item('ct').ok, 'CT available with 2 scanners online', item('ct').detail);
  for (const u of S.eq.ct) u.online = false;
  ok(!item('ct').ok && item('ct').detail === 'All CT scanners offline', 'all CT offline: CT not available');
  for (const u of S.eq.ct) u.online = true;
  const wrist = makePatient('wrist', 'EMS');
  wrist.esi = 4;
  ok(['airway', 'blood', 'ct'].every(k => readiness(wrist).items.find(i => i.k === k).ok), 'ESI 4 wrist fracture: airway, blood, CT not required count as ready');
  ok(readiness(null) === null, 'readiness(null) is null');
  r4 = readiness(p4);
  ok(r4.score === r4.items.filter(i => i.ok).length, 'score always equals the ready items');

  // --- transfer: responder-measured burns, patient still waiting when confirmed ---
  receivePreAlert(SAMPLE('T-806', { esi: 1, etaMin: 5, triage: { burnsPct: 35 } }));
  aiPlan();
  const p6 = byEnc('T-806');
  ok(p6.transfer && p6.transfer.status === 'requested' && p6.transfer.to === 'Burns Unit (demo)', 'burns 35%: transfer enquiry sent while inbound', JSON.stringify(p6.transfer));
  ok(feedHas(/^ServiceRequest: transfer enquiry T-806 → Burns Unit \(demo\) · burns 35% body surface \(≥ 20%\), ESI 1 · de-identified$/, 'ehr'), 'enquiry emitted (de-identified)');
  ok(traumaRules(p6).some(r => r.text === 'burns 35% body surface ≥ 20%'), 'measured burns rule text');
  ok(!card('transfer', p6), 'no transfer card while still in the ambulance');
  step(3 * 60);
  ok(p6.transfer.status === 'accepted' && feedHas(/^Burns Unit \(demo\) accepted T-806 · bed held · transfer ETA 25 min$/, 'ehr'), 'partner accepts after 3 sim-min', p6.transfer.status);
  ok(p6.stage === 'inbound' && !card('transfer', p6), 'accepted but inbound: card waits for the door');
  step(2 * 60 + 10);
  ok(p6.stage === 'waiting' && p6.wristband === true, 'arrived: waiting, wristband tapped', p6.stage);
  const c6 = card('transfer', p6);
  ok(c6 && c6.title === 'Transfer T-806 to Burns Unit (demo) — accepted bed, ETA 25 min' && c6.level === 2 && c6.owner === 'Charge nurse', 'transfer card: title, level 2, owner Charge nurse', c6 && `${c6.title} L${c6.level} ${c6.owner}`);
  ok(c6 && /needs a specialist burns centre/.test(c6.why) && /leaves as soon as you confirm/.test(c6.why), 'transfer why: reason + when it leaves', c6 && c6.why);
  ok(accept(c6, 'manual') === true, 'one tap confirms the transfer');
  ok(!P(p6.id) && p6.stage === 'done' && p6.dispo === 'transfer' && p6.transfer.status === 'in-transport' && p6.transfer.approvedBy === 'Charge nurse', 'waiting patient leaves immediately', JSON.stringify(p6.transfer));
  ok(feedHas(new RegExp('^ADT\\^A02 ' + p6.id + ' · Transferred to Burns Unit \\(demo\\)$'), 'adt') && feedHas(/^Critical-care ambulance departed with T-806 → Burns Unit \(demo\) · ETA 25 min$/, 'ems'), 'ADT A02 transfer + ambulance departure emitted');
  ok(familyBoard().some(r => r.enc === 'T-806' && r.status === 'Transferred'), 'family board: Transferred (no clinical detail)');
  aiPlan();
  ok(!S.sugg.some(s => s.pid === p6.id) && S.beds.every(b => !b.hold || S.sugg.some(s => s.id === b.hold)), 'no cards or bed holds left behind');
  const dep = p6.transfer.departedAt;
  step(25 * 60 + 10);
  ok(p6.transfer.status === 'completed' && p6.transfer.completedAt - dep >= 25 * 60 && p6.transfer.completedAt - dep <= 25 * 60 + STEP, 'transfer completed on arrival at the unit (ETA 25 min)', JSON.stringify(p6.transfer));

  // --- transfer: burnMajor (estimated ~35%) in a bed waits until stable ---
  MIX.v4burns = [['burnMajor', 1]];
  const inc = incident('Test fire', 'Test tower', 'test', 2, 'fire');
  const a7 = dispatchAmb(inc, 'v4burns', 1), p7 = P(a7.pts[0]);
  aiPlan();
  ok(burnsPct(p7) === 35 && p7.transfer && p7.transfer.status === 'requested' && /burns ~35% body surface/.test(p7.transfer.reason), 'burnMajor: ~35% estimate, enquiry sent', JSON.stringify(p7.transfer));
  ok(traumaRules(p7).some(r => r.text === 'burns ~35% body surface ≥ 20%'), 'estimated burns rule text');
  while (p7.stage === 'inbound') step(STEP);
  const b7 = S.beds.find(b => b.status === 'free' && !b.hold && b.zone === 'R') || S.beds.find(b => b.status === 'free' && !b.hold);
  ok(place(p7, b7, bestNurse(p7), 'test'), 'burns patient placed in a bed');
  Object.assign(p7.v, { hr: 132, sbp: 82, rr: 30, spo2: 89, avpu: 'A' });
  assess(p7);
  aiPlan();
  const c7 = card('transfer', p7);
  ok(c7 && /Leaves once stable/.test(c7.why), 'unstable in a bed: card says it leaves once stable', c7 && c7.why);
  ok(c7 && accept(c7, 'manual') && P(p7.id) && p7.stage === 'treatment' && p7.transfer.approved && p7.transfer.status === 'accepted', 'confirmed while unstable: stays in the bed', p7.stage);
  aiPlan();
  ok(P(p7.id) && p7.stage === 'treatment', 'still unstable: does not leave');
  Object.assign(p7.v, { hr: 92, sbp: 122, rr: 17, spo2: 97, temp: 37, avpu: 'A' });
  p7.onO2 = false;
  assess(p7);
  aiPlan();
  ok(!P(p7.id) && p7.transfer.status === 'in-transport' && bed(b7.id).status === 'cleaning', 'stable: leaves for the burns unit, bed to cleaning', `${p7.transfer.status} ${bed(b7.id).status}`);
  delete MIX.v4burns;

  // --- NFC wristband on arrival (EMS only) ---
  receivePreAlert(SAMPLE('T-808', { etaMin: 0 }));
  step(20);
  const p8 = byEnc('T-808');
  ok(p8 && p8.wristband === true && feedHas(/^Wristband T-808 tapped at ambulance bay · encounter token matched$/, 'adt', 'NFC'), 'EMS arrival: wristband tapped, ADT NFC emit');
  const w = makePatient('ankle', 'Walk-in');
  S.patients.push(w);
  arrive(w);
  ok(!w.wristband && !feedHas(new RegExp('^Wristband ' + w.enc + ' ')), 'walk-in: no wristband tap');

  // --- labels, roles and guarded hooks ---
  ok(SUGG_LABEL.trauma === 'Trauma activation' && SUGG_LABEL.transfer === 'Transfer', 'SUGG_LABEL entries');
  ok(['charge', 'physician'].every(k => ROLES[k].act.includes('trauma') && ROLES[k].act.includes('transfer'))
    && ['wall', 'nurse', 'admin'].every(k => !ROLES[k].act.includes('trauma') && !ROLES[k].act.includes('transfer')), 'only charge nurse and physician act on trauma/transfer');
  ok(readinessStillValid({ type: 'trauma', pid: 'P-0' }) === false && readinessStillValid({ type: 'other', pid: p8.id }) === false
    && readinessAccept({ type: 'other', pid: p8.id }, 'manual') === false, 'unknown patient or type is never valid');
}

/* ---------- Summary ---------- */
console.log('');
console.log(`checks passed ${R.pass} · failed ${R.fail}`);
for (const f of R.failures) console.log('  ✗ ' + f);
if (R.fail) throw new Error(R.fail + ' check(s) failed');
console.log('ALL GREEN');
