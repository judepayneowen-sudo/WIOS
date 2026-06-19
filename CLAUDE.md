# CLAUDE.md — durable guidance for this repo

Standalone iOS app (**WHOOP Core**) that reads a **WHOOP 5.0** band directly over Bluetooth and
computes Recovery / Sleep / Strain itself, so it can eventually stand alone **without** a WHOOP
subscription. For the full running log + handoff, read **`PROGRESS.md`** (source of truth for state).

---

## ⭐ Calibration strategy — settled, do not re-litigate (verified 2026-06-19)

The goal is to calibrate `src/scores.js` so our computed scores match WHOOP's official scores.
WHOOP's scores are computed in **WHOOP's cloud** — never on the band or in the app — so the only
"answer-key" is the **WHOOP developer API** (`tools/whoop-api.mjs`). Researched + verified against
the live API field set. The three headline scores split cleanly:

| Score | Inputs in WHOOP API? | Output score in API? | Needs raw band data to calibrate? |
|---|---|---|---|
| **Recovery %** | ✅ `hrv_rmssd_milli`, `resting_heart_rate`, `spo2_percentage`, `skin_temp_celsius`, resp, sleep | ✅ `recovery_score` | **No — cloud-only** |
| **Sleep Performance %** | ✅ `stage_summary` (in-bed/awake/light/sws/rem) + `sleep_needed` (baseline/debt/strain/nap) | ✅ `sleep_performance_percentage` | **No — cloud-only** |
| **Day Strain** | ❌ only summary `average_heart_rate` / `max_heart_rate` / `kilojoule` | ✅ `strain` (0–21) | **YES — needs continuous HR** |

**Why Strain is the exception:** WHOOP strain = time-in-heart-rate-zones integrated across the whole
24h cycle (logarithmic 0–21, personalized to max HR). The API exposes the strain *output* but **not**
the continuous minute-by-minute HR trace that is its *input* — the `/cycle` endpoint only gives
avg/max HR. (v2 added `zone_durations` to `/activity/workout`, but **not** to `/cycle`, and day strain
spans non-workout time too, so it's still unreconstructable from the cloud.) Therefore Strain — and
only Strain — requires pulling the **raw continuous HR** off the band ourselves.

### Consequences for sequencing (the plan)
1. **Recovery + Sleep:** calibrate **now, purely from the WHOOP cloud**. Requires NO band
   reverse-engineering. Just keep wearing the band + let the official WHOOP app sync, to fill the
   cloud answer-key over a ~2–3 week window, then `node tools/whoop-api.mjs` → `npm run calibrate`.
2. **Strain:** this is the *only* score that justifies the harder band-RE work (`HISTORICAL_DATA(47)`
   decode + `set_read_pointer` historical pull). Reserve that effort for Strain.

### Two misconceptions to correct if they resurface
- **"Don't sync to WHOOP cloud — it wipes the band and we lose calibration data."** Backwards.
  The cloud sync is what *creates* the answer-key (WHOOP only scores data once it reaches the cloud);
  the cloud is also the durable copy, so band-buffer trimming after sync loses nothing. Avoiding the
  cloud entirely means there is *nothing to calibrate against*. End-goal (cancel WHOOP) comes only
  **after** a one-time calibration.
- **"We need the raw band data to calibrate."** Only for **Strain**. Recovery + Sleep are fully
  cloud-calibratable because the API gives both their inputs and their output scores.

---

## Workflow rules
- Read **`PROGRESS.md`** first for current state. Update it when state changes.
- `git fetch` before working — both the laptop and phone/web push to this repo.
- Ship a phone build: bump `version` in `package.json` → run `release.yml` (publishes to
  `wios-awe.pages.dev`; SideStore updates OTA).
- Calibration answer-key lives in a **local, gitignored** `.whoop.env` / `.whoop-tokens.json` —
  never commit credentials.
