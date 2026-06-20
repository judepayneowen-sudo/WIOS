# CLAUDE.md — durable guidance for this repo

Standalone iOS app (**WHOOP Core**) that reads a **WHOOP 5.0** band directly over Bluetooth and
computes Recovery / Sleep / Strain itself, so it can eventually stand alone **without** a WHOOP
subscription. For the full running log + handoff, read **`PROGRESS.md`** (source of truth for state).

---

## ⭐ Strategy — settled, do not re-litigate (updated 2026-06-20)

End goal: the app computes Recovery / Sleep / Strain **itself, from the band**, so the user can
**cancel the WHOOP subscription**. ⚠️ **Cancelling kills WHOOP API/cloud access** (the developer API
requires an active membership) — so ongoing operation **cannot** depend on the cloud. Two phases, with
different data paths. Both are required; neither is "the" answer alone.

### Phase 1 — CALIBRATION (one-time, while still subscribed) → cloud
Calibrate `src/scores.js` so our computed scores match WHOOP's. WHOOP's scores live only in WHOOP's
cloud, reachable via the **WHOOP developer API** (`tools/whoop-api.mjs`) — the answer-key. All three
are calibratable from the cloud:

| Score | Inputs in API | Output in API |
|---|---|---|
| **Recovery %** | `hrv_rmssd`, `resting_heart_rate`, `spo2`, `skin_temp`, resp, sleep | `recovery_score` |
| **Sleep %** | `stage_summary` + `sleep_needed` | `sleep_performance_percentage` |
| **Day Strain** | `/activity/workout` `zone_durations` (z0–z5) + workout `strain` | `strain` (0–21) |

During Phase 1: **wear the band + let the official WHOOP app sync** (fills the cloud answer-key over
~2–3 weeks), then `node tools/whoop-api.mjs` → `npm run calibrate`. No need to touch the band yourself
for calibration — the cloud is the source. (Our band reads don't delete data or block WHOOP — see
below — but there's simply no reason to read the band during calibration.)

### Phase 2 — STANDALONE (ongoing, after cancelling WHOOP) → band-raw
No subscription = no API. The app reads the band directly and runs the calibrated `scores.js`:
band → decode HR/HRV/sleep → `scores.js` → Recovery/Sleep/Strain. **This is why band-raw extraction is
essential and is NOT retired.**

### ⚠️ Read semantics — CORRECTED 2026-06-20 (the ack is NOT a destructive wipe)
Earlier we wrongly concluded the historical ack "wipes" data. It does not. **PROOF: the official WHOOP
app re-synced 3 days of data *after* we thought our ack had destroyed it** — impossible if it were
deleted. What actually happens:
- `historical_data_result(23)` advances a read/commit **cursor** to the end; it does **not** erase flash.
- The band keeps a rolling **multi-day** buffer, so records persist; WHOOP re-reads them by **rewinding
  its own cursor**. Our commit doesn't block WHOOP, and nothing is lost (until data ages out naturally).
- After we commit, `get_data_range` shows oldest = "now" and our read-only returns 0 — that's the
  **cursor position**, not deletion. To re-read past data we must **rewind the cursor** ourselves.

**UPDATE 2026-06-20 — the standalone pull is SOLVED (see the Historical-sync section below).** We don't
need to "rewind" at all: the dump is a per-batch **ACK-loop** and the bug was acking with `trim=0`
instead of the `HISTORY_END` flash index. `set_read_pointer (cmd 33)` is **not** part of the protocol —
ignore it. Phase 2 = `drainHistory()` (send 22 → ack each batch's trim → `HISTORY_COMPLETE`) → decode →
`scores.js`. No data-loss risk (the ack advances a cursor; WHOOP re-reads by rewinding its own).

### ⭐ Historical sync — SOLVED (2026-06-20), `set_read_pointer` was a red herring
The dump is a documented **ACK-loop**, not a pointer seek: `send_historical_data(22)` → batches of
`HISTORICAL_DATA(47)` framed by `METADATA(49)` `HISTORY_START(1)`/`HISTORY_END(2)`; ack each with
`historical_data_result(23) = [01][u32le trim][u32le 0]` where **`trim` = the `HISTORY_END` flash index**
(old bug: we acked `trim=0`); loop until `HISTORY_COMPLETE(3)`. Implemented as `drainHistory()` in
`src/app.js` (auto-probes the 5.0 trim offset on batch 1, then locks it). **`cmd 33` is NOT part of this.**

### Remaining band-RE work for Phase 2 (develop in parallel; nothing is at risk)
- **Validate `drainHistory` on the real band** — confirm the 5.0 trim strategy/offset (worn-night "Sync
  full history" run; `decodeMetadata` exposes the `HISTORY_END` trim candidates from the capture).
- Decode the **accel/IMU tail of `(47)` / `HISTORICAL_IMU(52)`** → true actigraphy for sleep movement
  (classifier currently uses an HR-volatility proxy). HR confirmed: `[3..6]`=idx, `[7..10]`=ts, `[14]`=HR.
- Validate decoded inputs by sanity/consistency (sane HR, matches live HR, RR→HRV).

### Sleep — exact WHOOP match is impossible standalone (cloud-staged); target is calibrated-close
WHOOP computes staging in its cloud, so the band has only raw HR/RR/accel. We run our own
`classifySleepStages()` (cardiopulmonary + actigraphy; tunable `SLEEP_STAGE_PARAMS`) and **calibrate it to
WHOOP's per-night stage SUMMARY** during Phase 1 (`tools/calibrate.mjs` "Sleep stages" block) — the
openwhoop/noop approach and the agreed target. Do not chase byte-identical hypnograms.

### Misconceptions to correct if they resurface
- **"Don't sync to WHOOP cloud — it loses calibration data."** Backwards in Phase 1: the cloud sync
  *creates* the answer-key. Let WHOOP sync.
- **"We're cloud-only / band-raw is retired."** NO. Cloud is only for the one-time calibration.
  Standalone operation (the end goal) REQUIRES band-raw — cancelling WHOOP removes the API.
- **"The ack deletes data / band reads are destructive."** NO (corrected 2026-06-20). The ack moves a
  cursor; the data persists in a rolling multi-day buffer and WHOOP re-reads it.
- **"The blocker is `set_read_pointer` (cmd 33)."** NO (resolved 2026-06-20) — red herring. The dump is a
  per-batch ack-loop; ack `historical_data_result(23)` with the `HISTORY_END` **trim** (we wrongly used
  `trim=0`). See the Historical-sync section.

---

## Workflow rules
- Read **`PROGRESS.md`** first for current state. Update it when state changes.
- ℹ️ **Historical pull is the documented ACK-loop (2026-06-20).** `send_historical_data(22)` → ack each
  batch with `historical_data_result(23)=[01][u32le trim][u32le 0]` (trim = `HISTORY_END` flash index) →
  until `HISTORY_COMPLETE`. Non-destructive (cursor advance; WHOOP re-reads by rewinding its own).
  `set_read_pointer (cmd 33)` is **not** used. Implemented as `drainHistory()` in `src/app.js`.
- `git fetch` before working — both the laptop and phone/web push to this repo.
- Ship a phone build: bump `version` in `package.json` → run `release.yml` (publishes to
  `wios-awe.pages.dev`; SideStore updates OTA).
- Calibration answer-key lives in a **local, gitignored** `.whoop.env` / `.whoop-tokens.json` —
  never commit credentials.
