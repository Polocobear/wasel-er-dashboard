/* =========================================================================
 * ER Crisis Command Center · test/sim-test.js
 * Headless integration test of 10-engine.js + 20-ai.js (no DOM).
 *
 *   cat src/00-core.js src/10-engine.js src/20-ai.js test/sim-test.js > /private/tmp/er-sim-test.js
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc /private/tmp/er-sim-test.js
 *   (also runs under Node: node /private/tmp/er-sim-test.js)
 *
 * Every scenario runs 3 simulated hours in 10 s steps under several seeds. A
 * simulated charge nurse reviews the decision queue each sim minute, accepts
 * ~70% of cards and dismisses a few. State invariants are asserted after every
 * step and every decision round; realism checks run per scenario. Exits with an
 * uncaught error (non-zero status) if anything fails.
 * ========================================================================= */

/* ---------- Harness configuration ---------- */
const out = typeof print === 'function' ? print : (...a) => console.log(...a);
const STEP_SEC = 10;
const STEPS = 3 * 3600 / STEP_SEC;               // 1080 steps = 3 simulated hours
const REVIEW_EVERY = 60 / STEP_SEC;              // the operator looks once per sim minute
const P_ACCEPT = 0.70, P_DISMISS = 0.08;
const SEEDS = [1, 2, 3, 4, 5];
const LONG_WAIT_MIN = 240, BED_FREE_MIN = 30;

const SCENARIOS = [
  { name: 'none', ids: [] },
  { name: 'pileup', ids: ['pileup'] },
  { name: 'fire', ids: ['fire'] },
  { name: 'staff', ids: ['staff'] },
  { name: 'equipment', ids: ['equipment'] },
  { name: 'outage', ids: ['outage'] },
  { name: 'pileup+staff+equipment', ids: ['pileup', 'staff', 'equipment'] },
];
const SUGG_TYPES = ['placement', 'prearrival', 'retriage', 'supply', 'fatigue', 'callin',
  'reassign', 'capacity', 'ct', 'vent', 'needvent', 'outage'];

// Deterministic PRNG (mulberry32): any failure replays exactly from its seed
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bump = (o, k, n) => { o[k] = (o[k] || 0) + (n || 1); };
const simT = () => '+' + (S.t / 60).toFixed(1) + 'm';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const fmt1 = x => x == null ? '–' : (Math.round(x * 10) / 10).toFixed(1);

/* ---------- Run record ---------- */
function newRun(sc, seed) {
  return {
    sc, seed, errors: {}, warnings: {}, exception: null,
    stage: new Map(),                 // pid -> last observed stage
    arrivedIds: new Set(), arrivedEms: 0, arrivedWalk: 0,
    completed: 0, diverted: 0, placedIds: new Set(), d2b: [],
    maxWait: 0, maxWaitEsi: {}, triagedAt: new Map(), peakWaiting: 0, peakOcc: 0,
    flagged: new Set(), suggSeen: new Set(), created: {}, accepted: {}, dismissed: {},
    retriageByCond: {}, supplyItems: {}, freeSince: new Map(), longWaitWarned: new Set(),
  };
}
// Each distinct problem is reported once with its first occurrence and a count
function note(bucket, kind, detail) {
  const e = bucket[kind] || (bucket[kind] = { n: 0, first: `${simT()} ${detail}` });
  e.n++;
}
const fail = (run, kind, detail) => note(run.errors, kind, detail);
const warn = (run, kind, detail) => note(run.warnings, kind, detail);

// Instrumentation: a refused place() behind an accepted decision would audit "Accepted" for nothing
let currentRun = null;
const enginePlace = place;
place = function (p, b, n, how, silent) {
  const ok = enginePlace(p, b, n, how, silent);
  if (!ok && currentRun) fail(currentRun, 'place() refused', `${p && p.id} → ${b && b.id} via ${how} (bed ${b && b.status}/${b && b.pid})`);
  return ok;
};

