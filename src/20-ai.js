/* =========================================================================
 * ER Crisis Command Center · 20-ai.js
 * AI decision layer: it does the watching, counting and matching.
 *   assess()  NEWS2 plus a 12-minute vital-sign trend for every patient
 *   aiPlan()  turns the whole ED picture into ranked, explained suggestions
 *   accept() / dismiss()  the only way a suggestion changes anything
 * Humans decide. Nothing here acts without accept(); only bed placements may
 * be auto-accepted, and only under the charge nurse's auto-accept policy.
 *
 * Safety: findings are worded "consistent with", never as a diagnosis.
 * Privacy: suggestion and feed texts carry patient IDs only, never names.
 * Invariant: every bed.hold is the id of a live suggestion (dropSugg releases).
 * No DOM access: this module also runs headless.
 * ========================================================================= */

/* ---------- Patient assessment (NEWS2 + trend) ---------- */
const AI_TREND_SEC = 12 * 60;   // look-back span for trend and vital-sign deltas
const AI_MIN_SPAN = 4 * 60;     // shorter spans are noise, not a trend

function assessAll() { for (const p of S.patients) assess(p); }

function assess(p) {
  const v = p.v, h = p.hist || [];
  p.news = news2(v, p.onO2);
  // hist is ascending: walk back to the oldest sample still inside the look-back span
  let ref = null;
  for (let i = h.length - 1; i >= 0 && h[i].t >= S.t - AI_TREND_SEC; i--) ref = h[i];
  p.trend = ref ? p.news - ref.news : 0;

  let parts = null, hrUp = false, sbpDown = false, spo2Down = false, rrUp = false;
  if (ref && S.t - ref.t >= AI_MIN_SPAN) {
    const hr0 = r0(ref.hr), hr1 = r0(v.hr), sbp0 = r0(ref.sbp), sbp1 = r0(v.sbp);
    const sp0 = r0(ref.spo2), sp1 = r0(v.spo2), rr0 = r0(ref.rr), rr1 = r0(v.rr);
    hrUp = hr1 - hr0 >= 15; sbpDown = sbp0 - sbp1 >= 12; spo2Down = sp0 - sp1 >= 3; rrUp = rr1 - rr0 >= 6;
    if (hrUp || sbpDown || spo2Down || rrUp) {
      parts = [];
      if (hrUp) parts.push(`HR ${hr0}→${hr1}`);
      if (sbpDown) parts.push(`SBP ${sbp0}→${sbp1}`);
      if (spo2Down) parts.push(`SpO₂ ${sp0}→${sp1}%`);
      if (rrUp) parts.push(`RR ${rr0}→${rr1}`);
    }
  }

  const untreated = p.stage === 'waiting' || p.stage === 'inbound';
  if (untreated && parts && (p.trend >= 2 || p.news >= 5)) {
    p.flag = { level: 'critical', det: true,
      text: `Deteriorating: ${parts.join(', ')} in ${mins(S.t - ref.t)} min`,
      hint: aiPattern(hrUp, sbpDown, spo2Down, rrUp, v.temp) };
  } else if (untreated && p.news >= 7) {
    p.flag = { level: 'critical', det: true, text: `NEWS2 ${p.news}: urgent clinical review`, hint: aiDrivers(p) };
  } else if (untreated && p.news >= 5) {
    p.flag = { level: 'serious', det: false, text: `NEWS2 ${p.news}: review within 30 min`, hint: aiDrivers(p) };
  } else if (p.stage === 'boarding' && S.t - p.boardSince > 20 * 60) {
    p.flag = { level: 'serious', det: false,
      text: `Boarding ${mins(S.t - p.boardSince)} min: awaiting ${DISPO_LABEL[p.dispo]}`, hint: aiBoardHint(p) };
  } else {
    p.flag = null;
  }
}

// Pattern helper: the physiology a set of changes fits. Never a diagnosis.
function aiPattern(hrUp, sbpDown, spo2Down, rrUp, temp) {
  if (hrUp && sbpDown) return temp >= 38 ? 'Pattern consistent with septic shock' : 'Pattern consistent with internal bleeding / shock';
  if (spo2Down || rrUp) return 'Pattern consistent with respiratory deterioration';
  return 'Physiological trend worsening';
}

