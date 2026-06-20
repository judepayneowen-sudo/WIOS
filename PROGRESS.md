# WHOOP Core — progress & handoff

Standalone iOS app that reads a **WHOOP 5.0** directly over Bluetooth. Independent of any
other project. This file is the portable context: read it on your phone (GitHub) or hand it
to Claude on `claude.ai/code` pointed at this repo to continue with full context.

## UI overhaul (v0.2.0)
WHOOP-style dashboard rebuilt against the official app: **interactive, horizontally-scrollable
charts with a drag-to-read scrub readout** (HR 24h, recovery/strain/sleep trends), a new **Trends**
tab (1W/1M/6M segmented toggle), **Health Monitor** + **Stress** cards on Overview, **HR-zone
breakdown** with personalized %-of-max ranges + an optimal-strain band, an **Activities** list, and a
**Sleep-need breakdown** (baseline/debt/strain/nap) with efficiency·consistency·respiratory·
disturbances·time-in-bed. All sample-driven preview until decoding fills it in; live HR/HRV/stress
patch in real time. Charts in `src/app.js` (`interactiveChart`), screens in `www/index.html`.

## ✅ REAL-BAND VALIDATION (2026-06-20, v1.0) — `drainHistory` works; 5.0 records are EVENT(48)

First on-band "Sync full history" capture (`whoop-capture-2026-06-20T18-27-31.txt`, band 5A0097737378,
fw 50.36.2.0). Decoded with `tools/whoop-decode.mjs`:

1. **The ACK-loop drain runs end-to-end on the real 5.0 band.** Clean cycle:
   `HISTORY_START → HISTORY_END → … → HISTORY_COMPLETE` over 3 batches. The loop terminated correctly.
2. **5.0 trim offset = `@13`** (same as the documented 4.0 offset). Monotonic values **1 → 2 → 77**;
   the auto-probe locks `HISTORY_END@13`. No mystery offset.
3. **🔑 5.0 buffers its records as `EVENT(48)`, NOT `HISTORICAL_DATA(47)`.** The dump streams EVENT(48)
   frames between the START/END markers: ts @ body `[4..7]` (verified **+30 s** cadence), subcode `[2]`
   (`0x03` periodic metrics record + `0x3f` companion; other subcodes = connection/device-info events).
   The shipped v1.0 only recorded `(47)`, so it logged **"0 records"** despite the perfect ACK-loop.
   **Fix:** `onPullRecord` + `decodeCapture`/`decodeHistoricalEvent` now capture EVENT(48) too — this
   capture yields **49 records** (2026-05-11 00:42→02:23, incl. 17 thirty-second `0x03`/`0x3f` pairs).
4. **HR/RR offsets within EVENT(48) are still TBD** — not fabricated. The `0x03`/`0x3f` fields are
   accumulators (monotonic counters) + ~constant sensor values; no clean HR byte in this short tail.
   This dump was tiny (~tail only, trim≤77) because the official WHOOP app had already advanced the
   cursor. **NEXT: an overnight worn capture taken *before* letting the WHOOP app sync** → thousands of
   records → pin HR/RR against the WHOOP-app night reference, then feed `scores.js`.

## ⭐ BREAKTHROUGH (2026-06-20) — historical sync cracked + sleep approach settled

