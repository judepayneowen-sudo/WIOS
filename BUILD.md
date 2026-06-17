# WHOOP Core — standalone iOS reader

A self-contained iOS app that reads a **WHOOP 5.0** directly over Bluetooth and shows live
heart rate, HRV, battery, and device info — and (the reason it's on iOS) it can reach the
custom `fd4b` command service that Windows can't, because **CoreBluetooth performs WHOOP's
on-demand BLE encryption automatically**. Completely independent of ARC Home.

Built with Capacitor (same proven pipeline as the ARC iOS app): a free macOS GitHub Actions
runner produces an **unsigned `.ipa`**, and **Sideloadly** installs it with your free Apple ID
(no Mac, no $99 Apple Developer account).

## What v1 does
- Connect to the WHOOP 5.0, read battery + model/firmware/serial/manufacturer.
- **Live HR + HRV (RMSSD)** from the standard Heart Rate service.
- Subscribe to the custom `fd4b` notify channels and send the read-only commands
  `get_hello` (145), `get_battery_level` (26), `get_data_range` (34); decoded frames stream to the log.
- This proves the deep-metric service is reachable on iOS. Computing the full WHOOP **scores**
  (recovery / strain / sleep) and **historical sync** are the next milestones — they're a large
  algorithmic port and aren't in v1.

## Build it (no Mac needed)
1. Put this `whoop-ios/` folder in its **own GitHub repo** (keeps it separate from ARC Home), e.g.:
   ```sh
   cd whoop-ios
   git init && git add . && git commit -m "WHOOP Core v1"
   gh repo create whoop-core --private --source=. --push   # or create the repo in the web UI and push
   ```
2. On GitHub → **Actions** tab → **"Build WHOOP Core iOS (unsigned .ipa)"** → **Run workflow**.
3. When it finishes, download the **`WHOOP-Core-unsigned-ipa`** artifact (a `.zip` containing the `.ipa`).

## Install it
1. Open **Sideloadly** on Windows, plug in your iPhone.
2. Drag in the `.ipa`, sign in with your Apple ID, **Start**.
3. On the iPhone: Settings → General → VPN & Device Management → trust your Apple ID.
4. Launch **WHOOP Core**, allow Bluetooth, tap **Connect**, pick your band.
   - Quit the WHOOP phone app first (a band serves one connection at a time).

## Dev notes
- Web UI lives in `www/index.html`; logic in `src/app.js` (bundled to `www/app.js` by esbuild during build).
- BLE via `@capacitor-community/bluetooth-le` → CoreBluetooth.
- Protocol (frame build/parse, CRC16-MODBUS + CRC32) is a clean-room reimplementation of the
  GOOSE/Gen5 format, verified byte-identical to the known `get_hello` fixture
  (`aa0108000001e67123019101363e5c8d`) by the on-launch self-test.
- GATT: service `fd4b0001-cce1-4033-93ce-002d5875f58a`; write `…0002`, notify `…0003/0004/0005`.
