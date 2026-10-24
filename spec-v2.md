# v2 contract: align with the team's WASEL design doc

The team's design doc ("ER Command Dashboard", working name **WASEL**) is the source of truth for v2. v1 already covers: journey, inbound ambulances, priority list, bed board, supplies, staff and fatigue, AI suggestions, roles and masking, audit, outage, forecast. v2 adds what their 90-second demo needs. **spec.md still applies.** These additions are layered on top of it.

Concatenation order becomes: `00-core.js, 10-engine.js, 15-wasel.js, 20-ai.js, 30-ui.js`.

## Engine / data (Agent G owns 00-core.js additions, 10-engine.js edits, the new 15-wasel.js, and 20-ai.js edits)

### 1. Brand
`APP_NAME = 'WASEL'` and `APP_SUB = 'ER Command Dashboard'` in core.

### 2. Operating modes
`S.mode` is one of `'steady' | 'strain' | 'surge' | 'mci'`. `updateMode()` runs once per sim minute in `advance()`, with rules the hospital can read aloud. The rules are stored in `MODE_RULES` in core, with values:
- **strain** if occupancy ≥ 80%, OR any ESI-2 patient has waited > 15 min, OR any patient has boarded > 60 min
- **surge** if 2 or more strain rules hold, OR O-neg units ≤ 10, OR ventsFree() ≤ 2
- **mci** if an active incident has est ≥ 10, OR `S.mciDeclared`

When the mode changes:
- `S.modeSince = t`
- emit `('ems','NCEMA', 'Mode Steady → Strain: <reason>')`
- `audit('Mode changed to …')`
- `S.modeReason` = the rule that fired

**Silent surge** (when entering surge or mci, once per escalation): create one `surge` suggestion (level 1): "Silent surge: recall 2 on-call nurses, hold 2 recovery beds, blood bank standby". On accept: callIn(25) ×2, `S.icu.cap += 2` (recovery-room overflow), emit pharm 'Blood bank standby'.

### 3. Encounters and identity
- Every EMS patient gets `p.enc = 'T-' + (S.nextEnc++)` (start at 101). Walk-ins get `p.enc = p.id`.
- `p.identity = {status: 'confirmed'|'candidate'|'temporary', method: 'face'|'fingerprint'|'nfc'|'emirates-id'|'none', confidence (0–1 or null)}`.
  - EMS patients: 55% candidate (method face, confidence 0.86–0.98), 15% confirmed (nfc), 30% temporary (none).
  - Walk-ins: confirmed (emirates-id).
- On `arrive()`, a candidate identity creates an `identity` suggestion (level 2): "Confirm identity of T-104 (face match 94%)". Its `why` is "Compare with patient, relative or documents. A candidate never merges charts." On accept: status 'confirmed', emit ehr 'Identity confirmed · chart linked via Riayati'.

### 4. Safety summary
`p.safety = {allergies: string[] | null, anticoagulant: bool | null, bloodType: string | null, source: 'Riayati'|'Malaffi'|'NABIDH'|null, asOf: 'YYYY-MM-DD' | null, restricted: bool}`.
- Temporary identity → all null (**Unknown**).
- Otherwise:
  - allergies drawn from `['Penicillin','Sulfonamides','NSAIDs','Latex','Contrast media','Morphine']`: 25% one item, 5% two, 70% `[]` (confirmed none)
  - anticoagulant true 10% (when true, also set `p.meds = ['Warfarin']` or `['Apixaban']`)
  - bloodType from realistic UAE mix
  - source: Riayati 50%, Malaffi 30%, NABIDH 20%
  - asOf: a date within the last 2 years
  - 3% `restricted` (opted out), which shows "Restricted by patient" and is treated as Unknown
- Also add `p.history`: 0–2 chronic conditions from `['Type 2 diabetes','Hypertension','Asthma','CKD stage 3','Atrial fibrillation']`, each with source and date.

