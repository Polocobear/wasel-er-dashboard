/* =========================================================================
 * WASEL ER Command Dashboard · 16-readiness.js
 * Readiness for the patients on their way in, from rules a clinician can read aloud:
 *   readiness(p)    5-point checklist (bed, team, airway, blood, CT) from live state
 *   traumaRules(p)  field-triage rules for trauma team activation
 *                   (based on the ACS field triage guideline)
 *   transfers       burns ≥ 20% body surface go to a specialist burns unit (demo partner)
 *   NFC wristband   the field wristband is tapped at the ambulance bay on arrival
 *
 * Humans decide: a rule only proposes a card; activation needs a senior's tap (audited),
 * and a transfer leaves only after the charge nurse or physician confirms it.
 * Privacy: card and feed texts carry encounter ids only; the transfer enquiry sent to the
 * partner unit is de-identified (encounter, burns estimate, ESI).
 * Hooks: aiPlan → readinessPlan, stillValid → readinessStillValid, accept → readinessAccept
 * (20-ai.js), arrive → readinessOnArrive (10-engine.js). No DOM access (runs headless).
 * Concatenated after 15-wasel.js, before 20-ai.js.
 * ========================================================================= */

/* ---------- Tuning ---------- */
const READINESS_CFG = {
  ctMaxWaitMin: 30,                 // CT counts as available when the queue clears within this
  seniorRoles: ['physician', 'charge'],
  traumaOwner: 'Physician',
  traumaTeam: 'trauma surgeon, anaesthetist, 2 nurses, CT + OR alerted',
  burnsUnit: 'Burns Unit (demo)',
  transferBurnsPct: 20,             // burns ≥ 20% body surface: this ED has no burns unit
  transferAcceptMin: 3,             // simulated reply from the partner unit's bed manager
  transferEtaMin: 25,               // critical-care ambulance to the partner unit
  stableNewsBelow: 7,               // fit to travel: NEWS2 below the emergency-response threshold...
  stableSbpMin: 90,                 // ...and no hypotension
};

// Field triage rules for trauma team activation (based on the ACS field triage guideline):
// physiology (SBP, GCS, RR), burn size, and the anatomy/mechanism reported by the crew.
const TRAUMA_RULES = {
  source: 'based on the ACS field triage guideline',
  sbpBelow: 90,
  gcsAtMost: 13,
  rrBelow: 10,
  rrAbove: 29,
  burnsAtLeast: 20,
  penetrating: /\b(?:stab(?:bed|bing)?|knife|gunshot|gsw|shot|bullet|impaled?|penetrating)\b/i,
  amputation: /\bamputat\w*/i,
  quoteMax: 60,
};

// Body surface burned by condition, from its ICD-10-CM T31 band (T31.0 < 10%, T31.1x 10–19%,
// T31.3x 30–39%). A burn size measured by the responder (triage.burnsPct) takes precedence.
const READINESS_BURN_TBSA = { burnMinor: 5, burnMod: 15, burnMajor: 35 };

const READINESS_ITEMS = [
  ['bed', 'Bed reserved'], ['team', 'Team paged'], ['airway', 'Airway kit at bay'],
  ['blood', 'Blood on standby'], ['ct', 'CT available'],
];

// Family board status (15-wasel.js) for patients who leave by transfer: no clinical detail
if (typeof WASEL_FAMILY_DISPO === 'object' && WASEL_FAMILY_DISPO && !WASEL_FAMILY_DISPO.transfer) {
  WASEL_FAMILY_DISPO.transfer = 'Transferred';
}

/* ---------- Readiness score (fills the design doc's "readiness score" example) ---------- */
// {score, of: 5, items: [{k, label, ok, detail}]} for an inbound or pre-alerted patient.
// An item that this patient does not need counts as ready. Patients already in a bed
// count bed and team as ready. Pure: reads state, changes nothing.
function readiness(p) {
  if (!p || !COND[p.cond]) return null;
  const c = COND[p.cond], needs = c.needs || {};
  const check = {
    bed: rdyBed(p), team: rdyTeam(p), airway: rdyAirway(p, needs),
    blood: rdyBlood(p, needs), ct: rdyCt(p, needs),
  };
  const items = READINESS_ITEMS.map(([k, label]) => ({ k, label, ok: check[k].ok, detail: check[k].detail }));
  return { score: items.filter(i => i.ok).length, of: items.length, items };
}

function rdyBed(p) {
  if (occupiesBed(p) && p.bed) return { ok: true, detail: `In ${p.bed}` };
  const rb = p.reservedBed ? bed(p.reservedBed) : null;
  if (rb && rb.status === 'reserved' && rb.pid === p.id) return { ok: true, detail: `${zoneName(rb.zone)} ${rb.id} reserved` };
  const prep = S.sugg.find(s => s.type === 'prearrival' && s.pid === p.id && s.bed);
  return { ok: false, detail: prep ? `${prep.bed} held: awaiting one-tap confirmation` : 'No bed reserved yet' };
}

