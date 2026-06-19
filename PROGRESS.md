# WHOOP Core — progress & handoff

Standalone iOS app that reads a **WHOOP 5.0** directly over Bluetooth. Independent of any
other project. This file is the portable context: read it on your phone (GitHub) or hand it
to Claude on `claude.ai/code` pointed at this repo to continue with full context.

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
- 🔜 **Open question → `Trim test (safe)` button (v0.1.9):** does the ack also **commit/trim**
  (which would stop WHOOP syncing the same day = no answer-key)? The test pokes only the oldest ~60
  records, sends one ack, re-reads `get_data_range`, and prints **NON-DESTRUCTIVE** vs **DESTRUCTIVE**.
  - If non-destructive → a normal acked **Sync history** is safe; use it for the full nightly pull.
  - If destructive → need a non-committing flow-control ack (probe cmd-23 payload) or pointer-seek.
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
1. **(passive) Accumulate the answer-key.** Wear the band daily; keep the official WHOOP app syncing to the cloud for ~2–3 weeks → builds the Recovery/Sleep ground-truth. (Realtime stream + decode are DONE.)
2. **Decode HISTORICAL_DATA(47).** Run a **read-only** Sync-history capture overnight (band keeps the data for the official app), **Dump/Send**, then decode the (47) record stride (timestamp + HR + …) in `tools/whoop-decode.mjs` (the `decodeHistorical` stub) → full-day HR for strain + overnight HRV/sleep.
3. **Calibrate (laptop).** `node tools/whoop-api.mjs auth` → `node tools/whoop-api.mjs 60` → `npm run calibrate` → paste the printed `RECOVERY_WEIGHTS` / `STRAIN_SCALE` / `SLEEP_NEED` into `src/scores.js` → `npm test && npm run sync`. Full guide in `tools/CALIBRATE.md`.
4. **Ship it.** Bump `package.json` version → run `release.yml` → SideStore updates the phone OTA.

## Code map
- `src/app.js` — protocol (CRC/build/parse), BLE flow via `@capacitor-community/bluetooth-le`, UI wiring, capture/dump, drop-box send, read-only historical sync, guardrailed custom sender.
- `src/scores.js` — pure recovery/strain/sleep functions (clean-room approximations; constants flagged `CALIBRATE`, incl. a `bias` term in `RECOVERY_WEIGHTS`). `npm test` → 18 assertions.
- `www/index.html` — cyan HUD UI.
- **Calibration toolchain (laptop):** `tools/whoop-api.mjs` (+`WHOOP-API.md`) pulls official scores → `calibration/whoop-data.json`; `tools/whoop-decode.mjs` replays capture files offline; `tools/calibrate.mjs` (`npm run calibrate`) fits the constants; `tools/CALIBRATE.md` is the how-to; `tools/whoop-dropbox.py` is the drop-box receiver.
- `.github/workflows/` — `build.yml` (unsigned `.ipa`) · `release.yml` (signed source + `.ipa` → `wios-awe.pages.dev` for SideStore OTA).

## Notes
- Protocol was reverse-engineered **clean-room** (from frame fixtures + observed behaviour). Do not copy the abandoned, `UNLICENSED` third-party "goose" project's code — reference only.
- Reading your own band's data this way is outside WHOOP's ToS (gray area) — fine for personal use on your own device.