### 5. ATMIST pre-alert
`p.atmist = {age, time, mechanism, injuries, signs: {hr, sbp, rr, spo2, gcs}, treatment}` for EMS patients, built from COND plus the incident.
- Mechanism examples: 'Driver, frontal collision ~100 km/h', 'Rear passenger, rollover', 'Trapped on 9th floor, smoke exposure 20 min'.
- Treatment examples: 'Oxygen 15 L/min', 'Pelvic binder', '1 L saline', 'Burns dressings, 1 L Hartmann's'.
- GCS: 15, or 9–13 if avpu was V.

In MCI mode, field patients also carry `p.start` = 'red' (ESI 1–2) | 'yellow' (ESI 3) | 'green' (ESI 4–5), the START colour shown on inbound cards.

### 6. External pre-alerts (face-ID responder app)
`receivePreAlert(msg)` in 15-wasel.js follows FACE_ID_INTEGRATION.md:
- validate the shape
- if `msg.encounter` already exists → update vitals and ETA only (no duplicate)
- otherwise create an incident if none is active ('Responder pre-alert'), a patient (cond chosen by ESI/priority: 1→'polytrauma', 2→'femur', 3→'abdo', 4→'wrist', 5→'whiplash'), with v from atmist.signs, identity, safety and atmist from msg, then an ambulance with eta = t + etaMin·60 (sceneUntil = t, so status 'enroute')
- START priorities map red→1, yellow→3, green→4, black→5
- emit `('ems','FHIR','Pre-alert T-104 received from responder app · identity candidate (face 94%)')`, audit('Pre-alert received: T-104')
- return `{ok: true, encounter}`, or `{ok: false, error}`

Never accept names or images. Ignore any field other than those documented.

### 7. Tasks: owner, clock, escalation
Every suggestion gets `s.owner` (a role label: 'Receiving nurse' for prearrival/identity/placement, 'Charge nurse' for staffing/capacity/supply/surge/outage, 'Physician' for retriage/needvent) and `s.escalatesAt = s.at + ESC_MIN[level]·60` (ESC_MIN = {1: 3, 2: 6, 3: 10}).

In aiPlan, if `t > escalatesAt` and not yet escalated:
- `s.escalated = (s.escalated || 0) + 1`
- owner moves Receiving nurse → Charge nurse → ED coordinator
- level = max(1, level − 1)
- escalatesAt = t + ESC_MIN[level]·60
- emit roster 'Escalated: <title> → <owner>'
- audit

The UI shows the owner, the age clock and "escalates in m:ss".

### 8. Lobby: leave-without-being-seen risk
Waiting ESI 4–5 patients waiting > 60 min → an `lwbs` suggestion (level 3): "P-1020 at risk of leaving without being seen (72 min): offer fast-track or the partner clinic (live wait 15 min)". On accept: if a fast-track bed is free, place them there; otherwise mark `p.clinicOffer = true` and emit.

### 9. Clinical safety helpers (pure, for the patient drawer)
- `checkOrder(p, drug)` → `{ok: bool, hardStop: bool, reason}`.
  - Drug list `DRUGS`: Amoxicillin (penicillin class), Ceftriaxone, Morphine, Ibuprofen (NSAID), Ketorolac (NSAID), Heparin, Tranexamic acid, Paracetamol, IV contrast (contrast media).
  - Allergy class match → hard stop.
  - Heparin when anticoagulant true → hard stop (interaction).
  - Allergies null → `{ok: true, hardStop: false, reason: 'Allergy status UNKNOWN: ask patient or family before giving'}`.
  - Restricted → same as unknown.
- `overrideOrder(p, drug, reason)` → audit 'Override hard stop: <drug> for <enc> · reason: …' (requires reason ≥ 10 chars), emit ehr 'MedicationRequest …'.
- `sbar(p)` → `{s, b, a, r}` strings built from atmist, history, NEWS2, flag and plan (dispo / current location).

### 10. Family reunification
`familyBoard()` → `[{enc, initials, status: 'Arriving'|'Waiting'|'In treatment'|'In surgery'|'ICU'|'Admitted to ward'|'Discharged', since}]` for MCI patients (include done ones by tracking `S.reunify` entries appended on leave). No medical details.