function rdyTeam(p) {
  if (p.traumaActivated) return { ok: true, detail: 'Trauma team activated' };
  if (occupiesBed(p)) return { ok: true, detail: 'Under ED care' };
  const a = p.amb ? amb(p.amb) : null;
  if (a && a.prepared && a.team) return { ok: true, detail: `${wslCap(a.team)} paged to ${a.prepBed}` };
  return { ok: false, detail: 'Not paged yet' };
}

// Airway: ESI 1–2 or a likely ventilation need means a ventilator and airway kit are staged
function rdyAirway(p, needs) {
  if (p.esi > 2 && !needs.vent) return { ok: true, detail: `Not required (ESI ${p.esi})` };
  const free = ventsFree();
  if (free <= 0) return { ok: false, detail: 'No ventilator free: borrow from the anaesthesia pool' };
  const at = p.reservedBed || p.bed;
  return { ok: true, detail: `${aiCount(free, 'ventilator')} + airway kit free (RTLS)${at ? ' → staged at ' + at : ''}` };
}

// Blood: O-negative on the shelf covers this patient and every other patient not yet in a bed
function rdyBlood(p, needs) {
  const most = Array.isArray(needs.blood) ? needs.blood[1] : 0;
  if (!(most > 0)) return { ok: true, detail: 'Not expected' };
  const sp = S.sup.blood, pipeline = committed('blood');
  return {
    ok: sp.qty >= Math.max(most, pipeline),
    detail: `O-neg ${sp.qty} ${sp.unit} · up to ${most} for ${p.enc} · ~${pipeline} for all inbound + waiting`
      + (sp.pending ? ' · restock ordered' : ''),
  };
}

function rdyCt(p, needs) {
  if (!needs.ct && !p.traumaActivated) return { ok: true, detail: 'Not expected' };
  const on = ctOnline(), wait = ctWait();
  if (!on) return { ok: false, detail: 'All CT scanners offline' };
  return {
    ok: wait <= READINESS_CFG.ctMaxWaitMin,
    detail: `${on}/${S.eq.ct.length} scanners online · queue ${S.eq.ctQueue.length} · ~${wait} min wait`,
  };
}

/* ---------- Trauma activation rules ---------- */
// Burned body surface in percent: the responder's measurement, else the condition's ICD-10 band
function burnsPct(p) {
  if (p && p.triage && typeof p.triage.burnsPct === 'number') return p.triage.burnsPct;
  return (p && READINESS_BURN_TBSA[p.cond]) || 0;
}
// 'burns 30% body surface' when measured in the field, 'burns ~35% body surface' when estimated
function rdyBurnsText(p) {
  const measured = !!(p.triage && typeof p.triage.burnsPct === 'number');
  return `burns ${measured ? '' : '~'}${burnsPct(p)}% body surface`;
}

// Pure: every rule that fires for this patient now, as [{k, text}], e.g.
// [{k: 'sbp', text: 'SBP 84 < 90'}, {k: 'gcs', text: 'GCS 12 ≤ 13'}]. Empty when none fires.
function traumaRules(p) {
  const R = TRAUMA_RULES, out = [];
  if (!p || !p.v) return out;
  const sbp = r0(p.v.sbp), rr = r0(p.v.rr);
  if (sbp < R.sbpBelow) out.push({ k: 'sbp', text: `SBP ${sbp} < ${R.sbpBelow}` });
  const gcs = rdyGcsRule(p);
  if (gcs) out.push({ k: 'gcs', text: gcs });
  if (rr < R.rrBelow) out.push({ k: 'rr', text: `RR ${rr} < ${R.rrBelow}` });
  else if (rr > R.rrAbove) out.push({ k: 'rr', text: `RR ${rr} > ${R.rrAbove}` });
  if (burnsPct(p) >= R.burnsAtLeast) out.push({ k: 'burns', text: `${rdyBurnsText(p)} ≥ ${R.burnsAtLeast}%` });
  const at = p.atmist || {};
  const pen = [at.mechanism, at.injuries].find(x => typeof x === 'string' && R.penetrating.test(x));
  if (pen) out.push({ k: 'penetrating', text: `penetrating mechanism ("${rdyQuote(pen)}")` });
  const amp = [at.injuries, at.mechanism].find(x => typeof x === 'string' && R.amputation.test(x));
  if (amp) out.push({ k: 'amputation', text: `amputation ("${rdyQuote(amp)}")` });
  return out;
}

