# WHOOP Core — progress & handoff

Standalone iOS app that reads a **WHOOP 5.0** directly over Bluetooth. Independent of any
other project. This file is the portable context: read it on your phone (GitHub) or hand it
to Claude on `claude.ai/code` pointed at this repo to continue with full context.

## TL;DR — where we are
- ✅ **Live HR + HRV (RMSSD) + battery + device info** — via *standard* BLE services, no auth.
- ✅ **Custom `fd4b` command service CONFIRMED working on iOS.** CoreBluetooth bonds/encrypts
  on demand automatically, so the deep-metric service responds. This is the whole reason the
  app is on iOS: **Windows could NOT do this** — WinRT bonds the band at protection level
  "None" (no encryption key), so the link the band requires is unreachable there.
- ✅ Builds green via GitHub Actions → unsigned `.ipa` → Sideloadly (free Apple ID, no Mac).
- 🔜 **Next:** enable the realtime sensor stream, decode its packet layout, then historical
  sync for sleep/recovery, then calibrate the score functions.

## Build & run
1. **Actions** tab → "Build WHOOP Core iOS" → **Run workflow** → download `WHOOP-Core-unsigned-ipa`.
2. **Sideloadly** → Apple ID → install → trust on phone (Settings → General → VPN & Device Management).
3. Launch **WHOOP Core**, allow Bluetooth, **Connect** (quit the WHOOP phone app first — one BLE connection at a time).
4. In-app: command buttons, **custom command sender** (cmd # + hex data), **Capture/Dump** (collects raw `fd4b` frames → clipboard for decoding).

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

## NEXT STEPS (in order)
1. **Start the realtime stream.** Capture **on** → custom sender **cmd `3` data `01`** (`toggle_realtime_hr`). Watch the `fd4b frames` counter for **REALTIME_DATA(40)** on the data channel; let it run ~20 s; **Dump**. Send **cmd `3` data `00`** to stop.
   - If it only ACKs, pull goose's exact enable frame + the `start_raw_data` command number.
2. **Decode REALTIME_DATA(40) / RAW(43) / IMU(51)** byte offsets from the captured frames → HR / PPG / accel / SpO₂ / skin-temp. Feed into `makeStrainAccumulator` and recovery inputs.
3. **Historical sync** (for sleep/recovery): `get_data_range(34)` → `set_read_pointer(33)` → `send_historical_data(22)` → stream of **HISTORICAL_DATA(47)** packets → decode overnight HR/HRV + durations.
4. **Calibrate** `src/scores.js` constants (`STRAIN_SCALE`, `RECOVERY_WEIGHTS`, `SLEEP_NEED`, zone edges) by regressing our outputs against the real numbers the WHOOP app shows for the same day.

## Code map
- `src/app.js` — protocol (CRC/build/parse), BLE flow via `@capacitor-community/bluetooth-le`, UI wiring, capture/dump, guardrailed custom sender.
- `src/scores.js` — pure recovery/strain/sleep functions (clean-room approximations; constants flagged `CALIBRATE`). `npm test` → 18 assertions.
- `www/index.html` — cyan HUD UI. `.github/workflows/build.yml` — CI build.

## Notes
- Protocol was reverse-engineered **clean-room** (from frame fixtures + observed behaviour). Do not copy the abandoned, `UNLICENSED` third-party "goose" project's code — reference only.
- Reading your own band's data this way is outside WHOOP's ToS (gray area) — fine for personal use on your own device.