/* ---------- Invariants ---------- */
function checkInvariants(run, afterStep) {
  const live = new Map();
  for (const p of S.patients) {
    if (live.has(p.id)) fail(run, 'duplicate patient id', p.id);
    live.set(p.id, p);
  }

  // Beds <-> patients, holds <-> suggestions
  for (const b of S.beds) {
    if (b.status === 'occupied' || b.status === 'reserved') {
      const p = live.get(b.pid);
      if (!p) fail(run, `${b.status} bed without live patient`, `${b.id} pid=${b.pid}`);
      else if (b.status === 'occupied' && p.bed !== b.id) fail(run, 'occupied bed not owned back', `${b.id} → ${p.id} (p.bed=${p.bed}, ${p.stage})`);
      else if (b.status === 'reserved' && p.reservedBed !== b.id) fail(run, 'reserved bed not owned back', `${b.id} → ${p.id} (p.reservedBed=${p.reservedBed}, ${p.stage})`);
    } else if (b.pid) fail(run, 'free/cleaning bed keeps a pid', `${b.id} ${b.status} pid=${b.pid}`);
    if (b.hold) {
      const s = S.sugg.find(x => x.id === b.hold);
      if (!s) fail(run, 'bed hold without live suggestion', `${b.id} hold=${b.hold}`);
      else if (s.bed !== b.id) fail(run, 'bed hold points at another bed', `${b.id} hold=${s.id} (${s.type} for ${s.bed})`);
      if (b.status !== 'free') fail(run, 'held bed is not free', `${b.id} ${b.status} hold=${b.hold}`);
    }
  }

  const bedOwner = new Map();
  for (const p of S.patients) {
    // A diversion accepted between ticks marks patients done; the next advance() purges them
    if (p.stage === 'done' && (afterStep || !p.diverted)) fail(run, 'done patient left in S.patients', `${p.id} diverted=${p.diverted}`);
    if (p.stage === 'treatment' || p.stage === 'boarding') {
      const b = bed(p.bed);
      if (!b || b.status !== 'occupied' || b.pid !== p.id) fail(run, `${p.stage} patient without occupied bed`, `${p.id} bed=${p.bed} ${b ? b.status + '/' + b.pid : 'missing'}`);
    } else if (p.bed) fail(run, 'untreated patient holds a bed', `${p.id} ${p.stage} bed=${p.bed}`);
    if (p.bed) {
      if (bedOwner.has(p.bed)) fail(run, 'two live patients share a bed', `${p.bed}: ${bedOwner.get(p.bed)} + ${p.id}`);
      bedOwner.set(p.bed, p.id);
    }
    if (p.reservedBed) {
      const b = bed(p.reservedBed);
      if (p.stage !== 'inbound') fail(run, 'non-inbound patient keeps a reservation', `${p.id} ${p.stage} → ${p.reservedBed}`);
      if (!b || b.status !== 'reserved' || b.pid !== p.id) fail(run, 'reservation not mirrored on bed', `${p.id} → ${p.reservedBed} ${b ? b.status + '/' + b.pid : 'missing'}`);
    }
    if (p.stage === 'waiting' && p.arrivedAt == null) fail(run, 'waiting patient without arrival time', p.id);
    if (p.nurse && !nurse(p.nurse)) fail(run, 'patient refers to unknown nurse', `${p.id} → ${p.nurse}`);
    for (const k of ['hr', 'sbp', 'rr', 'spo2', 'temp']) if (!finite(p.v[k])) fail(run, 'NaN vital', `${p.id}.${k}=${p.v[k]}`);
    if (!finite(p.news) || !finite(p.trend)) fail(run, 'NaN NEWS2/trend', `${p.id} news=${p.news} trend=${p.trend}`);
    if (p.hist.length > 90) fail(run, 'history over 90 samples', `${p.id} ${p.hist.length}`);
    for (let i = 0; i < p.hist.length; i++) {
      const h = p.hist[i];
      if (i && h.t < p.hist[i - 1].t) { fail(run, 'history not ascending', p.id); break; }
      if (![h.t, h.hr, h.sbp, h.rr, h.spo2, h.news].every(finite)) { fail(run, 'NaN in history', p.id); break; }
    }
    if (p.flag && (!p.flag.text || !p.flag.hint || /undefined|NaN/.test(p.flag.text + p.flag.hint))) fail(run, 'malformed flag', `${p.id} ${JSON.stringify(p.flag)}`);
  }

  // Suggestions: unique ids/keys, bed-holding types hold their bed, nothing stale survives aiPlan
  const ids = new Set(), keys = new Set();
  for (const s of S.sugg) {
    if (ids.has(s.id)) fail(run, 'duplicate suggestion id', s.id);
    if (keys.has(s.key)) fail(run, 'duplicate suggestion key', s.key);
    ids.add(s.id); keys.add(s.key);
    if (!SUGG_TYPES.includes(s.type) || ![1, 2, 3].includes(s.level)) fail(run, 'bad suggestion type/level', `${s.id} ${s.type} L${s.level}`);
    if (/undefined|NaN|null/.test(s.title + ' ' + s.why)) fail(run, 'suggestion text has undefined/NaN/null', `${s.type}: ${s.title} | ${s.why}`);
    if (s.type === 'placement' || s.type === 'prearrival') {
      const b = bed(s.bed);
      if (!b || b.hold !== s.id) fail(run, `${s.type} suggestion does not hold its bed`, `${s.id} → ${s.bed} hold=${b ? b.hold : 'missing'}`);
    }
    if (afterStep && !stillValid(s)) fail(run, 'invalid suggestion survived aiPlan', `${s.id} ${s.type} ${s.title}`);
  }

  // After a plan, every waiting patient either has a pending placement, is suppressed, or has no bed
  if (afterStep) {
    for (const p of S.patients) {
      if (p.stage !== 'waiting' || blocked('placement:' + p.id)) continue;
      const b = findBed(p);
      if (b) fail(run, 'free bed but no placement suggested', `${p.id} ESI ${p.esi} could take ${b.id}`);
    }
  }

  // Resources and bounded collections
  for (const k in S.sup) {
    const sp = S.sup[k];
    if (!finite(sp.qty) || sp.qty < 0 || sp.qty > sp.cap) fail(run, 'supply qty out of range', `${k}=${sp.qty}`);
  }
  if (!(ventsFree() >= 0)) fail(run, 'ventsFree negative', ventsFree());
  if (monitorsInUse() > S.eq.monitors) fail(run, 'more monitors in use than exist', monitorsInUse());
  if (S.icu.used < 0 || S.icu.used > S.icu.cap) fail(run, 'ICU census out of range', S.icu.used);
  if (S.or.used < 0 || S.or.used > S.or.cap) fail(run, 'OR census out of range', S.or.used);
  if (!S.fc || S.fc.pts.length !== 31 || !S.fc.pts.every(x => finite(x.occ) && x.occ >= 0)) fail(run, 'NaN or malformed S.fc', JSON.stringify(S.fc).slice(0, 120));
  if (S.fc && S.fc.fullIn !== null && !(Number.isInteger(S.fc.fullIn) && S.fc.fullIn >= 0 && S.fc.fullIn <= 30)) fail(run, 'bad fc.fullIn', S.fc.fullIn);
  if (S.feed.length > 80) fail(run, 'feed over 80 rows', S.feed.length);
  if (S.audit.length > 150) fail(run, 'audit over 150 rows', S.audit.length);
  if (S.occ.length > 60 || !S.occ.every(o => finite(o.occ) && finite(o.t))) fail(run, 'occupancy series malformed', S.occ.length);
  if (S.announce && S.announce.length > 5) fail(run, 'announce queue unbounded', S.announce.length);
  for (const e of S.feed) if (/undefined|NaN/.test(e.text)) { fail(run, 'feed text has undefined/NaN', e.text); break; }
  for (const a of S.ambulances) {
    if (a.status === 'onscene' || a.status === 'enroute') {
      for (const id of a.pts) { const p = live.get(id); if (p && p.stage !== 'inbound') fail(run, 'en-route patient not inbound', `${a.id} ${id} ${p.stage}`); }
    }
  }
  const nids = new Set();
  for (const n of S.nurses) { if (nids.has(n.id)) fail(run, 'duplicate nurse id', n.id); nids.add(n.id); }
}

