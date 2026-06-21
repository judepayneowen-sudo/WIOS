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
for calibration — the cloud is the source. ⚠️ But do **NOT** run our **"Sync full history"** (the ack-loop
drain) on data the WHOOP app hasn't already synced — it is **DESTRUCTIVE** (see below). During Phase 1,
let the WHOOP app sync first; our **"Quick sync (read-only)"** never acks and is safe.

### Phase 2 — STANDALONE (ongoing, after cancelling WHOOP) → band-raw
No subscription = no API. The app reads the band directly and runs the calibrated `scores.js`:
band → decode HR/HRV/sleep → `scores.js` → Recovery/Sleep/Strain. **This is why band-raw extraction is
essential and is NOT retired.**

### ⚠️ Read semantics — RE-CORRECTED 2026-06-21: the ack-loop drain IS DESTRUCTIVE (observed data loss)
The 2026-06-20 "non-destructive" conclusion was **WRONG** and is hereby reverted. **PROOF (2026-06-21):**
a full overnight was pulled via "Sync full history" (the ack-loop), and afterwards the official WHOOP app
had **NO data for that night** — it only showed records from *after* our pull (~08:15). The night was
permanently lost from WHOOP. So:
- `historical_data_result(23)` (ack with `[01][trim][0]`) **commits and frees** the acked records on the
  band. WHOOP does **not** get a second chance at data it hadn't already synced — it's gone.
- The earlier "WHOOP re-synced 3 days after our ack" anecdote was misread (WHOOP had likely already synced
  those days, or they hadn't been acked to the end). It is **not** evidence of non-destructive reads.
- **Safe workflow:** let the WHOOP app sync to its cloud FIRST (that cloud copy is also the Phase-1
  answer-key), THEN run "Sync full history". Or use **"Quick sync (read-only)"**, which streams the first
  window and **never acks** (truly non-destructive, but can't pull a full night).
- The app now **confirms** before the destructive drain (`drainHistory` in `src/app.js`).
- ⛔ **Ack-variant experiments are EXHAUSTED (2026-06-21, on throwaway data):** the advance and the free are
  both gated by the ack's status byte `0x01` — you cannot decouple them.
  - **A** `[00][trim][0]`: 🟢 non-destructive but does **not** advance (band replays the oldest window). No-op.
  - **B** `[01][0][trim]`: 🔴 destructive (oldest jumped to now) **and** doesn't advance. Worst case.
  - **C** `[00][0][trim]`: predicted no-op like A (status 00 suppresses processing). So: no ack reads non-destructively.
- ✅ **The live lead is `set_read_pointer` (cmd 33)** — the band ACCEPTS it (responds `0x21`). Old attempts
  failed only because they used the **wrong number space** (the record index ~339k/72k). **FOUND
  (2026-06-21): the read/write pointers are small counters ~18,800** — visible in the `get_data_range`
  response header (e.g. `@10=18846 @18=18842`) and identical to the `HISTORY_END` **trim** we ack. Two wins
  if cmd 33 takes this space: (a) **non-destructive walk** — advance the read pointer per window, never ack;
  (b) **rewind-after-drain** — drain fast, then set the pointer back so WHOOP re-reads. Tool shipped:
  **"Read-pointer experiment (cmd 33)"** (`probePointer`/`setPointer` in `src/app.js`) — read-only, safe.
- Fallback if cmd 33 fails: **live overnight capture** (foreground + keep-awake; streams HR/RR without
  touching the buffer, so WHOOP syncs normally) or **passively sniff WHOOP's own sync** (Android HCI/nRF).

**UPDATE 2026-06-20 — the standalone pull is SOLVED (see the Historical-sync section below).** We don't
need to "rewind" at all: the dump is a per-batch **ACK-loop** and the bug was acking with `trim=0`
instead of the `HISTORY_END` flash index. `set_read_pointer (cmd 33)` is **not** part of the protocol —
ignore it. Phase 2 = `drainHistory()` (send 22 → ack each batch's trim → `HISTORY_COMPLETE`) → decode →
`scores.js`. ⚠️ **The ack frees the records (DESTRUCTIVE to un-synced data — see Read semantics above).**
In Phase 2 (subscription cancelled) that's fine — WHOOP no longer needs the data. In Phase 1, sync WHOOP first.

### ⭐ Historical sync — SOLVED (2026-06-20), `set_read_pointer` was a red herring
The dump is a documented **ACK-loop**, not a pointer seek: `send_historical_data(22)` → batches of
`HISTORICAL_DATA(47)` framed by `METADATA(49)` `HISTORY_START(1)`/`HISTORY_END(2)`; ack each with
`historical_data_result(23) = [01][u32le trim][u32le 0]` where **`trim` = the `HISTORY_END` flash index**
(old bug: we acked `trim=0`); loop until `HISTORY_COMPLETE(3)`. Implemented as `drainHistory()` in
`src/app.js` (auto-probes the 5.0 trim offset on batch 1, then locks it). **`cmd 33` is NOT part of this.**
⚠️ The ack **frees** the records — **DESTRUCTIVE to data WHOOP hasn't synced** (see Read semantics above).

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
- **"The ack-loop is non-destructive / WHOOP re-reads it."** ❌ FALSE (proven 2026-06-21 — a night was
  lost from WHOOP after our full drain). The ack **frees** the records; WHOOP can't recover un-synced data.
  Note: the **"Quick sync (read-only)"** path (no ack) *is* safe — but it only streams the first window.
- **"The blocker is `set_read_pointer` (cmd 33)."** NO (resolved 2026-06-20) — red herring. The dump is a
  per-batch ack-loop; ack `historical_data_result(23)` with the `HISTORY_END` **trim** (we wrongly used
  `trim=0`). See the Historical-sync section.

---

## Workflow rules
- Read **`PROGRESS.md`** first for current state. Update it when state changes.
- ℹ️ **Historical pull is the ACK-loop.** `send_historical_data(22)` → ack each batch with
  `historical_data_result(23)=[01][u32le trim][u32le 0]` (trim = `HISTORY_END` flash index) → until
  `HISTORY_COMPLETE`. ⚠️ **DESTRUCTIVE — the ack frees the records; data the WHOOP app hasn't synced is
  lost (proven 2026-06-21).** Let WHOOP sync first in Phase 1. `set_read_pointer (cmd 33)` is **not** used.
  Implemented as `drainHistory()` (now behind a confirm) in `src/app.js`; `waitBatch` acks on each
  `HISTORY_END` for speed.
- `git fetch` before working — both the laptop and phone/web push to this repo.
- Ship a phone build: bump `version` in `package.json` → run `release.yml` (publishes to
  `wios-awe.pages.dev`; SideStore updates OTA).
- Calibration answer-key lives in a **local, gitignored** `.whoop.env` / `.whoop-tokens.json` —
  never commit credentials.
