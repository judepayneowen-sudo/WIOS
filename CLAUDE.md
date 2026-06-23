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
- ⛔ **`cmd 33` is a DEAD END (settled 2026-06-22).** Its real name is **"Force Read Pointer"** (the band's
  console: `BLE_CMD: Command Force Read Pointer; read page:N wrap count:0`). It takes a flash **page** +
  **wrap count** (page ≈ trim/3), and the band parses it fine — BUT it does **not** redirect the historical
  dump. It moves a *different* read pointer. (cmd 32 POWER_CYCLE/0x0007 reset also does NOT rewind the dump.)
- ✅✅ **SOLVED 2026-06-22 — `FORCE_TRIM` (cmd 25) is the controllable rewind.** The "trim" is the commit
  cursor the historical dump actually reads from (the value we ack). Sending `FORCE_TRIM` with a target trim
  (u32 LE lo, then 4 zero bytes) **moves the dump's start to any point in flash**. PROVEN: from a cursor at
  "now" (trim 28840, Jun 22), one cmd 25 rewound the dump to Jun 21 12:15 and streamed 3.5 h of real records.
  Command numbers come from the decompiled WHOOP enum (via whoop-vault's `commands.py`): `FORCE_TRIM=25`,
  `SET_READ_POINTER=33`, `REBOOT_STRAP=29`, `POWER_CYCLE_STRAP=32`, `ENTER_HIGH_FREQ_SYNC=96`. Implemented as
  `forceTrimSeek()` in `src/app.js` (target time → trim → cmd 25 → probe → iterate).
- ✅ **The comparable-data problem is solved:** let the WHOOP app sync a night to its cloud (the Phase-1
  answer-key), then **FORCE_TRIM (cmd 25) back to that night → Sync full history** re-reads the raw `(47)`
  data from flash (persists ~4–5 days). Pair the two → a calibration pair for any night. Repeatable, in-app.
- ⚠️ **Phase-1 vs Phase-2 — the "no seek needed" rule only holds in Phase 2.** In **Phase 2** (subscription
  cancelled, WHOOP app gone) nobody else acks the band, so the dump's oldest-un-acked frontier *is* last
  night → a plain **daily `Sync full history`** pulls it incrementally, no seek. **But in Phase 1
  (calibrating)** we must let the WHOOP app sync first — and **WHOOP's own sync advances the band's commit
  cursor PAST that night**, so a plain Sync would start at "now" and pull nothing. Therefore the **daily
  calibration pull MUST FORCE_TRIM-first**: rewind (cmd 25) to last night's evening (data persists ~4–5 days
  in flash), then drain. Implemented as the one-tap **`dailySync()`** in `src/app.js` (v1.0.15): FORCE_TRIM →
  drainHistory → auto-send to the laptop drop-box (Save-to-Files fallback).
- ✅ **The comparable-data routine (use this daily):** WHOOP app syncs the night → cloud answer-key, then
  in WHOOP Core tap **"Pull last night → laptop"** (FORCE_TRIM back to that night → `Sync full history`
  re-reads the raw `(47)` from flash → drop-box to laptop). Pair the night capture with WHOOP's cloud
  `stage_summary` (one `node tools/whoop-api.mjs` covers all nights). Desktop one-shot: **`npm run
  calibrate:all`** (pull 14 days of answer-key → calibrate across every captured night/day).
- 📟 **The band's CONSOLE_LOGS(50) are an ASCII debug channel** — decode them (`Trim:`, `Dump Complete`,
  `PullStats`, `BLE_CMD: Command …`). They name commands and give exact pointer values; invaluable for RE.