// Which NEWS2 parameters drive a high score, biggest first: "Score driven by RR 28/min, SpO₂ 88%"
function aiDrivers(p) {
  const pts = news2Parts(p.v, p.onO2), v = p.v;
  const items = [
    [pts.rr, `RR ${r0(v.rr)}/min`], [pts.spo2, `SpO₂ ${r0(v.spo2)}%`], [pts.sbp, `SBP ${r0(v.sbp)}`],
    [pts.hr, `HR ${r0(v.hr)}`], [pts.avpu, 'responds to voice only (AVPU V)'],
    [pts.temp, `temp ${v.temp.toFixed(1)} °C`], [pts.o2, 'on supplemental O₂'],
  ].filter(x => x[0] >= 2).sort((a, b) => b[0] - a[0]);
  return items.length ? 'Score driven by ' + items.map(x => x[1]).join(', ') : 'Several vital signs mildly abnormal';
}

function aiBoardHint(p) {
  const where = `Holding ED bed ${p.bed}`;
  if (p.dispo === 'icu') return `${where} · ICU ${S.icu.used}/${S.icu.cap} beds occupied`;
  if (p.dispo === 'or') return `${where} · operating rooms ${S.or.used}/${S.or.cap} in use`;
  const m = mins((p.boardUntil || S.t) - S.t);
  return `${where} · ward bed expected ${m ? 'in ~' + m + ' min' : 'now'}`;
}

// Queue order: acuity first, then physiology, trend, time waited, active alarm.
function priority(p) {
  const waitMin = p.stage === 'waiting' && p.arrivedAt != null ? (S.t - p.arrivedAt) / 60 : 0;
  return (6 - p.esi) * 20 + (p.news || 0) * 4 + Math.max(0, p.trend || 0) * 6
    + Math.min(waitMin, 60) * 0.4 + (p.flag && p.flag.level === 'critical' ? 25 : 0);
}

/* ---------- Matching: beds and nurses ---------- */
function findBed(p) {
  for (const z of ZONE_PREF[p.esi]) {
    for (const b of S.beds) if (b.zone === z && b.status === 'free' && !b.hold) return b;
  }
  return null;
}

// One pass: ESI-weighted load already assigned, and load promised by pending placements.
function aiLoads(exceptPid) {
  const target = {}, load = {}, held = {};
  for (const s of S.sugg) if (s.type === 'placement' && s.nurse && s.pid !== exceptPid) target[s.pid] = s.nurse;
  for (const p of S.patients) {
    const w = W_ESI[p.esi] || 0;
    if (p.nurse && (p.stage === 'treatment' || p.stage === 'boarding')) load[p.nurse] = (load[p.nurse] || 0) + w;
    const to = target[p.id];
    if (to) held[to] = (held[to] || 0) + w;
  }
  return { load, held };
}
function nurseLoad(n) { return aiLoads().load[n.id] || 0; }
function heldLoad(n, exceptPid) { return aiLoads(exceptPid).held[n.id] || 0; }

// Lowest score wins: workload after taking p, with penalties for overload and long hours.
function aiNurseChoice(p) {
  const { load, held } = aiLoads(p.id), w = W_ESI[p.esi] || 0;
  let best = null, bestScore = Infinity, bestBefore = 0, light = null, lightBefore = Infinity;
  for (const n of S.nurses) {
    if (n.status !== 'on' || n.handover) continue;
    const before = (load[n.id] || 0) + (held[n.id] || 0);
    let score = before + w;
    if (score > 1.15) score += 1;
    if (n.hours >= 10) score += 0.25;
    if (n.hours >= 12) score += 0.6;
    if (before < lightBefore) { light = n; lightBefore = before; }
    if (score < bestScore) { best = n; bestScore = score; bestBefore = before; }
  }
  // Only the hours penalty can beat the lightest load, so `passed` is the tired nurse spared
  const passed = best && lightBefore < bestBefore - 1e-9 ? light : null;
  return best && { n: best, before: bestBefore, after: bestBefore + w, passed };
}
function bestNurse(p) { const c = aiNurseChoice(p); return c ? c.n : null; }

function fatigueLevel(n) { return n.hours >= 12 ? 'over' : n.hours >= 10 ? 'tired' : 'ok'; }

