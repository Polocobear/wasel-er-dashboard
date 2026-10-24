# WASEL decision algorithms

> **Explainable algorithms built on validated clinical scores. Every suggestion shows the rule that fired. Humans approve. ML is used only for face matching.**
>
> - **Scores:** NEWS2 (RCP 2017) and ESI v4 triage drive every patient-level decision. WASEL adds a 12-minute trend check on top, and there is no black box.
> - **Visible reasons:** each card on the decision board carries its `why` string, made from the numbers that crossed a threshold (for example "HR 92→110, SBP 121→104 in 11 min").
> - **Human approval:** nothing changes the department until someone taps Accept. One policy can auto-accept, and it covers bed placements only. It is off by default, only a role allowed to approve placements can switch it on, and every change is audited.
> - **Machine learning:** WASEL has one ML component. It matches faces using Facenet512 embeddings, and its output is only a **candidate** identity that a nurse confirms at the door.
> - **Code references:** every rule below is quoted from the code (`src/00-core.js`, `src/10-engine.js`, `src/15-wasel.js`, `src/20-ai.js`, `dispatch.html`, `responder.html`). Wherever this page cites a function, the function is the source of truth.

Each algorithm uses the same six fields: **Purpose**, **Inputs**, **Rule** (the exact thresholds), **Output**, **Why this design** (the evidence or standard behind it) and **Failure mode and safeguard**.

## Contents