- Fallback for live data if ever needed: **live overnight capture** (foreground + keep-awake; streams
  HR/RR without touching the buffer) or **passively sniff WHOOP's own sync** (Android HCI/nRF).

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
- ✅ **Actigraphy — SOLVED via the `(47)` orientation vector; raw IMU is NOT on the BLE interface (settled 2026-06-23).**
  The classifier uses real accel actigraphy from the **`f32@37/41/45`** vector in the 112-byte rich `(47)`
  record — a PROCESSED orientation/gravity vector (empirically `|v|≈0.995–1.005 g`, one sample per record
  ≈1 Hz). Its per-epoch change is the movement signal (drove sleep calibration to 4.1-min RMSE, 2026-06-22).
  ⛔ **The raw int16 6-axis `R21` IMU is NOT exposed over BLE on the 5.0 — exhaustively tested 2026-06-23:**
  - **Full GATT enumerated** (`listGatt`/`BleClient.getServices`): the band exposes ONLY `fd4b0001`
    (chars `0002` write, `0003/0004/0005/0007` notify) + standard HR(180d)/Battery(180f)/DeviceInfo(180a).
    The 6108/1150/8a58/5983 service families in `op0/p.java` are OTHER device generations, not this band.
  - **`fd4b0007` exists + supports notify and we subscribe to it, but the band never pushes to it** — no
    realtime IMU stream over BLE. Realtime `(40)` records are HR/RR only (20 B, no accel).
  - **`TOGGLE_IMU_MODE(106)` / `START_RAW_DATA(81)` / `TOGGLE_IMU_MODE_HISTORICAL(105)` / `ENTER_HIGH_FREQ_SYNC(96)`
    all just ACK and produce no new stream.** The historical dump (with cmd 105 on, AND under high-freq sync)
    returns only the usual 112-B `(47)` records — **byte-identical**, no `R21`. So `R21` (the
    `com.whoop.ble.model.ImuData` int16 6-axis) is recorded on-device, not delivered over this sync. Only its
    raw high-rate samples are missing — every BLE path is exhausted (settled 2026-06-23).
  - **Consequence:** standalone Recovery/Sleep/Strain need nothing more from the band.
- ✅ **Record taxonomy + the raw OPTICAL stream IS on BLE — RE-SCAN 2026-06-23 (corrects "raw not on BLE").**
  The full historical dump carries TWO `(47)` record variants, distinguished by the subtype byte `[1]`:
  - `[1]=0x12` → **112-byte R10** physiology record (HR/skin-temp/SpO2/orientation — the field map below).
  - `[1]=0x1a` → **76-byte R20 raw OPTICAL/PPG** record: 25 int16 samples @ `[19..69]`, centred ~0, RMS ~3600
    even when perfectly still (a pulse waveform — AC accel would be ~0 at rest), saturating on motion. I had
    been **filtering these out** by keeping only 112-byte records. So raw PPG (what HR/SpO2 are computed from)
    IS reachable; we just don't need it (R10 already gives HR + SpO2).
  - APK record enum (`oq0/d.java`): `R10, R11, R12, RAW_ECG, R20(optical), R21(IMU), R24(metrics)`. Only
    R10+R20 appear in the default dump; **R21(IMU) and R24(metrics) are NOT delivered** over this sync.
- ⛔ **STEPS — settled 2026-06-23: not on the band, by WHOOP's design.** The band's data-type enum
  (`com/whoop/service/network/model/cycles/Metric.java`) is exactly `HEART_RATE, GPS, TEMPERATURE, GSR,
  ACCELEROMETER_MAGNITUDE, RR_INTERVALS` — **no step metric**, and accel is exposed as **MAGNITUDE only**
  (the ~1 Hz scalar = our orientation `|v|`), not raw 3-axis. WHOOP sources step count from the **phone**
  (Android Health Connect / system pedometer — `z6/k3.java` builds `StepsRecord`), NOT the band. ⇒ For
  WHOOP Core, get steps the same way: the **iOS pedometer** (CoreMotion `CMPedometer` / HealthKit), not the
  band. (GPS is likewise phone-sourced. `GSR` = galvanic skin response is a real band metric we've not yet
  located in the record — future.)
