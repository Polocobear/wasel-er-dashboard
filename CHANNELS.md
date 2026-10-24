# WASEL low-friction flow: channel contract (v3)

**Principle:** no new typing for anyone. Operators and paramedics **tap and slide**, while vitals stream from monitors. The system computes priority, dispatch and destination, and humans confirm with one tap. WASEL sits on top of existing systems (read-only in phase 1) and adds no double entry.

All pages are served from one origin (Cloudflare Pages, or `serve.py` locally) and talk over `BroadcastChannel`. Every listener ignores malformed messages and deduplicates by id.

## 1. Call-taker → dashboard: `BroadcastChannel('wasel-incident')`
Sent by `dispatch.html` when the operator confirms a dispatch:
```json
{ "type": "incident", "v": 1, "id": "CALL-4821",
  "kind": "rtc",
  "place": "E311 highway, km 42",
  "casualties": 6,
  "severity": "major",
  "trapped": true,
  "hazards": ["fuel"],
  "units": { "ambulances": 3, "rescue": 1, "fire": 1 },
  "ts": 1729780000000 }
```
- `kind`: `rtc`, `fire`, `medical`, `chemical` or `other`
- `severity`: `minor`, `serious` or `major`
- `hazards`: `fire`, `fuel`, `chemical`, `electrical` or `crowd`
- `place` is a place, never a person. **No caller identity or phone number is sent.**
- Dashboard behaviour: create an **unconfirmed incident** (journey tile 1), then dispatch `units.ambulances` ambulances. The `casualties` are split across them using MIX by kind: rtc → pileup, fire → fire, else walkin. Arrivals follow normal engine timing. A repeated `id` updates the incident; it does not duplicate it.

## 2. Responder → dashboard: `BroadcastChannel('wasel-prealert')`
Same message as FACE_ID_INTEGRATION.md v1. Two **optional** fields are added; older listeners ignore them:
```json
"triage": { "avpu": "V", "breathing": "laboured", "bleeding": "heavy-controlled",
            "perfusion": "weak-fast", "pain": 7, "regions": ["chest","pelvis"],
            "burnsPct": 0, "ageBand": "adult" },
"destination": { "hospital": "Demo General Hospital", "reason": "Trauma bay free · O-neg 18 · 12 min", "etaMin": 12 }
```
`atmist` is **generated from the sliders** (no free text required). `priority` is computed by the responder rules and shown with its reasons.

## 3. Dashboard → responders and dispatch: `BroadcastChannel('wasel-capacity')`
Broadcast by the dashboard every 5 s, and on any mode change:
```json
{ "type": "capacity", "v": 1, "hospital": "Demo General Hospital",
  "mode": "strain", "edBedsFree": 6, "resusFree": 2, "traumaFree": 1, "icuFree": 1,
  "oNeg": 14, "ctOnline": 2, "diversion": false, "ts": 1729780000000 }
```
Only capacity leaves the hospital, never patient data. The responder and dispatch pages also simulate 3 fictional partner hospitals, marked "(demo)":
- one trauma centre
- one burns unit
- one stroke-capable general hospital

Each has slowly drifting capacity, so the destination logic has real choices.

---

# v4 satellite screens: state + command channels

New staff screens: `kiosk.html`, `commander.html`, `supply.html`, `equipment.html` and `admin.html`. They do **not** run their own simulation. They mirror the dashboard through a de-identified state snapshot and send requests back as commands. All of the dashboard side lives in **`src/40-bridge.js`**, concatenated last into the dashboard build.