function orphans() {
  return S.patients.filter(p => (p.stage === 'treatment' || p.stage === 'boarding')
    && (!p.nurse || (nurse(p.nurse) || {}).status !== 'on'));
}

/* ---------- Supplies and capacity forecast ---------- */
function minutesLeft(key) {
  const sp = S.sup[key], from = S.t - 30 * 60;
  let used = 0;
  for (let i = sp.log.length - 1; i >= 0 && sp.log[i].t >= from; i--) used += sp.log[i].n;
  const rate = used / 30;
  return rate > 0 ? Math.round(sp.qty / rate) : null;
}

// Expected need of patients not yet in a bed: ranges count their mean, probabilities their value.
function committed(key) {
  let need = 0;
  for (const p of S.patients) {
    if (p.stage !== 'inbound' && p.stage !== 'waiting') continue;
    const c = COND[p.cond], r = c && c.needs ? c.needs[key] : null;
    if (Array.isArray(r)) need += (r[0] + r[1]) / 2;
    else if (r) need += r;
  }
  return Math.round(need);
}

// Bed demand for the next 30 minutes: occupied + waiting + arriving − expected to leave.
function forecast() {
  const total = S.beds.length || 1, busy = bedsBusy(), ends = [], etas = [];
  let waitingN = 0, boardingN = 0;
  for (const p of S.patients) {
    if (p.stage === 'waiting') waitingN++;
    else if (p.stage === 'boarding') boardingN++;
    else if (p.stage === 'treatment') ends.push(p.treatEnd);
  }
  for (const a of S.ambulances) if (a.status === 'onscene' || a.status === 'enroute') etas.push(a);
  // Walk-ins: base 1 per 7 min, plus the incident surge only for the minutes it still lasts
  const boost = S.walkBoost && S.walkBoost.until > S.t ? S.walkBoost : null;
  const pts = [];
  let fullIn = null;
  for (let m = 0; m <= 30; m++) {
    const at = S.t + m * 60;
    let arrivals = m / 7 + (boost ? boost.rate * Math.min(m, (boost.until - S.t) / 60) : 0), ended = 0;
    for (const a of etas) if (a.eta <= at) arrivals += a.pts.length;
    for (const e of ends) if (e <= at) ended++;
    const demand = busy + waitingN + arrivals - (ended * 0.75 + boardingN * Math.min(1, m / 30) * 0.5);
    pts.push({ m, occ: Math.max(0, demand / total * 100) });
    if (fullIn === null && demand > total) fullIn = m;
  }
  return { pts, fullIn };
}

/* ---------- Suggestion bookkeeping ---------- */
function addSugg(obj) {
  const s = Object.assign({ id: 'S' + S.nextSugg++, at: S.t }, obj);
  waselAssignOwner(s);                 // owner + escalation clock (15-wasel.js)
  S.sugg.push(s);
  // Auto-accepted placements are applied at once; announcing them too would be noise
  if (s.level === 1 && !(s.type === 'placement' && prefs.autoAccept)) aiAnnounce(s.title);
  return s;
}

function dropSugg(s) {
  const i = S.sugg.findIndex(x => x.id === s.id);
  if (i >= 0) S.sugg.splice(i, 1);
  const b = s.bed ? bed(s.bed) : null;
  if (b && b.hold === s.id) b.hold = null;
}

function blocked(key) {
  return (S.dismissed[key] || 0) > S.t || S.sugg.some(s => s.key === key);
}

function stillValid(s) {
  const p = s.pid ? P(s.pid) : null, b = s.bed ? bed(s.bed) : null;
  const heldHere = !!b && b.status === 'free' && b.hold === s.id;
  switch (s.type) {
    case 'placement': return !!p && p.stage === 'waiting' && heldHere;
    case 'prearrival': {
      const a = amb(s.amb);
      return !!a && !!p && (a.status === 'onscene' || a.status === 'enroute') && heldHere;
    }
    case 'retriage': return !!p && (p.stage === 'waiting' || p.stage === 'inbound') && p.esi > s.to;
    case 'supply': return !!S.sup[s.item] && !S.sup[s.item].pending;
    case 'fatigue': { const n = nurse(s.nurse); return !!n && n.status === 'on' && !n.handover; }
    case 'reassign': return orphans().length > 0;
    case 'callin': return S.t - s.at < 20 * 60;
    case 'capacity': return S.diversionUntil <= S.t;
    case 'ct': { const u = aiCt1(); return !!u && !u.online && !S.ctRepair; }
    case 'vent': return S.eq.ventFaulty > 0 && !S.ventLoan;
    case 'needvent': return !!p && p.needsVent && !p.vent;
    case 'outage': return S.bedsOffline && !S.bedsFallback;
    case 'identity': case 'lwbs': case 'surge': return waselStillValid(s);
    default: return false;
  }
}

