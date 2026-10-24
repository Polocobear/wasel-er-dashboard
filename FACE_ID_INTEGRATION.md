# Connecting the face-ID responder app to the WASEL dashboard

Give this file to the agent building the face-ID / responder app. It defines how a responder's pre-alert reaches the ER dashboard live.

## Transport
Serve both pages from the **same local server** (same origin), for example `python3 -m http.server 8765` in a folder that holds both HTML files. The responder app then sends each pre-alert on a `BroadcastChannel`:

```js
const ch = new BroadcastChannel('wasel-prealert');
ch.postMessage(preAlert);   // the shape is below
```

The dashboard listens on the same channel. It turns each message into an inbound ambulance with a pre-alert card, and the charge nurse can accept it to reserve a bed. Sending the same `encounter` id again **updates** that pre-alert (new vital signs or ETA) instead of creating a duplicate.

If the two pages can't share an origin, the dashboard also exposes `window.WASEL.receivePreAlert(preAlert)`, which you can call from the browser console or from an iframe parent.

## Message shape (version 1)
```json
{
  "type": "prealert",
  "v": 1,
  "encounter": "T-104",
  "identity": {
    "status": "candidate",
    "method": "face",
    "confidence": 0.94,
    "display": "F.K."
  },
  "atmist": {
    "age": "45",
    "time": "19:12",
    "mechanism": "Driver, frontal collision at ~100 km/h",
    "injuries": "Chest wall tenderness, closed left femur fracture",
    "signs": { "hr": 124, "sbp": 96, "rr": 26, "spo2": 92, "gcs": 14 },
    "treatment": "Pelvic binder, 1 L saline, 10 mg morphine IV"
  },
  "priority": { "system": "ESI", "level": 2 },
  "etaMin": 12,
  "safety": {
    "allergies": ["Penicillin"],
    "anticoagulant": false,
    "bloodType": "O+",
    "source": "Riayati",
    "asOf": "2026-03-14"
  }
}
```

**Fields**
- `identity.status`: `confirmed`, `candidate` or `temporary`.
- `identity.method`: `face`, `fingerprint`, `nfc`, `emirates-id` or `none`.
- `identity.confidence`: 0–1. Leave it out for `temporary`.
- `identity.display`: initials only. **Never send a full name, face image or Emirates ID number in this message.**
- `priority.system`: `START` (with `level` `red`, `yellow`, `green` or `black`) or `ESI` (with `level` 1–5).
- `safety.allergies`: `null` means **Unknown**, which is not the same as "no allergies". `[]` means confirmed none.

## Rules the face-ID side must follow
From the team's own design doc, plus the UAE PDPL, which treats biometric data as sensitive:
1. **A match is only ever a *candidate*.** It never merges charts. An authorised nurse confirms identity at the door.
2. **No face images or templates leave the device**, and none are stored in the prototype. Send only the match result, the confidence and the record token.
3. **A failed or slow match never delays care.** The patient continues on a temporary ID (`T-###`).
4. **Use explicit consent rules.** Biometrics stay optional, and patients who opted out show as *Restricted by patient*.
5. **Every lookup is logged** with who, when and why. The dashboard writes its own audit entry when it receives the pre-alert.
