/* =========================================================================
 * WASEL ER Command Dashboard · 30-ui.js
 * The only module that touches the DOM. It owns the real-time loop, wires
 * user input, enforces role-based display rules and renders state `S`.
 *
 * Security model in this layer:
 *   - Escape by default: markup is built with the `html` tagged template,
 *     which HTML-escapes every interpolated value via esc() unless the value
 *     is itself markup produced by `html`. setHTML() refuses raw strings.
 *   - Minimum necessary: names and MRNs are masked per role (pname/pmrn);
 *     the wall display and IT see encounter id, priority and ETA only.
 *   - Care-team access: a nurse opens only assigned patients unless they
 *     "break glass" with a written reason. Record views, break-glass access
 *     and blocked attempts are all written to the audit log.
 *   - Automatic logoff after 5 minutes without input for clinical roles.
 *   - Only the theme and language choices are stored locally; patient data
 *     never goes to storage or URLs.
 *
 * v2 engine helpers (15-wasel.js) are resolved once at load and called
 * through uiCall(), so a missing helper degrades to a message, never a crash.
 * ========================================================================= */

/* ---------- Escape-by-default HTML builder ---------- */
class SafeHTML {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
function htmlFragment(v) {
  if (v instanceof SafeHTML) return v.s;
  if (Array.isArray(v)) return v.map(htmlFragment).join('');
  if (v === false || v == null) return '';
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += htmlFragment(vals[i]) + strings[i + 1];
  return new SafeHTML(out);
}

// Writes markup only when it changed: keeps buttons clickable, scroll and focus stable.
const UI_HTML_CACHE = new WeakMap();
function setHTML(el, content) {
  if (!el) return false;
  const markup = content instanceof SafeHTML ? content.s : esc(content);
  if (UI_HTML_CACHE.get(el) === markup) return false;
  const active = document.activeElement;
  let keep = null;
  if (active && active !== el && el.contains(active) && active.dataset && active.dataset.act) {
    keep = { act: active.dataset.act, id: active.dataset.id };
  }
  el.innerHTML = markup;
  UI_HTML_CACHE.set(el, markup);
  if (keep) {
    let sel = '[data-act="' + CSS.escape(keep.act) + '"]';
    if (keep.id != null) sel += '[data-id="' + CSS.escape(keep.id) + '"]';
    const again = el.querySelector(sel);
    if (again) again.focus({ preventScroll: true });
  }
  return true;
}
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
function showEl(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

/* ---------- Optional v2 engine API (15-wasel.js) ----------
 * Resolved once: every other module precedes this one in the same script, so
 * `typeof` tells us reliably whether a helper exists in this build.        */
const UI_API = Object.freeze({
  receivePreAlert: typeof receivePreAlert === 'function' ? receivePreAlert : null,
  checkOrder: typeof checkOrder === 'function' ? checkOrder : null,
  overrideOrder: typeof overrideOrder === 'function' ? overrideOrder : null,
  sbar: typeof sbar === 'function' ? sbar : null,
  familyBoard: typeof familyBoard === 'function' ? familyBoard : null,
  updateMode: typeof updateMode === 'function' ? updateMode : null,
  // Engine conveniences beyond the spec; this layer has its own fallback for each
  placeOrder: typeof waselOrder === 'function' ? waselOrder : null,
  declareMci: typeof waselDeclareMci === 'function' ? waselDeclareMci : null,
  // v3 low-friction flow (CHANNELS.md)
  receiveIncident: typeof receiveIncident === 'function' ? receiveIncident : null,
  capacitySnapshot: typeof capacitySnapshot === 'function' ? capacitySnapshot : null,
  routedAway: typeof waselRoutedAway === 'function' ? waselRoutedAway : null,
  triageWhy: typeof waselTriageWhy === 'function' ? waselTriageWhy : null,
});
// Calls an optional helper; a missing or failing helper returns undefined so one bad frame never stops the loop.
function uiCall(name, ...args) {
  const fn = UI_API[name];
  if (!fn) return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.error('WASEL: ' + name + '() failed', err);
    return undefined;
  }
}
const UI_APP_NAME = typeof APP_NAME === 'string' ? APP_NAME : 'WASEL';
const UI_APP_SUB = typeof APP_SUB === 'string' ? APP_SUB : 'ER Command Dashboard';

/* ---------- Language: English / Arabic (Modern Standard Arabic) ----------
 * Static labels only. Clinical codes (ESI, NEWS2, ICD-10-CM, LOINC, START),
 * numbers, patient and encounter ids, and source-system messages stay as
 * they are. Keys ending in .1 / .n are singular / plural (see tn()).       */
const I18N = {
  en: {
    'app.title': UI_APP_SUB, 'app.sub': UI_APP_SUB + ' · Demo General Hospital', 'app.sim': 'Simulated data',
    'hdr.simTime': 'Simulated time', 'hdr.speed': 'Speed', 'hdr.role': 'Role', 'hdr.pause': 'Pause', 'hdr.resume': 'Resume',
    'hdr.paused': 'PAUSED', 'hdr.sim': 'SIM {n}×', 'hdr.normal': 'Normal operations',
    'hdr.diverting': 'Diverting ESI 4–5 ambulances · {n} min left',
    'theme.toLight': 'Switch to light theme', 'theme.toDark': 'Switch to dark theme',
    'role.wall': 'Wall display', 'role.charge': 'Charge nurse', 'role.nurse': 'Nurse (A. Haddad)', 'role.physician': 'Physician', 'role.admin': 'IT / Admin',
    'tb.label': 'Run a scenario:', 'tb.pileup': 'Highway pile-up', 'tb.fire': 'Building fire', 'tb.staff': 'Staff shortage',
    'tb.equipment': 'Equipment failure', 'tb.outage': 'System outage', 'tb.reset': 'Reset',
    'tb.mci': 'Declare MCI', 'tb.mciEnd': 'Stand down MCI', 'tb.prealert': 'Simulate responder pre-alert', 'tb.auto': 'Auto-accept bed placements',
    'mode.steady': 'STEADY', 'mode.strain': 'STRAIN', 'mode.surge': 'SURGE', 'mode.mci': 'MCI',
    'mode.title': 'Operating mode', 'mode.since': 'since {time}', 'mode.calm': 'All strain rules clear',
    'p.inbound': 'Inbound · pre-alerts', 'p.staff': 'Nursing staff', 'p.patients': 'Patients · sorted by clinical priority', 'p.beds': 'Bed board',
    'p.equip': 'Equipment & supplies', 'p.dec': 'Decision support', 'p.feed': 'Live data feed', 'p.audit': 'Audit log',
    'p.chart': 'ED bed occupancy · last 60 min + forecast',
    'ft.family': 'Family desk', 'ft.standards': 'Standards & security', 'ft.datamap': 'Data map', 'm.close': 'Close',
    'w.or': ' or ', 'w.anyRole': 'an authorised role', 'w.unknown': 'Unknown', 'u.min': '{n} min',
    'ago.now': 'just now', 'ago.min': '{n} min ago', 'sr.newCrit': 'New critical decision: ',
    // Journey strip
    'j.1': 'Detection', 'j.2': 'First responders', 'j.3': 'En route', 'j.4': 'Waiting', 'j.5': 'In treatment', 'j.6': 'Disposition',
    'j.inc.1': 'incident', 'j.inc.n': 'incidents', 'j.mci': 'MCI declared · {name}', 'j.mciNoInc': 'hospital plan active',
    'j.via': 'via {via}', 'j.noIncident': 'No active incident', 'j.walk': 'Walk-ins ~1 per {n} min', 'j.surgeTag': ' (surge)',
    'j.unit.1': 'unit on scene', 'j.unit.n': 'units on scene', 'j.tri.1': '{n} patient field-triaged', 'j.tri.n': '{n} patients field-triaged',
    'j.noScene': 'No units on scene', 'j.standby': 'EMS dispatch standing by',
    'j.pin.1': 'patient inbound', 'j.pin.n': 'patients inbound', 'j.amb.1': '{n} ambulance', 'j.amb.n': '{n} ambulances',
    'j.nextNow': 'Next arrival now', 'j.next': 'Next arrival in {n} min', 'j.diverted': '{n} diverted', 'j.noEnroute': 'No ambulances en route',
    'j.waiting': 'waiting', 'j.urgent': '{n} ESI 1–2 waiting', 'j.longest': 'Longest wait {n} min', 'j.noQueue': 'No queue',
    'j.ofBeds': 'of {n} beds', 'j.free.1': '{n} bed free', 'j.free.n': '{n} beds free', 'j.stale': ' (stale data)', 'j.d2b': 'Door-to-bed median {v}',
    'j.done': 'done · last 60 min', 'j.dispo': '{a} home · {b} ward · {c} ICU · {d} OR', 'j.board': '{a} boarding · ICU {b} free',
    // Inbound pre-alerts
    'in.none': 'None inbound', 'in.empty': 'No ambulances inbound.', 'in.emsLive': 'EMS dispatch feed live.', 'in.emsOff': 'EMS dispatch feed offline.',
    'in.pts.1': '{n} patient', 'in.pts.n': '{n} patients', 'in.ambs.1': '{n} ambulance', 'in.ambs.n': '{n} ambulances',
    'in.onscene': 'On scene', 'in.enroute': 'En route', 'in.arriving': 'Arriving', 'in.eta': 'ETA {n} min', 'in.diverted': 'Diverted',
    'in.div.1': '{n} patient (ESI 4–5) sent to a nearby ED', 'in.div.n': '{n} patients (ESI 4–5) sent to a nearby ED',
    'in.prepDone': '✓ {bed} reserved · {team} paged', 'in.prepSugg': 'Prep suggested — see decision queue',
    'st.red': 'RED', 'st.yellow': 'YELLOW', 'st.green': 'GREEN', 'st.black': 'BLACK',
    'id.candidate': 'Candidate', 'id.confirmed': 'Confirmed', 'id.temporary': 'Temporary ID',
    'idm.face': 'face', 'idm.fingerprint': 'fingerprint', 'idm.nfc': 'NFC', 'idm.emirates-id': 'Emirates ID',
    'sf.unknown': 'Allergies: UNKNOWN', 'sf.anticoag': 'Anticoagulant', 'sf.restricted': 'Restricted by patient',
    // Staff, patients, beds, equipment
    'staff.meta': '{on} on duty · avg load {load}% · {tired} fatigued · 6 doctors',
    'staff.orph.1': '{n} patient without an assigned nurse', 'staff.orph.n': '{n} patients without an assigned nurse',
    'pt.meta': '{w} waiting · {c} in treatment · {f} flagged', 'pt.secWait': 'Waiting for a bed · {n}', 'pt.secCare': 'In treatment · {n}',
    'pt.emptyWait': 'Nobody waiting for a bed.', 'pt.emptyCare': 'No patients in treatment.', 'pt.unidentified': 'Unidentified',
    'pt.retriaged': 're-triaged', 'pt.open': 'Open record.',
    'loc.waiting': 'Waiting {n} min', 'loc.inbound': 'Inbound', 'loc.board': '{bed} · awaiting {what} {n} min', 'loc.noNurse': '⚠ no nurse',
    'dispo.discharge': 'discharge home', 'dispo.ward': 'ward bed', 'dispo.icu': 'ICU bed', 'dispo.or': 'operating room', 'dispo.transfer': 'transfer',
    'bed.meta': '{f}/{t} free · {c} cleaning', 'bed.staleMeta': 'Feed offline · snapshot from {time}', 'bed.backup': '{f}/{t} free · via backup RTLS bed sensors',
    'bed.zone': '{zone} · {f}/{t} free', 'bed.stale': 'STALE', 'bed.staleNote': ' · last update {time} · feed offline',
    'bt.free': 'free', 'bt.hold': 'hold', 'bt.clean': 'clean', 'bt.resv': 'resv',
    'lg.free': 'Free', 'lg.occ': 'Occupied', 'lg.clean': 'Cleaning', 'lg.resv': 'Reserved', 'lg.held': 'Held for a pending suggestion',
    'eq.monitors': 'Cardiac monitors', 'eq.vents': 'Ventilators', 'eq.ct': 'CT scanners', 'eq.free': '{a}/{b} free', 'eq.ventFree': '{a} free of {b}',
    'eq.ctv': '{on}/{tot} online · queue {q}', 'eq.ctWait': ' · ~{n} min wait', 'eq.ctNone': ' · no scanner online',
    'eq.left': '{q} {unit} · ~{n} min left', 'eq.stable': '{q} {unit} · stable', 'eq.ok': '✓ OK', 'eq.low': '● Low', 'eq.crit': '▲ Critical',
    'eq.allOk': 'All within limits', 'eq.att.1': '{n} item needs attention', 'eq.att.n': '{n} items need attention',
    // Decisions, feed, chart, sources
    'dec.meta': '{n} pending · {c} critical', 'dec.upToDate': 'Up to date', 'dec.auto': ' · auto-accept on',
    'dec.acceptAll': 'Accept all placements ({n})', 'dec.accept': 'Accept', 'dec.dismiss': 'Dismiss', 'dec.needs': 'Needs {who} sign-in',
    'dec.empty': 'No pending decisions. Watching {p} patients, {b} beds, {f} data feeds.',
    'dec.owner': 'Owner: {who}', 'dec.open': '{t} open', 'dec.escIn': 'escalates in {t}', 'dec.escNow': 'escalating now', 'dec.escalated': 'Escalated ×{n}',
    'fd.restricted': 'Restricted: sign in as IT / Admin to view the audit log.', 'fd.noAudit': 'No audit entries yet.',
    'fd.empty': 'Waiting for the first message from the integration gateway.',
    'ch.none': '✓ No overflow forecast', 'ch.nowFull': '▲ At capacity now', 'ch.full': 'Full in ~{n} min', 'ch.legend': 'solid recorded · dashed forecast',
    'ch.cap': '100% capacity', 'ch.now': 'now', 'ch.tipNow': 'Now · {v}% occupied', 'ch.tipPast': '{m} min · {v}% occupied', 'ch.tipFc': '+{m} min (forecast) · {v}%',
    'src.meta': 'Data sources {n}/{m} live · FHIR R4 gateway', 'src.offline': 'offline', 'src.backup': 'backup',
    // Patient drawer
    'd.identity': 'Identity', 'd.field': 'Field report · ATMIST', 'd.noField': 'Walk-in: no pre-hospital report.',
    'd.vitals': 'Vital signs · NEWS2 {n}', 'd.trends': 'Trends · last 30 min', 'd.ai': 'Decision support', 'd.history': 'History · shared record',
    'd.sbar': 'SBAR handover', 'd.order': 'Order a medication', 'd.access': 'Access log · this patient', 'd.fhir': 'FHIR R4 Bundle',
    'd.recorded': 'This view was recorded in the audit log.', 'd.closed': 'Encounter closed: {id} has left the emergency department, so the record is no longer live on this board.',
    'al.allergy': 'ALLERGY: {list}', 'al.unknown': 'Allergies UNKNOWN: ask patient/family', 'al.none': 'No known allergies',
    'al.anticoag': 'Anticoagulant', 'al.restricted': 'Restricted by patient',
    'k.identity': 'Identity', 'k.name': 'Name', 'k.enc': 'Encounter', 'k.pid': 'Patient ID', 'k.mrn': 'MRN', 'k.age': 'Age / sex',
    'k.blood': 'Blood type', 'k.arrival': 'Arrival', 'k.loc': 'Location', 'k.cond': 'Condition', 'k.res': 'Resources', 'k.triage': 'Triage',
    'k.aAge': 'Age', 'k.aTime': 'Time of injury', 'k.aMech': 'Mechanism', 'k.aInj': 'Injuries', 'k.aSigns': 'Signs', 'k.aTreat': 'Treatment',
    'idx.candidate': 'Confirm with the patient, a relative or documents. A candidate never merges charts.',
    'idx.confirmed': 'Identity confirmed; chart linked.', 'idx.temporary': 'Care continues on a temporary ID; identify later.',
    'h.none': 'No chronic conditions on the shared record', 'h.unknown': 'Unknown: identity not confirmed, shared record not queried', 'h.meds': 'Current medication',
    'sb.s': 'Situation', 'sb.b': 'Background', 'sb.a': 'Assessment', 'sb.r': 'Recommendation', 'sb.na': 'SBAR summary is not available in this build.',
    'o.drug': 'Medication', 'o.order': 'Order', 'o.na': 'Medication safety check is not available in this build.', 'o.pick': 'Choose a medication first.',
    'o.stop': 'HARD STOP', 'o.overrideLbl': 'Override reason (at least 10 characters)', 'o.overrideBtn': 'Override and order',
    'o.ok': 'Ordered: {drug}', 'o.okNote': 'No allergy or interaction conflict found.', 'o.warn': 'Ordered with warning: {drug}',
    'o.caution': 'Check before ordering: {drug}', 'o.confirm': 'Acknowledge and order', 'h.prealert': 'Not included in the pre-alert',
    't.prealertUpd': 'Pre-alert {enc} updated',
    'o.blocked': 'Not ordered: {drug}', 'o.overridden': 'Override recorded: {drug} ordered', 'o.overNote': 'The reason is in the audit trail.',
    'o.short': 'Enter a reason of at least 10 characters.', 'o.overFail': 'Override was not accepted.',
    'ac.none': 'No access recorded yet.',
    // Break-glass, family desk, standards, data map, toasts
    'bg.title': 'Restricted record', 'bg.warn': 'You are not in this patient’s care team',
    'bg.explain': 'Emergency access is allowed. Your reason is recorded in the audit log and reviewed.',
    'bg.reason': 'Reason for access (at least 10 characters)', 'bg.btn': 'Break glass', 'bg.cancel': 'Cancel',
    'fam.title': 'Family desk · reunification', 'fam.caption': 'No medical details are shown here.', 'fam.enc': 'Encounter', 'fam.initials': 'Initials',
    'fam.status': 'Status', 'fam.since': 'Since', 'fam.empty': 'No incident patients registered yet.', 'fam.na': 'The family board is not available in this build.',
    'std.title': 'Standards & security', 'std.s': 'Standard', 'std.a': 'Area', 'std.w': 'Where in this system', 'std.controls': 'Security controls implemented in this build',
    'dm.title': 'Data map · {n}/{m} sources live', 'dm.src': 'Source system', 'dm.std': 'Standard', 'dm.data': 'Data received', 'dm.shown': 'Shown in', 'dm.status': 'Status',
    't.prealert': 'Pre-alert {enc} received', 't.prealertBad': 'Pre-alert rejected: {err}', 't.prealertNA': 'Pre-alert receiver is not available in this build.',
    't.mciOn': 'MCI declared: major incident plan active', 't.mciOff': 'MCI stood down', 't.mciRole': 'Declaring an MCI needs Charge nurse or Physician sign-in. Attempt logged.',
    't.glass': 'Break-glass access granted. Reason logged.', 't.noChart': 'IT / Admin: no chart rights. Attempt logged.',
    't.wallBlocked': 'Wall display: no access to patient records. Attempt logged.', 't.recordClosed': 'Patient record closed: {role} has no access to it.',
    't.gone': 'That patient is no longer in the department.', 't.signedIn': 'Signed in as {role}', 't.roleNA': 'This role is not available in this build.',
    // v3: focus / calm views, responder sliders, routed elsewhere, dispatch incidents
    'view.focus': 'Focus', 'view.calm': 'Calm view',
    'view.tipFocus': 'Focus view: only pre-alerts, decisions, patients and beds. Press again for the full board.',
    'view.tipCalm': 'Calm wall view: journey, beds and inbound only. Press again for the full board.',
    'pa.sliders': 'Priority by responder sliders:', 'pa.noFlags': 'all sliders in normal range', 'pa.whyHere': 'Why here: {r}',
    'pa.live': 'LIVE', 'pa.liveTip': 'Updated by the responder in the last 20 seconds',
    'in.routed': 'Routed elsewhere', 'in.routedN': '{n} routed elsewhere', 'in.noBed': 'no bed reserved here',
    'j.unconfirmed': 'unconfirmed',
    'dec.more': '+{n} more in the full view', 'dec.showAll': 'Show all',
    't.routed': 'Pre-alert {enc} routed elsewhere: no bed reserved here',
    't.incident': 'Dispatch call {id} received: {name}', 't.incidentUpd': 'Dispatch call {id} updated',
    't.incidentClosed': 'Dispatch call {id} has already stood down', 't.incidentBad': 'Dispatch call rejected: {err}',
    't.incidentNA': 'Dispatch receiver is not available in this build.',
  },
  ar: {
    'app.title': 'لوحة قيادة الطوارئ', 'app.sub': 'لوحة قيادة الطوارئ · المستشفى العام التجريبي', 'app.sim': 'بيانات محاكاة',
    'hdr.simTime': 'وقت المحاكاة', 'hdr.speed': 'السرعة', 'hdr.role': 'الدور', 'hdr.pause': 'إيقاف مؤقت', 'hdr.resume': 'استئناف',
    'hdr.paused': 'متوقف', 'hdr.sim': 'محاكاة {n}×', 'hdr.normal': 'العمل اعتيادي',
    'hdr.diverting': 'تحويل سيارات إسعاف ESI 4–5 · متبقٍ {n} دقيقة',
    'theme.toLight': 'التبديل إلى الوضع الفاتح', 'theme.toDark': 'التبديل إلى الوضع الداكن',
    'role.wall': 'شاشة العرض', 'role.charge': 'الممرض المسؤول', 'role.nurse': 'ممرض (A. Haddad)', 'role.physician': 'الطبيب', 'role.admin': 'تقنية المعلومات / الإدارة',
    'tb.label': 'تشغيل سيناريو:', 'tb.pileup': 'تصادم على الطريق السريع', 'tb.fire': 'حريق مبنى', 'tb.staff': 'نقص الكوادر',
    'tb.equipment': 'عطل المعدات', 'tb.outage': 'انقطاع النظام', 'tb.reset': 'إعادة الضبط',
    'tb.mci': 'إعلان إصابات جماعية', 'tb.mciEnd': 'إنهاء الإصابات الجماعية', 'tb.prealert': 'محاكاة إنذار مسبق من المسعفين', 'tb.auto': 'قبول توزيع الأسرّة تلقائيًا',
    'mode.steady': 'مستقر', 'mode.strain': 'ضغط', 'mode.surge': 'ذروة', 'mode.mci': 'إصابات جماعية',
    'mode.title': 'وضع التشغيل', 'mode.since': 'منذ {time}', 'mode.calm': 'لا توجد مؤشرات ضغط',
    'p.inbound': 'القادمون · الإنذارات المسبقة', 'p.staff': 'طاقم التمريض', 'p.patients': 'المرضى · حسب الأولوية السريرية', 'p.beds': 'لوحة الأسرّة',
    'p.equip': 'المعدات والمستلزمات', 'p.dec': 'دعم القرار', 'p.feed': 'تدفق البيانات المباشر', 'p.audit': 'سجل التدقيق',
    'p.chart': 'إشغال أسرّة الطوارئ · آخر 60 دقيقة + التوقع',
    'ft.family': 'مكتب العائلات', 'ft.standards': 'المعايير والأمن', 'ft.datamap': 'خريطة البيانات', 'm.close': 'إغلاق',
    'w.or': ' أو ', 'w.anyRole': 'دور مخوّل', 'w.unknown': 'غير معروف', 'u.min': '{n} دقيقة',
    'ago.now': 'الآن', 'ago.min': 'قبل {n} دقيقة', 'sr.newCrit': 'قرار حرج جديد: ',
    'j.1': 'الرصد', 'j.2': 'المستجيبون الأوائل', 'j.3': 'في الطريق', 'j.4': 'الانتظار', 'j.5': 'قيد العلاج', 'j.6': 'قرار الخروج',
    'j.inc.1': 'حادث', 'j.inc.n': 'حوادث', 'j.mci': 'إعلان إصابات جماعية · {name}', 'j.mciNoInc': 'خطة المستشفى مفعّلة',
    'j.via': 'عبر {via}', 'j.noIncident': 'لا يوجد حادث نشط', 'j.walk': 'القادمون بأنفسهم: ~1 كل {n} دقيقة', 'j.surgeTag': ' (ذروة)',
    'j.unit.1': 'وحدة في الموقع', 'j.unit.n': 'وحدات في الموقع', 'j.tri.1': 'فرز ميداني: {n}', 'j.tri.n': 'فرز ميداني: {n}',
    'j.noScene': 'لا وحدات في الموقع', 'j.standby': 'الإسعاف في وضع الاستعداد',
    'j.pin.1': 'مريض قادم', 'j.pin.n': 'مرضى قادمون', 'j.amb.1': 'سيارات الإسعاف: {n}', 'j.amb.n': 'سيارات الإسعاف: {n}',
    'j.nextNow': 'الوصول التالي الآن', 'j.next': 'الوصول التالي خلال {n} دقيقة', 'j.diverted': 'محوّلة: {n}', 'j.noEnroute': 'لا سيارات إسعاف في الطريق',
    'j.waiting': 'ينتظرون', 'j.urgent': 'بالانتظار من فئة ESI 1–2: {n}', 'j.longest': 'أطول انتظار {n} دقيقة', 'j.noQueue': 'لا انتظار',
    'j.ofBeds': 'من {n} سريرًا', 'j.free.1': 'أسرّة شاغرة: {n}', 'j.free.n': 'أسرّة شاغرة: {n}', 'j.stale': ' (بيانات قديمة)', 'j.d2b': 'وسيط الوصول إلى السرير {v}',
    'j.done': 'منجز · آخر 60 دقيقة', 'j.dispo': 'منزل {a} · جناح {b} · عناية مركزة {c} · عمليات {d}', 'j.board': 'بانتظار النقل {a} · عناية مركزة شاغرة {b}',
    'in.none': 'لا قادمين', 'in.empty': 'لا توجد سيارات إسعاف قادمة.', 'in.emsLive': 'ربط الإسعاف متصل.', 'in.emsOff': 'ربط الإسعاف متوقف.',
    'in.pts.1': 'المرضى: {n}', 'in.pts.n': 'المرضى: {n}', 'in.ambs.1': 'سيارات الإسعاف: {n}', 'in.ambs.n': 'سيارات الإسعاف: {n}',
    'in.onscene': 'في الموقع', 'in.enroute': 'في الطريق', 'in.arriving': 'يصل الآن', 'in.eta': 'الوصول خلال {n} دقيقة', 'in.diverted': 'محوّلة',
    'in.div.1': 'المرضى: {n} (ESI 4–5) حُوّلوا إلى طوارئ قريبة', 'in.div.n': 'المرضى: {n} (ESI 4–5) حُوّلوا إلى طوارئ قريبة',
    'in.prepDone': '✓ حُجز {bed} · استُدعي الفريق', 'in.prepSugg': 'التجهيز مقترح — راجع قائمة القرارات',
    'st.red': 'أحمر', 'st.yellow': 'أصفر', 'st.green': 'أخضر', 'st.black': 'أسود',
    'id.candidate': 'مطابقة محتملة', 'id.confirmed': 'هوية مؤكدة', 'id.temporary': 'هوية مؤقتة',
    'idm.face': 'الوجه', 'idm.fingerprint': 'البصمة', 'idm.nfc': 'NFC', 'idm.emirates-id': 'الهوية الإماراتية',
    'sf.unknown': 'الحساسية: غير معروفة', 'sf.anticoag': 'مضاد تخثر', 'sf.restricted': 'مقيّد بطلب المريض',
    'staff.meta': 'في الخدمة {on} · متوسط العبء {load}% · مرهقون {tired} · 6 أطباء',
    'staff.orph.1': 'مرضى بلا ممرض مسؤول: {n}', 'staff.orph.n': 'مرضى بلا ممرض مسؤول: {n}',
    'pt.meta': 'ينتظرون {w} · قيد العلاج {c} · تنبيهات {f}', 'pt.secWait': 'بانتظار سرير · {n}', 'pt.secCare': 'قيد العلاج · {n}',
    'pt.emptyWait': 'لا أحد بانتظار سرير.', 'pt.emptyCare': 'لا يوجد مرضى قيد العلاج.', 'pt.unidentified': 'مجهول الهوية',
    'pt.retriaged': 'أُعيد فرزه', 'pt.open': 'فتح السجل.',
    'loc.waiting': 'ينتظر {n} دقيقة', 'loc.inbound': 'قادم', 'loc.board': '{bed} · بانتظار {what} {n} دقيقة', 'loc.noNurse': '⚠ بلا ممرض',
    'dispo.discharge': 'الخروج إلى المنزل', 'dispo.ward': 'سرير في الجناح', 'dispo.icu': 'سرير عناية مركزة', 'dispo.or': 'غرفة العمليات', 'dispo.transfer': 'النقل',
    'bed.meta': 'شاغرة {f}/{t} · تنظيف {c}', 'bed.staleMeta': 'الربط متوقف · لقطة من {time}', 'bed.backup': 'شاغرة {f}/{t} · عبر حساسات RTLS الاحتياطية',
    'bed.zone': '{zone} · شاغرة {f}/{t}', 'bed.stale': 'بيانات قديمة', 'bed.staleNote': ' · آخر تحديث {time} · الربط متوقف',
    'bt.free': 'شاغر', 'bt.hold': 'معلّق', 'bt.clean': 'تنظيف', 'bt.resv': 'محجوز',
    'lg.free': 'شاغر', 'lg.occ': 'مشغول', 'lg.clean': 'تنظيف', 'lg.resv': 'محجوز', 'lg.held': 'محجوز لاقتراح معلّق',
    'z.R': 'الإنعاش', 'z.T': 'الإصابات', 'z.A': 'الحالات الحادة', 'z.F': 'المسار السريع',
    'eq.monitors': 'أجهزة مراقبة القلب', 'eq.vents': 'أجهزة التنفس الاصطناعي', 'eq.ct': 'أجهزة التصوير المقطعي', 'eq.free': 'شاغرة {a}/{b}', 'eq.ventFree': 'شاغرة {a} من {b}',
    'eq.ctv': 'متصلة {on}/{tot} · الطابور {q}', 'eq.ctWait': ' · انتظار ~{n} دقيقة', 'eq.ctNone': ' · لا جهاز متصل',
    'eq.left': '{q} {unit} · يكفي ~{n} دقيقة', 'eq.stable': '{q} {unit} · مستقر', 'eq.ok': '✓ سليم', 'eq.low': '● منخفض', 'eq.crit': '▲ حرج',
    'eq.allOk': 'الكل ضمن الحدود', 'eq.att.1': 'عناصر تحتاج انتباهًا: {n}', 'eq.att.n': 'عناصر تحتاج انتباهًا: {n}',
    'sup.blood': 'دم O سالب', 'sup.burn': 'أطقم ضمادات الحروق', 'sup.o2': 'أسطوانات O₂ محمولة',
    'supu.blood': 'وحدة', 'supu.burn': 'طقم', 'supu.o2': 'أسطوانة',
    'dec.meta': 'معلّقة {n} · حرجة {c}', 'dec.upToDate': 'لا قرارات معلّقة', 'dec.auto': ' · القبول التلقائي مفعّل',
    'dec.acceptAll': 'قبول كل التوزيعات ({n})', 'dec.accept': 'قبول', 'dec.dismiss': 'تجاهل', 'dec.needs': 'يتطلب دخول {who}',
    'dec.empty': 'لا قرارات معلّقة. تحت المراقبة: المرضى {p} · الأسرّة {b} · مصادر البيانات {f}.',
    'dec.owner': 'المسؤول: {who}', 'dec.open': 'مفتوح منذ {t}', 'dec.escIn': 'يُصعَّد بعد {t}', 'dec.escNow': 'قيد التصعيد', 'dec.escalated': 'صُعِّد ×{n}',
    'lvl.1': 'حرج', 'lvl.2': 'مرتفع', 'lvl.3': 'روتيني',
    'sg.placement': 'توزيع سرير', 'sg.prearrival': 'تجهيز قبل الوصول', 'sg.retriage': 'إعادة فرز', 'sg.supply': 'المستلزمات',
    'sg.fatigue': 'الكوادر', 'sg.callin': 'الكوادر', 'sg.reassign': 'الكوادر', 'sg.capacity': 'السعة', 'sg.ct': 'المعدات', 'sg.vent': 'المعدات',
    'sg.needvent': 'المعدات', 'sg.outage': 'النظام', 'sg.identity': 'الهوية', 'sg.lwbs': 'الردهة', 'sg.surge': 'الذروة',
    'own.receiving-nurse': 'ممرض الاستقبال', 'own.charge-nurse': 'الممرض المسؤول', 'own.physician': 'الطبيب', 'own.ed-coordinator': 'منسق الطوارئ',
    'fd.restricted': 'مقيّد: سجّل الدخول بدور تقنية المعلومات / الإدارة لعرض سجل التدقيق.', 'fd.noAudit': 'لا توجد سجلات تدقيق بعد.',
    'fd.empty': 'بانتظار أول رسالة من بوابة التكامل.',
    'ch.none': '✓ لا تجاوز متوقع للسعة', 'ch.nowFull': '▲ السعة ممتلئة الآن', 'ch.full': 'امتلاء خلال ~{n} دقيقة', 'ch.legend': 'المتصل مسجّل · المتقطع متوقع',
    'ch.cap': 'سعة 100%', 'ch.now': 'الآن', 'ch.tipNow': 'الآن · إشغال {v}%', 'ch.tipPast': '{m} دقيقة · إشغال {v}%', 'ch.tipFc': '+{m} دقيقة (متوقع) · {v}%',
    'src.meta': 'مصادر البيانات المتصلة {n}/{m} · بوابة FHIR R4', 'src.offline': 'متوقف', 'src.backup': 'احتياطي',
    'd.identity': 'الهوية', 'd.field': 'التقرير الميداني · ATMIST', 'd.noField': 'حضر بنفسه: لا يوجد تقرير ما قبل المستشفى.',
    'd.vitals': 'العلامات الحيوية · NEWS2 {n}', 'd.trends': 'الاتجاهات · آخر 30 دقيقة', 'd.ai': 'دعم القرار السريري', 'd.history': 'التاريخ المرضي · السجل المشترك',
    'd.sbar': 'تسليم SBAR', 'd.order': 'طلب دواء', 'd.access': 'سجل الوصول · هذا المريض', 'd.fhir': 'حزمة FHIR R4',
    'd.recorded': 'سُجّل هذا العرض في سجل التدقيق.', 'd.closed': 'انتهت الزيارة: غادر {id} قسم الطوارئ، لذا لم يعد السجل مباشرًا على هذه اللوحة.',
    'al.allergy': 'حساسية: {list}', 'al.unknown': 'الحساسية غير معروفة: اسأل المريض أو العائلة', 'al.none': 'لا حساسية معروفة',
    'al.anticoag': 'مضاد تخثر', 'al.restricted': 'مقيّد بطلب المريض',
    'k.identity': 'الهوية', 'k.name': 'الاسم', 'k.enc': 'رقم الزيارة', 'k.pid': 'رقم المريض', 'k.mrn': 'رقم السجل الطبي', 'k.age': 'العمر / الجنس',
    'k.blood': 'فصيلة الدم', 'k.arrival': 'الوصول', 'k.loc': 'الموقع', 'k.cond': 'الحالة', 'k.res': 'الموارد', 'k.triage': 'الفرز',
    'k.aAge': 'العمر', 'k.aTime': 'وقت الإصابة', 'k.aMech': 'آلية الإصابة', 'k.aInj': 'الإصابات', 'k.aSigns': 'العلامات', 'k.aTreat': 'العلاج',
    'idx.candidate': 'تحقق مع المريض أو أحد الأقارب أو الوثائق. المطابقة المحتملة لا تدمج السجلات أبدًا.',
    'idx.confirmed': 'تم تأكيد الهوية وربط السجل.', 'idx.temporary': 'تستمر الرعاية بهوية مؤقتة، ويُحدَّد المريض لاحقًا.',
    'h.none': 'لا أمراض مزمنة في السجل المشترك', 'h.unknown': 'غير معروف: الهوية غير مؤكدة ولم يُستعلم عن السجل المشترك', 'h.meds': 'الأدوية الحالية',
    'sb.s': 'الوضع', 'sb.b': 'الخلفية', 'sb.a': 'التقييم', 'sb.r': 'التوصية', 'sb.na': 'ملخص SBAR غير متاح في هذا الإصدار.',
    'o.drug': 'الدواء', 'o.order': 'اطلب', 'o.na': 'فحص سلامة الدواء غير متاح في هذا الإصدار.', 'o.pick': 'اختر دواءً أولًا.',
    'o.stop': 'إيقاف إلزامي', 'o.overrideLbl': 'سبب التجاوز (10 أحرف على الأقل)', 'o.overrideBtn': 'تجاوز واطلب',
    'o.ok': 'تم الطلب: {drug}', 'o.okNote': 'لا تعارض مع الحساسية أو التداخلات الدوائية.', 'o.warn': 'تم الطلب مع تحذير: {drug}',
    'o.caution': 'تحقّق قبل الطلب: {drug}', 'o.confirm': 'إقرار وطلب', 'h.prealert': 'غير مضمّن في الإنذار المسبق',
    't.prealertUpd': 'حُدّث الإنذار المسبق {enc}',
    'o.blocked': 'لم يُطلب: {drug}', 'o.overridden': 'سُجّل التجاوز وطُلب {drug}', 'o.overNote': 'السبب محفوظ في سجل التدقيق.',
    'o.short': 'أدخل سببًا من 10 أحرف على الأقل.', 'o.overFail': 'لم يُقبل التجاوز.',
    'ac.none': 'لا يوجد وصول مسجّل بعد.',
    'bg.title': 'سجل مقيّد', 'bg.warn': 'لست ضمن فريق رعاية هذا المريض',
    'bg.explain': 'يُسمح بالوصول الطارئ، ويُسجَّل سببك في سجل التدقيق ويُراجَع.',
    'bg.reason': 'سبب الوصول (10 أحرف على الأقل)', 'bg.btn': 'وصول طارئ', 'bg.cancel': 'إلغاء',
    'fam.title': 'مكتب العائلات · لمّ الشمل', 'fam.caption': 'لا تُعرض هنا أي تفاصيل طبية.', 'fam.enc': 'رقم الزيارة', 'fam.initials': 'الأحرف الأولى',
    'fam.status': 'الحالة', 'fam.since': 'منذ', 'fam.empty': 'لا يوجد مرضى مسجّلون من الحادث بعد.', 'fam.na': 'لوحة العائلات غير متاحة في هذا الإصدار.',
    'fs.arriving': 'في الطريق', 'fs.waiting': 'في الانتظار', 'fs.in-treatment': 'قيد العلاج', 'fs.in-surgery': 'في الجراحة',
    'fs.icu': 'العناية المركزة', 'fs.admitted-to-ward': 'أُدخل إلى الجناح', 'fs.discharged': 'غادر المستشفى',
    'std.title': 'المعايير والأمن', 'std.s': 'المعيار', 'std.a': 'المجال', 'std.w': 'موضعه في النظام', 'std.controls': 'ضوابط الأمن المطبّقة في هذا الإصدار',
    'dm.title': 'خريطة البيانات · المصادر المتصلة {n}/{m}', 'dm.src': 'النظام المصدر', 'dm.std': 'المعيار', 'dm.data': 'البيانات الواردة', 'dm.shown': 'تظهر في', 'dm.status': 'الحالة',
    't.prealert': 'استُلم الإنذار المسبق {enc}', 't.prealertBad': 'رُفض الإنذار المسبق: {err}', 't.prealertNA': 'مستقبِل الإنذارات المسبقة غير متاح في هذا الإصدار.',
    't.mciOn': 'أُعلنت حالة الإصابات الجماعية: خطة الحوادث الكبرى مفعّلة', 't.mciOff': 'انتهت حالة الإصابات الجماعية',
    't.mciRole': 'إعلان الإصابات الجماعية يتطلب دخول الممرض المسؤول أو الطبيب. سُجّلت المحاولة.',
    't.glass': 'مُنح الوصول الطارئ وسُجّل السبب.', 't.noChart': 'تقنية المعلومات / الإدارة: لا صلاحية لفتح السجل الطبي. سُجّلت المحاولة.',
    't.wallBlocked': 'شاشة العرض: لا وصول إلى سجلات المرضى. سُجّلت المحاولة.', 't.recordClosed': 'أُغلق سجل المريض: لا صلاحية لدور {role}.',
    't.gone': 'لم يعد هذا المريض في القسم.', 't.signedIn': 'تم الدخول بدور {role}', 't.roleNA': 'هذا الدور غير متاح في هذا الإصدار.',
    'view.focus': 'تركيز', 'view.calm': 'عرض هادئ',
    'view.tipFocus': 'وضع التركيز: الإنذارات المسبقة والقرارات والمرضى والأسرّة فقط. اضغط مجددًا لعرض اللوحة كاملة.',
    'view.tipCalm': 'عرض هادئ لشاشة الحائط: المسار والأسرّة والقادمون فقط. اضغط مجددًا لعرض اللوحة كاملة.',
    'pa.sliders': 'الأولوية حسب مؤشرات المسعف:', 'pa.noFlags': 'كل المؤشرات ضمن المعدل الطبيعي', 'pa.whyHere': 'سبب التوجيه إلى هنا: {r}',
    'pa.live': 'مباشر', 'pa.liveTip': 'حدّثه المسعف خلال آخر 20 ثانية',
    'in.routed': 'وُجّه إلى مستشفى آخر', 'in.routedN': 'موجّهون إلى مستشفى آخر: {n}', 'in.noBed': 'لم يُحجز سرير هنا',
    'j.unconfirmed': 'غير مؤكد',
    'dec.more': '+{n} أخرى في العرض الكامل', 'dec.showAll': 'عرض الكل',
    't.routed': 'الإنذار المسبق {enc} وُجّه إلى مستشفى آخر: لم يُحجز سرير هنا',
    't.incident': 'استُلم بلاغ الإسعاف {id}: {name}', 't.incidentUpd': 'حُدّث بلاغ الإسعاف {id}',
    't.incidentClosed': 'بلاغ الإسعاف {id} أُغلق بالفعل', 't.incidentBad': 'رُفض بلاغ الإسعاف: {err}',
    't.incidentNA': 'مستقبِل بلاغات الإسعاف غير متاح في هذا الإصدار.',
  },
};
// Translate a static label; {name} placeholders are filled from vars. Unknown keys fall back to English, then the key.
function t(key, vars) {
  const dict = I18N[UI.lang] || I18N.en;
  let s = dict[key] != null ? dict[key] : I18N.en[key] != null ? I18N.en[key] : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}
// Singular/plural variant: key.1 or key.n, with {n} filled in
function tn(key, n, vars) { return t(key + (n === 1 ? '.1' : '.n'), Object.assign({ n }, vars)); }
// Translation only where the current language defines one; otherwise the engine's own English text
function tOr(key, fallback) {
  const dict = I18N[UI.lang];
  return dict && dict[key] != null ? dict[key] : fallback;
}
const uiSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------- UI state & constants ---------- */
const UI_LOCK_MS = 5 * 60 * 1000;      // automatic logoff for clinical roles
const UI_CHART_MS = 1500;              // occupancy chart redraw throttle
const UI_THEME_KEY = 'ercc.theme';
const UI_LANG_KEY = 'wasel.lang';      // only UI preferences are ever stored, never patient data
const UI_VIEW_KEY = 'wasel.view';      // 'focus' | 'full' for clinical roles; the wall display opens in its calm view
const UI_LIVE_MS = 20 * 1000;          // a pre-alert the responder updated this recently shows a LIVE dot
const UI_CAPACITY_MS = 5 * 1000;       // capacity broadcast to responders and dispatch (CHANNELS.md §3)
const UI_FOCUS_CARDS = 5;              // decision cards shown in the focus view
const UI_MINUS = '−';
const UI_REASON_MIN = 10;              // break-glass and override reasons
const UI_REASON_MAX = 200;
const UI_MCI_ROLES = ['charge', 'physician'];
const UI_SRC_BY_ID = Object.fromEntries(SOURCES.map(s => [s.id, s]));
// Mode → status colour + shape glyph, so the level never depends on colour alone (WCAG 1.4.1)
const UI_MODE = { steady: ['good', '●'], strain: ['warning', '◆'], surge: ['serious', '▲'], mci: ['critical', '■'] };
const UI_START = ['red', 'yellow', 'green', 'black'];
// Labels for v2 card types if core's SUGG_LABEL does not carry them yet
const UI_SUGG_FALLBACK = { identity: 'Identity', lwbs: 'Lobby', surge: 'Surge' };
const UI = {
  tab: 'feed', modal: null, lastFocus: null,
  lastTick: Date.now(), lastInput: Date.now(), lastPointer: 'mouse',
  theme: 'dark', lang: 'en', toastTimer: 0,
  chartAt: 0, chartW: 0, chartH: 0, geo: null, hoverPx: null,
  glass: new Set(),        // patient ids opened by break-glass in this sign-in
  order: null,             // {pid, drug, kind, reason}: last medication check in the drawer
  demoSeq: 0, channel: null,
  focus: false,            // focus view for clinical roles (persisted preference)
  wallFull: false,         // wall display showing the full board instead of its calm view (this sign-in only)
  live: new Map(),         // encounter id -> wall-clock ms of the responder's last update (LIVE dot)
  incChannel: null, capChannel: null, capMode: null,
};

/* ---------- Small helpers ---------- */
const nounCount = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const agoText = since => { const m = mins(S.t - since); return m < 1 ? t('ago.now') : t('ago.min', { n: m }); };
const fmtMS = sec => { const s = Math.max(0, Math.floor(sec)); return Math.floor(s / 60) + ':' + pad2(s % 60); };
const isActiveCare = p => p.stage === 'treatment' || p.stage === 'boarding';
const condInfo = p => COND[p.cond] || { label: String(p.cond), icd: '' };
const unitText = u => (u === 'mm[Hg]' ? 'mmHg' : u === 'Cel' ? '°C' : u);
const uiEnc = p => p.enc || p.id;
// Audit reference: patient id plus encounter, so the access log matches either
const uiRef = p => (p.enc && p.enc !== p.id ? p.id + ' (' + p.enc + ')' : p.id);
const uiMci = () => S.mode === 'mci' || !!S.mciDeclared;
const roleLabel = key => tOr('role.' + key, ROLES[key] ? ROLES[key].label : key);
const LEVEL_ICON = { critical: '▲', serious: '●', warning: '●', good: '✓', info: '●' };
const LEVEL_WORD = { critical: 'critical', serious: 'needs attention', warning: 'watch', good: 'normal' };

function chipHTML(level, text, size) {
  return html`<span class="chip${size ? ' ' + size : ''} ${level}">${text}</span>`;
}
function esiBadge(esi) {
  return html`<span class="esi e${esi}" title="ESI ${esi} · ${ESI_LABEL[esi]}"><b>${esi}</b><small>ESI</small></span>`;
}
function esiMini(esi) {
  return html`<span class="esi mini e${esi}">ESI ${esi}</span>`;
}
function approverLabels(type) {
  const keys = Object.keys(ROLES).filter(k => ROLES[k].act.includes(type));
  return keys.length ? keys.map(roleLabel).join(t('w.or')) : t('w.anyRole');
}
function uiSuggLabel(type) {
  return tOr('sg.' + type, SUGG_LABEL[type] || UI_SUGG_FALLBACK[type] || type);
}
// During a bed-feed outage (without backup sensors) the board shows the last snapshot, flagged stale.
function bedView() {
  const stale = S.bedsOffline && !S.bedsFallback && Array.isArray(S.bedsSnapshot);
  return { beds: stale ? S.bedsSnapshot : S.beds, stale };
}
function byPriority(list) {
  return list.map(p => [p, priority(p)]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
// Board layout: 'full' (every panel), 'focus' (what a clinician acts on) or 'calm' (read-only wall display)
function uiLayout() {
  if (prefs.role === 'wall') return UI.wallFull ? 'full' : 'calm';
  return UI.focus ? 'focus' : 'full';
}

/* ---------- Privacy: name & MRN masking by role (minimum necessary) ---------- */
function pname(p) {
  // A temporary ID means nobody knows the name yet; never show a guessed one
  if (p.identity && p.identity.status === 'temporary') return t('pt.unidentified');
  const mode = ROLES[prefs.role].names;
  if (mode === 'full') return p.first + ' ' + p.last;
  if (mode === 'partial') return p.first.charAt(0) + '. ' + p.last;
  return p.first.charAt(0) + '.' + p.last.charAt(0) + '.';
}
function pmrn(p) {
  return ROLES[prefs.role].detail ? String(p.mrn) : '•••' + String(p.mrn).slice(-4);
}

/* ---------- Care-team access (role detail: true | 'assigned' | false) ---------- */
function uiAssigned(p) {
  const r = ROLES[prefs.role];
  return !!r.nurseId && p.nurse === r.nurseId;
}
function canViewPatient(p) {
  const detail = ROLES[prefs.role].detail;
  if (detail === true) return true;
  if (detail === 'assigned') return uiAssigned(p) || UI.glass.has(p.id);
  return false;
}

/* ---------- Safety summary (allergies, anticoagulant) ----------
 * Missing, temporary-ID and patient-restricted summaries are all UNKNOWN,
 * which is never shown as "no allergies".                                  */
function safetyState(p) {
  const sf = p.safety || null;
  const restricted = !!(sf && sf.restricted);
  if (!sf || restricted || !Array.isArray(sf.allergies)) return { known: false, restricted, allergies: null, anticoag: false, sf };
  return { known: true, restricted: false, allergies: sf.allergies.map(String), anticoag: sf.anticoagulant === true, sf };
}
function safetySource(sf) {
  return sf && sf.source ? sf.source + (sf.asOf ? ' ' + sf.asOf : '') : '';
}

/* ---------- Toast & screen-reader announcements ---------- */
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  showEl(el, true);
  el.classList.add('show');
  clearTimeout(UI.toastTimer);
  UI.toastTimer = setTimeout(() => { el.classList.remove('show'); showEl(el, false); }, 3500);
}
function renderAnnouncements() {
  if (!Array.isArray(S.announce) || !S.announce.length) return;
  const msgs = S.announce.splice(0, S.announce.length);
  const sr = $('#sr');
  if (!sr) return;
  const shown = msgs.slice(-3);
  const text = t('sr.newCrit') + shown.join('. ') + (msgs.length > 3 ? '. +' + (msgs.length - 3) + '.' : '.');
  sr.textContent = '';
  setTimeout(() => { sr.textContent = text; }, 60);
}

/* ---------- Header: clock, banners, operating mode ---------- */
function renderMode() {
  const el = $('#mode');
  if (!el) return;
  const mode = UI_MODE[S.mode] ? S.mode : 'steady';
  const [level, glyph] = UI_MODE[mode];
  const cls = 'chip mode ' + level;
  if (el.className !== cls) el.className = cls;
  setText(el, glyph + ' ' + t('mode.' + mode));
  const since = mode !== 'steady' && S.modeSince != null ? ' · ' + t('mode.since', { time: fmtClock(S.modeSince) }) : '';
  const tip = t('mode.title') + ': ' + t('mode.' + mode) + ' · ' + (S.modeReason ? String(S.modeReason) : t('mode.calm')) + since;
  if (el.title !== tip) { el.title = tip; el.setAttribute('aria-label', tip); }
}
function renderHeader() {
  setText($('#clock'), fmtClock(S.t));
  setText($('#clockSub'), S.running ? t('hdr.sim', { n: S.speed }) : t('hdr.paused'));
  const items = S.banners.slice(-2).map(b => chipHTML(b.level, (b.level === 'critical' ? '▲ ' : '● ') + b.text));
  if (S.diversionUntil > S.t) {
    items.push(chipHTML('warning', '● ' + t('hdr.diverting', { n: mins(S.diversionUntil - S.t) })));
  }
  setHTML($('#banner'), items.length ? html`${items}` : chipHTML('good', '● ' + t('hdr.normal')));
  renderMode();
  const pb = $('#pause');
  if (pb) {
    setText(pb, S.running ? t('hdr.pause') : t('hdr.resume'));
    pb.setAttribute('aria-pressed', String(!S.running));
  }
  const mb = document.querySelector('[data-act="mci"]');
  if (mb) {
    setText(mb, S.mciDeclared ? '■ ' + t('tb.mciEnd') : t('tb.mci'));
    if (mb.getAttribute('aria-pressed') !== String(!!S.mciDeclared)) mb.setAttribute('aria-pressed', String(!!S.mciDeclared));
  }
}

/* ---------- Journey strip: detection → disposition ---------- */
function journeyTile(n, label, level, value, unit, subs) {
  return html`<div class="jt ${level}" role="group" aria-label="Step ${n}, ${label}: ${LEVEL_WORD[level]}"><div class="jl">${LEVEL_ICON[level]} ${n} · ${label}</div><div class="jv">${value}<span> ${unit}</span></div>${subs.filter(Boolean).map(s => html`<div class="js" dir="auto">${s}</div>`)}</div>`;
}
function renderJourney() {
  const now = S.t, pts = S.patients;

  // 1 Detection (in MCI mode the first line names the declared incident)
  const inc = S.incidents[S.incidents.length - 1];
  const mci = uiMci();
  const boost = S.walkBoost && now < S.walkBoost.until ? S.walkBoost.rate : 0;
  const every = 1 / (1 / 7 + boost);
  const walk = t('j.walk', { n: every >= 2 ? Math.round(every) : every.toFixed(1) }) + (boost ? t('j.surgeTag') : '');
  // A dispatch call stays "unconfirmed" until the first crew reaches the scene
  const incName = inc ? inc.name + (inc.unconfirmed ? ' (' + t('j.unconfirmed') + ')' : '') : '';
  let subs1;
  if (mci) subs1 = [t('j.mci', { name: inc ? incName : t('j.mciNoInc') }), inc ? inc.place + ' · ' + t('j.via', { via: inc.via }) : walk];
  else if (inc) subs1 = [incName + ' · ' + inc.place, t('j.via', { via: inc.via })];
  else subs1 = [t('j.noIncident'), walk];
  const t1 = journeyTile(1, t('j.1'), inc || mci ? 'critical' : 'good', S.incidents.length, tn('j.inc', S.incidents.length), subs1);

  // 2 First responders (START colours in MCI mode, ESI otherwise)
  const onScene = S.ambulances.filter(a => a.status === 'onscene');
  const scenePts = onScene.flatMap(a => a.pts.map(P).filter(Boolean));
  const esiMix = [1, 2, 3, 4, 5].map(e => [e, scenePts.filter(p => p.esi === e).length]).filter(x => x[1] > 0)
    .map(([e, k]) => k + '× ESI ' + e).join(' · ');
  const startMix = UI_START.map(c => [c, scenePts.filter(p => p.start === c).length]).filter(x => x[1] > 0)
    .map(([c, k]) => k + ' ' + t('st.' + c)).join(' · ');
  const t2 = journeyTile(2, t('j.2'),
    scenePts.some(p => p.esi === 1) ? 'critical' : onScene.length ? 'serious' : 'good',
    onScene.length, tn('j.unit', onScene.length),
    onScene.length ? [tn('j.tri', scenePts.length), mci && startMix ? startMix : esiMix] : [t('j.noScene'), t('j.standby')]);

  // 3 En route
  const enroute = S.ambulances.filter(a => a.status === 'enroute');
  const enPts = enroute.reduce((s, a) => s + a.pts.length, 0);
  const nextEta = enroute.length ? Math.min(...enroute.map(a => a.eta)) : null;
  const diverted = S.ambulances.filter(a => a.status === 'diverted').length;
  const nextMin = nextEta == null ? null : mins(nextEta - now);
  const divText = diverted ? t('j.diverted', { n: diverted }) : '';
  const t3 = journeyTile(3, t('j.3'),
    enroute.some(a => ambEsi(a) <= 2) ? 'serious' : enroute.length ? 'warning' : 'good',
    enPts, tn('j.pin', enPts),
    enroute.length
      ? [tn('j.amb', enroute.length), nextMin < 1 ? t('j.nextNow') : t('j.next', { n: nextMin }), divText]
      : [t('j.noEnroute'), divText]);

  // 4 Waiting
  const waiting = pts.filter(p => p.stage === 'waiting');
  const urgent = waiting.filter(p => p.esi <= 2).length;
  const longest = waiting.length ? Math.max(...waiting.map(p => mins(now - p.arrivedAt))) : 0;
  const t4 = journeyTile(4, t('j.4'),
    urgent ? 'critical' : waiting.length > 5 ? 'serious' : waiting.length ? 'warning' : 'good',
    waiting.length, t('j.waiting'),
    [t('j.urgent', { n: urgent }), waiting.length ? t('j.longest', { n: longest }) : t('j.noQueue')]);

  // 5 In treatment
  const inCare = pts.filter(isActiveCare).length;
  const { beds, stale } = bedView();
  const free = beds.filter(b => b.status === 'free').length;
  const d2b = median(S.d2b.filter(d => d.t >= now - 3600).map(d => d.m));
  const t5 = journeyTile(5, t('j.5'),
    free === 0 ? 'critical' : free <= 3 ? 'serious' : free <= 6 ? 'warning' : 'good',
    inCare, t('j.ofBeds', { n: S.beds.length }),
    [tn('j.free', free) + (stale ? t('j.stale') : ''), t('j.d2b', { v: d2b == null ? '—' : t('u.min', { n: Math.round(d2b) }) })]);

  // 6 Disposition
  const recent = S.done.filter(d => d.t >= now - 3600);
  const cnt = k => recent.filter(d => d.dispo === k).length;
  const boarding = pts.filter(p => p.stage === 'boarding').length;
  const icuFree = Math.max(0, S.icu.cap - S.icu.used);
  const t6 = journeyTile(6, t('j.6'),
    icuFree === 0 && boarding ? 'critical' : boarding > 3 ? 'serious' : boarding ? 'warning' : 'good',
    recent.length, t('j.done'),
    [t('j.dispo', { a: cnt('discharge'), b: cnt('ward'), c: cnt('icu'), d: cnt('or') }), t('j.board', { a: boarding, b: icuFree })]);

  setHTML($('#journey'), html`${[t1, t2, t3, t4, t5, t6]}`);
}

/* ---------- Inbound: ambulances carrying pre-alert cards ---------- */
// START colour (field triage) applies in MCI mode only; empty otherwise
function startChip(p) {
  if (!uiMci() || !UI_START.includes(p.start)) return '';
  return html`<span class="chip sm st-${p.start}" title="START triage">${t('st.' + p.start)}</span>`;
}
function priorityChip(p) {
  return startChip(p) || esiMini(p.esi);
}
function identityChip(p) {
  const id = p.identity;
  if (!id || !id.status) return '';
  const method = id.method && id.method !== 'none' ? tOr('idm.' + id.method, I18N.en['idm.' + id.method] || id.method) : '';
  if (id.status === 'candidate') {
    const conf = typeof id.confidence === 'number' ? Math.round(id.confidence * 100) + '%' : '';
    const how = [method, conf].filter(Boolean).join(' ');
    return html`<span class="chip sm warning" title="${t('idx.candidate')}">◆ ${t('id.candidate')}${how ? ' · ' + how : ''}</span>`;
  }
  if (id.status === 'confirmed') return html`<span class="chip sm good">✓ ${t('id.confirmed')}${method ? ' · ' + method : ''}</span>`;
  return html`<span class="chip sm" title="${t('idx.temporary')}">○ ${t('id.temporary')}</span>`;
}
function safetyChips(p) {
  const st = safetyState(p), out = [];
  if (!st.known) {
    out.push(html`<span class="chip sm warning">? ${t('sf.unknown')}${st.restricted ? ' · ' + t('sf.restricted') : ''}</span>`);
  } else if (st.allergies.length) {
    out.push(html`<span class="chip sm critical" title="${safetySource(st.sf)}">⚠ ${st.allergies.join(', ')}</span>`);
  }
  if (st.known && st.anticoag) out.push(html`<span class="chip sm serious">● ${t('sf.anticoag')}</span>`);
  return out;
}
// Strip a trailing speed estimate ("at ~100 km/h") so the one-liner stays readable
const uiShortMech = m => String(m || '').replace(/\s*(at\s*)?~?\s*\d+\s*km\/h\s*$/i, '').trim();
const uiLowerFirst = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
function atmistSigns(a, p) {
  const sg = (a && a.signs) || {};
  const v = (k, fallback) => (typeof sg[k] === 'number' ? r0(sg[k]) : fallback);
  const parts = [['HR', v('hr', r0(p.v.hr))], ['BP', v('sbp', r0(p.v.sbp))], ['SpO₂', v('spo2', r0(p.v.spo2))]];
  if (typeof sg.gcs === 'number') parts.push(['GCS', sg.gcs]);
  return parts.map(([k, x]) => k + ' ' + x).join(' ');
}
// "45y · driver, frontal collision · HR 124 BP 96 SpO₂ 92 GCS 14 · pelvic binder"
function atmistLine(p) {
  const a = p.atmist;
  if (!a) return '';
  const age = a.age != null && a.age !== '' ? a.age : p.age;
  const treat = String(a.treatment || '').split(',')[0].trim();
  return [age != null ? age + 'y' : '', uiLowerFirst(uiShortMech(a.mechanism)), atmistSigns(a, p), uiLowerFirst(treat)].filter(Boolean).join(' · ');
}
function atmistFull(p) {
  const a = p.atmist;
  if (!a) return condInfo(p).label;
  return [a.mechanism, a.injuries, atmistSigns(a, p), a.treatment].filter(Boolean).join(' · ');
}
// "● LIVE" while the responder app updated this pre-alert in the last 20 s (text + colour)
function liveDot(enc) {
  const at = UI.live.get(enc);
  if (!at || Date.now() - at >= UI_LIVE_MS) return '';
  return html`<span class="live" title="${t('pa.liveTip')}"><i aria-hidden="true"></i>${t('pa.live')}</span>`;
}
// The responder's own priority ({system, level}) as text + status colour, e.g. RED or ESI 2
function fieldPriorityText(fp) {
  if (!fp) return '';
  const START_LVL = { red: 'critical', yellow: 'warning', green: 'good', black: 'muted' };
  const ESI_LVL = { 1: 'critical', 2: 'serious', 3: 'warning', 4: 'good', 5: 'muted' };
  if (fp.system === 'START' && START_LVL[fp.level]) return html`<b class="tx-${START_LVL[fp.level]}">${t('st.' + fp.level)}</b>`;
  if (fp.system === 'ESI' && ESI_LVL[fp.level]) return html`<b class="tx-${ESI_LVL[fp.level]}">ESI ${fp.level}</b>`;
  return '';
}
// "Priority by responder sliders: RED · responds to voice only · breathing laboured · …" (sliders sent only)
function slidersLine(fp, triage) {
  const label = fieldPriorityText(fp);
  if (!label || !triage) return '';
  const why = uiCall('triageWhy', triage);
  const reasons = Array.isArray(why) && why.length ? why.slice(0, 3).join(' · ') : t('pa.noFlags');
  return html`<span class="pa-why" dir="auto">${t('pa.sliders')} ${label} · ${reasons}</span>`;
}
// Brief view (wall display, IT): encounter id + priority only; ETA sits on the ambulance row.
function preAlertRow(p, brief) {
  const enc = uiEnc(p);
  if (brief) return html`<span class="pa">${priorityChip(p)} <b>${enc}</b>${liveDot(enc)}</span>`;
  const flags = safetyChips(p);
  const line = atmistLine(p) || condInfo(p).label;
  const dest = p.destination && p.destination.reason ? html`<span class="pa-dest" dir="auto">${t('pa.whyHere', { r: p.destination.reason })}</span>` : '';
  return html`<button type="button" class="pa" data-act="patient" data-id="${p.id}" aria-label="${enc}, ${atmistFull(p)}. ${t('pt.open')}"><span class="pa-top">${priorityChip(p)}<b>${enc}</b>${identityChip(p)}${liveDot(enc)}</span>${slidersLine(p.fieldPriority, p.triage)}${dest}<span class="pa-line" dir="auto" title="${atmistFull(p)}">${line}</span>${flags.length ? html`<span class="pa-flags">${flags}</span>` : ''}</button>`;
}
// Pre-alert the responder routed to another hospital: shown for awareness, nothing is reserved here
function routedCard(r, brief) {
  const dest = r.destination || {};
  const etaMin = mins(r.eta - S.t);
  const to = html`<div class="pa-dest" dir="auto">→ ${dest.hospital}${!brief && dest.reason ? ' · ' + dest.reason : ''}</div>`;
  return html`<div class="amb routed"><div class="amb-top"><b>${r.encounter}</b>${liveDot(r.encounter)}<span class="muted">○ ${t('in.routed')} · ${t('in.noBed')}</span><span class="eta">${etaMin < 1 ? t('in.arriving') : t('in.eta', { n: etaMin })}</span></div>${to}${brief ? '' : slidersLine(r.priority, r.triage)}</div>`;
}
function ambCard(a, brief) {
  const inc = S.incidents.find(i => i.id === a.incident);
  if (a.status === 'diverted') {
    return html`<div class="amb diverted"><div class="amb-top"><b>${a.id}</b><span class="muted">${inc ? inc.id : ''}</span><span class="eta">${t('in.diverted')}</span></div><div class="amb-prep">${tn('in.div', a.pts.length)} · ${agoText(a.divertedAt)}</div></div>`;
  }
  const start = a.dispatchedAt != null ? a.dispatchedAt : S.t;
  const span = Math.max(1, a.eta - start);
  const progress = clamp((S.t - start) / span * 100, 0, 100);
  const etaMin = mins(a.eta - S.t);
  const state = a.status === 'onscene' ? t('in.onscene') : t('in.enroute');
  const pts = a.pts.map(P).filter(Boolean).sort((x, y) => x.esi - y.esi);
  let prep = '';
  if (!brief && a.prepared) {
    const pb = bed(a.prepBed);
    const where = (pb ? tOr('z.' + pb.zone, zoneName(pb.zone)) + ' ' : '') + a.prepBed;
    prep = html`<div class="amb-prep good">${t('in.prepDone', { bed: where, team: a.team || 'resus team' })}</div>`;
  } else if (!brief && S.sugg.some(s => s.type === 'prearrival' && s.amb === a.id)) {
    prep = html`<div class="amb-prep muted">${t('in.prepSugg')}</div>`;
  }
  return html`<div class="amb"><div class="amb-top"><b>${a.id}</b><span class="muted">${state}${inc ? ' · ' + inc.id : ''}</span><span class="eta">${etaMin < 1 ? t('in.arriving') : t('in.eta', { n: etaMin })}</span></div><div class="bar" aria-hidden="true"><i style="width:${Math.round(progress)}%"></i></div><div class="pas${brief ? ' brief' : ''}">${pts.map(p => preAlertRow(p, brief))}</div>${prep}</div>`;
}
function renderInbound() {
  // A pre-alert rerouted by the responder shows once, as its routed-elsewhere card
  const list = S.ambulances.filter(a => a.status !== 'arrived' && !a.routedTo)
    .sort((a, b) => (a.status === 'diverted') - (b.status === 'diverted') || a.eta - b.eta);
  const active = list.filter(a => a.status !== 'diverted');
  const routed = (uiCall('routedAway') || []).slice().sort((a, b) => a.eta - b.eta);
  const nPts = active.reduce((s, a) => s + a.pts.length, 0);
  const meta = active.length ? tn('in.pts', nPts) + ' · ' + tn('in.ambs', active.length) : t('in.none');
  setText($('#inboundMeta'), meta + (routed.length ? ' · ' + t('in.routedN', { n: routed.length }) : ''));
  const emsLive = S.src.ems && S.src.ems.status === 'live';
  const brief = !ROLES[prefs.role].detail;   // wall display and IT: no clinical detail
  for (const [enc, at] of UI.live) if (Date.now() - at >= UI_LIVE_MS) UI.live.delete(enc);
  setHTML($('#inbound'), list.length || routed.length
    ? html`${list.map(a => ambCard(a, brief))}${routed.map(r => routedCard(r, brief))}`
    : html`<p class="empty">${t('in.empty')} ${emsLive ? t('in.emsLive') : t('in.emsOff')}</p>`);
}

/* ---------- Staff (nurse workload & fatigue) ---------- */
function nurseRow(n) {
  const load = nurseLoad(n), loadPct = Math.round(load * 100);
  const k = S.patients.filter(x => x.nurse === n.id && isActiveCare(x)).length;
  const cls = load > 1 ? 'critical' : load > 0.85 ? 'warning' : 'good';
  const fat = fatigueLevel(n);
  const hrs = n.hours.toFixed(1) + ' h';
  let hours = hrs;
  if (n.status === 'on' && fat === 'over') hours = html`<span class="chip sm critical" title="Over 12 h on shift: fatigue risk">▲ ${hrs}</span>`;
  else if (n.status === 'on' && fat === 'tired') hours = html`<span class="chip sm warning" title="Over 10 h on shift">● ${hrs}</span>`;
  let note = '';
  if (n.status === 'incoming') {
    const covered = n.covers ? nurse(n.covers) : null;
    note = 'incoming · ETA ' + mins(n.arriveAt - S.t) + ' min' + (covered ? ' · relieves ' + covered.name : '');
  } else if (n.status === 'off') {
    note = 'off · ' + (n.offReason || 'off shift');
  } else if (n.handover) {
    const cover = S.nurses.find(x => x.covers === n.id && x.status === 'incoming');
    note = 'handover pending' + (cover ? ' → ' + cover.name : '');
  } else if (fat === 'over') {
    note = 'over 12 h on shift';
  } else if (fat === 'tired') {
    note = 'over 10 h on shift';
  }
  return html`<div class="nurse${n.status === 'on' ? '' : ' muted'}"><span class="nn">${n.name}${note ? html`<small> · ${note}</small>` : ''}</span><span class="nh">${hours}</span><span class="nbar" aria-hidden="true"><i class="${cls}" style="width:${Math.min(100, loadPct)}%"></i></span><span class="nl">${loadPct}%${load > 1 ? ' ▲' : ''} · ${nounCount(k, 'pt')}</span></div>`;
}
function renderStaff() {
  const now = S.t;
  const on = S.nurses.filter(n => n.status === 'on');
  const active = on.filter(n => !n.handover);
  const avg = active.length ? active.reduce((s, n) => s + nurseLoad(n), 0) / active.length : 0;
  const tired = on.filter(n => fatigueLevel(n) !== 'ok').length;
  setText($('#staffMeta'), t('staff.meta', { on: on.length, load: Math.round(avg * 100), tired }));
  const list = S.nurses
    .filter(n => n.status !== 'off' || now - (n.offAt || 0) <= 1800)
    .map(n => [n, nurseLoad(n)])
    .sort((a, b) => b[1] - a[1] || b[0].hours - a[0].hours)
    .map(x => x[0]);
  const orph = orphans();
  const alert = orph.length
    ? html`<p class="chip critical">▲ ${tn('staff.orph', orph.length)}</p>`
    : '';
  setHTML($('#staff'), html`${alert}${list.map(nurseRow)}`);
}

/* ---------- Patients ---------- */
function vitalsHTML(p) {
  const hr = r0(p.v.hr), sbp = r0(p.v.sbp), spo2 = r0(p.v.spo2), rr = r0(p.v.rr);
  const items = [
    ['HR', hr, '', hr > 110 ? '▲' : hr < 50 ? '▼' : ''],
    ['SBP', sbp, '', sbp <= 100 ? '▼' : sbp >= 200 ? '▲' : ''],
    ['SpO₂', spo2, '%', spo2 <= 93 ? '▼' : ''],
    ['RR', rr, '', rr >= 25 ? '▲' : rr <= 8 ? '▼' : ''],
  ];
  return html`${items.map(([k, val, u, arrow]) => arrow
    ? html`<b class="abn">${k} ${val}${u}${arrow}</b> `
    : html`<span>${k} ${val}${u}</span> `)}`;
}
function locationText(p) {
  if (p.stage === 'waiting') return t('loc.waiting', { n: mins(S.t - p.arrivedAt) });
  if (p.stage === 'inbound') return t('loc.inbound') + (p.amb ? ' · ' + p.amb : '');
  if (p.stage === 'boarding') {
    const what = t('dispo.' + (DISPO_LABEL[p.dispo] ? p.dispo : 'transfer'));
    return t('loc.board', { bed: p.bed, what, n: mins(S.t - p.boardSince) });
  }
  const n = p.nurse ? nurse(p.nurse) : null;
  return p.bed + ' · ' + (n && n.status === 'on' ? n.name : t('loc.noNurse'));
}
function trendText(trend) {
  return trend > 0 ? ' ↑' + trend : trend < 0 ? ' ↓' + (-trend) : '';
}
function patientRow(p) {
  const c = condInfo(p), f = p.flag;
  const news = p.news != null ? p.news : news2(p.v, p.onO2);
  const newsCls = news >= 7 ? ' critical' : news >= 5 ? ' serious' : '';
  const loc = locationText(p);
  const enc = p.enc && p.enc !== p.id ? p.enc + ' · ' : '';   // EMS patients carry a field encounter id
  const label = pname(p) + ', ' + enc + p.id + ', ESI ' + p.esi + ', ' + c.label + ', NEWS2 ' + news +
    (p.trend > 0 ? ' rising' : p.trend < 0 ? ' falling' : '') + ', ' + loc +
    (f ? ', alert: ' + f.text : '') + '. ' + t('pt.open');
  return html`<button type="button" class="prow${f ? ' f-' + f.level : ''}" data-act="patient" data-id="${p.id}" aria-label="${label}">${esiBadge(p.esi)}<span class="pid"><b>${pname(p)}</b> <small>${enc}${p.id} · ${p.age} ${p.sex}${p.retriaged ? ' · ' + t('pt.retriaged') : ''}</small></span><span class="pcond">${c.label} <small>ICD-10-CM ${c.icd}</small></span><span class="pvit">${vitalsHTML(p)}</span><span class="pnews${newsCls}">NEWS2 ${news}${trendText(p.trend)}</span><span class="ploc">${loc}</span>${f ? html`<span class="pflag" dir="auto">${f.level === 'critical' ? '▲' : '●'} ${f.text}${f.hint ? ' · ' + f.hint : ''}</span>` : ''}</button>`;
}
function renderPatients() {
  const waiting = byPriority(S.patients.filter(p => p.stage === 'waiting'));
  const inCare = byPriority(S.patients.filter(isActiveCare));
  const flagged = waiting.concat(inCare).filter(p => p.flag).length;
  setText($('#patientsMeta'), t('pt.meta', { w: waiting.length, c: inCare.length, f: flagged }));
  setHTML($('#patients'), html`<div class="sect" role="heading" aria-level="3">${t('pt.secWait', { n: waiting.length })}</div>${waiting.length ? waiting.map(patientRow) : html`<p class="empty">${t('pt.emptyWait')}</p>`}<div class="sect" role="heading" aria-level="3">${t('pt.secCare', { n: inCare.length })}</div>${inCare.length ? inCare.map(patientRow) : html`<p class="empty">${t('pt.emptyCare')}</p>`}`);
}

/* ---------- Bed board ---------- */
function bedTile(b) {
  let cls = 's-' + b.status, sub = '', tip = b.id + ' · ' + b.status;
  if (b.status === 'occupied') {
    const p = P(b.pid);
    sub = p ? 'ESI ' + p.esi : 'occ';
    if (p) { cls += ' e' + p.esi; tip += ' · ' + p.id; }
  } else if (b.status === 'free') {
    sub = b.hold ? t('bt.hold') : t('bt.free');
    if (b.hold) { cls += ' held'; tip += ' · held for suggestion ' + b.hold; }
  } else if (b.status === 'cleaning') {
    sub = t('bt.clean');
  } else {
    sub = t('bt.resv');
    if (b.pid) tip += ' · ' + b.pid;
  }
  return html`<div class="bed ${cls}" title="${tip}"><b>${b.id}</b><small>${sub}</small></div>`;
}
function renderBeds() {
  const { beds, stale } = bedView();
  const free = beds.filter(b => b.status === 'free').length;
  const cleaning = beds.filter(b => b.status === 'cleaning').length;
  let meta = t('bed.meta', { f: free, t: beds.length, c: cleaning });
  if (stale) meta = t('bed.staleMeta', { time: fmtClock(S.bedsSnapAt) });
  else if (S.bedsOffline && S.bedsFallback) meta = t('bed.backup', { f: free, t: beds.length });
  setText($('#bedsMeta'), meta);
  const zones = ZONES.map(z => {
    const zb = beds.filter(b => b.zone === z.id);
    const zf = zb.filter(b => b.status === 'free').length;
    return html`<div class="zone"><div class="zh">${t('bed.zone', { zone: tOr('z.' + z.id, z.name), f: zf, t: zb.length })}</div><div class="beds">${zb.map(bedTile)}</div></div>`;
  });
  const overlay = stale
    ? html`<div class="stale" role="status"><b>${t('bed.stale')}</b>${t('bed.staleNote', { time: fmtClock(S.bedsSnapAt) })}</div>`
    : '';
  const legend = [['s-free', 'lg.free'], ['s-occupied', 'lg.occ'], ['s-cleaning', 'lg.clean'], ['s-reserved', 'lg.resv'], ['held', 'lg.held']];
  setHTML($('#beds'), html`<div class="bedwrap">${zones}${overlay}</div><div class="legend">${legend.map(([c, k]) => html`<span><i class="sw ${c}" aria-hidden="true"></i> ${t(k)}</span> `)}</div>`);
}

/* ---------- Equipment & supplies (bars show what is LEFT) ---------- */
function eqRow(label, value, frac, level, note, status) {
  return html`<div class="eq"><div class="eq-top"><span>${label}</span><span class="eq-v">${value}${status ? html` ${status}` : ''}</span></div><div class="bar ${level}" aria-hidden="true"><i style="width:${Math.round(clamp(frac, 0, 1) * 100)}%"></i></div>${note ? html`<div class="eq-note">${note}</div>` : ''}</div>`;
}
const fracLevel = f => (f > 0.3 ? 'good' : f > 0.1 ? 'warning' : 'critical');
function renderEquipment() {
  const rows = [];
  let alerts = 0;

  const mf = monitorsFree(), mt = S.eq.monitors;
  const mLvl = fracLevel(mf / Math.max(1, mt));
  if (mLvl !== 'good') alerts++;
  rows.push(eqRow(t('eq.monitors'), t('eq.free', { a: mf, b: mt }), mf / Math.max(1, mt), mLvl, ''));

  const vAvail = Math.max(0, S.eq.vents - S.eq.ventFaulty), vf = ventsFree();
  const needV = S.patients.filter(p => p.needsVent && !p.vent).length;
  const ids = [];
  for (let i = 1; i <= S.eq.vents; i++) if (!(S.eq.ventFaulty && (i === 3 || i === 8))) ids.push(i);
  const nearest = ids.length ? 'V-' + pad2(ids[Math.min(ids.length - 1, ventsInUse())]) : '';
  const vNotes = [];
  if (S.eq.ventFaulty) vNotes.push(S.eq.ventFaulty + ' failed self-test' + (S.ventLoan ? ' · loan from anaesthesia on the way' : ''));
  if (needV) vNotes.push('▲ ' + nounCount(needV, 'patient') + ' waiting for a ventilator');
  vNotes.push(vf ? 'nearest free ' + nearest + ' · ICU store (RTLS)' : 'none free');
  const vLvl = needV ? 'critical' : fracLevel(vf / Math.max(1, vAvail));
  if (vLvl !== 'good' || S.eq.ventFaulty) alerts++;
  rows.push(eqRow(t('eq.vents'), t('eq.ventFree', { a: vf, b: vAvail }), vf / Math.max(1, vAvail), vLvl, vNotes.join(' · ')));

  const ctTot = S.eq.ct.length, ctOn = ctOnline(), queue = S.eq.ctQueue.length, wait = ctWait();
  const ctLvl = ctOn === ctTot ? (wait != null && wait > 20 ? 'warning' : 'good') : ctOn ? 'warning' : 'critical';
  if (ctLvl !== 'good') alerts++;
  const offline = S.eq.ct.filter(u => !u.online).map(u => u.id + ' (' + u.loc + ') offline');
  const ctNote = offline.length ? offline.join(' · ') + (S.ctRepair ? ' · engineer on site' : '') : '';
  rows.push(eqRow(t('eq.ct'), t('eq.ctv', { on: ctOn, tot: ctTot, q: queue }) + (wait != null ? t('eq.ctWait', { n: wait }) : t('eq.ctNone')),
    ctOn / Math.max(1, ctTot), ctLvl, ctNote));

  for (const key of Object.keys(S.sup)) {
    const sp = S.sup[key], left = minutesLeft(key), need = committed(key);
    const crit = sp.qty <= sp.cap * 0.1 || (left != null && left < 20) || need > sp.qty;
    const low = !crit && (sp.qty <= sp.cap * 0.25 || (left != null && left < 45));
    if (crit || low) alerts++;
    const status = crit ? chipHTML('critical', t('eq.crit'), 'sm') : low ? chipHTML('warning', t('eq.low'), 'sm') : chipHTML('good', t('eq.ok'), 'sm');
    const notes = [];
    if (sp.pending) notes.push('Restock ordered · arrives within 15 min');
    if (need > 0) notes.push('Waiting + inbound patients likely need ~' + need);
    const unit = tOr('supu.' + key, sp.unit);
    rows.push(eqRow(tOr('sup.' + key, sp.label), left == null ? t('eq.stable', { q: sp.qty, unit }) : t('eq.left', { q: sp.qty, unit, n: left }),
      sp.qty / Math.max(1, sp.cap), crit ? 'critical' : low ? 'warning' : 'good', notes.join(' · '), status));
  }
  setText($('#equipMeta'), alerts ? tn('eq.att', alerts) : t('eq.allOk'));
  setHTML($('#equipment'), html`${rows}`);
}

/* ---------- AI decision queue ---------- */
// Owner, open clock (m:ss) and escalation countdown; v1 suggestions without an owner show their age.
function decisionClock(s) {
  if (!s.owner) return html`<span class="cclock">${agoText(s.at)}</span>`;
  const owner = t('dec.owner', { who: tOr('own.' + uiSlug(s.owner), s.owner) });
  const open = t('dec.open', { t: fmtMS(S.t - s.at) });
  let due = '', soon = false;
  if (typeof s.escalatesAt === 'number') {
    const left = s.escalatesAt - S.t;
    due = left > 0 ? t('dec.escIn', { t: fmtMS(left) }) : t('dec.escNow');
    soon = left <= 60;
  }
  return html`<span class="cclock${soon ? ' soon' : ''}">${[owner, open, due].filter(Boolean).join(' · ')}</span>`;
}
function decisionCard(s) {
  const lvl = s.level === 1 ? 'critical' : s.level === 2 ? 'serious' : 'info';
  const actions = canAct(s.type)
    ? html`<button type="button" class="btn primary sm" data-act="accept" data-id="${s.id}" aria-label="${t('dec.accept')}: ${s.title}">${t('dec.accept')}</button><button type="button" class="btn ghost sm" data-act="dismiss" data-id="${s.id}" aria-label="${t('dec.dismiss')}: ${s.title}">${t('dec.dismiss')}</button>`
    : html`<span class="muted">${t('dec.needs', { who: approverLabels(s.type) })}</span>`;
  const escalated = s.escalated > 0 ? chipHTML('critical', '▲ ' + t('dec.escalated', { n: s.escalated }), 'sm') : '';
  return html`<article class="card l${s.level}"><div class="ctype"><span class="chip sm ${lvl}">${s.level === 1 ? '▲' : '●'} ${tOr('lvl.' + s.level, LEVEL_LABEL[s.level])}</span>${escalated} ${uiSuggLabel(s.type)}${decisionClock(s)}</div><h3 dir="auto">${s.title}</h3><p dir="auto">${s.why}</p><div class="cact">${actions}</div></article>`;
}
function renderDecisions() {
  const list = S.sugg.slice().sort((a, b) => a.level - b.level || a.at - b.at);
  const crit = list.filter(s => s.level === 1).length;
  const auto = prefs.autoAccept ? t('dec.auto') : '';
  setText($('#decMeta'), list.length ? t('dec.meta', { n: list.length, c: crit }) + auto : t('dec.upToDate') + auto);
  const nPlace = list.filter(s => s.type === 'placement').length;
  const btn = $('#acceptAll');
  if (btn) {
    showEl(btn, nPlace > 0 && canAct('placement'));
    setText(btn, t('dec.acceptAll', { n: nPlace }));
  }
  // Focus view: the most urgent cards only, with a one-tap way back to the whole queue
  const shown = uiLayout() === 'focus' ? list.slice(0, UI_FOCUS_CARDS) : list;
  const more = list.length - shown.length;
  const moreRow = more > 0
    ? html`<p class="more">${t('dec.more', { n: more })} <button type="button" class="btn ghost sm" data-act="view" data-id="full">${t('dec.showAll')}</button></p>`
    : '';
  setHTML($('#decisions'), list.length
    ? html`<div class="cards">${shown.map(decisionCard)}</div>${moreRow}`
    : html`<p class="empty">${t('dec.empty', { p: S.patients.length, b: S.beds.length, f: SOURCES.length })}</p>`);
}

/* ---------- Integration feed / audit log ---------- */
function auditRow(a) {
  return html`<div class="fr"><time datetime="${simDate(a.t).toISOString()}">${fmtClockS(a.t)}</time><span class="tag">${a.role}</span><span dir="auto">${a.text}</span></div>`;
}
function renderFeed() {
  document.querySelectorAll('#feedTabs [data-act="tab"]').forEach(b => {
    const sel = String(b.dataset.id === UI.tab);
    if (b.getAttribute('aria-selected') !== sel) b.setAttribute('aria-selected', sel);
  });
  const el = $('#feed');
  if (UI.tab === 'audit') {
    if (!ROLES[prefs.role].audit) {
      setHTML(el, html`<p class="empty">${t('fd.restricted')}</p>`);
      return;
    }
    setHTML(el, S.audit.length
      ? html`${S.audit.slice(0, 60).map(auditRow)}`
      : html`<p class="empty">${t('fd.noAudit')}</p>`);
    return;
  }
  setHTML(el, S.feed.length
    ? html`${S.feed.slice(0, 40).map(f => {
      const src = UI_SRC_BY_ID[f.src];
      return html`<div class="fr"><time datetime="${simDate(f.t).toISOString()}">${fmtClockS(f.t)}</time><span class="tag" title="${src ? src.name : f.src}">${src ? src.short : f.src} · ${f.std}</span><span dir="auto">${f.text}</span></div>`;
    })}`
    : html`<p class="empty">${t('fd.empty')}</p>`);
}

/* ---------- Occupancy chart: 60 min history + 30 min forecast ---------- */
function chartParts() {
  const box = $('#chart');
  if (!box) return null;
  let svg = box.querySelector('svg.occ');
  if (!svg) {
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    setHTML(box, html`<svg class="occ" role="img" aria-label="Bed occupancy chart" style="display:block;width:100%;height:100%"></svg><div class="xh" aria-hidden="true" style="display:none"></div><div class="tip" aria-hidden="true" style="display:none"></div>`);
    svg = box.querySelector('svg.occ');
  }
  return { box, svg };
}
function renderChart(force) {
  const parts = chartParts();
  if (!parts) return;
  const { box, svg } = parts;
  const W = Math.round(box.clientWidth), H = Math.round(box.clientHeight);
  const now = Date.now();
  if (!force && W === UI.chartW && H === UI.chartH && now - UI.chartAt < UI_CHART_MS) return;
  UI.chartAt = now; UI.chartW = W; UI.chartH = H;

  const fc = S.fc || { pts: [], fullIn: null };
  const status = fc.fullIn == null ? chipHTML('good', t('ch.none'), 'sm')
    : fc.fullIn === 0 ? chipHTML('critical', t('ch.nowFull'), 'sm')
    : chipHTML(fc.fullIn <= 20 ? 'critical' : 'serious', (fc.fullIn <= 20 ? '▲ ' : '● ') + t('ch.full', { n: fc.fullIn }), 'sm');
  setHTML($('#chartMeta'), html`${status} <span class="muted">${t('ch.legend')}</span>`);
  if (W < 80 || H < 60) { UI.geo = null; positionHover(); return; }

  const remK = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16; const pad = { l: 36 * remK, r: 12 * remK, t: 12 * remK, b: 22 * remK };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const nowPt = { m: 0, v: bedsBusy() / Math.max(1, S.beds.length) * 100 };
  const hist = S.occ.map(o => ({ m: (o.t - S.t) / 60, v: o.occ })).filter(o => o.m >= -60.5 && o.m < 0).concat(nowPt);
  const fcp = (fc.pts || []).map(o => ({ m: o.m, v: o.occ }));
  const vmax = Math.max(100, ...hist.map(o => o.v), ...fcp.map(o => o.v));
  const yMax = Math.ceil(vmax / 25) * 25;
  const X = m => pad.l + (m + 60) / 90 * pw;
  const Y = v => pad.t + (1 - v / yMax) * ph;
  const f1 = n => n.toFixed(1);
  const path = pts => pts.map((o, i) => (i ? 'L' : 'M') + f1(X(o.m)) + ' ' + f1(Y(o.v))).join(' ');

  const grid = [];
  for (let v = 0; v <= yMax; v += 25) grid.push(v);
  const histArea = hist.length > 1
    ? path(hist) + ' L' + f1(X(0)) + ' ' + f1(Y(0)) + ' L' + f1(X(hist[0].m)) + ' ' + f1(Y(0)) + ' Z'
    : '';
  const overflow = fcp.some(o => o.v > 100)
    ? 'M' + fcp.map(o => f1(X(o.m)) + ' ' + f1(Y(Math.max(100, o.v)))).join(' L') +
      ' L' + f1(X(fcp[fcp.length - 1].m)) + ' ' + f1(Y(100)) + ' L' + f1(X(fcp[0].m)) + ' ' + f1(Y(100)) + ' Z'
    : '';
  const xTicks = [-60, -30, 0, 15, 30];
  const xLabel = m => (m === 0 ? t('ch.now') : (m < 0 ? UI_MINUS + Math.abs(m) : '+' + m) + (m === -60 || m === 30 ? ' min' : ''));
  const axisStyle = 'fill:var(--muted);font-size:.625rem;font-variant-numeric:tabular-nums';

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const peak = fcp.length ? Math.round(Math.max(...fcp.map(o => o.v))) : null;
  svg.setAttribute('aria-label', 'Bed occupancy over the last 60 minutes and 30-minute forecast. Now ' + Math.round(nowPt.v) + '%.' +
    (peak != null ? ' Forecast peak ' + peak + '%.' : '') +
    (fc.fullIn == null ? ' No overflow forecast.' : fc.fullIn === 0 ? ' At capacity now.' : ' Full in about ' + fc.fullIn + ' minutes.'));
  setHTML(svg, html`${grid.map(v => html`<line x1="${pad.l}" x2="${W - pad.r}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" style="stroke:var(--grid);stroke-width:1"/><text x="${pad.l - 6 * remK}" y="${f1(Y(v) + 3.5 * remK)}" text-anchor="end" style="${axisStyle}">${v}%</text>`)}${xTicks.map(m => html`<text x="${f1(X(m))}" y="${H - 6 * remK}" text-anchor="${m === -60 ? 'start' : m === 30 ? 'end' : 'middle'}" style="${axisStyle}">${xLabel(m)}</text>`)}${histArea ? html`<path d="${histArea}" style="fill:var(--accent);opacity:.12"/>` : ''}${overflow ? html`<path d="${overflow}" style="fill:var(--critical-weak)"/>` : ''}<line x1="${pad.l}" x2="${W - pad.r}" y1="${f1(Y(100))}" y2="${f1(Y(100))}" style="stroke:var(--critical);stroke-width:1.5;stroke-dasharray:2 3"/><text x="${W - pad.r - 2}" y="${f1(Y(100) - 4 * remK)}" text-anchor="end" style="fill:var(--critical-fg);font-size:.625rem;font-weight:600">${t('ch.cap')}</text><line x1="${f1(X(0))}" x2="${f1(X(0))}" y1="${pad.t}" y2="${H - pad.b}" style="stroke:var(--text-2);stroke-width:1;stroke-dasharray:3 3"/><path d="${path(hist)}" style="fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>${fcp.length ? html`<path d="${path(fcp)}" style="fill:none;stroke:var(--accent);stroke-width:2;stroke-dasharray:5 4;stroke-linejoin:round"/>` : ''}<circle cx="${f1(X(0))}" cy="${f1(Y(nowPt.v))}" r="3.5" style="fill:var(--accent)"/>`);

  UI.geo = { X, Y, pad, pw, W, H, hist, fc: fcp };
  positionHover();
}
// Crosshair + tooltip live outside the SVG, so they survive redraws; recomputed from the latest geometry.
function positionHover() {
  const box = $('#chart');
  if (!box) return;
  const xh = box.querySelector('.xh'), tip = box.querySelector('.tip');
  if (!xh || !tip) return;
  const g = UI.geo;
  const hide = () => { xh.style.display = 'none'; tip.style.display = 'none'; };
  if (!g || UI.hoverPx == null) return hide();
  const m = clamp((UI.hoverPx - g.pad.l) / g.pw * 90 - 60, -60, 30);
  const pool = m <= 0 ? g.hist : g.fc;
  if (!pool.length) return hide();
  let best = pool[0];
  for (const o of pool) if (Math.abs(o.m - m) < Math.abs(best.m - m)) best = o;
  const x = g.X(best.m), y = g.Y(best.v), mm = Math.round(best.m), v = Math.round(best.v);
  xh.style.display = '';
  xh.style.left = x.toFixed(1) + 'px';
  xh.style.top = g.pad.t + 'px';
  xh.style.height = (g.H - g.pad.t - g.pad.b) + 'px';
  tip.textContent = best.m > 0 ? t('ch.tipFc', { m: mm, v })
    : mm === 0 ? t('ch.tipNow', { v })
    : t('ch.tipPast', { m: UI_MINUS + Math.abs(mm), v });
  tip.style.display = '';
  const tw = tip.offsetWidth || 120;
  tip.style.left = (x + 10 + tw > g.W ? x - 10 - tw : x + 10).toFixed(1) + 'px';
  tip.style.top = clamp(y - 30, 0, Math.max(0, g.H - 24)).toFixed(1) + 'px';
}

/* ---------- Source systems footer ---------- */
function srcChip(s) {
  const st = S.src[s.id] || { status: 'offline', last: 0 };
  const live = st.status === 'live';
  const backup = s.id === 'beds' && S.bedsOffline && S.bedsFallback;
  const title = s.name + ' · ' + s.std + ' · ' + (live ? 'live, last message ' + agoText(st.last) : backup ? 'offline, backup RTLS sensors in use' : 'offline');
  return html`<span class="src${live ? '' : ' offline'}" title="${title}"><span class="dot" aria-hidden="true">${live ? '●' : '○'}</span>${s.short}${live ? '' : html` <small>${backup ? t('src.backup') : t('src.offline')}</small>`}</span> `;
}
function renderSources() {
  const live = SOURCES.filter(s => S.src[s.id] && S.src[s.id].status === 'live').length;
  setHTML($('#sources'), html`<span class="muted">${t('src.meta', { n: live, m: SOURCES.length })}</span> ${SOURCES.map(srcChip)}`);
}

/* ---------- Modals: patient drawer, break-glass, family desk, standards, data map ---------- */
const UI_STANDARDS = [
  ['HL7 FHIR R4', 'Interoperability API', 'Integration gateway; EHR, bed (Location), EMS and pharmacy feeds; patient record exported as a FHIR Bundle (Encounter, Condition, AllergyIntolerance, Observation)'],
  ['HL7 v2.5 ADT', 'Messaging', 'Registration events ADT^A04 (arrival), A02 (transfer), A03 (discharge) in the integration feed'],
  ['IEEE 11073 SDC', 'Medical device connectivity', 'Bedside monitors and wearable patches stream vital signs; device recorded on every Observation'],
  ['LOINC', 'Observation terminology', 'Vital signs coded 8867-4 HR, 8480-6 SBP, 9279-1 RR, 59408-5 SpO₂, 8310-5 temperature (record table, FHIR Observation, monitor feed)'],
  ['ICD-10-CM', 'Diagnosis coding', 'Every presenting condition: patient list, record, FHIR Condition, ADT messages'],
  ['SNOMED CT', 'Clinical terminology (mapping target)', 'Conditions carry ICD-10-CM today; the gateway maps them to SNOMED CT for problem-list exchange; "no known allergy" is coded 716186003'],
  ['ESI v4', 'Triage acuity', 'ESI badge on every patient; drives bed-zone matching, nurse workload weights and re-triage suggestions'],
  ['START triage', 'Mass-casualty field triage', 'In MCI mode, inbound pre-alerts show the START colour (RED / YELLOW / GREEN) instead of ESI'],
  ['ATMIST', 'Pre-hospital handover', 'Age, Time, Mechanism, Injuries, Signs, Treatment: one line on each pre-alert card, full field report in the patient record'],
  ['SBAR', 'Structured clinical communication', 'Situation, Background, Assessment, Recommendation block generated in every patient record'],
  ['NEWS2 (RCP 2017)', 'Early-warning score', 'Live score and 12-minute trend per patient; per-parameter points in the record; deterioration alerts'],
  ['NCEMA framework', 'UAE National Emergency Crisis and Disaster Management Authority', 'Operating modes Steady → Strain → Surge → MCI with rules that can be read aloud; mode changes logged as NCEMA messages; MCI declaration and stand-down audited'],
  ['JCI Accreditation Standards for Hospitals', 'Emergency management (Facility Management and Safety)', 'Written surge triggers, escalation owners and clocks on every task, silent-surge actions (staff recall, overflow beds, blood bank standby), family reunification desk'],
  ['ISO 9241-210', 'Human-centred design', 'Role-specific views; the system suggests and a human decides; one decision queue; low-clutter layout; English and Arabic'],
  ['WCAG 2.2 AA', 'Accessibility', 'Real buttons with keyboard support, dialog focus management, live-region announcements, status as text + colour + shape, light/dark themes, right-to-left layout'],
  ['HIPAA Security Rule + NIST SP 800-66 Rev. 2', 'Security safeguards', 'Access control, audit controls (§164.312(b)), automatic logoff (§164.312(a)(2)(iii)), emergency access procedure (break-glass, §164.312(a)(2)(ii)), minimum-necessary display'],
  ['ISO/IEC 27001', 'Information security management', 'Role-based access, event logging, degraded-mode handling of interface outages'],
  ['UAE Federal Law No. 2 of 2019', 'ICT in health fields', 'Health data stored and processed inside the UAE; confidentiality and logged access to patient data'],
  ['UAE PDPL · Federal Decree-Law No. 45 of 2021', 'Personal data protection', 'Biometric and health data are sensitive: face matching is optional, only the match result and confidence reach the dashboard (no images or templates), and patients who opt out show "Restricted by patient"'],
  ['NABIDH · Malaffi · Riayati', 'UAE health information exchanges (Dubai · Abu Dhabi · MOHAP / EHS)', 'Allergies, anticoagulants, blood type and history carry their exchange source and as-of date; a candidate identity never links a chart'],
  ['ADHICS', 'Abu Dhabi Healthcare Information & Cyber Security Standard', 'Access control, audit logging, session lock, incident handling for failed interfaces'],
  ['GS1', 'Supply identification', 'Blood units and supply restocks received with GS1 barcodes (pharmacy feed)'],
  ['I-PASS', 'Structured handover', 'Nurse handovers and reassignments sent as I-PASS summaries (roster feed)'],
];
const UI_CONTROLS = [
  'Role-based access with least privilege: five roles; each suggestion type can be approved only by the roles allowed to act on it.',
  'Minimum-necessary display: full names for Physician, initial + surname for nurses, initials only on the wall display and for IT; MRN masked outside clinical roles; the wall display and IT see encounter id, priority and ETA on pre-alerts, nothing clinical.',
  'Care-team access: a nurse opens only assigned patients; any other record needs a break-glass reason of at least 10 characters. IT / Admin has no chart rights.',
  'Every record view, break-glass access and blocked attempt is written to the audit log and listed in that patient’s access log.',
  'Medication safety: allergy-class and anticoagulant interaction hard stops; an override needs a written reason of at least 10 characters and is audited. Unknown allergies are never shown as "none".',
  'Identity: a face match is only ever a candidate and never merges charts; pre-alerts carry no names, images or Emirates ID numbers, and undocumented fields are ignored.',
  'Automatic logoff: clinical roles fall back to the wall display after 5 minutes without input.',
  'Output encoding: all dynamic text is HTML-escaped by default before rendering (XSS); no eval, no inline event handlers, no third-party scripts, fonts or CDNs; a Content-Security-Policy blocks all network access.',
  'Human in the loop: the system only suggests; the single exception is opt-in auto-accept of bed placements, logged as policy.',
  'Fail-safe data: offline feeds are flagged; stale bed data is overlaid as STALE instead of being shown as current.',
  'Synthetic, fictional patients only; no data leaves the browser. Only the theme and language choices are stored locally; patient data never goes to storage or URLs.',
];

function sparkline(p, key, label, unit) {
  const pts = (p.hist || []).filter(h => h.t >= S.t - 1800 && h[key] != null);
  if (pts.length < 2) return html`<div><div>${label}</div><div class="muted">collecting data…</div></div>`;
  const vals = pts.map(h => h[key]);
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  let lo = vMin, hi = vMax;
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
  const W = 160, H = 40, t0 = S.t - 1800;
  const d = pts.map((h, i) => (i ? 'L' : 'M') + ((h.t - t0) / 1800 * W).toFixed(1) + ' ' + (H - 3 - (h[key] - lo) / (hi - lo) * (H - 6)).toFixed(1)).join(' ');
  const last = r0(vals[vals.length - 1]);
  return html`<div><div>${label} <b>${last}${unit}</b> <span class="muted">range ${r0(vMin)}–${r0(vMax)}</span></div><svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label} over the last 30 minutes, from ${r0(vals[0])} to ${last}"><path d="${d}" style="fill:none;stroke:var(--accent);stroke-width:1.5;stroke-linejoin:round"/></svg></div>`;
}
// AllergyIntolerance entries: one per known allergy, or SNOMED CT "no known allergy"; nothing when UNKNOWN.
function fhirAllergies(p, subject) {
  const st = safetyState(p);
  if (!st.known) return [];
  const note = safetySource(st.sf) ? [{ text: 'Source: ' + safetySource(st.sf) }] : undefined;
  const clinical = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] };
  const verified = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] };
  const items = st.allergies.length
    ? st.allergies.map(a => ({ text: a }))
    : [{ coding: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text: 'No known allergy' }];
  return items.map((code, i) => ({
    fullUrl: 'urn:uuid:allergy-' + p.id + '-' + i,
    resource: { resourceType: 'AllergyIntolerance', id: 'allergy-' + p.id + '-' + i, clinicalStatus: clinical, verificationStatus: verified, code, patient: subject, note },
  }));
}
function fhirBundle(p) {
  const c = condInfo(p), subject = { reference: 'Patient/' + p.id };
  const last = p.hist && p.hist.length ? p.hist[p.hist.length - 1] : null;
  const when = simDate(last ? last.t : S.t).toISOString();
  const value = k => (k === 'temp' ? Math.round(p.v.temp * 10) / 10 : r0(last && last[k] != null ? last[k] : p.v[k]));
  const encStatus = isActiveCare(p) ? 'in-progress' : p.stage === 'waiting' ? 'triaged' : 'planned';
  const observations = ['hr', 'sbp', 'rr', 'spo2', 'temp'].map(k => ({
    fullUrl: 'urn:uuid:obs-' + p.id + '-' + k,
    resource: {
      resourceType: 'Observation', id: 'obs-' + p.id + '-' + k, status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: LOINC[k].code, display: LOINC[k].name }] },
      subject, effectiveDateTime: when,
      valueQuantity: { value: value(k), unit: unitText(LOINC[k].unit), system: 'http://unitsofmeasure.org', code: LOINC[k].unit },
      device: { display: 'IEEE 11073 SDC wearable patch' },
    },
  }));
  return {
    resourceType: 'Bundle', id: 'ed-' + p.id, type: 'collection', timestamp: when,
    entry: [
      {
        fullUrl: 'urn:uuid:enc-' + p.id,
        resource: {
          resourceType: 'Encounter', id: 'enc-' + p.id, status: encStatus,
          identifier: [{ system: 'urn:wasel:encounter', value: uiEnc(p) }],
          class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'emergency' },
          priority: { text: 'ESI ' + p.esi + ' (' + ESI_LABEL[p.esi] + ')' }, subject,
        },
      },
      {
        fullUrl: 'urn:uuid:cond-' + p.id,
        resource: {
          resourceType: 'Condition', id: 'cond-' + p.id,
          clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
          code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: c.icd, display: c.label }], text: c.label },
          subject, encounter: { reference: 'Encounter/enc-' + p.id },
        },
      },
      ...fhirAllergies(p, subject),
      ...observations,
    ],
  };
}
function kvList(rows) {
  return html`<dl class="kv">${rows.filter(Boolean).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

/* Patient drawer, top to bottom: allergy banner, identity, field report,
 * vitals + NEWS2, history, SBAR, medication order, access log, FHIR bundle.
 * The order form lives in its own container that re-renders only when the
 * order state changes, so typed reasons survive the 500 ms live refresh.   */
function allergyBanner(p) {
  const st = safetyState(p), src = safetySource(st.sf);
  let cls, text;
  if (!st.known) {
    cls = 'warning';
    text = '● ' + t('al.unknown') + (st.restricted ? ' · ' + t('al.restricted') : '');
  } else if (st.allergies.length) {
    cls = 'critical';
    text = '▲ ' + t('al.allergy', { list: st.allergies.join(', ') }) + (src ? ' · ' + src : '');
  } else {
    cls = 'neutral';
    text = '✓ ' + t('al.none') + (src ? ' · ' + src : '');
  }
  const meds = Array.isArray(p.meds) ? p.meds.join(', ') : '';
  const anti = st.known && st.anticoag ? html`<span class="chip serious">● ${t('al.anticoag')}${meds ? ': ' + meds : ''}</span>` : '';
  return html`<div class="allergy ${cls}">${text}${anti}</div>`;
}
function identityNote(p) {
  const s = p.identity && p.identity.status;
  return s === 'candidate' ? t('idx.candidate') : s === 'confirmed' ? t('idx.confirmed') : s === 'temporary' ? t('idx.temporary') : '';
}
function patientDetails(p) {
  const c = condInfo(p), st = safetyState(p);
  const n = p.nurse ? nurse(p.nurse) : null;
  const pb = p.bed ? bed(p.bed) : null;
  let where = locationText(p);
  if (isActiveCare(p)) where = 'Bed ' + p.bed + (pb ? ' (' + zoneName(pb.zone) + ')' : '') + ' · nurse ' + (n && n.status === 'on' ? n.name : 'not assigned') + (p.stage === 'boarding' ? ' · awaiting ' + (DISPO_LABEL[p.dispo] || 'transfer') : '');
  const resources = [p.monitor && 'Cardiac monitor', p.vent && 'Ventilator', p.needsVent && !p.vent && 'Needs ventilator (none free)',
    p.onO2 && 'Oxygen', S.eq.ctQueue.includes(p.id) && 'Queued for CT'].filter(Boolean).join(' · ') || 'None';
  const idChip = identityChip(p), idNote = identityNote(p);
  return kvList([
    (idChip || idNote) && [t('k.identity'), html`${idChip}${idNote ? html`<span class="idnote">${idNote}</span>` : ''}`],
    [t('k.triage'), html`${startChip(p)} ${esiMini(p.esi)} ${ESI_LABEL[p.esi]}${p.retriaged ? ' · ' + t('pt.retriaged') : ''}`],
    [t('k.name'), pname(p)],
    p.enc && p.enc !== p.id && [t('k.enc'), p.enc],
    [t('k.pid'), p.id],
    [t('k.mrn'), pmrn(p)],
    [t('k.age'), p.age + ' y · ' + (p.sex === 'F' ? 'Female' : 'Male')],
    [t('k.blood'), st.known && st.sf.bloodType ? st.sf.bloodType : t('w.unknown')],
    [t('k.arrival'), p.src + (p.amb ? ' · ' + p.amb : '') + (p.arrivedAt != null ? ' · arrived ' + fmtClock(p.arrivedAt) : ' · not yet arrived')],
    [t('k.loc'), where],
    [t('k.cond'), c.label + ' · ICD-10-CM ' + c.icd],
    [t('k.res'), resources],
  ]);
}
function fieldReport(p) {
  const a = p.atmist;
  if (!a) return html`<p class="muted">${t('d.noField')}</p>`;
  return kvList([
    [t('k.aAge'), a.age != null && a.age !== '' ? a.age + ' y' : p.age + ' y'],
    a.time && [t('k.aTime'), a.time],
    a.mechanism && [t('k.aMech'), a.mechanism],
    a.injuries && [t('k.aInj'), a.injuries],
    [t('k.aSigns'), atmistSigns(a, p) + (a.signs && typeof a.signs.rr === 'number' ? ' RR ' + r0(a.signs.rr) : '')],
    a.treatment && [t('k.aTreat'), a.treatment],
  ]);
}
function vitalsTable(p, news, parts) {
  const trend = p.trend > 0 ? 'rising +' + p.trend + ' in 12 min' : p.trend < 0 ? 'falling ' + p.trend + ' in 12 min' : 'stable';
  const vrow = k => html`<tr><td>${LOINC[k].name}</td><td><code>${LOINC[k].code}</code></td><td>${fmtV(k, p.v[k])} ${unitText(LOINC[k].unit)}</td><td>${parts[k]}</td></tr>`;
  return html`<table><thead><tr><th scope="col">Observation</th><th scope="col">LOINC</th><th scope="col">Value</th><th scope="col">NEWS2 pts</th></tr></thead><tbody>${['rr', 'spo2', 'sbp', 'hr', 'temp'].map(vrow)}<tr><td>Supplemental oxygen</td><td>—</td><td>${p.onO2 ? 'Yes' : 'No (room air)'}</td><td>${parts.o2}</td></tr><tr><td>Consciousness (ACVPU)</td><td>—</td><td>${p.v.avpu === 'A' ? 'Alert' : 'Responds to voice'}</td><td>${parts.avpu}</td></tr></tbody><tfoot><tr><th scope="row" colspan="3">NEWS2 total · ${trend}</th><td><b>${news}</b></td></tr></tfoot></table>`;
}
function aiAssessment(p, news, parts) {
  const risk = news >= 7 ? 'high clinical risk' : news >= 5 ? 'medium clinical risk'
    : Object.values(parts).some(x => x === 3) ? 'low–medium risk (a single parameter scores 3)' : 'low clinical risk';
  const f = p.flag;
  const pending = S.sugg.filter(s => s.pid === p.id);
  return html`${f
    ? html`<p>${chipHTML(f.level, (f.level === 'critical' ? '▲ ' : '● ') + LEVEL_LABEL[f.level === 'critical' ? 1 : 2], 'sm')} ${f.text}</p>${f.hint ? html`<p>${f.hint}.</p>` : ''}`
    : html`<p>${chipHTML('good', '✓ Stable', 'sm')} No deterioration pattern detected over the last 12 minutes.</p>`}${pending.length ? html`<p>In decision queue: ${pending.map(s => s.title).join(' · ')}</p>` : ''}<p class="muted">NEWS2 ${news}: ${risk}. This is rule-based decision support only; the treating clinician decides.</p>`;
}
// p.history entries are strings or {name|condition|label, source, date|asOf}
function historyBlock(p) {
  const st = safetyState(p);
  const rows = Array.isArray(p.history) ? p.history.filter(h => h != null && h !== '') : [];
  const meds = Array.isArray(p.meds) && p.meds.length ? p.meds : null;
  if (!rows.length && !meds) {
    if (st.restricted) return html`<p class="muted">${t('al.restricted')}</p>`;
    if (p.preAlert) return html`<p class="muted">${t('h.prealert')}</p>`;
    if (!st.known) return html`<p class="muted">${t('h.unknown')}</p>`;
    const src = safetySource(st.sf);
    return html`<p class="muted">${t('h.none')}${src ? ' · ' + src : ''}</p>`;
  }
  const line = h => {
    if (typeof h !== 'object') return html`<li>${h}</li>`;
    const name = h.name || h.condition || h.label || h.text || '';
    const meta = [h.source || h.src, h.date || h.asOf || h.since].filter(Boolean).join(' · ');
    return html`<li><b>${name}</b>${meta ? html` <small class="muted">· ${meta}</small>` : ''}</li>`;
  };
  const src = safetySource(st.sf);
  return html`<ul class="hist">${rows.map(line)}${meds ? html`<li><b>${t('h.meds')}:</b> ${meds.join(', ')}${src ? html` <small class="muted">· ${src}</small>` : ''}</li>` : ''}</ul>`;
}
function sbarBlock(p) {
  const r = uiCall('sbar', p);
  if (!r) return html`<p class="muted">${t('sb.na')}</p>`;
  if (typeof r !== 'object') return html`<p>${r}</p>`;
  const rows = [['S', 'sb.s', r.s], ['B', 'sb.b', r.b], ['A', 'sb.a', r.a], ['R', 'sb.r', r.r]];
  return html`<dl class="sbar">${rows.map(([k, key, v]) => html`<dt><b>${k}</b>${t(key)}</dt><dd>${v || '—'}</dd>`)}</dl>`;
}
function drawerLive(p) {
  const news = news2(p.v, p.onO2), parts = news2Parts(p.v, p.onO2);
  const sparks = html`<div style="display:flex;flex-wrap:wrap;gap:16px">${sparkline(p, 'hr', 'Heart rate', '/min')}${sparkline(p, 'sbp', 'Systolic BP', ' mmHg')}${sparkline(p, 'spo2', 'SpO₂', '%')}</div>`;
  return html`${allergyBanner(p)}<div class="mgrid"><section><h3>${t('d.identity')}</h3>${patientDetails(p)}</section><section><h3>${t('d.field')}</h3>${fieldReport(p)}<h3>${t('d.ai')}</h3>${aiAssessment(p, news, parts)}</section></div><div class="mgrid"><section><h3>${t('d.vitals', { n: news })}</h3>${vitalsTable(p, news, parts)}</section><section><h3>${t('d.trends')}</h3>${sparks}<h3>${t('d.history')}</h3>${historyBlock(p)}</section></div><h3>${t('d.sbar')}</h3>${sbarBlock(p)}`;
}

// DRUGS (15-wasel.js) may be a list of names / {name|label|key|id, cls} objects or a map keyed by drug; normalised to [{key, label, cls}]
function uiDrugList() {
  if (typeof DRUGS === 'undefined' || !DRUGS || typeof DRUGS !== 'object') return [];
  const entries = Array.isArray(DRUGS)
    ? DRUGS.map(d => (typeof d === 'string' ? [d, d] : [d && (d.key || d.id || d.name || d.label), d]))
    : Object.entries(DRUGS);
  return entries.filter(([k]) => typeof k === 'string' && k).map(([k, d]) => ({
    key: k,
    label: typeof d === 'string' ? d : (d && (d.label || d.name)) || k,
    cls: d && typeof d === 'object' && d.cls ? String(d.cls) : '',
  }));
}
const uiDrugLabel = key => (uiDrugList().find(d => d.key === key) || { label: key }).label;
function drawerOrder(p) {
  const drugs = uiDrugList();
  const head = html`<h3 id="pd-order-h">${t('d.order')}</h3>`;
  if (!UI_API.checkOrder || !drugs.length) return html`${head}<p class="muted">${t('o.na')}</p>`;
  const st = UI.order && UI.order.pid === p.id ? UI.order : null;
  const label = st ? uiDrugLabel(st.drug) : '';
  const form = html`<div class="order"><label class="sr-only" for="pd-drug">${t('o.drug')}</label><select id="pd-drug">${drugs.map(d => html`<option value="${d.key}"${st && d.key === st.drug ? html` selected` : ''}>${d.label}${d.cls ? ' · ' + d.cls : ''}</option>`)}</select><button type="button" class="btn primary" data-act="order" data-id="${p.id}">${t('o.order')}</button></div>`;
  let res = '';
  if (st && st.kind === 'stop') {
    // Red blocking box: the only way on is a written override reason
    res = html`<div class="ordres critical" role="alert"><p><b>⛔ ${t('o.stop')} · ${label}</b></p><p>${st.reason}</p><label for="pd-override">${t('o.overrideLbl')}</label><div class="order"><input id="pd-override" class="txt" type="text" minlength="${UI_REASON_MIN}" maxlength="${UI_REASON_MAX}" autocomplete="off" data-enter="override"><button type="button" class="btn danger" data-act="override" data-id="${p.id}">${t('o.overrideBtn')}</button></div></div>`;
  } else if (st && st.kind === 'caution') {
    // Amber, non-blocking: one explicit acknowledgement places the order
    res = html`<div class="ordres warning" role="alert"><p><b>● ${t('o.caution', { drug: label })}</b></p><p>${st.reason}</p><div class="order"><button type="button" class="btn" data-act="orderConfirm" data-id="${p.id}">${t('o.confirm')}</button></div></div>`;
  } else if (st && (st.kind === 'warn' || st.kind === 'blocked')) {
    res = html`<div class="ordres warning" role="status"><p><b>● ${t(st.kind === 'warn' ? 'o.warn' : 'o.blocked', { drug: label })}</b></p><p>${st.reason}</p></div>`;
  } else if (st && (st.kind === 'ok' || st.kind === 'overridden')) {
    res = html`<div class="ordres good" role="status"><p><b>✓ ${t(st.kind === 'ok' ? 'o.ok' : 'o.overridden', { drug: label })}</b></p><p>${st.kind === 'ok' ? st.reason || t('o.okNote') : t('o.overNote')}</p></div>`;
  }
  return html`${head}${form}${res}`;
}
// Audit lines that name this patient by id or encounter (whole-token match, so T-10 never matches T-104)
function uiAccessLines(p) {
  const ids = new Set([p.id, uiEnc(p)]);
  return S.audit.filter(a => String(a.text).split(/[^\w-]+/).some(w => ids.has(w))).slice(0, 8);
}
function drawerTail(p) {
  const lines = uiAccessLines(p);
  return html`<h3>${t('d.access')}</h3>${lines.length ? html`<div class="alog">${lines.map(auditRow)}</div>` : html`<p class="muted">${t('ac.none')}</p>`}<h3>${t('d.fhir')}</h3><pre tabindex="0">${JSON.stringify(fhirBundle(p), null, 2)}</pre><p class="muted">${t('d.recorded')}</p>`;
}
function renderPatientDrawer(id) {
  const p = P(id);
  if (!p) {
    setText($('#mtitle'), id);
    setHTML($('#mbody'), html`<p class="empty">${t('d.closed', { id })}</p>`);
    return;
  }
  if (!canViewPatient(p)) { closeModal(); return; }
  setText($('#mtitle'), pname(p) + ' · ' + uiEnc(p) + (p.enc && p.enc !== p.id ? ' · ' + p.id : ''));
  // Fixed skeleton (written once), then each part refreshes on its own
  setHTML($('#mbody'), html`<div id="pd-live"></div><section id="pd-order" aria-labelledby="pd-order-h"></section><div id="pd-tail"></div>`);
  setHTML($('#pd-live'), drawerLive(p));
  setHTML($('#pd-order'), drawerOrder(p));
  setHTML($('#pd-tail'), drawerTail(p));
}

function breakGlassModal(id) {
  const p = P(id);
  if (!p) return [t('bg.title'), html`<p class="empty">${t('t.gone')}</p>`];
  return [t('bg.title') + ' · ' + uiEnc(p), html`<div class="glass"><p><b>▲ ${t('bg.warn')}</b></p><p>${t('bg.explain')}</p><label for="bg-reason">${t('bg.reason')}</label><div class="order"><input id="bg-reason" class="txt" type="text" minlength="${UI_REASON_MIN}" maxlength="${UI_REASON_MAX}" autocomplete="off" data-enter="breakglass" data-autofocus><button type="button" class="btn danger" data-act="breakglass" data-id="${p.id}">${t('bg.btn')}</button><button type="button" class="btn ghost" data-act="close">${t('bg.cancel')}</button></div></div>`];
}
// Family reunification: encounter, initials, status, since. Deliberately no clinical fields.
function familyModal() {
  const board = uiCall('familyBoard');
  const cap = html`<p class="fam-cap">${t('fam.caption')}</p>`;
  if (!Array.isArray(board)) return [t('fam.title'), html`${cap}<p class="empty">${t('fam.na')}</p>`];
  const rows = board.filter(r => r && typeof r === 'object');
  if (!rows.length) return [t('fam.title'), html`${cap}<p class="empty">${t('fam.empty')}</p>`];
  const since = v => (typeof v === 'number' ? fmtClock(v) + ' · ' + agoText(v) : v);
  return [t('fam.title'), html`${cap}<table><thead><tr><th scope="col">${t('fam.enc')}</th><th scope="col">${t('fam.initials')}</th><th scope="col">${t('fam.status')}</th><th scope="col">${t('fam.since')}</th></tr></thead><tbody>${rows.map(r => html`<tr><th scope="row">${r.enc}</th><td>${r.initials}</td><td>${tOr('fs.' + uiSlug(r.status), r.status)}</td><td>${since(r.since)}</td></tr>`)}</tbody></table>`];
}
function standardsModal() {
  const idleMin = Math.max(0, Math.ceil((UI_LOCK_MS - (Date.now() - UI.lastInput)) / 60000));
  const lockText = ROLES[prefs.role].detail ? 'auto-lock in ' + idleMin + ' min without input' : 'no clinical session to lock';
  return [t('std.title'), html`<p>Signed in as <b>${ROLES[prefs.role].label}</b> (demo sign-in) · ${lockText} · ${S.audit.length} audit entries this session.</p><table><thead><tr><th scope="col">${t('std.s')}</th><th scope="col">${t('std.a')}</th><th scope="col">${t('std.w')}</th></tr></thead><tbody>${UI_STANDARDS.map(([s, a, w]) => html`<tr><th scope="row">${s}</th><td>${a}</td><td>${w}</td></tr>`)}</tbody></table><h3>${t('std.controls')}</h3><ul>${UI_CONTROLS.map(c => html`<li>${c}</li>`)}</ul><p class="muted">Production deployment: SSO with MFA (OIDC / SAML) replaces the demo role selector; TLS 1.2+ on every interface; AES-256 encryption at rest; UAE-hosted servers; audit log streamed to a SIEM; break-glass events reviewed daily by the privacy officer.</p>`];
}
function dataMapModal() {
  const live = SOURCES.filter(s => S.src[s.id] && S.src[s.id].status === 'live').length;
  const rows = SOURCES.map(s => {
    const st = S.src[s.id] || { status: 'offline', last: 0 };
    const on = st.status === 'live';
    const status = on ? chipHTML('good', '● Live · ' + agoText(st.last), 'sm')
      : chipHTML('critical', s.id === 'beds' && S.bedsFallback ? '○ Offline · backup sensors' : '○ Offline', 'sm');
    return html`<tr><th scope="row">${s.name}</th><td>${s.std}</td><td>${s.feeds}</td><td>${s.panel}</td><td>${status}</td></tr>`;
  });
  return [t('dm.title', { n: live, m: SOURCES.length }), html`<p>Ten hospital systems → integration gateway (normalised to HL7 FHIR R4, coded with LOINC and ICD-10-CM) → this dashboard. Nothing is entered twice; every panel cites its source.</p><table><thead><tr><th scope="col">${t('dm.src')}</th><th scope="col">${t('dm.std')}</th><th scope="col">${t('dm.data')}</th><th scope="col">${t('dm.shown')}</th><th scope="col">${t('dm.status')}</th></tr></thead><tbody>${rows}</tbody></table><p class="muted">Responder app (face-ID): pre-alerts arrive on the same-origin BroadcastChannel "wasel-prealert" or through window.WASEL.receivePreAlert(), in the documented ATMIST message shape. Names, images and Emirates ID numbers are never accepted.</p><p class="muted">Dispatch (call-taker): confirmed calls arrive on "wasel-incident" with no caller identity. Capacity out: every 5 s and on each mode change this dashboard broadcasts free beds, ICU, O-negative blood, CT and diversion on "wasel-capacity", never patient data.</p>`];
}
function renderModal() {
  if (!UI.modal) return;
  const { kind, id } = UI.modal;
  if (kind === 'patient') { renderPatientDrawer(id); return; }
  if (kind === 'breakglass' && ROLES[prefs.role].detail !== 'assigned') { closeModal(); return; }
  const [title, body] = kind === 'breakglass' ? breakGlassModal(id)
    : kind === 'family' ? familyModal()
    : kind === 'standards' ? standardsModal()
    : dataMapModal();
  setText($('#mtitle'), title);
  setHTML($('#mbody'), body);
}
function openModal(kind, id) {
  const m = $('#modal');
  if (!m) return;
  if (!UI.modal) {
    const a = document.activeElement;
    UI.lastFocus = a && a.dataset ? { el: a, act: a.dataset.act, id: a.dataset.id } : null;
  }
  UI.modal = { kind, id };
  m.classList.toggle('drawer', kind === 'patient');
  m.classList.toggle('narrow', kind === 'breakglass' || kind === 'family');
  renderModal();
  showEl(m, true);
  // Focus the reason field when there is one, else the header's close button (not the backdrop)
  const target = m.querySelector('[data-autofocus]') || m.querySelector('.mhead [data-act="close"]');
  if (target) setTimeout(() => target.focus(), 0);   // after the pointer's own focus handling
}
function closeModal() {
  const m = $('#modal');
  UI.modal = null;
  UI.order = null;
  if (m) showEl(m, false);
  const last = UI.lastFocus;
  UI.lastFocus = null;
  if (!last) return;
  let target = last.el && last.el.isConnected ? last.el : null;
  if (!target && last.act) {
    target = document.querySelector('[data-act="' + CSS.escape(last.act) + '"]' + (last.id != null ? '[data-id="' + CSS.escape(last.id) + '"]' : ''));
  }
  if (target) target.focus({ preventScroll: true });
}
function enforceModalAccess() {
  if (!UI.modal) return;
  const { kind, id } = UI.modal;
  const p = id ? P(id) : null;
  if (kind === 'patient' && p && !canViewPatient(p)) {
    closeModal();
    toast(t('t.recordClosed', { role: roleLabel(prefs.role) }));
  } else if (kind === 'breakglass' && ROLES[prefs.role].detail !== 'assigned') {
    closeModal();
  }
}
function openPatient(id) {
  const p = P(id);
  if (!p) { toast(t('t.gone')); return; }
  const role = ROLES[prefs.role];
  if (role.detail === 'assigned' && !canViewPatient(p)) {
    audit('Care-team check: ' + uiRef(p) + ' is not assigned to ' + role.label + '; break-glass prompt shown');
    openModal('breakglass', p.id);
    return;
  }
  if (!canViewPatient(p)) {
    const why = role.audit ? 'no chart rights' : 'no clinical access';
    audit('Blocked: patient record ' + uiRef(p) + ' view attempt (' + role.label + ': ' + why + ')');
    toast(role.audit ? t('t.noChart') : t('t.wallBlocked'));
    return;
  }
  audit('Viewed patient record ' + uiRef(p));
  UI.order = null;
  openModal('patient', p.id);
}

/* ---------- Medication order (decision support in the drawer) ---------- */
function uiReason(sel) {
  const el = $(sel);
  return el ? el.value.replace(/\s+/g, ' ').trim().slice(0, UI_REASON_MAX) : '';
}
// Places an order that passed checkOrder. The engine records, emits and audits it when it
// offers waselOrder(); otherwise this layer writes the MedicationRequest and audit line itself.
function commitOrder(p, drugKey, warning) {
  const placed = UI_API.placeOrder ? uiCall('placeOrder', p, drugKey) : undefined;
  if (placed && typeof placed === 'object') return placed.ordered !== false;
  const note = warning ? ' · warning acknowledged' : '';
  emit('ehr', 'FHIR', 'MedicationRequest ' + uiDrugLabel(drugKey) + ' for ' + uiEnc(p) + ' · active' + note);
  audit('Medication ordered: ' + uiDrugLabel(drugKey) + ' for ' + uiEnc(p) + note);
  return true;
}
// "Order": hard stop → red box (override only); warning → amber box awaiting acknowledgement; clear → ordered.
function placeOrder(p) {
  const sel = $('#pd-drug');
  const drug = uiDrugList().find(d => sel && d.key === sel.value);
  if (!drug) { toast(t('o.pick')); return false; }
  const r = uiCall('checkOrder', p, drug.key);
  if (!r || typeof r !== 'object') { toast(t('o.na')); return false; }
  const reason = r.reason ? String(r.reason) : '';
  // An engine that reports `warning` says so explicitly; otherwise any reason on a passing check is one
  const warning = typeof r.warning === 'boolean' ? r.warning : !!reason;
  const setState = kind => { UI.order = { pid: p.id, drug: drug.key, kind, reason }; };
  if (r.hardStop) {
    setState('stop');
    audit('Blocked by hard stop: ' + drug.label + ' for ' + uiEnc(p) + (reason ? ' · ' + reason : ''));
  } else if (!r.ok) {
    setState('blocked');
  } else if (warning) {
    setState('caution');
  } else {
    setState(commitOrder(p, drug.key, false) ? 'ok' : 'blocked');
  }
  return true;
}
function confirmCaution(p) {
  const st = UI.order;
  if (!st || st.pid !== p.id || st.kind !== 'caution') return false;
  UI.order = Object.assign({}, st, { kind: commitOrder(p, st.drug, true) ? 'warn' : 'blocked' });
  return true;
}
function confirmOverride(p) {
  const st = UI.order;
  if (!st || st.pid !== p.id || st.kind !== 'stop') return false;
  const reason = uiReason('#pd-override');
  if (reason.length < UI_REASON_MIN) {
    toast(t('o.short'));
    const el = $('#pd-override');
    if (el) el.focus();
    return false;
  }
  if (!UI_API.overrideOrder) { toast(t('o.na')); return false; }
  const r = uiCall('overrideOrder', p, st.drug, reason);
  if (r === undefined || r === false || (r && typeof r === 'object' && r.ok === false)) {
    toast(t('o.overFail') + (r && r.error ? ' ' + String(r.error).slice(0, 120) : ''));
    return false;
  }
  UI.order = { pid: p.id, drug: st.drug, kind: 'overridden', reason: '' };
  return true;
}

/* ---------- Responder pre-alerts (face-ID app → BroadcastChannel / window.WASEL) ---------- */
// receivePreAlert() validates the message and ignores undocumented fields; this wrapper only reports the result.
function uiReceivePreAlert(msg) {
  if (!UI_API.receivePreAlert) {
    toast(t('t.prealertNA'));
    return { ok: false, error: 'pre-alert receiver not available' };
  }
  if (!msg || typeof msg !== 'object') {
    toast(t('t.prealertBad', { err: 'not an object' }));
    return { ok: false, error: 'not an object' };
  }
  const r = uiCall('receivePreAlert', msg) || { ok: false, error: 'invalid message' };
  if (r.ok) {
    if (r.encounter) UI.live.set(r.encounter, Date.now());
    toast(t(r.routed ? 't.routed' : r.updated ? 't.prealertUpd' : 't.prealert', { enc: r.encounter || '' }));
  } else toast(t('t.prealertBad', { err: String(r.error || 'invalid message').slice(0, 120) }));
  if (S) render();
  return r;
}
// Sample from FACE_ID_INTEGRATION.md. Each press takes the next free id from T-900 up, so a
// repeat adds a new pre-alert instead of updating one already on the board.
function demoPreAlert() {
  let n = 900 + UI.demoSeq;
  while (S.patients.some(p => p.enc === 'T-' + n)) n++;
  UI.demoSeq = n - 900 + 1;
  const enc = 'T-' + n;
  return {
    type: 'prealert', v: 1, encounter: enc,
    identity: { status: 'candidate', method: 'face', confidence: 0.94, display: 'F.K.' },
    atmist: {
      age: '45', time: fmtClock(S.t - 12 * 60),
      mechanism: 'Driver, frontal collision at ~100 km/h',
      injuries: 'Chest wall tenderness, closed left femur fracture',
      signs: { hr: 124, sbp: 96, rr: 26, spo2: 92, gcs: 14 },
      treatment: 'Pelvic binder, 1 L saline, 10 mg morphine IV',
    },
    priority: { system: 'ESI', level: 2 },
    etaMin: 8,
    safety: { allergies: ['Penicillin'], anticoagulant: false, bloodType: 'O+', source: 'Riayati', asOf: '2026-03-14' },
    // CHANNELS.md §2: the responder's sliders and the destination the responder app chose
    triage: { avpu: 'V', breathing: 'laboured', bleeding: 'heavy-controlled', perfusion: 'weak-fast', pain: 7,
      regions: ['chest', 'pelvis'], burnsPct: 0, ageBand: 'adult' },
    destination: { hospital: 'Demo General Hospital', reason: 'Trauma bay free · O-neg ' + S.sup.blood.qty + ' · 8 min', etaMin: 8 },
  };
}
function wirePreAlerts() {
  try {
    UI.channel = new BroadcastChannel('wasel-prealert');
    UI.channel.onmessage = e => uiReceivePreAlert(e.data);
  } catch (err) { /* BroadcastChannel unavailable (e.g. some file:// contexts): window.WASEL still works */ }
  window.WASEL = Object.freeze({
    receivePreAlert: msg => uiReceivePreAlert(msg),
    receiveIncident: msg => uiReceiveIncident(msg),
    capacity: () => uiCall('capacitySnapshot', Date.now()) || null,
  });
}

/* ---------- Dispatch calls in, capacity out (CHANNELS.md §1 and §3) ---------- */
// receiveIncident() validates the call and ignores undocumented fields (no caller identity); this only reports.
function uiReceiveIncident(msg) {
  if (!UI_API.receiveIncident) {
    toast(t('t.incidentNA'));
    return { ok: false, error: 'incident receiver not available' };
  }
  if (!msg || typeof msg !== 'object') {
    toast(t('t.incidentBad', { err: 'not an object' }));
    return { ok: false, error: 'not an object' };
  }
  const r = uiCall('receiveIncident', msg) || { ok: false, error: 'invalid message' };
  if (r.ok) {
    const inc = S.incidents.find(i => i.id === r.id);
    const key = r.updated === false ? 't.incidentClosed' : r.updated ? 't.incidentUpd' : 't.incident';
    toast(t(key, { id: r.id, name: inc ? inc.name + ' · ' + inc.place : '' }));
  } else toast(t('t.incidentBad', { err: String(r.error || 'invalid message').slice(0, 120) }));
  if (S) render();
  return r;
}
// Only capacity leaves the hospital: the §3 snapshot has no patient fields at all
function broadcastCapacity() {
  if (!UI.capChannel || !S) return;
  const snap = uiCall('capacitySnapshot', Date.now());
  if (!snap) return;
  try { UI.capChannel.postMessage(snap); } catch (err) { /* channel closed or message not cloneable: next tick retries */ }
}
// Mode changes go out at once, not at the next 5 s tick
function broadcastOnModeChange() {
  if (UI.capMode === S.mode) return;
  UI.capMode = S.mode;
  broadcastCapacity();
}
function wireDispatch() {
  try {
    UI.incChannel = new BroadcastChannel('wasel-incident');
    UI.incChannel.onmessage = e => uiReceiveIncident(e.data);
  } catch (err) { /* BroadcastChannel unavailable: window.WASEL.receiveIncident still works */ }
  try {
    UI.capChannel = new BroadcastChannel('wasel-capacity');
  } catch (err) { UI.capChannel = null; /* responders fall back to their own simulated capacity */ }
  setInterval(broadcastCapacity, UI_CAPACITY_MS);
}

/* ---------- Controls, theme, language, auto-lock ---------- */
function applyTheme(theme) {
  UI.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', UI.theme);
  const b = $('#theme');
  if (b) {
    // Icon-only button (shell): keep the glyph, describe the action for screen readers
    b.title = t(UI.theme === 'dark' ? 'theme.toLight' : 'theme.toDark');
    b.setAttribute('aria-label', b.title);
  }
}
function toggleTheme() {
  applyTheme(UI.theme === 'dark' ? 'light' : 'dark');
  try { localStorage.setItem(UI_THEME_KEY, UI.theme); } catch (err) { /* storage blocked: theme applies to this session only */ }
}
function applyLang(lang) {
  UI.lang = lang === 'ar' ? 'ar' : 'en';
  const root = document.documentElement;
  root.setAttribute('lang', UI.lang);
  root.setAttribute('dir', UI.lang === 'ar' ? 'rtl' : 'ltr');
  document.querySelectorAll('[data-i18n]').forEach(el => setText(el, t(el.dataset.i18n)));
  setText($('#appName'), UI_APP_NAME);
  document.title = UI_APP_NAME + ' · ' + t('app.title');
  const b = $('#lang');
  if (b) {
    // The button names the other language in that language
    setText(b, UI.lang === 'ar' ? 'EN' : 'ع');
    b.setAttribute('lang', UI.lang === 'ar' ? 'en' : 'ar');
    b.title = UI.lang === 'ar' ? 'English' : 'العربية';
    b.setAttribute('aria-label', b.title);
  }
  applyTheme(UI.theme);
  UI.chartAt = 0;
}
function toggleLang() {
  applyLang(UI.lang === 'ar' ? 'en' : 'ar');
  try { localStorage.setItem(UI_LANG_KEY, UI.lang); } catch (err) { /* storage blocked: language applies to this session only */ }
}
// Header "Focus" (clinical roles) / "Calm view" (wall display) toggle; want 'full' always shows the whole board
function toggleView(want) {
  if (prefs.role === 'wall') {
    UI.wallFull = want === 'full' ? true : !UI.wallFull;
    return;
  }
  UI.focus = want === 'full' ? false : !UI.focus;
  try { localStorage.setItem(UI_VIEW_KEY, UI.focus ? 'focus' : 'full'); } catch (err) { /* storage blocked: view applies to this session only */ }
}
// body[data-view] drives the layout in the shell CSS; the button states what is on, in text
function applyView() {
  const view = uiLayout();
  if (document.body && document.body.dataset.view !== view) {
    document.body.dataset.view = view;
    UI.chartAt = 0;
  }
  const b = $('#view');
  if (!b) return;
  const wall = prefs.role === 'wall';
  setText(b, t(wall ? 'view.calm' : 'view.focus'));
  const pressed = String(view !== 'full');
  if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
  const tip = t(wall ? 'view.tipCalm' : 'view.tipFocus');
  if (b.title !== tip) b.title = tip;
}
function syncControls() {
  const sp = $('#speed');
  if (sp && document.activeElement !== sp && sp.value !== String(S.speed)) sp.value = String(S.speed);
  const rl = $('#role');
  if (rl && document.activeElement !== rl && rl.value !== prefs.role) rl.value = prefs.role;
  const au = $('#auto');
  if (au) {
    au.checked = !!prefs.autoAccept;
    au.disabled = !canAct('placement');
    au.title = au.disabled ? 'Policy can be changed by ' + approverLabels('placement') : '';
  }
  if (document.body && document.body.dataset.role !== prefs.role) document.body.dataset.role = prefs.role;
  applyView();
}
// Sign-out: a role change ends any break-glass grants and pending order state.
// The wall display always comes back in its calm view.
function setRole(role) {
  prefs.role = role;
  UI.glass.clear();
  UI.order = null;
  UI.wallFull = false;
}
function checkAutoLock() {
  if (!ROLES[prefs.role].detail) return;
  if (Date.now() - UI.lastInput < UI_LOCK_MS) return;
  audit('Session auto-locked after 5 min inactivity');
  setRole('wall');
  const sel = $('#role');
  if (sel) sel.value = 'wall';
  enforceModalAccess();
  toast('Session locked after 5 min without input. Showing wall display.');
}

/* ---------- Actions ---------- */
function findSugg(id) { return S.sugg.find(s => s.id === id) || null; }
function handleAction(el) {
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  UI.lastInput = Date.now();
  const act = el.id === 'pause' ? 'pause' : el.id === 'theme' ? 'theme' : el.dataset.act;
  const id = el.dataset.id;
  switch (act) {
    case 'pause':
      S.running = !S.running;
      UI.lastTick = Date.now();
      break;
    case 'theme':
      toggleTheme();
      break;
    case 'lang':
      toggleLang();
      break;
    case 'view':
      toggleView(id === 'full' ? 'full' : null);
      break;
    case 'scenario':
      if (!SCEN[id]) return;
      runScenario(id);
      toast('Scenario started: ' + ((SCEN_LABEL && SCEN_LABEL[id]) || id));
      break;
    case 'reset':
      if (UI.modal) closeModal();
      init();
      UI.glass.clear();
      UI.live.clear();
      UI.lastTick = Date.now();
      UI.chartAt = 0;
      toast('Simulation reset');
      break;
    case 'mci':
      if (!UI_MCI_ROLES.includes(prefs.role)) {
        audit('Blocked: MCI declaration attempt (' + ROLES[prefs.role].label + ')');
        toast(t('t.mciRole'));
        break;
      }
      if (UI_API.declareMci) {
        uiCall('declareMci', !S.mciDeclared);   // sets the flag, audits and re-evaluates the mode
      } else {
        S.mciDeclared = !S.mciDeclared;
        audit(S.mciDeclared ? 'MCI declared' : 'MCI declaration stood down');
        uiCall('updateMode');   // apply the mode rules now instead of at the next sim minute
      }
      toast(S.mciDeclared ? t('t.mciOn') : t('t.mciOff'));
      break;
    case 'demoPrealert':
      uiReceivePreAlert(demoPreAlert());
      return;   // the receiver re-renders
    case 'accept': {
      const s = findSugg(id);
      if (!s) { toast('That suggestion is no longer valid.'); break; }
      if (!canAct(s.type)) {
        audit('Blocked: accept attempt on "' + s.title + '" (' + ROLES[prefs.role].label + ' lacks approval rights)');
        toast('Needs ' + approverLabels(s.type) + ' sign-in. Attempt logged.');
        break;
      }
      toast(accept(s, 'manual') ? 'Accepted: ' + s.title : 'Could not apply: ' + s.title);
      break;
    }
    case 'dismiss': {
      const s = findSugg(id);
      if (!s) { toast('That suggestion is no longer valid.'); break; }
      if (!canAct(s.type)) { toast('Needs ' + approverLabels(s.type) + ' sign-in.'); break; }
      dismiss(s);
      toast('Dismissed for 10 min: ' + s.title);
      break;
    }
    case 'acceptAll': {
      if (!canAct('placement')) { toast('Needs ' + approverLabels('placement') + ' sign-in.'); break; }
      let ok = 0;
      for (const s of S.sugg.filter(x => x.type === 'placement')) if (S.sugg.includes(s) && accept(s, 'bulk')) ok++;
      toast(ok ? 'Accepted ' + nounCount(ok, 'bed placement') : 'No placements could be applied.');
      break;
    }
    case 'patient':
      openPatient(id);
      break;
    case 'breakglass': {
      const p = P(id);
      if (!p) { toast(t('t.gone')); closeModal(); break; }
      if (ROLES[prefs.role].detail !== 'assigned') break;
      const reason = uiReason('#bg-reason');
      if (reason.length < UI_REASON_MIN) {
        toast(t('o.short'));
        const input = $('#bg-reason');
        if (input) input.focus();
        return;
      }
      UI.glass.add(p.id);
      audit('BREAK-GLASS: ' + uiEnc(p) + ' · reason: ' + reason);
      toast(t('t.glass'));
      UI.order = null;
      openModal('patient', p.id);
      break;
    }
    case 'order': {
      const p = P(id);
      if (!p || !canViewPatient(p)) break;
      if (!placeOrder(p)) return;
      break;
    }
    case 'orderConfirm': {
      const p = P(id);
      if (!p || !canViewPatient(p)) break;
      if (!confirmCaution(p)) return;
      break;
    }
    case 'override': {
      const p = P(id);
      if (!p || !canViewPatient(p)) break;
      if (!confirmOverride(p)) return;
      toast(t('o.overridden', { drug: uiDrugLabel(UI.order.drug) }));
      break;
    }
    case 'close':
      closeModal();
      break;
    case 'family':
      audit('Viewed family desk board');
      openModal('family');
      break;
    case 'standards':
      openModal('standards');
      break;
    case 'datamap':
      openModal('datamap');
      break;
    case 'tab':
      if (id !== 'feed' && id !== 'audit') return;
      UI.tab = id;
      if (id === 'audit') audit(ROLES[prefs.role].audit ? 'Viewed audit log' : 'Blocked: audit log view attempt (' + ROLES[prefs.role].label + ')');
      break;
    default:
      return;
  }
  render();
}
function actionTarget(e) {
  return e.target && e.target.closest ? e.target.closest('[data-act], #pause, #theme') : null;
}
// Mouse/pen act on pointerdown (robust while panels re-render); touch waits for click so scrolling never triggers actions.
function onPointerDown(e) {
  UI.lastPointer = e.pointerType || 'mouse';
  if (e.button !== 0 || e.pointerType === 'touch') return;
  const el = actionTarget(e);
  if (!el) return;
  e.preventDefault();
  handleAction(el);
}
function onClick(e) {
  const modal = $('#modal');
  if (modal && e.target === modal && UI.modal) { closeModal(); return; }   // backdrop
  const keyboard = e.detail === 0;
  const touch = UI.lastPointer === 'touch' && !keyboard;
  if (!keyboard && !touch) return;
  const el = actionTarget(e);
  if (el) handleAction(el);
}
function onChange(e) {
  const el = e.target;
  UI.lastInput = Date.now();
  if (el.id === 'speed') {
    const v = Number(el.value);
    S.speed = [1, 10, 30, 60].includes(v) ? v : 30;
  } else if (el.id === 'role') {
    if (!ROLES[el.value]) { el.value = prefs.role; toast(t('t.roleNA')); return; }
    setRole(el.value);
    audit('Role switched to ' + ROLES[prefs.role].label + ' (demo sign-in; production: SSO + MFA)');
    enforceModalAccess();
    toast(t('t.signedIn', { role: roleLabel(prefs.role) }));
  } else if (el.id === 'auto') {
    if (!canAct('placement')) { el.checked = !!prefs.autoAccept; toast('Only ' + approverLabels('placement') + ' can change this policy.'); return; }
    prefs.autoAccept = !!el.checked;
    audit('Auto-accept of bed placements ' + (prefs.autoAccept ? 'enabled' : 'disabled'));
    toast(prefs.autoAccept ? 'Bed placements will be auto-accepted (logged as policy)' : 'Auto-accept turned off');
  } else {
    return;
  }
  render();
}
function trapFocus(e) {
  const m = $('#modal');
  if (!UI.modal || !m) return;
  const items = Array.from(m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(x => !x.disabled && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], active = document.activeElement;
  if (!m.contains(active)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
function onKeyDown(e) {
  if (e.key === 'Escape' && UI.modal) { e.preventDefault(); closeModal(); return; }
  if (e.key === 'Tab') { trapFocus(e); return; }
  // Enter in a reason field submits its own form (break-glass, override)
  const enter = e.key === 'Enter' && e.target && e.target.dataset ? e.target.dataset.enter : null;
  if (enter && UI.modal) {
    const btn = $('#modal [data-act="' + CSS.escape(enter) + '"]');
    if (btn) { e.preventDefault(); handleAction(btn); }
  }
}
function wireEvents() {
  const markInput = () => { UI.lastInput = Date.now(); };
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, markInput, { passive: true, capture: true }));
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeyDown);

  const box = $('#chart');
  if (box) {
    box.addEventListener('pointermove', e => { UI.hoverPx = e.clientX - box.getBoundingClientRect().left; positionHover(); });
    box.addEventListener('pointerleave', () => { UI.hoverPx = null; positionHover(); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => renderChart(true)).observe(box);
  }
  window.addEventListener('resize', () => renderChart(true));
  wirePreAlerts();
  wireDispatch();
}

/* ---------- Loop & render ---------- */
function render() {
  if (!S) return;
  renderHeader();
  renderJourney();
  renderInbound();
  renderStaff();
  renderPatients();
  renderBeds();
  renderEquipment();
  renderDecisions();
  renderFeed();
  renderChart(false);
  renderSources();
  renderAnnouncements();
  renderModal();
  syncControls();
  broadcastOnModeChange();
}
function loop() {
  const now = Date.now();
  const realDt = Math.min(1, Math.max(0, (now - UI.lastTick) / 1000));
  UI.lastTick = now;
  if (S.running) step(realDt * S.speed);
  checkAutoLock();
  render();
}
function readPref(key, allowed, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return allowed.includes(saved) ? saved : fallback;
  } catch (err) {
    return fallback;   // storage unavailable (private mode / sandbox): keep the default
  }
}
function boot() {
  UI.lang = readPref(UI_LANG_KEY, ['en', 'ar'], 'en');
  UI.focus = readPref(UI_VIEW_KEY, ['focus', 'full'], 'full') === 'focus';
  applyTheme(readPref(UI_THEME_KEY, ['light', 'dark'], 'light'));
  applyLang(UI.lang);
  init();
  wireEvents();
  UI.lastTick = Date.now();
  UI.lastInput = Date.now();
  setInterval(loop, 500);
  render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