// GCS ≤ 13 from the ATMIST signs; otherwise from AVPU (V, P or U corresponds to GCS ≤ 13)
function rdyGcsRule(p) {
  const R = TRAUMA_RULES, g = p.atmist && p.atmist.signs ? p.atmist.signs.gcs : null;
  if (typeof g === 'number' && Number.isFinite(g) && g <= R.gcsAtMost) return `GCS ${g} ≤ ${R.gcsAtMost}`;
  const field = p.triage && p.triage.avpu, live = typeof g === 'number' ? null : p.v.avpu;
  const avpu = WASEL_AVPU_TEXT[field] ? field : WASEL_AVPU_TEXT[live] ? live : null;
  return avpu ? `AVPU ${avpu}, ${WASEL_AVPU_TEXT[avpu]} (GCS ≤ ${R.gcsAtMost})` : null;
}

function rdyQuote(text) {
  const s = wslText(text, 200).replace(/"/g, "'");
  return s.length > TRAUMA_RULES.quoteMax ? s.slice(0, TRAUMA_RULES.quoteMax - 1) + '…' : s;
}

function rdyTraumaWhy(p, rules) {
  const a = p.amb ? amb(p.amb) : null;
  const where = p.stage === 'inbound' ? (a ? `${a.id} ETA ${aiEta(a)}` : 'inbound') : `waiting ${mins(S.t - p.arrivedAt)} min`;
  return `Field triage rules met (${TRAUMA_RULES.source}): ${rules.map(r => r.text).join(' · ')}.`
    + ` ${p.enc} · ${where} · ESI ${p.esi} · ${COND[p.cond].label}.`
    + ' A senior (physician or charge nurse) confirms; the activation is audited.';
}

/* ---------- Transfers to a partner burns unit ---------- */
const rdyStable = p => (p.news || 0) < READINESS_CFG.stableNewsBelow && r0(p.v.sbp) >= READINESS_CFG.stableSbpMin;
const rdyInEd = p => p.stage === 'waiting' || occupiesBed(p);

// Automatic, de-identified bed enquiry (capacity question only); the partner replies in a few sim-minutes
function rdyRequestTransfer(p) {
  const C = READINESS_CFG, tr = {
    to: C.burnsUnit, status: 'requested', etaMin: C.transferEtaMin, reason: rdyBurnsText(p),
    requestedAt: S.t, acceptedAt: null, approved: false, approvedBy: null, departedAt: null, completedAt: null,
  };
  p.transfer = tr;
  emit('ehr', 'FHIR', `ServiceRequest: transfer enquiry ${p.enc} → ${tr.to} · ${tr.reason} (≥ ${C.transferBurnsPct}%), ESI ${p.esi} · de-identified`);
  schedule(C.transferAcceptMin * 60, () => {
    if (p.stage === 'done' || p.transfer !== tr || tr.status !== 'requested') return;
    tr.status = 'accepted';
    tr.acceptedAt = S.t;
    emit('ehr', 'FHIR', `${tr.to} accepted ${p.enc} · bed held · transfer ETA ${tr.etaMin} min`);
  });
}

function rdyTransferWhy(p) {
  const tr = p.transfer;
  const when = p.stage === 'waiting' ? 'Not yet in a bed: leaves as soon as you confirm'
    : rdyStable(p) ? `Stable for transfer now (NEWS2 ${p.news}, SBP ${r0(p.v.sbp)})`
    : `Leaves once stable (NEWS2 < ${READINESS_CFG.stableNewsBelow} and SBP ≥ ${READINESS_CFG.stableSbpMin}); now NEWS2 ${p.news}, SBP ${r0(p.v.sbp)}`;
  return `${wslCap(tr.reason)} (≥ ${READINESS_CFG.transferBurnsPct}%): needs a specialist burns centre, which this ED does not have`
    + ` · ${tr.to} accepted at ${fmtClock(tr.acceptedAt)} · ${when}.`;
}

// The patient leaves the ED by critical-care ambulance; arrival at the unit completes the transfer
function rdyDepart(p) {
  const tr = p.transfer;
  const own = S.sugg.find(x => x.key === 'placement:' + p.id);
  if (own) dropSugg(own);
  const rb = p.reservedBed ? bed(p.reservedBed) : null;
  if (rb && rb.status === 'reserved' && rb.pid === p.id) { rb.status = 'free'; rb.pid = null; }
  p.reservedBed = null;
  p.dispo = 'transfer';
  tr.status = 'in-transport';
  tr.departedAt = S.t;
  leave(p, `Transferred to ${tr.to}`);
  S.patients = S.patients.filter(q => q !== p);   // off the board now, not at the next engine tick
  emit('ems', 'CAD', `Critical-care ambulance departed with ${p.enc} → ${tr.to} · ETA ${tr.etaMin} min`);
  schedule(tr.etaMin * 60, () => {
    tr.status = 'completed';
    tr.completedAt = S.t;
    emit('ems', 'CAD', `${p.enc} arrived at ${tr.to} · handover complete`);
  });
}

/* ---------- Plan, validity and accept (hooks from 20-ai.js) ---------- */
// Called by aiPlan() after waselPlan()
function readinessPlan() {
  for (const p of S.patients) {
    if (p.stage === 'done') continue;
    rdyPlanTrauma(p);
    rdyPlanTransfer(p);
  }
}

// EMS patients inbound or waiting: a card when any field-triage rule fires; an open card's
// reasons stay current
function rdyPlanTrauma(p) {
  if (p.src !== 'EMS' || p.traumaActivated || (p.stage !== 'inbound' && p.stage !== 'waiting')) return;
  const key = 'trauma:' + p.id, rules = traumaRules(p);
  const open = S.sugg.find(s => s.key === key);
  if (open) {
    if (rules.length) { open.why = rdyTraumaWhy(p, rules); open.rules = rules.map(r => r.text); }
    return;
  }
  if (!rules.length || blocked(key)) return;
  const s = addSugg({ key, type: 'trauma', level: 1, pid: p.id, rules: rules.map(r => r.text),
    title: `Activate trauma team for ${p.enc}`, why: rdyTraumaWhy(p, rules) });
  s.owner = READINESS_CFG.traumaOwner;   // 15-wasel.js gives unknown types to the charge nurse
}

// Burns ≥ 20%: enquiry sent when the patient is first seen (often still in the ambulance), so the
// partner's acceptance is ready at the door; the one-tap card appears once the patient is in the ED.
function rdyPlanTransfer(p) {
  const tr = p.transfer;
  if (!tr) {
    if ((p.stage === 'inbound' || rdyInEd(p)) && burnsPct(p) >= READINESS_CFG.transferBurnsPct) rdyRequestTransfer(p);
    return;
  }
  if (tr.status !== 'accepted' || !rdyInEd(p)) return;
  if (tr.approved) {
    if (p.stage === 'waiting' || rdyStable(p)) rdyDepart(p);
    return;
  }
  const key = 'transfer:' + p.id, open = S.sugg.find(s => s.key === key);
  if (open) { open.why = rdyTransferWhy(p); return; }
  if (blocked(key)) return;
  addSugg({ key, type: 'transfer', level: 2, pid: p.id,
    title: `Transfer ${p.enc} to ${tr.to} — accepted bed, ETA ${tr.etaMin} min`, why: rdyTransferWhy(p) });
}

// Called by stillValid()
function readinessStillValid(s) {
  const p = s.pid ? P(s.pid) : null;
  if (!p) return false;
  switch (s.type) {
    case 'trauma': return !p.traumaActivated && (p.stage === 'inbound' || p.stage === 'waiting');
    case 'transfer': return !!p.transfer && p.transfer.status === 'accepted' && !p.transfer.approved && rdyInEd(p);
    default: return false;
  }
}

// Called by accept(); false leaves the card in place
function readinessAccept(s, actor) {
  const p = s.pid ? P(s.pid) : null;
  if (!p) return false;
  const who = ROLES[prefs.role] ? ROLES[prefs.role].label : prefs.role;
  switch (s.type) {
    case 'trauma': {
      // A senior confirms in person: never by policy, never by a role without that authority
      if (actor === 'auto' || !READINESS_CFG.seniorRoles.includes(prefs.role)) return false;
      const rules = traumaRules(p).map(r => r.text);
      p.traumaActivated = true;
      p.traumaActivatedAt = S.t;
      p.traumaActivatedBy = who;
      emit('roster', 'Paging', `Trauma team activated: ${READINESS_CFG.traumaTeam} · ${p.enc}`
        + (p.reservedBed ? ' → ' + p.reservedBed : ''));
      audit(`Trauma activation ${p.enc} confirmed by senior (${who})`
        + ` · ${(rules.length ? rules : s.rules || []).join(' · ') || 'rules met at proposal'}`);
      return true;
    }
    case 'transfer': {
      const tr = p.transfer;
      tr.approved = true;
      tr.approvedBy = who;
      emit('ehr', 'FHIR', `Transfer ${p.enc} → ${tr.to} confirmed by ${who} · critical-care ambulance booked`);
      if (p.stage === 'waiting' || rdyStable(p)) rdyDepart(p);
      return true;
    }
    default: return false;
  }
}

/* ---------- NFC wristband (hook from 10-engine.js arrive()) ---------- */
// The crew bands every casualty in the field with the encounter token; the tap at the bay
// matches it to the pre-alert, so nobody re-registers or types at the door.
function readinessOnArrive(p) {
  if (!p || p.src !== 'EMS') return;
  p.wristband = true;
  emit('adt', 'NFC', `Wristband ${p.enc} tapped at ambulance bay · encounter token matched`);
}