- [Part A - Patient-level clinical scores](#part-a---patient-level-clinical-scores)
  - [1. NEWS2 early-warning score](#1-news2-early-warning-score)
  - [2. 12-minute deterioration trend and pattern hints](#2-12-minute-deterioration-trend-and-pattern-hints)
  - [3. Re-triage rule](#3-re-triage-rule)
  - [4. Queue priority](#4-queue-priority)
- [Part B - Placement and staffing](#part-b---placement-and-staffing)
  - [5. ESI-zone bed matching and bed release](#5-esi-zone-bed-matching-and-bed-release)
  - [6. Nurse matching: ESI-weighted workload and fatigue penalty](#6-nurse-matching-esi-weighted-workload-and-fatigue-penalty)
  - [7. Fatigue relief, call-in and orphan reassignment](#7-fatigue-relief-call-in-and-orphan-reassignment)
  - [8. Pre-arrival preparation](#8-pre-arrival-preparation)
  - [9. Leave-without-being-seen risk](#9-leave-without-being-seen-risk)
- [Part C - Department-level rules](#part-c---department-level-rules)
  - [10. Supplies: minutes left and committed demand](#10-supplies-minutes-left-and-committed-demand)
  - [11. Overflow forecast (30 minutes)](#11-overflow-forecast-30-minutes)
  - [12. Ambulance diversion](#12-ambulance-diversion)
  - [13. Operating modes and step-down hysteresis](#13-operating-modes-and-step-down-hysteresis)
  - [14. Silent surge](#14-silent-surge)
  - [15. Equipment and system-failure rules](#15-equipment-and-system-failure-rules)
  - [16. Task ownership and escalation](#16-task-ownership-and-escalation)
- [Part D - Safety and communication](#part-d---safety-and-communication)
  - [17. Allergy and interaction hard stop](#17-allergy-and-interaction-hard-stop)
  - [18. SBAR handover generation](#18-sbar-handover-generation)
  - [19. Face matching (the only machine-learning component)](#19-face-matching-the-only-machine-learning-component)
- [Part E - Field, dispatch and satellite screens](#part-e---field-dispatch-and-satellite-screens)
  - [20. Dispatch unit recommendation](#20-dispatch-unit-recommendation)
  - [21. Destination ranking and ambulance split](#21-destination-ranking-and-ambulance-split)
  - [22. Responder priority: START and ESI](#22-responder-priority-start-and-esi)
  - [23. Readiness score and trauma activation](#23-readiness-score-and-trauma-activation)
  - [24. Kiosk ESI suggestion and two-person supply approval](#24-kiosk-esi-suggestion-and-two-person-supply-approval)
- [What is simulated, not decided](#what-is-simulated-not-decided)
- [Phase 2: where ML could earn its place](#phase-2-where-ml-could-earn-its-place)

## Part A - Patient-level clinical scores

### 1. NEWS2 early-warning score

- **Purpose:** Turn five streamed vital signs, plus oxygen and consciousness, into one validated measure of how unwell a patient is.
- **Inputs:** Respiratory rate, SpO2, supplemental oxygen (`p.onO2`), systolic BP, heart rate, AVPU and temperature. These come from monitors as IEEE 11073 SDC observations with LOINC codes, so nobody has to type them.
- **Rule:** `news2(v, onO2)` in `00-core.js` sums the points in the table below. Before banding, RR, SpO2, SBP and HR are rounded to whole numbers and temperature to 0.1 °C. `news2Parts()` returns the same points one parameter at a time, for the patient drawer.
- **Output:** An aggregate score from 0 to 20 (`p.news`), which `assess()` recomputes after every engine step.
- **Why this design:** NEWS2 is the Royal College of Physicians standard (2017) and is endorsed by NHS England. Its bands have been validated on large adult cohorts. Because WASEL uses it unchanged, any clinician can check a score by hand.
- **Failure mode and safeguard:** WASEL implements SpO2 scale 1 only. Patients with hypercapnic respiratory failure, who need scale 2, will over-score. NEWS2 is validated for adults aged 16 and over, not children or pregnancy. A detached probe or motion artefact can spike a single reading. The safeguards are that the drawer shows each parameter's points, so an artefact is visible at a glance, and that a score only ever raises a card. It never changes ESI, the bed or orders by itself.

| Parameter | 3 | 2 | 1 | 0 | 1 | 2 | 3 |
|---|---|---|---|---|---|---|---|
| Respiratory rate (/min) | ≤ 8 | | 9–11 | 12–20 | | 21–24 | ≥ 25 |
| SpO2, scale 1 (%) | ≤ 91 | 92–93 | 94–95 | ≥ 96 | | | |
| Air or oxygen | | Oxygen | | Air | | | |
| Systolic BP (mmHg) | ≤ 90 | 91–100 | 101–110 | 111–219 | | | ≥ 220 |
| Heart rate (/min) | ≤ 40 | | 41–50 | 51–90 | 91–110 | 111–130 | ≥ 131 |
| Consciousness | | | | Alert | | | Not alert (V, P or U) |
| Temperature (°C) | ≤ 35.0 | | 35.1–36.0 | 36.1–38.0 | 38.1–39.0 | ≥ 39.1 | |

`assess()` applies these response thresholds to **untreated** patients (stage `waiting` or `inbound`):

| NEWS2 | Flag | Card text | RCP 2017 response band |
|---|---|---|---|
| ≥ 7 | `critical`, `det: true` | "NEWS2 n: urgent clinical review" | High: emergency response |
| 5–6 | `serious` | "NEWS2 n: review within 30 min" | Medium: key threshold for urgent response |
| 0–4 | none (unless the trend rule fires) | none | Low |

`aiDrivers()` explains every high score by listing the parameters that score 2 or more, largest first, for example "Score driven by RR 28/min, SpO₂ 88%".

**Known gap:** RCP also triggers an urgent response when a single parameter scores 3. The dashboard does not flag that case unless the total reaches 5. The responder page shows it ("Low–medium: one parameter scores 3").

### 2. 12-minute deterioration trend and pattern hints

- **Purpose:** Catch a patient who is getting worse while their score still looks moderate, for example compensated shock in the waiting room.
- **Inputs:** `p.hist`, one vital-sign sample per simulated minute written by `sample()` and capped at 90 samples, together with the current vital signs.
- **Rule:** `assess()` (`20-ai.js`) takes as its reference sample the oldest sample within `AI_TREND_SEC` = 12 min. It then applies these steps:
  - `trend` = NEWS2 now − NEWS2 at the reference sample.
  - The vital-sign deltas are tested only if the reference is at least `AI_MIN_SPAN` = 4 min old. Shorter spans count as noise.
  - Each delta has a threshold: **HR up ≥ 15**, **SBP down ≥ 12 mmHg**, **SpO2 down ≥ 3 points** and **RR up ≥ 6**.
  - The rules are checked in order, and the first one that holds sets the flag:
    1. Untreated, any delta fires, and (trend ≥ 2 **or** NEWS2 ≥ 5): `critical`, `det: true`, "Deteriorating: HR 92→110, SBP 121→104 in 11 min".
    2. Untreated and NEWS2 ≥ 7: `critical`, `det: true`.
    3. Untreated and NEWS2 ≥ 5: `serious`.
    4. Boarding for more than 20 min: `serious`, "Boarding n min: awaiting ICU bed", plus ICU, OR or ward occupancy (`aiBoardHint`).
- **Output:** `p.flag = {level, det, text, hint}` and `p.trend`.
- **Pattern hint (`aiPattern`):** The hint names the physiology the changes fit. It is never a diagnosis.
  - HR up and SBP down with temperature ≥ 38 °C: "Pattern consistent with septic shock".
  - HR up and SBP down otherwise: "Pattern consistent with internal bleeding / shock".
  - SpO2 down or RR up: "Pattern consistent with respiratory deterioration".
  - Anything else: "Physiological trend worsening".
- **Why this design:** NEWS2 guidance asks clinicians to watch the trend as well as the snapshot. A rising heart rate with a falling systolic pressure is the classic sign of compensated shock, often before the score crosses 5. The 4-minute minimum span and the deltas are set wider than the simulated monitor noise (about ±1.5 bpm and ±1.5 mmHg per minute), so one noisy reading cannot fire the rule.
- **Failure mode and safeguard:** The trend rule needs at least 4 minutes of history, so a patient who collapses within minutes of arrival is caught by the NEWS2 thresholds instead. Patients already in a bed get no flag, because they are under direct nursing care, so the rule cannot replace bedside observation. The wording is always "consistent with". The flag only raises a re-triage card (section 3), which a physician approves.

### 3. Re-triage rule

- **Purpose:** Propose a more urgent ESI level when an untreated patient deteriorates, or when the field crew raises the priority.
- **Inputs:** `p.flag.det`, `p.news`, systolic BP, current `p.esi`, and updated pre-alerts from the responder.
- **Rule (`aiPlan` step 3):** For each waiting or inbound patient whose `flag.det` is true:
  - The target is **ESI 1 if NEWS2 ≥ 9 or SBP ≤ 85 mmHg**, otherwise **ESI 2**.
  - A card is raised only if the target is more urgent than the current level (`to < p.esi`).
  - The card is level 1 (Critical) and its owner is the Physician.
- **Field re-triage (`wslProposeFieldRetriage`):** If an updated pre-alert carries a more urgent priority than the patient's current ESI, WASEL raises a card. It is level 1 if the target is ESI 1–2 and level 2 otherwise. The card quotes up to three slider reasons from `waselTriageWhy()`. The priority is never changed silently.
- **Output:** A card such as "Re-triage P-1043 from ESI 3 to ESI 2". `accept()` then sets `p.esi`, marks `p.retriaged` and drops any pending placement for the patient, so the bed is re-planned in the right zone.
- **Why this design:** In ESI v4, danger-zone vital signs move a patient to ESI 2, and needing an immediate life-saving intervention means ESI 1. NEWS2 ≥ 9 and SBP ≤ 85 are deliberately set beyond the RCP high-risk trigger of 7, so WASEL proposes ESI 1 only for frank instability.
- **Failure mode and safeguard:** WASEL never proposes a **less** urgent level, because no rule down-triages. A physician confirms every change. If the physician dismisses the card, the same proposal stays quiet for 10 simulated minutes (`dismiss`) and then returns if the patient is still deteriorating.

### 4. Queue priority

- **Purpose:** Decide who gets the next bed, and order the patient list, using one transparent number.
- **Inputs:** ESI, NEWS2, positive trend, minutes waited (stage `waiting` only) and whether a critical flag is active.
- **Rule (`priority(p)`):**
  `priority = (6 − ESI) × 20 + NEWS2 × 4 + max(0, trend) × 6 + min(waitMin, 60) × 0.4 + (critical flag ? 25 : 0)`
- **Output:** A score where higher means sooner. `aiPlan` uses it to sort the placement queue. The patient list uses it through `byPriority()` in `30-ui.js`. The bed-release rule in section 5 uses it with a 15-point margin.
- **Why this design:** Acuity dominates. One ESI level (20 points) is worth 5 NEWS2 points, about 3.3 points of trend, or 50 minutes of waiting. The wait term is capped at 60 minutes, which is 24 points, so a long wait can lift a patient by at most about one ESI level. That limit prevents starvation without ever letting time outrank a sicker patient by two levels. A critical flag adds 25 points, slightly more than one ESI level, so a deteriorating patient jumps the queue.
- **Failure mode and safeguard:** The weights are design choices, not values from the literature. They are written in one line so they can be reviewed and changed. Every placement card prints the inputs ("NEWS2 6 ↑2, deteriorating · Acute zone matches ESI 3 · waited 22 min"), so the charge nurse can see why one patient is ahead of another and dismiss a card to override the order.

## Part B - Placement and staffing

### 5. ESI-zone bed matching and bed release

- **Purpose:** Put each patient in a bed of the right acuity, and never double-book a bed.
- **Inputs:** `p.esi`, bed status and hold, and the zone layout. The layout has 30 beds: Resus R1–R4, Trauma T1–T6, Acute A1–A12 and Fast track F1–F8.
- **Rule (`findBed`, `ZONE_PREF` in `00-core.js`):** WASEL takes the first bed that is free and not held, searching the zones in preference order and then by bed number:

| ESI | Zone order |
|---|---|
| 1 | Resus → Trauma → Acute |
| 2 | Trauma → Acute → Resus |
| 3 | Acute → Trauma |
| 4 | Fast track → Acute |
| 5 | Fast track → Acute |

- **Hold invariant:** A proposed bed gets `bed.hold = suggestion id` until someone accepts or dismisses the suggestion or it becomes invalid (`dropSugg` releases it). `place()` refuses any bed that is not free and is not this patient's own reservation, so a stale card can never double-book.
- **Bed release (`aiPlan` step 5):** This handles a sicker waiting patient for whom no bed is free. If another patient's pending placement holds a bed in an allowed zone, and that patient's priority is more than 15 points lower, WASEL withdraws that card so the sicker patient can be placed. It picks the lowest-priority eligible card. The rule touches **pending suggestions only**, never a patient already in a bed. The new card says "bed released from lower-priority P-1050".
- **Output:** A placement card such as "Place P-1043 (ESI 2) in Trauma T3 with S. Fernandes", with level 1 for ESI 1–2, level 2 for ESI 3 and level 3 for ESI 4–5.
- **Why this design:** The zones follow the ESI v4 acuity tiers. Resus bays are the scarcest resource, so ESI 3–5 never receive one, and ESI 2 uses Resus only after Trauma and Acute are full. A wrong-zone placement explains itself (`aiZoneReason`), for example "Resus and Trauma full · Acute is next-best for ESI 1".
- **Failure mode and safeguard:** When no allowed bed is free, no card appears. The patient stays at the top of the queue, and the Strain rule "ESI 1–2 waiting > 15 min" fires (section 13). One policy can auto-accept placements (`prefs.autoAccept`). It is off by default, only a role allowed to approve placements can switch it on, every change is audited, and it never covers any other card type.

### 6. Nurse matching: ESI-weighted workload and fatigue penalty

- **Purpose:** Name the best nurse for each placement, balancing workload and shift length.
- **Inputs:** Every nurse who is on duty and not in handover. For each one, WASEL uses their ESI-weighted load from assigned patients in treatment or boarding, the load already promised by other pending placement cards (`aiLoads`), and their hours on shift from the roster feed.
- **ESI weights (`W_ESI`):** 1.0 means one nurse is fully occupied.

| ESI | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Weight | 1.0 | 0.5 | 0.34 | 0.25 | 0.2 |
| Equivalent ratio | 1:1 | 1:2 | about 1:3 | 1:4 | 1:5 |

- **Rule (`aiNurseChoice`):** WASEL computes a score for each nurse, and the lowest score wins (`bestNurse` returns that nurse):
  - Start with `score = load before + weight of this patient`.
  - Add **1** if the score is above 1.15 (overload).
  - Add **0.25** if hours ≥ 10.
  - Add a further **0.6** if hours ≥ 12, making 0.85 in total.
- **Output:** The chosen nurse, with their load before and after, for example "S. Fernandes lightest load (34% → 84%), 6.9 h on shift". If the hours penalty skipped the lightest-loaded nurse, the card says so: "best fit; A. Haddad is lighter but at 11.6 h".
- **Why this design:** The weights mirror widely used ED staffing ratios: 1:1 for resuscitation or trauma, 1:2 for critical care and 1:4 for general ED, as in California Title 22 §70217. The hours penalty reflects evidence that nurses' error risk rises significantly beyond 12-hour shifts (Rogers et al., *Health Affairs* 2004). The overload cut-off of 1.15 is a tuning value.
- **Failure mode and safeguard:** The weights describe the average patient at each level. A confused ESI 3 patient who needs 1:1 care is under-counted, and skill mix (paediatric, burns) is not modelled. Before anyone taps, the card names the nurse. If that nurse goes off duty or starts handover, `aiOutdated()` withdraws and re-plans the card. `accept()` re-checks the nurse and falls back to `bestNurse()`.

### 7. Fatigue relief, call-in and orphan reassignment

- **Purpose:** Keep enough rested nurses on the floor, and make sure no patient is left without one.
- **Inputs:** Roster hours, status and handover flags, the ESI-weighted loads, and the patients whose nurse has left.
- **Rule (`aiPlan` steps 8–10):** Fatigue levels come from `fatigueLevel(n)`: `over` at 12 h or more, `tired` at 10 h or more, otherwise `ok`. The steps raise three kinds of card:

| Card | Fires when | Level | On accept |
|---|---|---|---|
| Relieve nurse | `hours ≥ 12` | 2 | Nurse enters handover; on-call cover is called with ETA 20 min; on arrival every patient is transferred with an I-PASS handover (`nurseArrives`) |
| Call in 2 on-call nurses | average load of available nurses > 0.85, **or** 11 or fewer available (14 rostered), and nobody already incoming | 2 | `callIn(25)` × 2 |
| Reassign patients left without a nurse | any patient in treatment or boarding whose nurse is missing or off duty (`orphans()`) | 1 | each patient goes to `bestNurse()`; I-PASS handover sent per nurse |

- **Output:** Staffing cards that list the reasons, for example "R. Menon redeployed to ICU (3), never assigned (1)".
- **Why this design:** The 12-hour limit has the same basis as section 6. Structured I-PASS handover reduced medical errors by 23% in a multicentre study (Starmer et al., *NEJM* 2014). A target average load of 85% or less leaves headroom for the next critical arrival.
- **Failure mode and safeguard:** The rules depend on an accurate roster feed. A call-in card expires after 20 minutes (`stillValid`), so it never lingers. A reassign card whose patients cannot be placed with anyone stays visible (`accept` returns false), and the gap cannot disappear quietly.

### 8. Pre-arrival preparation

- **Purpose:** Have the bed and the team ready before a critical ambulance reaches the doors.
- **Inputs:** Ambulances that are on scene or en route, their ETA, the ESI of every patient on board (`ambEsi` = the most urgent), NEWS2, and free beds.
- **Rule (`aiPlan` step 4):** WASEL raises a card when all of these hold:
  - The ETA is 15 min or less.
  - The most urgent patient on board is ESI 1–2.
  - The ambulance is not already prepared.
  - The card is not blocked by a recent dismissal.

  The sickest patient on board (lowest ESI, then highest NEWS2) gets `findBed()`. The team to page comes from the condition (trauma, burn, cardiac or stroke team), defaulting to the "resus team".
- **Output:** A card such as "Prepare for AMB-12: reserve Resus R2, page trauma team". It is level 1 for ESI 1 and level 2 for ESI 2. On accept, the bed becomes `reserved`, the team is paged, and on arrival `arrive()` places the patient straight into that bed.
- **Why this design:** Pre-hospital notification with team activation before arrival is standard trauma and stroke practice, and it shortens door-to-intervention time. Fifteen minutes is enough to clear and set up a bay.
- **Failure mode and safeguard:** Field triage can over-call or under-call, and ETAs drift. Until a human accepts, the bed is only **held**. The card disappears if the ambulance arrives or is diverted. A reservation is released if the responder reroutes the patient (`wslRouteAway`) or if diversion applies.

### 9. Leave-without-being-seen risk

- **Purpose:** Stop low-acuity patients from walking out of a long lobby wait.
- **Inputs:** ESI, minutes waited, free fast-track beds, and the partner clinic's live wait.
- **Rule (`waselPlan` → `wslProposeLwbs`):** A card is raised for a patient who is waiting, is ESI 4–5, has not already been offered the clinic, and has waited **more than 60 min** (`WASEL_CFG.lwbsMin`). It is level 3 (Routine) and its owner is the Receiving nurse.
- **Output:** A card offering fast-track or the partner clinic. On accept, the patient takes a free fast-track bed if there is one. Otherwise the clinic is offered, and a FHIR ServiceRequest is logged.
- **Why this design:** Rates of leaving without being seen rise with lobby wait, and most of the patients who leave are low acuity. Offering a quicker route keeps them in care.
- **Failure mode and safeguard:** The clinic's wait time is a simulated feed. The card is an **offer**, and the patient decides. ESI 1–3 patients never get this card, so it cannot move a sick patient out of the ED.

## Part C - Department-level rules

### 10. Supplies: minutes left and committed demand

- **Purpose:** Request O-negative blood, burn kits or O2 cylinders before they run out, not after.
- **Inputs:** Stock (`qty`, `cap`), the dispense log (GS1 barcode scans) and the expected needs (`COND.needs`) of patients who are waiting or inbound.
- **Rule:**
  - `minutesLeft(key)` = round(qty ÷ (units used in the last 30 min ÷ 30)). It is null if nothing was used.
  - `committed(key)` = Σ over waiting and inbound patients of their expected need. For a range [a, b] the expected need is (a + b) ÷ 2. For a probability it is the probability itself. The sum is rounded.
  - A card is raised (`aiPlan` step 7) when any of these hold:
    - **low:** qty ≤ 25% of capacity.
    - **short:** committed > qty.
    - **fast:** minutes left < 45.
  - The card is level 1 if short or if minutes left < 20, otherwise level 2.
- **Output:** A card such as "Request 20 units of O-negative blood from the regional blood bank" with "~14 min at current use · waiting + inbound patients likely need ~9". On accept a FHIR SupplyRequest is sent, and the simulated restock arrives after 15 min.
- **Why this design:** A pure stock threshold misses a fast burn during a mass-casualty incident. Committed demand looks ahead to patients who have not yet reached a bed. Forty-five minutes leaves margin over the 15-minute restock.
- **Failure mode and safeguard:** A burst of use inflates the 30-minute rate, so the estimate leans early, which is the safe direction. Expected need comes from condition profiles, not individual orders. The blood bank and the charge nurse still decide. Large requests need two approvers (section 24).

### 11. Overflow forecast (30 minutes)

- **Purpose:** Show when the ED will run out of beds, early enough to act.
- **Inputs:** Busy beds (occupied, cleaning or reserved), waiting patients, boarding patients, treatment end times, ambulance ETAs with their patient counts, and the active walk-in surge.
- **Rule (`forecast()`):** For each minute m from 0 to 30:
  - `arrivals = m ÷ 7 + surgeRate × min(m, surge minutes left) + patients on ambulances with ETA ≤ now + m`
  - `ended = treatment patients whose treatEnd ≤ now + m`
  - `demand = busy + waiting + arrivals − (ended × 0.75 + boarding × min(1, m ÷ 30) × 0.5)`
  - `occupancy(m) = max(0, demand ÷ total beds × 100)`
  - `fullIn` = the first m at which demand exceeds the total number of beds.
- **Output:** `S.fc = {pts, fullIn}`. These feed the occupancy chart and the diversion rule.
- **Why this design:** The forecast is a deterministic projection that anyone can recompute by hand from the board. Ambulance ETAs are the strongest short-range signal. The 0.75 factor reflects that some finishing patients go on to board and do not free their bed. The model also assumes half of the current boarders leave over 30 minutes.
- **Failure mode and safeguard:** The constants (1 walk-in per 7 min, 0.75 and 0.5) are tuning values. Real arrivals vary by hour and season (see Phase 2). The forecast only informs: it raises the diversion card, it does not divert.

### 12. Ambulance diversion

- **Purpose:** Send low-acuity ambulances elsewhere before the ED overflows, while critical patients keep coming.
- **Inputs:** `S.fc.fullIn`, the active diversion window, and the ESI of the patients on each ambulance.
- **Rule (`aiPlan` step 11):** A card is proposed when `fullIn ≤ 20` minutes and no diversion is active. It is level 1. An open card keeps its text up to date, and `aiOutdated()` withdraws it if the forecast clears. On accept:
  - `S.diversionUntil = now + 45 min`.
  - Every on-scene or en-route ambulance whose most urgent patient is **ESI 4–5** (`ambEsi(a) ≥ 4`) is diverted.
  - While the window lasts, new ESI 4–5 ambulances are diverted automatically (`dispatchAmb`, `receivePreAlert`).
- **Output:** A CAD message, a diverted status on the inbound board, and `diversion: true` in the capacity broadcast.
- **Why this design:** Diverting only low-acuity units protects time-critical patients, who still reach the nearest capable ED. A fixed 45-minute window can be reviewed and does not chatter on and off.
- **Failure mode and safeguard:** Diversion moves the load to neighbouring hospitals, which is why it is never automatic. An ambulance carrying any ESI 1–3 patient is never diverted. Section 3 of `CHANNELS.md` shares capacity with dispatch and responders, so they see the diversion state.

### 13. Operating modes and step-down hysteresis

- **Purpose:** Give the whole hospital one shared word for the situation (Steady, Strain, Surge or MCI), always with the rule that set it.
- **Inputs:** Bed occupancy, the longest wait of an ESI 1–2 patient, the longest boarding time, O-negative stock, free ventilators, open incidents and the MCI declaration.
- **Rule (`MODE_RULES` in `00-core.js`, `waselModeCheck` and `updateMode` in `15-wasel.js`):**

| Mode | Enters when | Thresholds |
|---|---|---|
| Strain | **any one** strain rule holds | occupancy ≥ 80% · an ESI 1–2 patient waiting > 15 min · a patient boarding > 60 min |
| Surge | 2 or more strain rules, **or** a resource is at its floor | O-negative ≤ 10 units · free ventilators ≤ 2 |
| MCI | an open incident with an estimate of 10 or more casualties, **or** MCI declared by the command team | `MODE_RULES.mci.incidentEst = 10` |

  - The highest mode whose rules hold wins, and its first rule becomes `modeReason`.
  - The check runs once per simulated minute, and immediately on a dispatch incident or a declaration.
  - **Escalation is immediate.**
  - **Step-down waits** until the calmer mode has held continuously for `stepDownMin` = 10 minutes. `modeLowerSince` resets if the rules swing back.
- **Output:** `S.mode` and `S.modeReason`, for example "Occupancy 83% (≥ 80%)", plus a NCEMA-tagged feed line and an audit entry. In MCI, every inbound field patient gets a START colour.
- **Why this design:** A single named mode with its reason lowers cognitive load during a crisis. ESI 2 patients are meant to be placed immediately (ESI Implementation Handbook), so 15 minutes is a tolerance. Bed-shortage risk climbs steeply above about 85% occupancy (Bagust et al., *BMJ* 1999), so WASEL warns at 80%. Boarding is the main driver of ED crowding, and The Joint Commission recommends keeping it under 4 hours, so 60 minutes gives early warning. Hysteresis is standard control practice: it stops the mode from flickering, which would cause alarm fatigue.
- **Failure mode and safeguard:** The thresholds are site settings and need local calibration. Step-down is deliberately slow, so a mode can stay raised for up to 10 minutes after conditions improve, which errs on the safe side. The mode changes no clinical decision by itself. It raises the silent-surge card (section 14).

### 14. Silent surge

- **Purpose:** Add staff, critical-care overflow and blood before the wave peaks, without a public announcement.
- **Inputs:** A mode escalation into Surge or MCI.
- **Rule (`wslProposeSurge`):** WASEL raises one card per escalation, with key `surge:<mode>`. If a surge card is already open, its reason is refreshed rather than duplicated. The card stays valid while the mode is Surge or above.
- **Output:** A level 1 card: "Silent surge: recall 2 on-call nurses, hold 2 recovery beds, blood bank standby". On accept:
  - `callIn(25)` is called twice.
  - ICU capacity rises by 2 (`WASEL_CFG.surgeBeds`).
  - The blood bank receives a standby message.
- **Why this design:** The response is graded, so capacity is added at Surge, before an MCI is declared. Recalling staff takes about 25 minutes, which is why the trigger has to come early.
- **Failure mode and safeguard:** Recalling staff has a cost, so the card always waits for the charge nurse. If someone dismisses it, it stays quiet for 10 minutes.

### 15. Equipment and system-failure rules

| Card (`aiPlan` step 12) | Fires when | Level | Detail in the card |
|---|---|---|---|
| Repair CT-1 | CT-1 offline and no repair under way | 2 | Queue length and wait = round(queue × 7 min ÷ scanners online) (`ctWait`) |
| Borrow ventilators | `ventFaulty > 0` and no loan under way | 2 | Working units free, plus `committed('vent')` |
| Bring a spare ventilator | a placed patient needed ventilation and none was free (`p.needsVent`) | 1 | Current SpO2 and RR |
| Switch to backup bed sensors | bed-management feed offline and no fallback yet | 1 | Minutes since the last update; the bed board and capacity broadcast show the last snapshot, marked stale |

Each card only appears when its rule holds, and `stillValid()` removes it as soon as the condition clears.

### 16. Task ownership and escalation

- **Purpose:** Make sure no card sits unanswered. Every suggestion has an owner and a clock.
- **Inputs:** Card type, card level and time open.
- **Rule (`waselAssignOwner`, `waselEscalate`, `ESC_MIN`):**
  - **Owners:** Placement, pre-arrival, identity and LWBS cards go to the Receiving nurse. Re-triage and spare-ventilator cards go to the Physician. Everything else goes to the Charge nurse.
  - **Clock:** `ESC_MIN = {1: 3, 2: 6, 3: 10}` minutes, set by card level.
  - **Escalation:** When the clock runs out, the card moves one step up the chain: Receiving nurse → Charge nurse → ED coordinator, and Physician → ED coordinator. Its level rises by one (to a minimum of 1), and a new clock starts. The ED coordinator is the top of the chain, so the clock stops there.
  - Each escalation sends a page, is written to the audit log and, if the card reaches level 1, is announced to screen readers.
- **Output:** An escalation chip ("▲ Escalated ×n"), the owner and an "escalates in m:ss" countdown on the card. The decision board sorts cards by level, then by age.
- **Why this design:** The clocks scale with acuity: a critical card waits 3 minutes, a routine one 10. Escalating along the clinical chain of command reflects how EDs already work.
- **Failure mode and safeguard:** Escalation never accepts a card. It only moves the card to someone who can. Role checks (`canAct`) mean that only roles allowed for a card type see Accept. Everyone else sees who is needed. Every accept, dismiss and escalation is audited.

## Part D - Safety and communication

### 17. Allergy and interaction hard stop

- **Purpose:** Block a medication that the patient's record says will harm them, and never treat missing information as safe.
- **Inputs:** The patient's safety summary (allergies, anticoagulant, source HIE and as-of date, restricted flag), their medications and history, and the drug from `DRUGS`, which is coded with WHO ATC codes.
- **Rule (`checkOrder(p, drug)`):** The checks run in this order:
  1. **Allergy hard stop:** The allergy list is known and not restricted, and an allergy matches the drug's allergen class or its name. Matching ignores case, punctuation and a trailing "s", so "NSAIDs" matches "NSAID".
  2. **Interaction hard stop:** The drug is an anticoagulant (heparin) and the patient is already anticoagulated.
  3. **Unknown is never a silent pass:** If the allergy list is unknown or restricted, the order is allowed with a warning: "Allergy status UNKNOWN: ask patient or family before giving".
  4. **Soft warnings:** The order goes ahead with an amber warning if any of these apply:
     - Cross-reactivity, such as ceftriaxone with a penicillin allergy.
     - A drug that adds bleeding risk, such as ibuprofen or ketorolac, in an anticoagulated patient.
     - A renally cleared or nephrotoxic drug (NSAIDs, IV contrast) with CKD stage 3 on record.
  5. Otherwise: "No allergy or interaction found (source, date)".
- **Output:** `{ok, hardStop, warning, reason}`. `waselOrder()` places only orders that are not hard-stopped. `overrideOrder()` requires a clinical reason of at least 10 characters and always writes it to the audit log.
- **Why this design:** Hard stops for documented allergies and duplicate anticoagulation follow ISMP and Joint Commission medication-safety guidance. Treating unknown as a warning rather than a pass is the core safety principle. Every message names its record source and date, so the clinician can judge how current it is.
- **Failure mode and safeguard:** The drug table is a demo subset of nine drugs. A record from 2 years ago can be out of date, so its date is always shown. Clinicians keep authority through the audited override. Silent overrides are not possible.

| Drug | ATC | Hard-stop allergen | Soft-warning flags |
|---|---|---|---|
| Amoxicillin | J01CA04 | Penicillin | |
| Ceftriaxone | J01DD04 | none | cross-reacts with Penicillin |
| Morphine | N02AA01 | Morphine | |
| Ibuprofen | M01AE01 | NSAIDs | bleeds, renal |
| Ketorolac | M01AB15 | NSAIDs | bleeds, renal |
| Heparin | B01AB01 | none | anticoagulant: hard stop if already anticoagulated |
| Tranexamic acid | B02AA02 | none | |
| Paracetamol | N02BE01 | none | |
| IV contrast | V08AB02 | Contrast media | renal |

### 18. SBAR handover generation

- **Purpose:** Produce a complete, standard handover in one tap, so nobody has to type one.
- **Inputs:** The encounter, age, sex, condition, ESI or START, location and nurse, the ATMIST field report, history, safety summary, orders, NEWS2 with its trend, the vital signs, the active flag and any pending cards.
- **Rule (`sbar(p)`):**
  - **S:** encounter ID, age and sex, condition, ESI (and START if present), and where the patient is now (`wslWhere`).
  - **B:** mechanism, time, injuries and field treatment, or the arrival route. Then history (with HIE source and date), allergy text, anticoagulant status ("unknown" is stated), and medications ordered in the ED.
  - **A:** NEWS2 with its 12-minute trend arrow, HR, BP, RR, SpO2, O2 and AVPU, then the flag text and hint, or "No active alarms".
  - **R:** "Urgent clinical review now" if the flag is critical, or "Clinical review within 30 min" for any other flag (except boarding). Then the next step for the patient's stage (`wslPlanText`), every pending decision for this patient, "Confirm allergies…" if they are unknown, and "Confirm identity…" if identity is not confirmed.
- **Output:** `{s, b, a, r}` text, using **encounter IDs only**, never names.
- **Why this design:** SBAR is the IHI and WHO-endorsed structure for handover. Generating it from live data removes transcription errors and makes sure unknowns are said out loud.
- **Failure mode and safeguard:** The text is only as good as the source data, so every line names its source. The receiving clinician reads it and asks questions. SBAR supports the conversation but does not replace it.

### 19. Face matching (the only machine-learning component)

- **Purpose:** Suggest who an unidentified casualty might be, so their safety summary (allergies, anticoagulant, blood type) is available before arrival.
- **Inputs:** One photo taken on the responder tablet. The photo is downscaled to 1600 px or less, which also strips EXIF data, and sent through `serve.py` to the face service at `/face/identify`. The face service runs outside this repository.
- **Rule:**
  - The face service compares **Facenet512** embeddings by **cosine similarity**.
  - The match cutoff is read live from `/face/health` (`match_similarity`). It is **0.70** for Facenet512.
  - `responder.html` keeps the **top 3** candidates. Each shows its similarity, its position against the cutoff, and a match or "below cutoff" badge. A candidate below the cutoff that is ranked first carries an explicit warning.
- **Output:** The responder chooses one candidate or keeps the temporary ID. The pre-alert carries **only** `{status: 'candidate', method: 'face', confidence, display: initials}`. The photo is discarded from memory, and no name, ID number, image or template leaves the device.
- **On the dashboard:** A candidate identity on a patient who has arrived raises a level 2 card, "Confirm identity of T-104 (face match 94%)", owned by the Receiving nurse. Its reason reads "A candidate never merges charts". Until identity is confirmed, the family board shows "—" instead of initials, and SBAR adds "Confirm identity before linking the chart".
- **Why this design:** Identification is the one task where a learned model clearly beats rules. Even so, the output is treated as a hypothesis. This follows UAE PDPL, under which biometric data is sensitive, and the team's rule that a match is only ever a candidate.
- **Failure mode and safeguard:** Blur, poor light, masks, facial injury and demographic bias can produce false or missed matches. The safeguards are:
  - Matching is optional, and a failed or slow match never delays care, because the patient continues on a temporary `T-###` ID.
  - Candidates never merge charts. A nurse confirms identity at the door.
  - Patients who opted out show as "Restricted by patient", and their record is never loaded.
  - Every lookup is audited.

## Part E - Field, dispatch and satellite screens

### 20. Dispatch unit recommendation

*As implemented in `dispatch.html` (`recommend()`).*

- **Purpose:** Turn a few taps from the call-taker into an explainable unit recommendation.
- **Inputs:** Incident kind, place, casualties (slider, 1–30), severity, trapped, and hazards.
- **Rule:**
  - **Ambulances:** `clamp(ceil(casualties × factor), 1, 12)`. The factor is 0.25 for Minor (1 per 4), 0.5 for Serious (1 per 2) and 1 for Major (1 each). The page assumes Serious until a severity is chosen and says so.
  - **Above the cap of 12:** "request mutual aid for n more".
  - **MCI:** 10 or more casualties, **or** Major with 6 or more casualties.
  - **Rescue units:** 1 if anyone is trapped, or 2 if the incident is also an MCI.
  - **Fire units:** 1 if it is a fire or chemical call, or if a fire, fuel or chemical hazard is present. This becomes 2 if the incident is also an MCI.
  - **Advisories:** Chemical → HAZMAT, approach upwind and decontaminate. Electrical → isolate the power. Crowd → police for scene control.
- **Output:** Unit counts with one "why" line per rule. The operator can adjust any count with − and +, within limits of 1–20 ambulances, 0–4 rescue units and 0–6 fire units. An adjustment that matches the system's pick stops counting as an override.
- **Why this design:** The rules are short enough to read aloud on a call, and they match the triggers dispatchers already use.
- **Failure mode and safeguard:** The casualty count is the caller's estimate. Dispatchers can adjust the numbers, and repeating the dispatch with the same `CALL-` ID updates the incident (sending extra ambulances) rather than duplicating it (`receiveIncident`).

### 21. Destination ranking and ambulance split

*As implemented in `dispatch.html` (`primaryNeed()`, `withStatus()`, `planSplit()`).*

- **Purpose:** Send each ambulance to the nearest hospital that can actually take its patients.
- **Inputs:** This hospital's live capacity (`wasel-capacity`, `CHANNELS.md` §3), three simulated partner hospitals (trauma centre, burns unit, stroke-capable general), and the travel time from the incident place.
- **Rule:**
  - **Primary need:**
    - Minor severity → general.
    - Fire kind or fire hazard → burns.
    - Road collision or trapped → trauma.
    - Major or chemical → resus.
    - Otherwise → general.
  - **Hospital status:** "No live feed" (no capacity for 15 s), "On diversion" and "ED full" (0 beds) mark a hospital as unusable. With 3 or fewer free ED beds it is marked "Busy" but stays usable.
  - **Ranking:** Usable hospitals are sorted by travel time, then by more free ED beds.
  - **Split:**
    - Specialist ambulances are all of them for Major, half (rounded up) for Serious, and none for a general need.
    - These go to the nearest hospitals with matching slots, filling each in turn. The slots are trauma + resus bays at a trauma-capable hospital, burns beds at a burns unit, or resus bays.
    - The remaining ambulances, including any specialist shortfall, go to the nearest EDs. Each ED takes up to `floor(free ED beds ÷ patients per ambulance)` ambulances.
    - Any ambulances still left are shown as "Hold at the casualty clearing point · request mutual aid".
- **Output:** A list of rows "n → hospital" with the reason for each, for example "trauma bays free: 3".
- **Why this design:** Field triage guidelines send the most seriously injured to the right level of care, and everyone else to the nearest ED with room. A greedy fill is simple enough to explain on screen.
- **Failure mode and safeguard:** Partner capacity is simulated (demo). The second pass does not subtract the specialist bays it has already used from that hospital's ED-bed count, so the split can be optimistic for one hospital. Every hospital's live numbers are shown next to the plan, and the crew and receiving ED confirm by radio as usual.

### 22. Responder priority: START and ESI

*As implemented in `responder.html` and the dashboard parser in `15-wasel.js`. The slider-based responder is being rebuilt at the time of writing. The contract for its triage fields is `CHANNELS.md` §2.*

- **Purpose:** Give the receiving ED a field priority with its reasons, without free text.
- **Inputs:** The responder's priority, which is either START (red, yellow, green or black) or ESI 1–5. Also the vital signs (HR, SBP, RR, SpO2, GCS) and, per the contract, the optional triage sliders (AVPU, breathing, bleeding, perfusion, pain, regions, burns %, age band).
- **Rule:**
  - **NEWS2-style helper on the responder page (`renderVitals`):** HR, SBP, RR and SpO2 use the NEWS2 bands in section 1, and GCS below 15 scores 3. Oxygen adds 2, and temperature is not collected in the field. A total of 7 or more is "High risk", 5 or more is "Medium risk", and any single parameter at 3 gives "Low–medium". The responder then picks the priority.
  - **Dashboard mapping (`PREALERT_RULES.startToEsi`):** red → ESI 1, yellow → ESI 3, green → ESI 4, black → ESI 5. Black (expectant) maps to ESI 5, so it never takes a resus bay, but the START colour stays visible.
  - **Displaying START on the dashboard (`wslStart`):** In MCI mode, WASEL derives a START colour for field patients from ESI: 1–2 → red, 3 → yellow, 4–5 → green. This is a colour mapping, not the START algorithm. A START category sent from the field takes precedence.
  - **Slider reasons (`waselTriageWhy`):** Reasons are ranked by urgency, 3 meaning an immediate threat to life:
    - Breathing absent or agonal: 3.
    - Bleeding catastrophic, uncontrolled or heavy: 3. Heavy-controlled: 2.
    - Perfusion absent: 3. Weak, delayed or similar: 2.
    - AVPU P or U: 3. AVPU V: 2.
    - Burns ≥ 20%: 3. 10–19%: 2.
    - Pain ≥ 7, body regions and age band: 1.
- **Output:** The field priority shown with its reasons. A more urgent update raises a re-triage card (section 3).
- **Why this design:** START is the international mass-casualty field standard, and ESI is the ED standard. WASEL keeps both: the field category is shown as sent, and a more urgent update becomes a re-triage card that the ED confirms.
- **Failure mode and safeguard:** The dashboard maps GCS 13 or below to AVPU V (`wslApplySigns`), while the responder helper scores any GCS below 15. A GCS of 14 is therefore "alert" on the dashboard. The ED re-measures on arrival. Invalid fields become Unknown and are listed as "ignored invalid …". They never block the pre-alert.

### 23. Readiness score and trauma activation

*In progress. `src/16-readiness.js` is not in the build yet.*

The state contract (`CHANNELS.md` §4) already includes the shape for each inbound patient: `readiness: {score, of: 5, items: [{k, ok}]}`. That is a 0–5 checklist of preparation items, for example `{k: 'bed', ok: true}`. This page will document the exact items and the trauma-activation criteria from the code once the module lands. Until then, team paging comes from the pre-arrival rule (section 8).

### 24. Kiosk ESI suggestion and two-person supply approval

*Contract in `CHANNELS.md` §5. Implemented in `src/40-bridge.js` (in progress).*

- **Kiosk check-in (`kioskCheckin`):** The patient taps a complaint tile (chest pain, abdominal pain, shortness of breath, fever, injury or other), and their vital signs are recorded. The bridge creates a waiting walk-in. Its suggested ESI comes from **NEWS2 plus the complaint**, and **a nurse confirms it** through the identity and re-triage flow. The patient never sets their own priority.
- **Supply approval (`approveRequest`, `secondApprove`):** A request for **20 or more units** needs a second approver, who must be a different person from the first. Smaller requests are accepted after one approval. Every command is audited, and any action not on the allow-list is rejected and audited.

## What is simulated, not decided

These parts of the demo make the world WASEL reacts to. They are **not** decision logic, and judges should read their numbers as test data:

- Vital-sign drift and recovery (`updateVitals`, `relaxVitals`). Condition profiles, ICD-10-CM codes and deterioration probabilities (`COND`).
- Walk-in arrivals (a Poisson process at 1 per 7 min, plus incident surges), ambulance timings, treatment times and dispositions.
- Field identity outcomes in scenarios: candidate 55%, confirmed by NFC 15%, temporary 30%, with confidence between 0.86 and 0.98.
- Synthetic records (allergies, anticoagulants, the UAE blood-group mix), lab results with HL7 abnormal flags, the partner clinic's wait (an 8–20 min drift), and partner-hospital capacity drift.

## Phase 2: where ML could earn its place

Any model would have to beat the rule it replaces, on local data, while showing its reasons in the same card. Each candidate below follows the same path:

1. **Silent shadow mode:** the model runs, but its output is not shown.
2. **Head-to-head comparison:** the model is measured against the rule.
3. **Display beside the rule:** both values appear, and disagreements are flagged.
4. **Prospective review:** the model is reviewed in live use before it gains any influence.

Humans keep the tap in every phase.

| Candidate | Baseline rule it must beat | Metric | Guardrail |
|---|---|---|---|
| Deterioration prediction (vitals, labs, trajectory) | NEWS2 plus the 12-minute trend (sections 1–2) | AUROC and lead time for ICU transfer or cardiac arrest within 24 h; alerts per true event | Card shows the top contributing factors and the NEWS2 value side by side |
| Arrival forecasting (hour-of-day and weekday seasonality, events, weather) | 1 walk-in per 7 min plus ambulance ETAs (section 11) | Mean absolute error of the 30- and 60-minute bed demand | Falls back to the rule when the inputs are stale |
| Length-of-stay and disposition | The fixed 0.75 bed-release and 0.5 boarding factors (section 11) | Error in predicted bed-free time | Only adjusts the forecast; never moves a patient |
| Supply consumption | The 30-minute burn rate plus committed demand (section 10) | Stock-out events avoided; false requests | Requests still need one or two approvers |
| Nurse assignment (optimisation, not ML) | Greedy `aiNurseChoice` (section 6) | Load spread, overtime hours, handovers | Same explanation format; nurse named before the tap |
| Under- and over-triage audit | ESI with the NEWS2 re-triage rule (section 3) | Agreement with outcomes (admission, ICU, death) | Audit only: feeds training, never the live ESI |
| Face matching calibration | Facenet512 at the 0.70 cutoff (section 19) | False-match rate at a fixed miss rate, broken down by demographic group | Remains candidate-only; nurse confirmation unchanged |

This order keeps WASEL in the category of decision support that a clinician can check independently, which is the FDA's criterion for non-device clinical decision support (2022 guidance). The rules in this document remain the fallback and the benchmark.
