# WHOOP Core — AltStore source (OTA updates)

Install WHOOP Core through **AltStore** so new versions arrive over-the-air: AltStore polls
a small JSON manifest (`apps.json`) and offers an update whenever its `version` is newer than
what's installed. Because this repo is **private**, the manifest and `.ipa` are hosted on a
**public URL you control** (chosen during setup) — AltStore fetches them with no auth.

> **7-day reminder:** A free Apple ID signature expires after 7 days. This source automates
> delivering *new builds*; it does **not** remove the weekly re-sign. Keep refreshing via
> **AltServer** (PC on the same Wi-Fi) or use **SideStore** for computer-free refresh. A paid
> Apple Developer account ($99/yr) gives 1-year signing and makes this moot.

## One-time: publish a release bundle
1. **Actions → "Release WHOOP Core (AltStore bundle)" → Run workflow.** Fill in:
   - **base_url** — the public folder URL you'll host the files under, e.g. `https://dl.example.com/whoop`
   - **version** — optional (defaults to `package.json` version)
   - **notes** — optional "what's new" text
2. Download the **`WHOOP-Core-altstore-dist`** artifact. It contains three files:
   - `WHOOP-Core.ipa` · `apps.json` · `icon.png`
3. Upload all three to your host so they're reachable at:
   - `<base_url>/WHOOP-Core.ipa`
   - `<base_url>/apps.json`
   - `<base_url>/icon.png`
   (Must be HTTPS and publicly downloadable — open `<base_url>/apps.json` in a private browser tab to confirm.)

## One-time: add the source in AltStore
1. AltStore → **Browse → Sources → edit (＋)** → add `<base_url>/apps.json`.
2. Open the source, install **WHOOP Core**.

## Shipping an update
1. Bump `version` in `package.json` (or pass **version** to the workflow). AltStore compares versions, so it must increase.
2. Re-run the Release workflow with the **same base_url**, re-upload the 3 files (overwrite).
3. On the phone: AltStore → **My Apps** shows an update for WHOOP Core.

## How the bundle is generated (local equivalents)
- `npm run icon` → `dist/icon.png` (dependency-free PNG, cyan ECG glyph).
- `node tools/make-altstore-source.mjs --base <url> --ipa dist/WHOOP-Core.ipa --out dist/apps.json --notes "…"`
  → `dist/apps.json` with `size` + `sha256` computed from the `.ipa`, plus both the modern
  `versions[]` array and legacy top-level fields for old/new AltStore & SideStore clients.

The plain unsigned-`.ipa` workflow (`build.yml`) still exists for one-off Sideloadly installs;
`release.yml` is the AltStore/OTA path.