After a strategic step-back we **stopped re-deriving from scratch and aggregated the community WHOOP
RE** ([whoof](https://github.com/madhursatija/whoof) — full protocol incl. the dump state machine;
[openwhoop](https://github.com/bWanShiTong/openwhoop) / [noop](https://github.com/noop-app/noop) —
local recovery/strain/sleep; [goose](https://github.com/b-nnett/goose) — WHOOP 5.0 on iOS). Two facts
changed everything:

1. **The historical dump is a documented ACK-loop — `set_read_pointer`/cmd 33 was a RED HERRING.**
   Mechanism: `send_historical_data(22)` → band streams batches of `HISTORICAL_DATA(47)` framed by
   `METADATA(49)` `HISTORY_START(1)`…`HISTORY_END(2)`. The host acks each batch with
   `historical_data_result(23) = [01][u32le trim][u32le 0]`, where **`trim` = the flash-record index
   from that batch's `HISTORY_END`**. That frees the records, advances the read cursor, and releases
   the next batch — looping until `METADATA(49) HISTORY_COMPLETE(3)`. **Our long-standing bug: we acked
   with `trim=0` (`HIST_ACK=[1,0,…]`), which never walked the buffer.** Confirmed offline:
   `decodeMetadata` extracts `trim=5368` from a `HISTORY_END` — exactly the band's console "Trim: …5368".
   Now implemented as **`drainHistory()`** in `src/app.js` (auto-probes the 5.0 trim offset on batch 1,
   then locks it). **Non-destructive** (cursor advance; the WHOOP app re-reads by rewinding its own).

2. **WHOOP stages sleep (and computes Strain/Recovery) in its CLOUD, not on the band.** The strap only
   stores raw 1 Hz HR + RR + accel. So an **exact** WHOOP sleep-stage match is **impossible standalone**
   — the algorithm leaves with the subscription. Settled target (user-approved): a **local
   cardiopulmonary + actigraphy classifier calibrated to match WHOOP's per-night stage SUMMARY** during
   Phase 1 — "calibrated-close, not byte-identical", exactly as openwhoop/noop do. Implemented as
   `classifySleepStages()` in `src/scores.js` (HR-rel / HRV-rel / movement features, tunable
   `SLEEP_STAGE_PARAMS`), with stage-summary fitting wired into `tools/calibrate.mjs`.

   ⚠️ **Needs a real-band run to validate:** the corrected drain is built against the documented 4.0
   spec + a 5.0 auto-probe; a "Sync full history" run over a worn night will confirm the trim offset and
   feed the first real overnight epochs into the sleep calibration.

## TL;DR — where we are (updated 2026-06-18)
- ✅ **App is LIVE on the iPhone — WHOOP Core v0.1.6.** Installed via **SideStore**; updates
  **over-the-air** from the `wios-awe.pages.dev` source — no cable.
- ✅ **Live HR + HRV (RMSSD) + battery + device info** — via *standard* BLE services, no auth.
- ✅ **Custom `fd4b` command service working on iOS.** CoreBluetooth bonds/encrypts on demand,
  so the deep-metric service responds. This is the whole reason it's iOS: **Windows could NOT**
  (WinRT bonds at protection level "None" — no encryption key — so the link is unreachable).
- ✅ **Realtime stream decoded.** `toggle_realtime_hr` (cmd **3**, data `01`on/`00`off) →
  REALTIME_DATA(40): HR at payload byte **8**, RR-present flag byte **9**, RR ms bytes **10–11** (LE).
- ✅ **Drop-box** (v0.1.5): "Send to laptop" POSTs captures over WiFi to `tools/whoop-dropbox.py`
  → `captures/` (no copy-paste). *Laptop-only receiver.*
- ✅ **Read-only historical sync** (v0.1.6): streams HISTORICAL_DATA(47) **without** the commit-ack,
  so the band keeps the data for the official app (won't starve WHOOP's own cloud sync).
- ✅ **Score-calibration harness** (committed `bdae010`): tunes `scores.js` against the **WHOOP API**
  (the ground-truth answer-key). The scores are computed in WHOOP's **cloud** — *not* on the band
  or in the app, so they can't be reverse-engineered out of goose/the binary. We reconstruct the
  published shapes and **fit** the constants. See `tools/CALIBRATE.md`.
- ✅ **Full-night pull** (v0.1.8): new **Pull full night** button walks the historical read pointer
  forward with **set_read_pointer (cmd 33)**, burst-by-burst, to pull the *whole* buffer (the plain
  sync only ever returned the oldest ~30). Still **read-only** — never sends the commit-ack (cmd 23),
  so nothing is wiped and the official WHOOP app can still sync. cmd 33's payload format is unknown,
  so it **auto-probes** (`idx-u32` → `idx-u64` → `ts-u32`) on the first run and locks the winner.
  Logic validated against a simulated band; needs a real-band run to confirm the encoding.
- ✅ **Capture decoded (2026-06-19, `whoopcapture20260619T124557`).** `(47)` HR decodes perfectly
  (idx 72551→, 1/s, HR 80→72). `get_data_range` shows the band buffers **~25 h** (oldest Jun-18 11:28
  → now), so **last night is on the band**. **Key finding:** read-only stalls at ~30 not because of
  the pointer but because of **flow control** — the band's own console log says it dumped `Data: 601`
  but only 30 crossed BLE; it sends a ~30-record window then **waits for `historical_data_result(23)`**
  before sending more. So a full pull *requires* acks. The pointer (`~5370`) never moved on the
  `set_read_pointer` guesses (wrong number space — pointer lives near 5370, not the 72551 record idx).
- ⚠️ **Trim test ANSWERED (2026-06-19, DESTRUCTIVE).** `historical_data_result(23)` with the
  `[01 …]` payload = **commit up to the read pointer = wipe the whole buffer**. Proof: a single ack
  moved `get_data_range`'s oldest from Jun‑18 11:28 → "now" (+28.8 h), and a follow‑up **read‑only
  sync returned 0 records**. Mechanism: `send_historical_data(22)` makes the band internally read its
  *entire* buffer (read pointer races to the end; console: `Data: 601 … Dump Complete`), streaming
  ~30‑record windows gated by acks — and the ack commits to that end pointer. **Consequences:** acked
  sync = full wipe (and the data never reached WHOOP's cloud either, so it's gone); read‑only = max
  ~30 (one BLE window) because only an ack releases the next window. Net: **no non‑destructive full
  pull yet.** The ~29 h buffer (incl. that night) was lost in the test.
- ✅ **CORRECTION (2026-06-20): the ack is NOT destructive.** Earlier we concluded the historical ack
  "wipes" the buffer — **wrong**. Proof: the official WHOOP app **re-synced 3 days** after we thought
  it was lost. The ack advances a read/commit **cursor** to the end (not a delete); the band keeps a
  rolling **multi-day** buffer; WHOOP re-reads by rewinding its own cursor. After we commit,
  `get_data_range` shows oldest="now" and our read-only returns 0 — that's the cursor position, not
  deletion. **So the only blocker is rewinding our own cursor:** `set_read_pointer (cmd 33)` (accepted,
  responds `0x21`, payload unknown). No data-loss risk experimenting.
- 🔜 **Phase-2 band-RE (develop on sacrificial days, parallel to cloud calibration):** verify a full
  **paced acked sync** delivers the whole buffer (trim test only did one ack+abort); finish the
  `(47)` decode (RR/HRV + sleep staging); validate by HR sanity/consistency (not WHOOP same-day).
- 🔜 **Then:** decode `(47)` HR for **Strain** (the one score the WHOOP cloud API can't give —
  see `CLAUDE.md`). Recovery + Sleep calibrate from the cloud alone; accumulate ~2–3 weeks.

## Working from your phone — temp handover (next few days)

On `claude.ai/code` (pointed at this repo) or GitHub mobile. What's doable where, so you don't
reach for a tool that only runs on the laptop:

### ✅ Doable from the phone
- **Edit code/docs, commit, push.** Always `git fetch` first — desktop + phone both push here.
- **Ship a build to the phone, no laptop:** bump `version` in `package.json` → run **release.yml**
  (Actions → Run workflow, or `gh workflow run release.yml -f version=X.Y.Z`). It publishes the
  source + `.ipa` to `wios-awe.pages.dev`; **SideStore** then updates WHOOP Core OTA (open SideStore → refresh).
- **Use the app + capture on-device** (Connect, Start capture, **Dump** to clipboard). Paste a dump
  into chat if you want it decoded/eyeballed.
- **Phone-sized tasks:** UI polish in `www/index.html`; the `HISTORICAL_DATA(47)` decoder
  (`decodeHistorical` stub in `tools/whoop-decode.mjs`); labels/docs.

### 🔌 Laptop-only (NOT from the phone)
- **Drop-box** `tools/whoop-dropbox.py` — needs the laptop on the same WiFi. From the phone use the
  app's **Dump** (copy text) instead of **Send to laptop**.
- **`tools/whoop-api.mjs`** + **`npm run calibrate`** — need Node + the gitignored `.whoop.env` creds
  + `captures/`, all on the laptop. (Recovery/sleep need ~2–3 weeks of data anyway, so this waits regardless.)

### ⏳ Time-gated (just wear the band)
- **Recovery + Sleep** calibration needs ~2–3 weeks of WHOOP **cloud** history as the answer-key
  (only ~1 day so far). **Keep the official WHOOP app syncing** during this window — that's what fills
  the cloud. Accumulates passively; nothing to code.
- **Strain** isn't time-gated (it's computed daily), but needs a **full-day capture** = the band's
  historical buffer = the `HISTORICAL_DATA(47)` decode (the one open decoder TODO).

### ⚠️ Gotchas
- **VPN OFF** on phone + laptop (Nord broke Bonjour/local-network before).
- **Quit the official WHOOP app** before connecting WHOOP Core (one BLE connection at a time); reopen
  it after so it resyncs to the cloud.
- **`git fetch` before every push** (parallel desktop/phone work).
- The drop-box only catches sends while the **laptop is on with `whoop-dropbox.py` running** — don't rely on it while away; use **Dump** instead.

## Build & run
**Now installed (current path):** via **SideStore**, updating OTA from the `wios-awe.pages.dev`
source. To push an update: bump `package.json` version → run **release.yml** → open SideStore → refresh.

**From scratch (if ever reinstalling):**
1. **Actions** tab → "Build WHOOP Core iOS" → **Run workflow** → download `WHOOP-Core-unsigned-ipa`.
2. **Sideloadly** or **SideStore** → Apple ID → install → trust on phone (Settings → General → VPN & Device Management).
3. Launch **WHOOP Core**, allow Bluetooth, **Connect** (quit the WHOOP phone app first — one BLE connection at a time).
4. In-app: command buttons, **custom command sender** (cmd # + hex data), **Capture/Dump** (raw `fd4b` frames → clipboard), **Send to laptop** (drop-box), **Sync history** (Read-only).

## Protocol (clean-room reimplementation of the GOOSE/Gen5 format)
### GATT map
- Service `fd4b0001-cce1-4033-93ce-002d5875f58a`
  - `fd4b0002` **write** — command_to_strap
  - `fd4b0003` notify — command_from_strap (command responses)
  - `fd4b0004` notify — events_from_strap
  - `fd4b0005` notify — data_from_strap (realtime / historical data)
- Standard (no auth): Heart Rate `0x180D/0x2A37` (HR + RR-intervals), Battery `0x180F/0x2A19`, Device Info `0x180A`.

### Frame format
```
outbound:  AA 01 <len u16-LE> 00 01 <crc16-modbus(first 6 bytes), LE>  <payload>  <crc32(payload), LE>
inbound :  same, but header byte[4] = 01  (direction flag; header CRC still covers bytes 0..6)
payload :  [ packetType, sequence, command/event, ...data ]
```
- **packetType:** 35 COMMAND · 36 COMMAND_RESPONSE · 40 REALTIME_DATA · 43 REALTIME_RAW_DATA · 47 HISTORICAL_DATA · 48 EVENT · 49 METADATA · 51 REALTIME_IMU · 52 HISTORICAL_IMU
- CRC16 = MODBUS (init `0xFFFF`, poly `0xA001`); CRC32 = standard, little-endian. Payload padded to a multiple of 4.
- get_hello reference frame (self-test): `aa0108000001e67123019101363e5c8d`

### Command numbers (known)
| # | id | notes |
|---|---|---|
| 1 | link_valid | |
| 2 | get_max_protocol_version | |
| **3** | **toggle_realtime_hr** | **realtime HR packet stream — the realtime enabler** |
| 7 | report_version_info | |
| 10 / 11 | set_clock / get_clock | |
| 14 | toggle_generic_hr_profile | the standard `0x2A37` HR profile (already used) |
| 16 | toggle_r7_data_collection | |
| 26 | get_battery_level | |
| 34 | get_data_range | available historical window |
| 33 | set_read_pointer | move historical read pointer |
| 22 / 23 | send_historical_data / historical_data_result | historical transfer |
| 63 | send_r10_r11_realtime | R10/R11 raw — ACKs but needs more setup |
| 145 | get_hello | identity |
- **Guardrailed (confirm-gated) in the custom sender:** 36/37/38 firmware DFU, 39/41/43 optical-sensor (AFE) config — destructive.

## Verified against a real band (serial 5A00977378, fw 50.36.2.0)
- `get_hello` (145) → COMMAND_RESPONSE carrying band clock (unix time, LE), serial string, and a device identity token.
- `get_data_range` (34) → COMMAND_RESPONSE with available-window timestamps + record-index counters (currently only ~minutes of buffer when freshly connected).
- `send_r10_r11_realtime` (63) → only ACKs, no stream (wrong toggle — use cmd 3).
- `toggle_realtime_hr` (3, data 01) → **REALTIME_DATA(40)** stream. Decoded from a real capture:
  payload `[8]` = HR bpm, `[9]` = RR-present flag, `[10..11]` = RR interval ms (LE). Proof: mean
  byte[8] ≈ 60000 / mean RR. (Replayed offline by `tools/whoop-decode.mjs`.)

## NEXT STEPS (in order)
1. **Validate the corrected drain on the real band (THE unblock).** Wear it a few hours / a night, quit
   the WHOOP app, Connect → **Sync full history** → leave until **SYNC COMPLETE** → **Save file / Send to
   laptop**. The log prints the winning `trim` strategy + record count. If it stalls at the first window
   (`trim strategy=NONE`), the 5.0 `HISTORY_END` layout differs — the capture's `METADATA(49)` frames
   (now decoded by `decodeMetadata`, with `trimCandidates` at offsets 3/5/9/13/17) tell us the right
   offset to lock.
2. **(passive) Accumulate the answer-key.** Keep the official WHOOP app syncing to the cloud for ~2–3
   weeks → Recovery/Sleep ground-truth (incl. per-stage minutes). Realtime + (47) HR decode are DONE.
3. **Calibrate (laptop).** `node tools/whoop-api.mjs auth` → `node tools/whoop-api.mjs 60` →
   `npm run calibrate` → paste `RECOVERY_WEIGHTS` / `STRAIN_SCALE` / `SLEEP_NEED` / `SLEEP_STAGE_PARAMS`
   into `src/scores.js` → `npm test && npm run sync`. The new **Sleep-stages** block fits our hypnogram
   classifier to WHOOP's stage minutes once an overnight capture exists. Guide in `tools/CALIBRATE.md`.
4. **Finish the (47) tail decode for sleep movement.** Today the sleep classifier uses an HR-volatility
   movement proxy; decode the accel/IMU tail of `(47)` / `HISTORICAL_IMU(52)` for true actigraphy → better
   Wake/REM separation.
5. **Ship it.** Bump `package.json` version → run `release.yml` → SideStore updates the phone OTA.

## Code map
- `src/app.js` — protocol (CRC/build/parse), BLE flow via `@capacitor-community/bluetooth-le`, UI wiring, capture/dump, drop-box send, read-only historical sync, guardrailed custom sender.
- `src/scores.js` — pure recovery/strain/sleep functions (clean-room approximations; constants flagged `CALIBRATE`, incl. a `bias` term in `RECOVERY_WEIGHTS`). `npm test` → 18 assertions.
- `www/index.html` — cyan HUD UI.
- **Calibration toolchain (laptop):** `tools/whoop-api.mjs` (+`WHOOP-API.md`) pulls official scores → `calibration/whoop-data.json`; `tools/whoop-decode.mjs` replays capture files offline; `tools/calibrate.mjs` (`npm run calibrate`) fits the constants; `tools/CALIBRATE.md` is the how-to; `tools/whoop-dropbox.py` is the drop-box receiver.
- `.github/workflows/` — `build.yml` (unsigned `.ipa`) · `release.yml` (signed source + `.ipa` → `wios-awe.pages.dev` for SideStore OTA).

## Notes
- Protocol is **clean-room**: we reference the *documented* wire protocol + observed behaviour from the
  community RE (whoof/openwhoop/noop/goose) and reimplement it ourselves. Protocol facts (command
  numbers, frame/byte layouts, the dump state machine) aren't copyrightable; **do not copy code**,
  especially from the `UNLICENSED` goose project — reference only.
- **cmd 33 / `set_read_pointer` is NOT used** by the historical dump (was a red herring). The dump is the
  `send_historical_data(22)` → per-batch `historical_data_result(23)` ack-loop, ended by
  `METADATA(49) HISTORY_COMPLETE`. See the BREAKTHROUGH section above.
- Reading your own band's data this way is outside WHOOP's ToS (gray area) — fine for personal use on your own device.