// Still valid but superseded, so re-plan: the named nurse can no longer take
// patients (the card would mislead), or the overflow forecast has cleared.
function aiOutdated(s) {
  if (s.type === 'placement' && s.nurse) { const n = nurse(s.nurse); return !n || n.status !== 'on' || n.handover; }
  if (s.type === 'capacity') return S.fc.fullIn === null;
  return false;
}

/* ---------- The plan: runs after every engine advance ---------- */
function aiPlan() {
  if (!S.announce) S.announce = [];

  // 1. Retire suggestions the situation has moved past (releases their bed holds)
  for (const s of S.sugg.slice()) if (!stillValid(s) || aiOutdated(s)) dropSugg(s);
  for (const b of S.beds) if (b.hold && !S.sugg.some(s => s.id === b.hold)) b.hold = null;
  for (const k in S.dismissed) if (S.dismissed[k] <= S.t) delete S.dismissed[k];
  // 1b. Tasks left open past their clock escalate (owner up the chain, level up, page)
  waselEscalate();

  // 2. Capacity forecast (also feeds the occupancy chart)
  S.fc = forecast();

  // 3. Re-triage untreated patients whose vital signs are deteriorating
  for (const p of S.patients) {
    if ((p.stage !== 'waiting' && p.stage !== 'inbound') || !p.flag || !p.flag.det) continue;
    const to = p.news >= 9 || r0(p.v.sbp) <= 85 ? 1 : 2, key = 'retriage:' + p.id;
    if (to >= p.esi || blocked(key)) continue;
    addSugg({ key, type: 'retriage', level: 1, pid: p.id, to,
      title: `Re-triage ${p.id} from ESI ${p.esi} to ESI ${to}`,
      why: `${p.flag.text}. ${p.flag.hint}.` + (p.flag.text.startsWith('NEWS2') ? '' : ` NEWS2 ${p.news}.`) });
  }

  // 4. Pre-arrival: critical ambulances within 15 min get a bed and a team before the doors open
  for (const a of S.ambulances) {
    if ((a.status !== 'onscene' && a.status !== 'enroute') || a.prepared || a.eta - S.t > 15 * 60) continue;
    const key = 'prearrival:' + a.id;
    if (blocked(key) || ambEsi(a) > 2) continue;
    let p = null;
    for (const id of a.pts) {
      const q = P(id);
      if (q && (!p || q.esi < p.esi || (q.esi === p.esi && (q.news || 0) > (p.news || 0)))) p = q;
    }
    const b = p && findBed(p);
    if (!b) continue;
    const team = aiTeam(p), others = a.pts.length - 1;
    const s = addSugg({ key, type: 'prearrival', level: p.esi === 1 ? 1 : 2, pid: p.id, bed: b.id, amb: a.id,
      title: `Prepare for ${a.id}: reserve ${zoneName(b.zone)} ${b.id}, page ${team}`,
      why: `ETA ${aiEta(a)} · field triage ESI ${p.esi} · ${COND[p.cond].label}`
        + (others > 0 ? ` · ${aiCount(others, 'more patient')} on board` : '') + '. Bed and team ready before the doors open.' });
    b.hold = s.id;
  }

  // Waiting queue, highest priority first (steps 5 and 6)
  const queue = [], prio = {};
  let waitingN = 0, inboundN = 0;
  for (const p of S.patients) {
    if (p.stage === 'inbound') inboundN++;
    if (p.stage !== 'waiting') continue;
    waitingN++;
    if (p.reservedBed) continue;
    const pr = priority(p);
    queue.push({ p, pr });
    prio[p.id] = pr;
  }
  queue.sort((x, y) => y.pr - x.pr);

  // 5. Bed stealing: a much sicker patient with no bed takes one held for a far less urgent patient
  const freedFrom = {};
  for (const w of queue) {
    if (blocked('placement:' + w.p.id) || findBed(w.p)) continue;
    const zones = ZONE_PREF[w.p.esi];
    let victim = null, victimPr = w.pr - 15;
    for (const s of S.sugg) {
      if (s.type !== 'placement' || prio[s.pid] === undefined || prio[s.pid] >= victimPr) continue;
      const b = bed(s.bed);
      if (b && zones.includes(b.zone)) { victim = s; victimPr = prio[s.pid]; }
    }
    if (victim) { freedFrom[w.p.id] = victim.pid; dropSugg(victim); }
  }

  // 6. Placement: best free bed in the ESI-appropriate zone + best-fit nurse, bed held until decided
  let monSeq = monitorsInUse();   // narrates which monitor RTLS would assign next
  for (const s of S.sugg) if (s.type === 'placement') { const q = P(s.pid); if (q && q.esi <= 3) monSeq++; }
  for (const { p } of queue) {
    const key = 'placement:' + p.id;
    if (blocked(key)) continue;
    const b = findBed(p);
    if (!b) continue;
    const c = aiNurseChoice(p), n = c ? c.n : null, why = [];
    if (p.flag) why.push(`NEWS2 ${p.news}${p.trend > 0 ? ' ↑' + p.trend : ''}${p.flag.det ? ', deteriorating' : ''}`);
    why.push(aiZoneReason(p, b));
    const waited = mins(S.t - p.arrivedAt);
    why.push(waited ? `waited ${waited} min` : 'just arrived');
    if (freedFrom[p.id]) why.push(`bed released from lower-priority ${freedFrom[p.id]}`);
    why.push(!n ? 'no nurse on duty can take a patient: assign one at placement'
      : `${n.name} ${c.passed ? 'best fit' : 'lightest load'} (${pct(c.before)} → ${pct(c.after)}), ${n.hours.toFixed(1)} h on shift`
        + (c.passed ? `; ${c.passed.name} is lighter but at ${c.passed.hours.toFixed(1)} h` : ''));
    if (p.esi <= 3) why.push(++monSeq <= S.eq.monitors ? `monitor M-${pad2(monSeq)} free nearby (RTLS)` : 'all cardiac monitors in use');
    const s = addSugg({ key, type: 'placement', level: p.esi <= 2 ? 1 : p.esi === 3 ? 2 : 3,
      pid: p.id, bed: b.id, nurse: n ? n.id : null,
      title: `Place ${p.id} (ESI ${p.esi}) in ${zoneName(b.zone)} ${b.id}` + (n ? ` with ${n.name}` : ''),
      why: why.join(' · ') });
    b.hold = s.id;
  }

  // 7. Supplies: low stock, faster burn than restock time, or more committed than on the shelf
  for (const item in S.sup) {
    const sp = S.sup[item], key = 'supply:' + item;
    if (sp.pending || blocked(key)) continue;
    const left = minutesLeft(item), need = committed(item);
    const low = sp.qty <= sp.cap * 0.25, short = need > sp.qty, fast = left !== null && left < 45;
    if (!low && !short && !fast) continue;
    const why = [`${sp.qty} ${sp.unit} left` + (low ? ` (${pct(sp.qty / sp.cap)} of stock)` : ''),
      left !== null ? `~${left} min at current use` : 'no use in the last 30 min'];
    if (need > 0) why.push(`waiting + inbound patients likely need ~${need}`);
    addSugg({ key, type: 'supply', level: short || (left !== null && left < 20) ? 1 : 2, item,
      title: sp.ask, why: why.join(' · ') });
  }

  // 8. Reassign patients whose nurse left; the pending card's count is kept current
  const orph = orphans();
  if (orph.length) {
    const title = `Reassign ${aiCount(orph.length, 'patient')} left without a nurse`;
    const why = aiOrphanWhy(orph) + 'Balanced by ESI-weighted workload and hours on shift; structured I-PASS handover sent to each new nurse.';
    const s = S.sugg.find(x => x.key === 'reassign');
    if (s) { s.title = title; s.why = why; }
    else if (!blocked('reassign')) addSugg({ key: 'reassign', type: 'reassign', level: 1, title, why });
  }

  // 9-10. Fatigue relief and call-in, from one pass over the roster
  const { load } = aiLoads();
  let onN = 0, sumLoad = 0, incoming = false;
  for (const n of S.nurses) {
    if (n.status === 'incoming') incoming = true;
    if (n.status !== 'on' || n.handover) continue;
    onN++; sumLoad += load[n.id] || 0;
    const key = 'fatigue:' + n.id;
    if (n.hours < 12 || blocked(key)) continue;
    let k = 0;
    for (const p of S.patients) if (p.nurse === n.id && (p.stage === 'treatment' || p.stage === 'boarding')) k++;
    addSugg({ key, type: 'fatigue', level: 2, nurse: n.id,
      title: `Relieve ${n.name} (${n.hours.toFixed(1)} h on shift): call in on-call nurse`,
      why: `Over the 12 h safe-shift limit, where error risk rises · caring for ${aiCount(k, 'patient')}, load ${pct(load[n.id] || 0)}`
        + ' · cover arrives in ~20 min, then structured I-PASS handover of every patient' });
  }
  const avg = onN ? sumLoad / onN : Infinity;
  if ((avg > 0.85 || onN <= 11) && !incoming && !blocked('callin')) {
    addSugg({ key: 'callin', type: 'callin', level: 2, title: 'Call in 2 on-call nurses',
      why: (onN <= 11 ? `Only ${onN} nurses free to take patients (${NURSES.length} rostered)` : `${onN} nurses free to take patients`)
        + (onN ? `, average load ${pct(avg)}${avg > 0.85 ? ' (target ≤ 85%)' : ''}` : '')
        + ` · ${waitingN} waiting, ${inboundN} inbound · on-call ETA ~25 min` });
  }

  // 11. Capacity: divert low-acuity ambulances before the ED overflows; critical ones keep coming
  const fc = S.fc;
  if (fc.fullIn !== null && S.diversionUntil <= S.t) {
    let lowAcuity = 0;
    for (const a of S.ambulances) if ((a.status === 'onscene' || a.status === 'enroute') && ambEsi(a) >= 4) lowAcuity++;
    const why = `ED beds full ${fc.fullIn === 0 ? 'now' : 'in ~' + fc.fullIn + ' min'}: ${S.beds.length - bedsBusy()} free, `
      + `${waitingN} waiting, ${inboundN} inbound. Critical patients still come here.`
      + (lowAcuity ? ` ${aiCount(lowAcuity, 'low-acuity ambulance')} already en route would be redirected.` : '');
    const s = S.sugg.find(x => x.key === 'capacity');
    if (s) s.why = why;
    else if (fc.fullIn <= 20 && !blocked('capacity')) {
      addSugg({ key: 'capacity', type: 'capacity', level: 1, title: 'Divert ESI 4–5 ambulances to nearby EDs for 45 min', why });
    }
  }

  // 12. Equipment and system failures
  const ct1 = aiCt1();
  if (ct1 && !ct1.online && !S.ctRepair && !blocked('ct')) {
    const q = S.eq.ctQueue.length, wait = ctWait();
    addSugg({ key: 'ct', type: 'ct', level: 2, title: 'Send biomedical engineering to repair CT-1 (ED)',
      why: 'CT-1 offline: all scans now go to CT-2 (Radiology) · '
        + (q ? `${aiCount(q, 'patient')} queued` + (wait !== null ? `, ~${wait} min wait` : '') : 'no scans queued yet') + ' · repair takes ~30 min once dispatched' });
  }
  if (S.eq.ventFaulty > 0 && !S.ventLoan && !blocked('vent')) {
    const k = S.eq.ventFaulty, need = committed('vent');
    addSugg({ key: 'vent', type: 'vent', level: 2, title: `Borrow ${aiCount(k, 'ventilator')} from the anaesthesia pool`,
      why: `${aiCount(k, 'ventilator')} failed self-test · ${ventsFree()} of ${S.eq.vents - k} working units free`
        + (need > 0 ? ` · waiting + inbound patients may need ~${need}` : '') + ' · loan arrives in ~10 min' });
  }
  for (const p of S.patients) {
    const key = 'needvent:' + p.id;
    if (!p.needsVent || p.vent || blocked(key)) continue;
    addSugg({ key, type: 'needvent', level: 1, pid: p.id,
      title: `Bring a spare ventilator to ${p.bed || 'the ED'} for ${p.id}`,
      why: `${p.id} needs ventilation (now SpO₂ ${r0(p.v.spo2)}%, RR ${r0(p.v.rr)}) and no ED ventilator was free at placement`
        + ' · nearest spare is in the ICU store (RTLS)' });
  }
  if (S.bedsOffline && !S.bedsFallback && !blocked('outage')) {
    addSugg({ key: 'outage', type: 'outage', level: 1, title: 'Bed management feed offline: switch to backup bed sensors',
      why: `No bed updates since ${fmtClock(S.bedsSnapAt)}` + (mins(S.t - S.bedsSnapAt) ? ` (${mins(S.t - S.bedsSnapAt)} min)` : '')
        + ' · the bed board is showing stale data'
        + ' · RTLS occupancy sensors can confirm every bed until the feed recovers' });
  }

  // 12b. WASEL: confirm candidate identities at the door; lobby leave-without-being-seen risk
  waselPlan();

  // 13. Auto-accept policy covers bed placements only
  if (prefs.autoAccept) for (const s of S.sugg.slice()) if (s.type === 'placement') accept(s, 'auto');
}