/* ---------- Observation: metrics + the long-wait warning ---------- */
function observe(run) {
  const now = new Set();
  let waiting = 0;
  for (const p of S.patients) {
    now.add(p.id);
    if (p.arrivedAt != null && p.arrivedAt > 0 && !run.arrivedIds.has(p.id)) {
      run.arrivedIds.add(p.id);
      if (p.src === 'EMS') run.arrivedEms++; else run.arrivedWalk++;
    }
    if (p.stage === 'treatment' && !run.placedIds.has(p.id)) {
      run.placedIds.add(p.id);
      if (p.bedAt > 0) run.d2b.push((p.bedAt - p.arrivedAt) / 60);
    }
    if (p.flag && p.flag.det) run.flagged.add(p.id);
    if (p.stage === 'waiting') {
      waiting++;
      const w = (S.t - p.arrivedAt) / 60;
      run.maxWait = Math.max(run.maxWait, w);
      // Per-ESI waits count from the moment the patient was (re)triaged to that level
      const tri = run.triagedAt.get(p.id);
      if (!tri || tri.esi !== p.esi) run.triagedAt.set(p.id, { esi: p.esi, at: tri ? S.t : p.arrivedAt });
      const wEsi = (S.t - run.triagedAt.get(p.id).at) / 60;
      run.maxWaitEsi[p.esi] = Math.max(run.maxWaitEsi[p.esi] || 0, wEsi);
      const suitableFree = S.beds.some(b => b.status === 'free' && ZONE_PREF[p.esi].includes(b.zone));
      if (!suitableFree) run.freeSince.delete(p.id);
      else if (!run.freeSince.has(p.id)) run.freeSince.set(p.id, S.t);
      const freeMin = run.freeSince.has(p.id) ? (S.t - run.freeSince.get(p.id)) / 60 : 0;
      if (w > LONG_WAIT_MIN && freeMin > BED_FREE_MIN && !run.longWaitWarned.has(p.id)) {
        run.longWaitWarned.add(p.id);
        warn(run, `waited > ${LONG_WAIT_MIN} min with a suitable bed free > ${BED_FREE_MIN} min`, `${p.id} ESI ${p.esi} waited ${r0(w)} min`);
      }
    } else run.freeSince.delete(p.id);
    run.stage.set(p.id, p.diverted ? 'diverted' : p.stage);
  }
  for (const [id, st] of run.stage) {
    if (now.has(id)) continue;
    if (st === 'diverted') run.diverted++;
    else if (st === 'treatment' || st === 'boarding') run.completed++;
    else fail(run, 'patient vanished from the waiting room', `${id} (${st})`);
    run.stage.delete(id);
  }
  run.peakWaiting = Math.max(run.peakWaiting, waiting);
  run.peakOcc = Math.max(run.peakOcc, bedsBusy() / S.beds.length * 100);
  for (const s of S.sugg) {
    if (run.suggSeen.has(s.id)) continue;
    run.suggSeen.add(s.id);
    bump(run.created, s.type);
    if (s.type === 'retriage') { const p = P(s.pid); bump(run.retriageByCond, p ? p.cond : '?'); }
    if (s.type === 'supply') bump(run.supplyItems, s.item);
  }
}