## 4. Dashboard → screens: `BroadcastChannel('wasel-state')`
Sent every 2 s. **Never contains a name, MRN, Emirates ID or image.** Patients appear by `enc`/`id` only.
```json
{ "type": "state", "v": 1, "ts": 1729780000000, "simClock": "19:42", "hospital": "Demo General Hospital",
  "mode": "mci", "modeReason": "Active incident ≥10 casualties", "downtime": false,
  "incidents": [{"id":"INC-1","name":"Multi-vehicle collision","place":"E311 highway, km 42","est":22,"kind":"pileup","unconfirmed":false}],
  "inbound": [{"enc":"T-104","amb":"AMB-12","status":"enroute","etaMin":6,"priority":{"system":"START","level":"red"},"esi":1,
               "label":"Multiple injuries (polytrauma)","identity":"candidate","bed":"R2","team":"trauma team","readiness":{"score":3,"of":5,"items":[{"k":"bed","ok":true}]}}],
  "beds": {"total":30,"free":6,"cleaning":2,"reserved":1,"byZone":{"R":{"free":1,"total":4},"T":{"free":0,"total":6},"A":{"free":4,"total":12},"F":{"free":1,"total":8}}},
  "bedList": [{"id":"R1","zone":"R","status":"occupied","esi":1}],
  "waiting": [{"id":"P-1043","enc":"P-1043","token":"A-017","esi":3,"news":5,"waitMin":22,"kiosk":true,"lwbsRisk":false,"flag":"NEWS2 5: review within 30 min"}],
  "capacity": {"edBedsFree":6,"resusFree":1,"traumaFree":0,"icuFree":1,"orFree":2,"ctOnline":2,"ctQueue":3,"ventsFree":4,"ventsTotal":10,"monitorsFree":9,"diversion":false},
  "supplies": [{"key":"blood","label":"O-negative blood","unit":"units","qty":14,"par":16,"cap":40,"perHour":12,"minutesLeft":70,"pending":false}],
  "requests": [{"id":"S12","item":"blood","title":"Request 20 units …","why":"…","level":1,"qty":20,"needsSecond":true,"approvals":["Charge nurse"],"status":"awaiting-second"}],
  "staff": {"onDuty":13,"avgLoad":0.72,"fatigued":2,"incoming":1,"doctors":6,
            "nurses":[{"id":"N1","name":"A. Haddad","hours":11.6,"load":0.84,"status":"on","fatigue":"tired"}]},
  "tasks": [{"id":"S9","type":"placement","title":"Place …","owner":"Charge nurse","openSec":95,"escalated":1,"level":1}],
  "family": [{"enc":"T-104","initials":"—","status":"In treatment","since":"19:31"}],
  "assets": [{"id":"V-03","type":"ventilator","state":"in-use","loc":"R2","zone":"R"},{"id":"D-02","type":"defibrillator","state":"free","loc":"Corridor T","zone":"T"}],
  "audit": [{"t":"19:41","role":"Charge nurse","text":"Accepted: …"}],
  "breakGlass": [{"i":0,"t":"19:40","role":"Nurse (A. Haddad)","text":"BREAK-GLASS: T-104 · reason: …","reviewed":false}],
  "devices": [{"id":"TAB-AMB-12","kind":"Responder tablet","status":"online","lastSeenSec":4}] }
```
The `audit` and `breakGlass` arrays are only for `admin.html`. Other screens must ignore them.

## 5. Screens → dashboard: `BroadcastChannel('wasel-command')`
```json
{ "type": "command", "v": 1, "id": "cmd-8f3a2c", "from": "kiosk", "role": "Lobby kiosk", "action": "kioskCheckin", "args": {} }
```
The bridge only accepts these actions, from these screens. Everything is audited, and anything else is rejected and audited:
| action | from | args | effect |
|---|---|---|---|
| `kioskCheckin` | kiosk | `{token, idMethod:'emirates-id'|'temporary', ageBand:'child'|'adult'|'elderly', sex, complaint:'chestPain'|'abdoPain'|'dyspnea'|'fever'|'injury'|'other', vitals:{hr,sbp,rr,spo2,temp}, lang:'ar'|'en'}` | New walk-in, waiting, `p.kiosk=true`, `p.token`; ESI suggested from NEWS2 + complaint; a nurse confirms (identity card / retriage flow) |
| `declareMci` | commander | `{on}` | Same as the dashboard's Declare MCI |
| `divert` | commander | `{minutes}` | `S.diversionUntil = t + minutes·60` + emit |
| `callIn` | commander | `{count, skill}` | `callIn(25)` × count, emit with skill |
| `approveRequest` | supply | `{id, approver}` | First approval of a supply suggestion. If `qty ≥ 20` (large), mark `awaiting-second`; otherwise accept |
| `secondApprove` | supply | `{id, approver}` | Must be a different approver from the first; then accept |
| `killSwitch` | admin | `{on}` | Downtime mode: dashboard read-only overlay + paper/voice banner; sim keeps running |
| `reviewBreakGlass` | admin | `{i}` | Mark that break-glass entry reviewed |
| `assetState` | equipment | `{id, state:'free'|'cleaning'|'out-of-service'}` | Update the asset overlay |
