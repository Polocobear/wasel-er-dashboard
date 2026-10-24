# ER Crisis Command Center: presentation notes

**One-line pitch:** "AI does the watching, counting and matching. Humans do the judging, treating and deciding."

**To run it:** open `er-command-center.html` in Chrome or Edge. Nothing needs installing and it works offline. All data is simulated.

---

## 90-second demo script
1. **Opening (10 s).** "During a mass emergency, the ER's data is split across 10 systems. This screen brings all 10 together. The bottom strip shows each system feeding in live: EHR, registration, beds, lab, radiology, pharmacy, asset tags, monitors, ambulance dispatch and rostering."
2. **The journey (10 s).** Point at the top strip. "We track every patient from the moment the emergency is detected, through first responders, en route, waiting and treatment, to their outcome."
3. **Click "Highway pile-up" (15 s).** The incident appears and ambulances show up under *Inbound* with field triage and ETAs. "Before the first ambulance arrives, the AI suggests reserving a resus bay and paging the trauma team." Click **Accept**.
4. **The deterioration catch (20 s).** Wait for a red row in *Patients* reading "Deteriorating: HR 94→126, SBP 118→92 in 12 min · Pattern consistent with internal bleeding." "This patient was triaged as stable. No nurse could watch 20 people in a crowded waiting room. The AI did, and it suggests re-triage." Click **Accept** on the re-triage card, then on the bed placement card.
5. **Resources (10 s).** Point at *Equipment & supplies*: "O-negative blood runs out in about 30 minutes at the current rate. The request is one click."
6. **Nurse fatigue (10 s).** Click **Staff shortage**. "Three nurses were pulled to ICU. The AI rebalances their patients by workload and hours on shift, and flags anyone past 12 hours."
7. **Privacy (10 s).** Switch the role to **Wall display**. "On the public wall screen, names become initials and nothing can be clicked. Every record view and every decision goes into an audit log, which only IT can open."
8. **Closing (5 s).** Open **Standards & security**. "Every feature maps to a named standard."

## How it maps to the rubric
| Criterion | Where it shows |
|---|---|
| UI & data integration (40%) | One screen, no tabs for critical data. Clinical terms: ESI, NEWS2, ICD-10-CM, LOINC. All 10 source systems shown live in the footer, with a **Data map** of system → standard → panel. |
| Sample code (30%) | Live simulation with 6 scenarios: normal day, pile-up, fire, staff shortage, equipment failure, system outage. The AI reacts to each one. Security is built in: role-based access, masking, audit log, auto-lock, escaped rendering. |
| Standards (15%) | **Standards & security** button: HL7 FHIR R4, HL7 v2.5, IEEE 11073, LOINC, ICD-10-CM, SNOMED CT, ESI, NEWS2, ISO 9241-210, WCAG 2.2, HIPAA Security Rule / NIST SP 800-66, ISO 27001, UAE Federal Law No. 2 of 2019, ADHICS. |
| Innovation (15%) | Targets the three pain points the brief names: **communication breakdowns** (pre-arrival prep, I-PASS handovers, live feed), **nurse fatigue** (load and hours balancing, relief suggestions), **delayed decisions** (deterioration watch, bed matching, shortage countdowns, overflow forecast). Every suggestion explains *why*, and a human approves it. |

## What the AI does vs what humans do
- **AI watches:** vital-sign trends for every waiting patient (NEWS2 plus a 12-minute trend).
- **AI counts:** beds, blood, kits, oxygen, ventilators, CT queue, nurse load and hours, and forecasts when the ED fills up.
- **AI matches:** patient → bed zone → nurse with the lightest load → nearest free equipment.
- **Humans decide:** every suggestion has Accept / Dismiss. Optionally, bed placements can be auto-accepted.

## Check before presenting
- **Rules:** confirm with an organizer that AI-assisted code is allowed, and disclose it if they ask.
- **Codes:** the ICD-10-CM codes are believed correct, but spot-check two or three of them, e.g. T59.811A smoke inhalation, S36.90XA intra-abdominal injury.
- **Local regulations:** UAE Federal Law No. 2 of 2019 and ADHICS (Abu Dhabi). If judges ask about Sharjah, mention that Emirates Health Services runs the northern emirates.
- **Simulated data:** all names and data are fictional. Say so if asked.