/* ---------- The simulated charge nurse ---------- */
function review(run, rand) {
  for (const s of S.sugg.slice()) {
    if (!S.sugg.includes(s)) continue;        // an earlier decision this round already retired it
    const r = rand();
    if (r < P_ACCEPT) { if (accept(s, 'manual')) bump(run.accepted, s.type); }
    else if (r < P_ACCEPT + P_DISMISS) { dismiss(s); bump(run.dismissed, s.type); }
  }
}

/* ---------- One scenario under one seed ---------- */
function runCase(sc, seed) {
  Math.random = mulberry32(seed * 2654435761 >>> 0);
  const rand = mulberry32(seed * 40503 + 7);
  prefs.role = 'charge';
  prefs.autoAccept = false;
  const run = newRun(sc, seed);
  currentRun = run;
  try {
    S = null;
    init();
    for (const id of sc.ids) if (!runScenario(id)) fail(run, 'runScenario rejected id', id);
    observe(run);
    checkInvariants(run, false);
    for (let i = 1; i <= STEPS; i++) {
      step(STEP_SEC);
      observe(run);
      checkInvariants(run, true);
      if (i % REVIEW_EVERY === 0) {
        review(run, rand);
        observe(run);
        checkInvariants(run, false);
      }
    }
  } catch (e) {
    run.exception = `${simT()} ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`;
  }
  run.final = {
    waiting: S.patients.filter(p => p.stage === 'waiting').length,
    treatment: S.patients.filter(p => p.stage === 'treatment').length,
    boarding: S.patients.filter(p => p.stage === 'boarding').length,
    nurses: S.nurses.filter(n => n.status === 'on').length,
  };
  return run;
}

/* ---------- Report ---------- */
const nErr = r => Object.values(r.errors).reduce((s, e) => s + e.n, 0) + (r.exception ? 1 : 0);
const nWarn = r => Object.values(r.warnings).reduce((s, e) => s + e.n, 0);
const byType = o => SUGG_TYPES.filter(k => o[k]).map(k => `${k} ${o[k]}`).join(' · ') || 'none';

