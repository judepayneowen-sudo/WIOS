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
  data from flash. Pair the two → a calibration pair for any night. Repeatable, in-app.
  - 📏 **Flash retention — WHOOP's spec is "up to 14 days" (per their website, 2026-06-24), NOT the "~4–5 days"
    earlier guessed here.** That earlier figure was an under-observation, now retracted. ✅ **EMPIRICALLY
    CONFIRMED ≥5 days (2026-06-24):** a seek capture streamed real records spanning **Jun 19 17:05 → Jun 23**,
    so the band clearly holds well past 4–5 days.
  - 📅 **DECODED a real `get_data_range` (cmd 34) response (2026-06-24): the band held ~44 DAYS.** Structured
    fields (u32 LE unix ts; the "newest" field matched wall-clock exactly, confirming the epoch): oldest =
    **May-11 00:42:53**, newest = **now (Jun-24 18:25)**. So actual retention ≫ WHOOP's "up to 14 days" spec
    when the buffer isn't full.
  - ✅✅ **`get_data_range` TRIM POINTERS RECONCILED (2026-06-25, console-verified across ~50 frames).** The
    response's header carries THREE u32 trim-space pointers (payload offsets — `payloadBytes[10/14/18]`):
    **`[10]` = commit/read CURSOR** (oldest readable trim, advances as we ack), **`[14]` = WRITE POINTER** (the
    trim CEILING), **`[18]` = read pointer ≈ cursor. PROOF for `[14]`: it matched the firmware's own console
    `writeptr @ 104534` exactly (B=104523 same day) and rises monotonically through each day (Jun-24:
    102525→104523→105516→105724). These are the SAME units we FORCE_TRIM/ack — so `forceTrimSeek` now bounds its
    binary search EXACTLY from one read-only `get_data_range` (`hiTrim`=writeptr, `loTrim`=cursor), no probe to
    find the ceiling, no forward/rewind branching. `parseDataRange` returns `{oldest,newest,cursorTrim,writeTrim,
    readTrim}`. (The OTHER per-marker pair-values — 2293/14745/20316 etc. — are a separate physical/page counter,
    non-monotonic/wrapping; NOT the trim. That earlier "not reconciled" note is resolved.)
  - ✅✅ **FORCE_TRIM seek is now an EXACT bounded binary search (2026-06-25, `src/seek.js`, unit-tested).** Why it
    was ever a "search": the band has no read-at-time-T command; the only read is "stream forward from the trim"
    (a monotonic RECORD INDEX, not a clock), and time is monotonic but NOT linear in trim (off-wrist gaps stretch
    it ~1.6 s/trim worn → ∞ across a gap), so there is no formula time→trim. But monotonic ⇒ binary-searchable
    EXACTLY. `bisectSeek` runs Illinois false-position bounded to **[MIN_SAFE_TRIM, write-pointer]**: each probe
    FORCE_TRIMs to a candidate, streams the first batch, reads its ts, aborts uncommitted (non-destructive),
    halves the bracket — converging to the record at/just-before target within ~2 min in ≤~16 probes, no rate
    guess. Bounded ⇒ it can never probe the erased crash zone or overshoot now, and can never extrapolate out of
    range (kills the old trim-257431 blowup). `test/seek.test.mjs` proves convergence + safety on a synthetic band
    with an off-wrist gap (40 assertions). Replaced the anchor+rate extrapolation in `forceTrimSeek`.
  - ✅ **FORCE_TRIM seek REBUILT clean (2026-06-24) — `dailySync` → `forceTrimSeek` → `drainHistory`(→`persistPull`→store).**
    After the binary-search version groped upward from `trim 0` (the crash zone) and kept resetting the band, the
    seek was rebuilt on the **original anchor+rate method** that worked, hardened with everything learned:
    gate the target to the valid range (read-only `get_data_range`), **anchor at the head** (a plain probe — no
    FORCE_TRIM, gives the ceiling), then jump `trim = anchorTrim + (target−anchorTs)/rate` **clamped to
    [floor, ceiling]**, probe, **refine the rate from feedback**, repeat (≤6). `forceTrimTo` floors every send at
    **`MIN_SAFE_TRIM=2000`** so a near-zero trim is structurally impossible → no `0x0007` crash, no clamp-to-now.
    The user picks a date/time and the pull is stored **in the app** (not just the laptop). `trimToOldest` (the
    FORCE_TRIM→0 crash path) and its button were REMOVED; `showOldest` stays read-only (range info only).
  - ⚠️ **THE CURSOR IS NOT "NOW" — first rebuild never sent a FORCE_TRIM (capture-proven 2026-06-24 eve).** A
    capture showed the seek doing only `get_data_range`/`send_historical`/`abort`/`ack` — **zero cmd 25**. Root
    cause: the rebuild probed the band's CURRENT read cursor and treated it as the newest data. But WHOOP had
    only synced part-way, so the cursor was parked at **Jun-18 08:29** while `get_data_range` knew the newest was
    **Jun-24 21:08**. The seek saw `target ≥ cursor` → "nothing to rewind" → returned without trimming, and the
    drain streamed+**acked Jun-18 (destructive)**. FIX: take the TRUE range (oldest+newest) from the read-only
    `get_data_range`, use the cursor probe ONLY as a measured `(ts,trim)` anchor, gate the target to
    `[oldest,newest]`, and jump `trim = anchorTrim + (target−anchorTs)/rate` in **EITHER direction** (target can
    be older OR newer than the parked cursor) with the ceiling = the estimated writeptr (so a forward seek isn't
    capped at the cursor). `parseDataRange` now returns `{oldest,newest}`; `readDataRange()` exposes both.
  - ⛔ **FORCE_TRIM → 0 CRASHES the band (2026-06-24).** A capture showed the strap hard-rebooting TWICE (full
    boot logs, `SUPERVISOR: Post reboot reason: 0x0007`, `error code 0x05`) ~3 s after a `FORCE_TRIM→0`, and
    the historical dump returned ZERO `(47)` records (only EVENT(48)/METADATA(49)/CONSOLE(50) frames). Trim 0
    points BELOW the valid floor into erased flash, and reading it faults the firmware → supervisor reboot. So:
    **never FORCE_TRIM to 0 / the raw buffer start.** `trimToOldest()` now reads the data-range marker and
    SEEKS to ~1 h INSIDE the oldest valid data (clear of the erased edge); `forceTrimSeek()` detects the reset
    (`linkDown`), raises its floor past the offending trim, and BAILS after 2 reboots rather than hammering.
    The very oldest data sits on this erased edge — prefer seeking a specific RECENT night over "trim to oldest".
  - ⚠️ **The "oldest = now" bug was a WINDOW-CLIP, not a wrong pointer (corrected 2026-06-24).** `get_data_range`
    DOES carry the true oldest ts, but `parseDataRangeOldest` scanned only `now−15d`; the real oldest (44 d
    back) fell outside, leaving only the "now" field in range. Widened the scan to **90 days**. So **"Show
    oldest on flash" is back to a READ-ONLY `get_data_range` read** (moves nothing); **"Trim to oldest" is the
    action** (FORCE_TRIM→0 + probe) that positions the dump for a pull.
  - ⚙️ **FORCE_TRIM seek REWRITTEN to a bracketed (false-position) search (2026-06-24).** The old linear-rate
    extrapolation went unstable on a real seek — it computed a trim of **257431** (~5× beyond the valid ~50k
    range); the band wrapped/clamped it, so probes bounced **Jun-19 ↔ Jun-23** and never converged. The rewrite
    in `forceTrimSeek()` probes both ends (now + oldest via FORCE_TRIM→0) to BOUND the valid trim range, then
    interpolates the target strictly INSIDE that bracket and shrinks it — never extrapolating out of range.
    Also fixed `probeReadPos()`: it took the MIN ts of a probe window, but bursts stream non-monotonically (one
    window held both 06:45 and 03:57), so it now uses the median of the first arrivals. `trimToOldest()` no
    longer seeks — it FORCE_TRIMs straight to 0 (the buffer start) and confirms by probe.
  - 🔑 **THE TRIM CEILING — the band's own console explains the clamp (2026-06-24).** A capture showed the
    firmware logging: **`Trim request @ 257431 is beyond writeptr in erased data` → `Setting trim to writeptr @
    104534`** → `Hist pull too short for valid stats`. So **trim ↑ = newer; the WRITE POINTER (≈104534 on
    Jun-24, i.e. "now") is the HARD CEILING**; any FORCE_TRIM above it lands in erased flash and is clamped to
    the writeptr (= now, which has no history to stream → empty probe). This is why the upfront "oldest"
    probe (`FORCE_TRIM→0`) was the step that "failed" and why overshoots clamped to now. `forceTrimSeek()`
    REWRITTEN AGAIN to a **bounded binary search downward from now**: `hi` starts at now's trim (never exceeds
    the writeptr), `lo` at 0; bisect/interpolate on trim via the monotonic ts feedback; an **empty probe = fell
    into erased/too-old flash → raise the floor**. No upfront oldest probe; nothing is ever sent above the
    writeptr. (Same capture also showed the band can REBOOT mid-seek — boot logs `Maverick main Ver 50.36.2.0`,
    reset reason `0x0007` — so the search tolerates transient empty probes with one retry.)