/* ---------- Human decisions ---------- */
// Applies an approved suggestion. Role checks happen in the UI (canAct) before this is called.
function accept(s, actor) {
  if (!S.sugg.some(x => x.id === s.id)) return false;
  if (!stillValid(s)) { dropSugg(s); return false; }
  const p = s.pid ? P(s.pid) : null, b = s.bed ? bed(s.bed) : null;
  switch (s.type) {
    case 'placement': {
      let n = s.nurse ? nurse(s.nurse) : null;
      if (!n || n.status !== 'on' || n.handover) n = bestNurse(p);
      place(p, b, n, actor);
      break;
    }
    case 'prearrival': {
      const a = amb(s.amb), team = aiTeam(p);
      b.status = 'reserved'; b.pid = p.id; b.hold = null;
      p.reservedBed = b.id;
      a.prepared = true; a.prepBed = b.id; a.team = team;
      emit('beds', 'FHIR', `Location ${b.id} → reserved for ${p.id} (${a.id})`);
      emit('roster', 'Paging', `${team.charAt(0).toUpperCase() + team.slice(1)} paged to ${b.id} for ${a.id}`);
      break;
    }
    case 'retriage': {
      p.esi = s.to; p.retriaged = true;
      emit('ehr', 'FHIR', `Encounter ${p.id} priority updated → ESI ${s.to}`);
      // New acuity means a new zone and urgency: re-plan any pending bed for this patient
      const old = S.sugg.find(x => x.key === 'placement:' + p.id);
      if (old) dropSugg(old);
      break;
    }
    case 'supply': {
      const sp = S.sup[s.item];
      sp.pending = true;
      emit('pharm', 'FHIR', `SupplyRequest sent: ${sp.label} × ${sp.restock} · ETA 15 min`);
      schedule(15 * 60, () => {
        const before = sp.qty;
        sp.qty = Math.min(sp.cap, sp.qty + sp.restock); sp.pending = false;
        emit('pharm', 'GS1', `Received ${sp.label} × ${sp.qty - before} (barcode scan) · stock now ${sp.qty} ${sp.unit}`);
      });
      break;
    }
    case 'fatigue': {
      const n = nurse(s.nurse);
      n.handover = true;
      const cover = callIn(20);
      cover.covers = n.id;
      break;
    }
    case 'callin': callIn(25); callIn(25); break;
    case 'reassign': {
      const byNurse = {};
      for (const q of orphans()) {
        const n = bestNurse(q);
        if (!n) continue;
        q.nurse = n.id;
        (byNurse[n.id] || (byNurse[n.id] = { name: n.name, ids: [] })).ids.push(q.id);
      }
      const names = Object.keys(byNurse);
      if (!names.length) return false;   // nobody on duty can take them: keep the card visible
      for (const id of names) emit('roster', 'I-PASS', `Structured handover to ${byNurse[id].name}: ${byNurse[id].ids.join(', ')}`);
      break;
    }
    case 'capacity': {
      S.diversionUntil = S.t + 45 * 60;
      const low = S.ambulances.filter(a => (a.status === 'onscene' || a.status === 'enroute') && ambEsi(a) >= 4);
      for (const a of low) divert(a);
      emit('ems', 'CAD', `Diversion until ${fmtClock(S.diversionUntil)}: ESI 4–5 ambulances go to nearby EDs`
        + (low.length ? ` · ${aiCount(low.length, 'unit')} en route redirected` : ''));
      break;
    }
    case 'ct': {
      S.ctRepair = true;
      emit('ris', 'HL7 v2', 'Work order: biomedical engineering dispatched to CT-1 (ED) · repair ETA 30 min');
      schedule(30 * 60, () => {
        const u = aiCt1();
        if (u) u.online = true;
        S.ctRepair = false;
        emit('ris', 'DICOM', 'CT-1 (ED) back online after repair · scan queue shared by 2 scanners');
      });
      break;
    }
    case 'vent': {
      const k = S.eq.ventFaulty;
      S.ventLoan = true;
      emit('rtls', 'RTLS', `Loan of ${aiCount(k, 'ventilator')} requested from the anaesthesia pool · ETA 10 min`);
      schedule(10 * 60, () => {
        S.eq.ventFaulty = 0; S.ventLoan = false;
        emit('rtls', 'BLE tag', `${aiCount(k, 'loaned ventilator')} arrived and tagged · faulty units sent for repair`);
      });
      break;
    }
    case 'needvent': {
      p.vent = true; p.needsVent = false;
      S.eq.vents += 1;
      emit('rtls', 'BLE tag', `Ventilator V-${pad2(S.eq.vents)} located in ICU store → ${p.bed || 'ED'} for ${p.id}`);
      break;
    }
    case 'outage': {
      S.bedsFallback = true;
      emit('beds', 'RTLS backup', 'Bed board switched to backup RTLS bed sensors');
      break;
    }
    case 'identity': case 'lwbs': case 'surge':
      if (!waselAccept(s, actor)) return false;
      break;
    default: return false;
  }
  audit((actor === 'auto' ? 'Auto-accepted (policy): ' : 'Accepted: ') + s.title);
  dropSugg(s);
  return true;
}