### 11. Roles
Add `nurse: {label: 'Nurse (A. Haddad)', names: 'partial', detail: 'assigned', audit: false, act: ['placement','prearrival','identity','lwbs'], nurseId: 'N1'}`. Then:
- add 'identity', 'lwbs' and 'surge' to charge.act
- add 'identity' to physician.act
- add `SUGG_LABEL` entries: identity 'Identity', lwbs 'Lobby', surge 'Surge'

## UI (Agent H owns shell.html and 30-ui.js)
1. **Branding.** Header title "WASEL", subtitle "ER Command Dashboard · Demo General Hospital". `<title>WASEL · ER Command Dashboard</title>`.
2. **Mode chip** in the header, next to the clock: "STEADY / STRAIN / SURGE / MCI" with a level colour, a shape glyph (● ◆ ▲ ■) and a tooltip showing modeReason. In MCI, the journey strip's tile 1 reads "MCI declared · <incident>".
3. **Inbound cards = pre-alert cards.**
   - encounter id, START colour chip in MCI (text "RED"/"YELLOW"/"GREEN" plus colour) or ESI
   - identity chip: "Candidate · face 94%" / "Confirmed · NFC" / "Temporary ID"
   - a one-line ATMIST: "45y · driver, frontal collision · HR 124 BP 96 SpO₂ 92 GCS 14 · pelvic binder"
   - safety flags: "⚠ Penicillin" / "Allergies: UNKNOWN" / "Anticoagulant"
   - wall display shows encounter id + priority + ETA only
4. **Patient drawer** (patient modal), top to bottom:
   1. critical-allergy banner (red: "ALLERGY: Penicillin · Riayati 2025-11-02", amber: "Allergies UNKNOWN: ask patient/family", grey: "No known allergies · Malaffi 2026-01-10")
   2. identity status
   3. field report (ATMIST)
   4. vitals + NEWS2 (keep v1)
   5. history summary with source and date per line
   6. SBAR handover block
   7. **Order a medication**: select from DRUGS + "Order" button → `checkOrder`. A hard stop shows a red blocking box with the reason, plus an override field (reason ≥ 10 chars) and a confirm button that calls `overrideOrder`. A non-blocking warning shows amber.
   8. access-log lines for this patient (filter S.audit by enc/id)
   9. the FHIR bundle (keep v1)
5. **Break-glass.** A role with `detail: 'assigned'` (nurse) opening a patient not assigned to N1 sees the warning "You are not in this patient's care team", a reason field (≥ 10 chars) and "Break glass". This opens the drawer and writes `audit('BREAK-GLASS: <enc> · reason: …')`. Wall display: no access, no break-glass. IT/Admin: "No chart rights".
6. **Decision cards:** show "Owner: Charge nurse · 2:41 open · escalates in 0:19" and an "Escalated ×1" chip. New card types: identity, lwbs, surge.
7. **Family board:** footer button "Family desk" opens a modal with `familyBoard()` rows (enc, initials, status, since). Add the caption "No medical details are shown here."
8. **Arabic toggle:** header button "ع / EN". Sets `<html lang="ar" dir="rtl">`. Wrap every static label the UI renders (panel titles, journey labels, section headers, legends, buttons, mode names, empty states) in `t('key')`, with an `I18N = {en: {...}, ar: {...}}` dictionary. Clinical codes, numbers and patient ids stay unchanged. Keep the translations short and correct (MSA). The layout must not break in RTL.
9. **BroadcastChannel listener.** `new BroadcastChannel('wasel-prealert')` (wrapped in try/catch). `onmessage` → `receivePreAlert(e.data)`, then toast "Pre-alert T-104 received" and render. Also expose `window.WASEL = {receivePreAlert}`.
10. **Toolbar:** add a "Declare MCI" button (`data-act="mci"`, sets S.mciDeclared, audit) and a "Simulate responder pre-alert" button (`data-act="demoPrealert"`). The latter calls `receivePreAlert` with a realistic sample (candidate face match 94%, Penicillin allergy, ESI 2, ETA 8 min) so the demo works without the face-ID app.