function printRun(r, full) {
  const d2b = median(r.d2b);
  const head = `arrived ${r.arrivedIds.size} (EMS ${r.arrivedEms}, walk-in ${r.arrivedWalk}) · completed ${r.completed} · diverted ${r.diverted}`
    + ` · max wait ${r0(r.maxWait)} min · door-to-bed median ${fmt1(d2b)} min (n=${r.d2b.length})`;
  if (!full) {
    out(`  seed ${r.seed}: ${head} · det flags ${r.flagged.size} · ${nErr(r)} errors, ${nWarn(r)} warnings`);
    return;
  }
  out(`  seed ${r.seed}`);
  out(`    patients   ${head}`);
  out(`    load       peak waiting ${r.peakWaiting} · peak occupancy ${r0(r.peakOcc)}% · end: ${r.final.waiting} waiting, ${r.final.treatment} in treatment, ${r.final.boarding} boarding, ${r.final.nurses} nurses on`);
  out(`    max wait   by ESI: ${[1, 2, 3, 4, 5].map(e => `${e}: ${r.maxWaitEsi[e] == null ? '–' : r0(r.maxWaitEsi[e])}`).join(' · ')} min`);
  out(`    flags      deterioration flags raised for ${r.flagged.size} patients · retriage by condition: ${Object.entries(r.retriageByCond).map(([k, v]) => k + ' ' + v).join(', ') || 'none'}`);
  out(`    created    ${byType(r.created)}` + (r.created.supply ? ` (supply: ${Object.keys(r.supplyItems).join(', ')})` : ''));
  out(`    accepted   ${byType(r.accepted)}`);
  out(`    dismissed  ${byType(r.dismissed)}`);
}

function printProblems(r) {
  if (r.exception) out(`    EXCEPTION (seed ${r.seed}) ${r.exception}`);
  for (const [k, e] of Object.entries(r.errors)) out(`    ERROR (seed ${r.seed}) ${k} ×${e.n} · first ${e.first}`);
  for (const [k, e] of Object.entries(r.warnings)) out(`    warning (seed ${r.seed}) ${k} ×${e.n} · first ${e.first}`);
}

const t0 = Date.now();
const realism = [];
let totalErr = 0, totalWarn = 0;
out(`ER Command Center · headless sim test · ${SCENARIOS.length} scenarios × ${SEEDS.length} seeds · ${STEPS} steps of ${STEP_SEC} s (3 sim h)`);
for (const sc of SCENARIOS) {
  const runs = SEEDS.map(seed => runCase(sc, seed));
  out(`\n=== ${sc.name} ===`);
  printRun(runs[0], true);
  for (const r of runs.slice(1)) printRun(r, false);
  for (const r of runs) { printProblems(r); totalErr += nErr(r); totalWarn += nWarn(r); }

  // Realism: what a clinician would expect to see in each crisis. Scenario-driven cards must
  // always appear; casualty-mix-driven ones (who is hurt, how badly) in most seeds.
  const hits = f => runs.filter(f).length;
  const ALL = runs.length, MOST = Math.ceil(runs.length * 0.6);
  const expect = (label, k, need) => realism.push({ sc: sc.name, label, k, n: runs.length, ok: k >= need });
  if (sc.ids.includes('pileup')) {
    expect('an abdo (silent bleed) patient gets a retriage suggestion', hits(r => r.retriageByCond.abdo > 0), MOST);
    expect('O-negative blood request suggested', hits(r => r.supplyItems.blood > 0), MOST);
  }
  if (sc.ids.includes('fire')) expect('burn kit or O₂ request suggested', hits(r => r.supplyItems.burn > 0 || r.supplyItems.o2 > 0), MOST);
  if (sc.ids.includes('pileup') || sc.ids.includes('fire')) {
    expect('prearrival suggestions appear', hits(r => r.created.prearrival > 0), ALL);
    expect('ESI 1–2 never wait longer than ESI 4–5', hits(r => Math.max(r.maxWaitEsi[1] || 0, r.maxWaitEsi[2] || 0)
      <= Math.max(r.maxWaitEsi[4] || 0, r.maxWaitEsi[5] || 0)), ALL);
  }
  if (sc.ids.includes('staff')) expect('reassign suggestion appears', hits(r => r.created.reassign > 0), ALL);
  if (sc.ids.includes('equipment')) expect('ct + vent suggestions appear', hits(r => r.created.ct > 0 && r.created.vent > 0), ALL);
  if (sc.ids.includes('outage')) expect('outage suggestion appears', hits(r => r.created.outage > 0), ALL);
  if (!sc.ids.length) {
    expect('quiet day: no diversion suggested', hits(r => !r.created.capacity), ALL);
    expect('quiet day: door-to-bed median under 5 min', hits(r => median(r.d2b) < 5), ALL);
  }
}

out('\n=== realism ===');
for (const x of realism) out(`  ${x.ok ? 'ok  ' : 'FAIL'} ${x.sc}: ${x.label} (${x.k}/${x.n} seeds)`);
const realismFail = realism.filter(x => !x.ok).length;
out(`\nRESULT: ${totalErr || realismFail ? 'FAIL' : 'PASS'} · ${totalErr} invariant errors · ${totalWarn} warnings · ${realismFail} realism failures · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (totalErr || realismFail) throw new Error('sim-test failed');