function dismiss(s) {
  S.dismissed[s.key] = S.t + 10 * 60;   // stays quiet for 10 sim-minutes, then may return
  audit('Dismissed: ' + s.title);
  dropSugg(s);
}

/* ---------- Small helpers ---------- */
function aiAnnounce(text) {
  const a = S.announce || (S.announce = []);
  a.push(text);
  if (a.length > 5) a.shift();   // the UI drains this; cap it in case nobody does
}
function aiCount(k, word) { return k + ' ' + word + (k === 1 ? '' : 's'); }
function aiTeam(p) { return (COND[p.cond] && COND[p.cond].team) || 'resus team'; }
function aiCt1() { return S.eq.ct.find(u => u.id === 'CT-1') || null; }
function aiEta(a) { const m = Math.round((a.eta - S.t) / 60); return m < 1 ? '<1 min' : m + ' min'; }

function aiZoneReason(p, b) {
  const pref = ZONE_PREF[p.esi], i = pref.indexOf(b.zone);
  if (i <= 0) return `${zoneName(b.zone)} ${b.zone === 'R' || b.zone === 'T' ? 'bay' : 'zone'} matches ESI ${p.esi}`;
  return `${pref.slice(0, i).map(zoneName).join(' and ')} full · ${zoneName(b.zone)} is next-best for ESI ${p.esi}`;
}

// "R. Menon redeployed to ICU (3), never assigned (1). "
function aiOrphanWhy(list) {
  const by = {};
  for (const p of list) by[p.nurse || ''] = (by[p.nurse || ''] || 0) + 1;
  return Object.keys(by).map(id => {
    const n = id ? nurse(id) : null;
    if (!id) return `never assigned (${by[id]})`;
    const why = n && n.offReason ? n.offReason.charAt(0).toLowerCase() + n.offReason.slice(1) : 'off duty';
    return n ? `${n.name} ${why} (${by[id]})` : `nurse unavailable (${by[id]})`;
  }).join(', ') + '. ';
}