- ✅✅ **The `(47)` rich record carries WAY more than HR — MAPPED 2026-06-23 (this corrects the earlier
  "SpO2/skin-temp/resp are cloud-only" claim, which was WRONG).** The band is the only sensor, so everything
  WHOOP computes MUST traverse BLE — and it does, inside the 112-byte `(47)` record. Field map (verified on a
  60,838-record full night, all little-endian):
  - `[3..6]` idx u32 · `[7..10]` ts u32 · `[14]` HR u8
  - **`[65..66]` skin temperature = int16 ÷100 °C** (verified 27.6–38.6, mean 33.4 — the thermistor)
  - **`[74]` SpO2 = u8 %** (0 most records; 88–99 when sampled during sleep — matches WHOOP's sleep-only SpO2;
    385 readings/night, mean 96.3%)
  - `[72]` respiratory rate u8 (tentative, sits ~12) · `[37/41/45]` f32 orientation/gravity vector (actigraphy)
  - Decoded in `decodeHistorical()` → `{hr, rr, acc, skinTempC, spo2, respRate}`; `decodeCapture()` returns
    `skinTemp[]`, `spo2[]`, `resp[]`. So **skin-temp deviation + SpO2 are now band-derivable Recovery inputs**
    (no cloud needed). ⚠️ The APK note "the app doesn't PARSE these from the band" is about the *app's display
    path* (it shows cloud-computed values) — the raw values are nonetheless IN the record the app uploads.
  - Still unmapped in the 112-B record: a second varying block `[97..101]`/`[105..108]` (likely another
    processed vector or PPG amplitude) and `[33..51]` beyond the accel triplet — decode next if useful.
- Validate decoded inputs by sanity/consistency (sane HR, matches live HR, RR→HRV).

### 📦 Decompiled-APK intel (2026-06-22 — WHOOP Android 5.456)
Second independent source. **Confirms** but does **not** fully decompile the band protocol (JADX dropped the
sync engine + ack builder + metadata parser + frame/CRC base classes `hp0.c`/`kp0.*`), so it CANNOT confirm
or refute the ack byte-layout, the trim-from-metadata read, the 96/97 handshake order, FORCE_TRIM usage, or
the destructive-ack — **the APK's silence on those is a decompile gap, not a contradiction**; our empirical
findings stand. What it DID confirm:
- ✅ **Full command enum** (`hp0/e.java`) matches ours exactly: `SEND_HISTORICAL_DATA=22`,
  `HISTORICAL_DATA_RESULT=23`, `FORCE_TRIM=25`, `REBOOT_STRAP=29`, `POWER_CYCLE_STRAP=32`,
  `SET_READ_POINTER=33`, `GET_DATA_RANGE=34`, `ENTER/EXIT_HIGH_FREQ_SYNC=96/97`, `TOGGLE_IMU_MODE_HISTORICAL=105`.
  ⛔ Brick-risk (keep guarded): `START_FIRMWARE_LOAD=36/142`, `LOAD/PROCESS_FIRMWARE=37/38`, `ENTER_BLE_DFU=45`.
- ✅ **Two-layer framing** (`gi0/a.java`): a frame carries a **transport type at byte [1]** (`gi0.b`:
  `BLE_COMMAND_FRAMEWORK=64, HISTORICAL_METADATA=65, HISTORICAL_DATA=66, REALTIME_DATA=67, INFORMATIONAL=68`)
  AND an **inner sub-type u16 at byte [17]** (`gi0.c`: `…CONSOLE_LOG=9, EVENTS=10…`). Our decoder's **`47/49`
  are inner *record* codes nested inside the type-66 transport frame** — the two-layer nesting we hypothesized.
  All payloads **little-endian**; timestamps are **32768-Hz fixed-point** (`millis = s·1000 + sub·1000/32768`).
  No `0xAA`/CRC16 in this parser → our SOF+MODBUS-CRC framing is a *lower* transport layer (the absent `hp0.c`).
- ✅ **Historical record taxonomy**: `R10/R11/R12/RAW_ECG/R20/R21(IMU)/R24` (`oq0/d.java`); HR is R10/R11.
- ⚠️ **SpO2 / skin-temp / respiratory rate are not parsed from the band *by the WHOOP app's display path*** —
  it shows cloud-computed values. ❗BUT they ARE present in the band's raw `(47)` record (skin-temp `[65]`,
  SpO2 `[74]`, resp `[72]` — see the record map above), which we decode directly. So for Phase 1 the cloud
  is a convenient answer-key, but in Phase 2 these come straight off the band — NOT cloud-only.

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