- 🔁 **BLE frame REASSEMBLY (v2.8.2).** The band splits OVERSIZED frames (the 1.2–2 kB end-of-dump blocks) across
  several notifications; only the first carries the `0xAA` SOF. The old per-notification parse logged every
  continuation fragment as a red `no 0xAA / short` (one real sync produced 1,451) and spawned bogus `?NNN`
  unknown-type ghosts in the `fd4b frames:` counter. `onFrame` now buffers per channel and slices COMPLETE frames
  by **SOF + declared length** (full frame = 8-byte header + declared) before parsing; raw notifications are still
  captured verbatim for RE. Replaying a real capture: 1,451 red errors → 0, same 79,710 frames, 0 leftover.
- 📲 **AUTO-SYNC pill (v2.8.3, Phase-1 = tap-to-sync).** Top-right `#syncpill` (WHOOP-style). On launch
  `autoConnect()` reconnects to the remembered band by saved `deviceId` (no chooser — same call `reconnect()`
  uses). The pill shows how far **behind** the app's stored data is (`now − max stored maxTs`), and a **tap**
  runs `resumeSync()` → seek to `lastStoredTs − 15 min` (overlap so a seek overshoot can't leave a gap; dedup
  absorbs it) → `dailySync` drain → store. It **never auto-drains** (the ack is destructive — would free records
  WHOOP hasn't synced in Phase 1); the drain's confirm stays the gate. Flip to fully-automatic only in Phase 2.
- ⚠️ **Phase-1 vs Phase-2 — the "no seek needed" rule only holds in Phase 2.** In **Phase 2** (subscription
  cancelled, WHOOP app gone) nobody else acks the band, so the dump's oldest-un-acked frontier *is* last
  night → a plain **daily `Sync full history`** pulls it incrementally, no seek. **But in Phase 1
  (calibrating)** we must let the WHOOP app sync first — and **WHOOP's own sync advances the band's commit
  cursor PAST that night**, so a plain Sync would start at "now" and pull nothing. Therefore the **daily
  calibration pull MUST FORCE_TRIM-first**: rewind (cmd 25) to last night's evening (WHOOP stores up to 14 days
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
- ⚡ **SYNC SPEED — VERIFIED root cause (adversarial multi-agent investigation, 2026-06-27). ⚠️ The earlier
  "it's the iOS connection interval" claim was WRONG — REFUTED twice; do not revive it.** A drain runs **fast
  (~120 rec/s, ~50-rec batches, dup≈1.03)** or **slow (~8 rec/s, ~13-rec batches, dup≈3.0)**. PROVEN findings:
  - **NOT the connection interval.** Inter-NOTIFICATION timing is the SAME ~15 ms quantum in fast and slow
    sessions (the "different timing" we once measured was an artifact of counting ALL frames incl. console/event;
    isolating in-batch `(47)` gaps: fast 6.6 ms/rec vs slow 40 ms/rec). So a reconnect "re-roll" can't fix it.
  - **It's PACKETS-PER-CONNECTION-EVENT / batch size** (Bluetooth spec: an event stays open via the More-Data bit
    only while a side has data queued; an acked-batch stop-and-wait pays ≥1 interval of dead air per `HISTORY_END
    →ack→resume`). Fast = band TX buffer full → many records/event (records-per-clump 2.6). Slow/live-edge = few
    records/event (1.1) → each tiny batch's fixed round-trip dominates. records/event, NOT interval length, is the lever.
  - ⛔ **cmd 96 (high-freq sync) is NET-HARMFUL — DEFAULT IT OFF (`hiFreqSync`, v2.24.0).** Every clean dup≈1.03
    capture used NO cmd 96; every dup≈3.0 (slow) capture USED it. cmd 96 introduces an **intra-batch 3× record
    triplication** (51 wire / ~17 unique / +17 advance, ~0 inter-batch overlap) and does NOT raise the rate.
  - ⛔ **`ensureFastLink` (v2.23.0) REMOVED (v2.24.0)** — built on the refuted interval premise; its read-only
    probe + auto-reconnect (31 s backoff × rerolls) actively BROKE syncs (a 0.8 rec/s capture was its storm +
    a dailySync seek/abort thrash). No link probe, no auto-reconnect re-roll.
  - **The fast lever = pull a LARGER MID-BUFFER backlog** (seek further back so the band's TX buffer stays full →
    big batches, dup≈1.03). Scraping the live edge is inherently slow. Keep the v2.17.0 async ack-pipelining;
    feed it a full buffer. Real minor levers: foreground + screen wake-lock (v2.18.0), Low Power Mode OFF.
  - **Broken-capture failure mode = self-inflicted aborts:** `forceTrimTo`/`probeReadPos` abort + the stray-firehose
    guard firing cmd20/cmd97 BETWEEN passes cut off each stream → "Hist pull too short for valid stats" → re-seek.
    Fixed (v2.24.0): `managedPull` flag suppresses the guard during a dailySync; stall reset gated on NEW records
    only (dup re-serves no longer reset the re-prime counter → no infinite live-edge loop); re-prime cap 5→3;
    `reconnect()` fires immediately (backoff only after a failure) + honors Stop.
  - Apple QA1931 (true but ~2× swing only, not our 6×): no iOS API to set interval/MTU/PHY; plugin
    `requestConnectionPriority` is an iOS no-op; only HID-over-GATT gets 11.25 ms; HR service gets no special interval.
    Sources: Apple QA1931, Memfault BLE primer, ble-guides (Punch Through tables), Silicon Labs/Nordic throughput.

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
- ✅ **STEPS — band-derivable after all; CORRECTED 2026-06-23 (two earlier wrong calls retracted).** WHOOP's
  own site: steps come from the **wrist accelerometer** + ML (filters non-walking) + stride estimation. My
  "phone-sourced" call was wrong — the APK's Health-Connect `StepsRecord` (`z6/k3.java`) is WHOOP *exporting*
  steps to the OS, not the source; the band's `accelerometer_magnitude` metric is uploaded and WHOOP computes
  steps cloud-side. We HAVE that accel: **the `f32@37/41/45` vector is RAW wrist accel, not normalised** —
  `|v|` swings **0.45–4.26 g** (mean 0.999; ~1 g gravity at rest, spikes on motion). Plus **`f32@33` is a
  motion-energy field** (~0.05–0.2 at rest, spikes 1.4–2.0 in lockstep with `|v|`). Both at **~1 Hz** (one
  R10 record/sec). ⇒ Steps are computable WHOOP's way: detect walking (sustained accel-energy with walking
  cadence, ML-filter driving/cycling) → estimate count = walking-time × cadence / stride model. The 1 Hz rate
  means **estimation, not per-step peak counting** (that's what "ML + stride estimation" is anyway).
  NEXT: a **WALKING capture** (walk a known count, e.g. 100 steps, then Sync) to see the signal and
  build/calibrate the walking-detector + step estimator. (GPS is phone-sourced; `GSR` is a real band metric
  not yet located in the record.)
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
  - ✅✅ **CROSS-VALIDATED 2026-06-25 against 3 other 5.0 RE projects + a real 61,872-record night capture
    (df8c7386).** Our offsets are RIGHT; the cross-source disagreements resolve in our favour:
    - **HR@14, accel@37/41/45, skinTemp@65÷100** — independently confirmed by `Sophonbot0/whoop-vault`
      (the closest 5.0 peer; same Maverick framing/ack-loop/record map). whoop-vault lands on the EXACT
      same absolute offsets incl. the ÷100 skin-temp scale.
    - **SpO2@74 — PROVEN here, not just claimed.** In the night capture byte[74] is 0 in 97.7% of records
      with the non-zero values clustered at **95/96/97%** (textbook sleep-only SpO2). `openwhoop`'s claim of
      SpO2 @data48 (abs ~51) is WRONG for the 5.0 — byte[51] holds 180/200/237 (an activity-score field, not
      SpO2). So keep @74.
    - **Ack `[01][trim][0]` — PROVEN correct.** Across all 1,206 `HISTORY_END(49,code2)` frames the word we
      echo (payload `@13`, monotonic) drives the cursor and the SECOND u32 (`@17`) is **0 in 100% of frames**.
      whoop-vault/openwhoop "echo metadata `[14:18]`" = our `@17` = 0 for this band, so identical bytes — not a
      bug. (HISTORY_END layout: `@3` unix u32, `@9` per-batch count, `@13` TRIM, `@17` 0.) Optional robustness:
      echo `@17` verbatim instead of hardcoding 0 (same output today, future-proof).
    - **Framing confirmed:** CRC16-MODBUS over `[0..6]` + zlib CRC32 over the **4-byte-padded** inner. We
      already pad (`padLen`) — whoop-vault warns the strap *silently drops un-padded commands*. (whoop-vault's
      docstring mislabels the CRC16 as CCITT-FALSE; openwhoop+whoof+our band's self-test say MODBUS — MODBUS is
      right.)
    - **New fields available if useful:** 2nd skin-temp `@61` u16÷10 (coarser; we have @65÷100), activity-score
      u8 `@51` (~91–255), sub-seconds u16 `@11` (1/32768), on-body status bit in flags `@13`.
- 📚 **Other 5.0/4.0 projects + published WHOOP intel (researched 2026-06-25) — for calibration/Phase-2:**
  - **Throughput:** whoop-vault sustains **~120 chunks/s (~50 KB/s)** via cmd-96 + **async ack pipelining**
    (queue acks, fire on HISTORY_END) + **commit every ~200 records**. Our pipelined drain (v2.17.0) mirrors this.
  - **Sleep-need (WHOOP patent US 11,627,946 B2):** `SleepNeed = Baseline + f(strain) + debt − naps`, strain term
    **`f(i) = 1.7/(1 + e^((17−i)/3.5))`** (minutes-equiv, i=strain 0–21). The one published constant — use directly.
  - **Strain zones use Heart-Rate Reserve:** `targetHR = (HRmax−RHR)·pct + RHR`, zones at **40/60/70/80/90 %HRR**;
    Day Strain 0–21 logarithmic (Borg RPE). HRV = **RMSSD during last slow-wave sleep**. Calibrate z0–z5 to HRR.
  - **Recovery weights (3 peer references, NOT WHOOP's — all guesses, cross-checks only):** whoof — linear, HRV .35/
    RHR .20/resp .10/temp .10/sleep .15/priorStrain .10, neutral 70; my-whoop — logistic `100/(1+e^(−1.6(Z+0.20)))`
    (Z=0→**58%**), HRV .60/RHR .20/resp .05/sleep .15; geniemax (closest 5.0 peer) — `100·Φ(.55·zHRV−.20·zRHR−.10·zRR+
    .15·zSleep)`, **zHRV on ln(RMSSD)**. ⇒ we adopted **bias→58% population anchor** + **lnRMSSD HRV z-score** (v2.22.0).
    openwhoop has NO HRV→Recovery model (we're ahead there).
  - **Strain compression — peers differ; ours is the patent w(v) integral:** openwhoop/my-whoop `21·ln(TRIMP+1)/ln(7201)`
    (Edwards zone-TRIMP, weights 1–5); geniemax `21·(1−e^(−TRIMP/τ))` (Banister). We use WHOOP's PATENT load (w={0,1,18,42}
    HRR integral) → our `strainFromLoad` 21·(1−e^(−load/scale)) (same saturating shape as geniemax). Calibrate `scale`.
  - **Other peer constants (cross-checks):** VO2max Uth `15.3·HRmax/HRrest` (we match); TRIMP ♀ `0.86·e^(1.67x)` / ♂
    `0.64·e^(1.92x)` (we match); my-whoop HRV baseline EWMA half-life 14 nights, artifact filter = Kubios/Lipponen
    (the "Malik" claim is marketing); geniemax baselines α: HRV ~7d, RHR/resp/sleep ~30d.
  - **FORCE_TRIM-as-seek is novel to us** — openwhoop only uses cmd 25 to `erase()`; edge/my-whoop/whoop-vault
    never rewind. Our `seek.js` bounded search is ahead of all of them.
  - Repos: `Sophonbot0/whoop-vault` (5.0, closest), `madhursatija/whoof` (4.0+5.0, richest scoring),
    `zhenglong-wu/OpenWhoop` (maintained openwhoop, 4.0+5.0), `johnmiddleton12/my-whoop`, `OpenStrap/edge` (4.0).
- ⚖️ **WHOOP PATENT PORTFOLIO — disclosed algorithms (researched 2026-06-25; ~87 patents, core inventors Ahmed,
  J. Capodilupo, A. Nicolae). HARD = an equation/constant we can implement; SOFT = structure only, calibrate the rest.**
  - ✅✅ **STRAIN — HARD, IMPLEMENTED (v2.20.0).** Patents `US 11,185,241` / `US 11,185,292` / `US20140073486A1`:
    cardiovascular load `I = ∫ w(v(t)) dt`, `v = (HR−RHR)/(MHR−RHR)` (HRR), with a STEP weight
    **`w = 0` at 0 · `1` on (0,AT] · `18` on (AT,CPT] · `42` on (CPT,1]** — the 1→18→42 jumps are why high zones
    accrue strain so fast. Normalize by `42·24h`, compress to 0–21 (sigmoid/arctan). Implemented in `scores.js`
    `strainWeight()` + `makeStrainAccumulator` (weight·minute load → `strainFromLoad`); AT/CPT (HRR fracs) CALIBRATE.
  - ✅ **HRV SAMPLING — HARD rule.** `US 9,750,415 B2` / `US 9,743,848` ("HRV with sleep detection"): compute **RMSSD
    in the LAST slow-wave-sleep period immediately before waking** (highest-quality HR window within it) → feed Recovery.
    We currently take whole-night RMSSD (`store.js` line ~87) — TODO: switch to last-SWS window (we already stage the night).
  - ✅ **SLEEP STAGING from respiration — HARD constants.** `WO2014047310` / `US 10,492,720` / `US 11,801,009` /
    `US 12,178,600`: 30-s epochs; per-epoch respiration rate = freq of **max PSD**; **high RR-variability → REM, low →
    deep(N3)**; signal-quality gate **>40 mV**; RR-variability stability threshold **0.5 bpm** (high-quality) / **1.5 bpm**
    (low); breath-consistency bounds **±0.1 s or ±2.5%**; smoothing: **runs of ≤4 deep epochs → relabel light**. Our
    classifier is HR/HRV/actigraphy — could add these respiration-variability features (resp is the @72 byte, tentative).
  - ✅ **SLEEP NEED — HARD (already implemented).** `US 11,627,946 B2` + continuation `US 12,318,226`/`US20240252121A1`:
    `SleepNeed = Baseline + f(strain) + f(debt) − naps`, `f(i)=1.7/(1+e^((17−i)/3.5))` h. Debt scaled+capped per person.
  - ◐ **RECOVERY — SOFT (input set HARD, weights NOT disclosed).** `US 11,574,722` / `US20140073486A1`: recovery is a
    **weighted combination of HRV + RHR + sleep score + RECENT STRAIN (intensity)** — note RECENT STRAIN is an input we
    DON'T yet use (TODO: add a prior-day-strain term to `recoveryScore`). The 65/20/15-type weights are blog estimates,
    NOT patent-disclosed; the 2024 systematic review confirms WHOOP's recovery/strain weights are unpublished → only our
    cloud calibration can fix them.
  - **SpO2** `US 10,799,162` (660 nm + 855 nm, `SpO2 = C1 − C2·R`) and **multi-estimator HR fusion** `US 9,538,923`,
    **data-quality weighting** `US 11,185,292`/`US 11,986,323` (weight metrics by P(accurate); drop below-threshold or
    below-adjacent segments) — relevant if we ever decode raw PPG; we read the band's computed SpO2@74 directly.
  - **Validation reality check:** peer studies confirm the INPUTS are accurate (HR ~±0.4%, RHR MAPE ~3%, HRV RMSSD ICC
    ~0.99, resp ±1 bpm) but NO study reverse-derived Recovery/Strain weights — calibration-vs-cloud is the only path.
    Sleep staging is only "fair" even WHOOP-vs-PSG (κ≈0.37–0.49) → keep calibrating to the stage SUMMARY, not the hypnogram.
- 🔎 **Official/community algorithm intel (2nd scan, 2026-06-25) — calibration-critical facts:**
  - ⚠️ **ZONE CUTOFFS — app ≠ API (RECONCILED, code now matches API).** WHOOP's *app* shows zone 1 from **40 %HRR**,
    but the developer-API **`zone_duration`** object (singular! z0…z5 — our answer-key) buckets at **50/60/70/80/90 %HRR**
    with a z0 catch-all <50%. `ZONE_EDGES_HRR` is now `[0.5,0.6,0.7,0.8,0.9]` to calibrate 1:1 against `zone_duration`.
  - **Recovery — staff-confirmed input set + baselines:** original = HRV + RHR (in deep sleep) + Sleep Performance;
    **respiratory rate added later** as an INDEPENDENT term (info not already in HRV/RHR/sleep). RHR/sleep contribute
    **far less** than HRV (collinear with it) → keep HRV-dominant, small non-HRV weights. **HRV baseline = 30 days;
    Stress Monitor baseline = 14 days** (different windows). Calibration needs **4 nights** before WHOOP scores; ~30 d
    to settle. Pop. anchor: **avg recovery ≈ 58–60 %** (output sanity check). Recovery colours **Red ≤33 / Yellow 34–66 /
    Green ≥67** (our `recColor` already matches).
  - **HRV metric:** WHOOP reports **RMSSD** (Altini: a *weighted* nightly RMSSD, weighted toward SWS/late night — supports
    our last-SWS-window switch). whoof uses **lnRMSSD** for day-to-day stability — a candidate for our recovery z-score.
  - **API v2 fields (answer-key):** Recovery `recovery_score/resting_heart_rate/hrv_rmssd_milli(float ms)/spo2_percentage/
    skin_temp_celsius/user_calibrating`; Sleep `sleep_needed{baseline + need_from_sleep_debt + need_from_recent_strain −
    need_from_recent_nap}` (matches our patent model exactly) + `stage_summary` + `sleep_performance_percentage`; Workout
    `score{strain, zone_duration{zone_zero…five_milli}}`. `*_percentage` are **0–100 floats**. **Drop/down-weight rows where
    `user_calibrating==true`.** Sleep/Workout ids are UUIDs in v2 (Cycle id stays int).
  - **Strain:** HR sampled **every second**; Borg-RPE log 0–21; targets ~**10–14 recovery days / 14–18 training days**.
    5.0/MG strain = cardio load + **muscular load** (volume×intensity from reps/sets) — band-only Phase-2 reproduces the
    **cardio half** only.
  - **Closest 5.0 peer found:** `satayutata/geniemax-core` (Swift, golden-vector-tested 5.0/MG recovery/sleep/HRV/strain) —
    mine its test fixtures for exact expected outputs. API struct refs: `ferueda/go-whoop`, `hedgertronic/whoop`.
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
