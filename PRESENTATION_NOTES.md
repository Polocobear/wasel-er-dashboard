# WASEL: presentation notes

**Live:** https://wasel-er-dashboard.pages.dev · **Code:** https://github.com/Polocobear/wasel-er-dashboard
**Other pages:** `/responder.html` (paramedic app) · `/architecture.html` (data-flow diagram and data map) · [COMPLIANCE.md](COMPLIANCE.md) (standards justification)

**Pitch line:** "AI watches, counts and matches. Humans judge, treat and decide."
**Closing line (team's own):** "We did not add a screen. The next bed, the next ambulance and the next nurse action are the same system."

---

## 90-second demo, following the team's script
Before you start, set the role to **Charge nurse**.

1. **Steady board (10 s).** The mode chip by the clock reads **STEADY**. "Ten hospital systems feed one screen." Point at the source chips along the bottom.
2. **Pre-alert (15 s).** Click **Simulate responder pre-alert**. An inbound card appears: *T-9xx · Candidate · face 94% · ⚠ Penicillin*, with the one-line ATMIST and ETA. "The paramedic identified the patient and sent the field report before arrival."
3. **Accept (10 s).** In the **AI decision queue**, accept *Prepare for AMB-…: reserve Resus R… page trauma team*. The bed shows **resv** on the bed board. "Bed, team and blood are ready before the doors open."
4. **Patient drawer and hard stop (15 s).** Click a patient row. Point out the **allergy banner** at the top, history with source and date, and the SBAR. Under **Order a medication**, pick a drug that clashes with the allergy (e.g. Amoxicillin for a Penicillin allergy, or Ibuprofen for an NSAID allergy). A **hard stop** appears, and overriding it needs a written reason, which is logged.
5. **Mass casualty (15 s).** Click **Highway pile-up**, or **Declare MCI**. The mode flips to **MCI**, reds show START colours, the **silent surge** card appears (recall nurses, recovery-room overflow, blood bank standby), and the **diversion** card sends ESI 4–5 patients to nearby EDs.
6. **Lobby watch (10 s).** A waiting patient's row turns red: *Deteriorating: HR 94→126, SBP 118→92 in 12 min*. Accept the **re-triage** card. "No nurse can watch 20 people in a waiting room. The system can."
7. **Accountability (5 s).** Point at a card's **Owner · open clock · escalates in m:ss** and an **Escalated ×1** chip. Unanswered tasks move up to the charge nurse, then the ED coordinator.
8. **Audit (5 s).** Switch the role to **IT / Admin** and open the **Audit log** tab: who did what, under which role. IT has no chart rights.
9. **Wall display and Arabic (5 s).** Switch the role to **Wall display**: names become initials and clicking is blocked. Press **ع** for Arabic and right-to-left layout.

**Optional extras:**
- **Nurse role + break-glass:** open a patient who isn't yours → give a reason → it's logged as BREAK-GLASS.
- **Family desk** (footer): status only, no medical details.
- **Standards & security** and **Data map** buttons in the footer.

## Live face-ID demo (laptop only, not on Cloudflare)
1. Start the face service (in the face-service folder): `.venv/bin/uvicorn app:app --port 8000`
2. In this folder: `python3 serve.py`, then open `http://127.0.0.1:8765/er-command-center.html` and `http://127.0.0.1:8765/responder.html` in **the same browser**.
3. On the responder page: open *Enrol demo faces*, tick consent, and enrol a teammate. Then **Identify** → choose the candidate → fill ATMIST → **Send pre-alert**. It appears on the dashboard.
4. If anything fails, use **Simulate responder pre-alert** on the dashboard. It runs the same flow.

## How it maps to the rubric
| Criterion | Where it shows |
|---|---|
| UI & data integration (40%) | One screen. Clinical terms used: ESI, START, NEWS2, ICD-10-CM, LOINC. All 10 source systems are live in the footer, and the Data map / architecture page shows system → standard → panel |
| Code (30%) | Live simulation with 6 scenarios, plus modes, pre-alerts and escalation. 168 automated checks pass. Security: role-based access with 5 roles, wall-display de-identification, break-glass, audit log, auto-lock, escaped rendering, no patient data in storage |
| Standards (15%) | **Standards & security** modal plus COMPLIANCE.md: FHIR R4, HL7 v2.5, IEEE 11073, LOINC, ICD-10-CM, SNOMED CT, ESI, START, NEWS2, ISO 9241-210, WCAG 2.2, ISO 27001, HIPAA/NIST (comparison only), UAE Law No. 2/2019, PDPL 45/2021, ADHICS, NABIDH/Malaffi/Riayati, JCI, NCEMA |
| Innovation (15%) | Targets the brief's three pain points. **Communication breakdowns:** pre-alerts, ATMIST, SBAR, I-PASS. **Nurse fatigue:** load and hours balancing, relief cards. **Delayed decisions:** deterioration watch, bed matching, shortage countdowns, overflow forecast, silent surge |

## What's design, not built (say so if asked)
Lobby kiosk and token display · separate commander screen (MCI shows on the main board) · equipment floor-plan map · hospital-to-hospital transfers · insurance · readiness score · trauma-activation rules · real NFC wristbands · supply second approver · kill switch.

## Check before presenting
- Confirm with an organizer that AI-assisted code is allowed, and disclose it if they ask.
- Law article numbers and ICD-10 codes are marked "verify" in COMPLIANCE.md. Spot-check two or three.
- All data and names are fictional.
- Biometrics are candidate-only and confirmed by a nurse. No face images leave the device.
