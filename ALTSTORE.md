# WHOOP Core — AltStore source (OTA updates via Cloudflare Pages)

Install WHOOP Core through **AltStore** so new versions arrive over-the-air. The release
workflow builds the `.ipa`, generates the AltStore manifest (`apps.json`) + icon, and
**auto-deploys all three to Cloudflare Pages**. AltStore polls `apps.json` and offers an
update whenever its `version` is newer than what's installed.

> **7-day reminder:** A free Apple ID signature expires after 7 days. This automates delivering
> *new builds*; it does **not** remove the weekly re-sign. Keep refreshing via **AltServer**
> (PC on the same Wi-Fi) or use **SideStore** for computer-free refresh. A paid Apple Developer
> account ($99/yr) gives 1-year signing and makes this moot.

## One-time setup
1. **Create a Cloudflare API token** — Cloudflare dashboard → My Profile → API Tokens →
   Create Token → template **"Edit Cloudflare Workers"** (includes Pages), or a custom token with
   **Account › Cloudflare Pages › Edit**. Copy the token.
2. **Find your Account ID** — Cloudflare dashboard → Workers & Pages (right sidebar shows *Account ID*).
3. **Add two repo secrets** — GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` = the ID from step 2
4. **Pick a Pages project name** (e.g. `whoop-core`). It'll be served at `https://<project>.pages.dev`.
   The workflow creates the project on first deploy — no need to make it in the dashboard first.

## Release (build + deploy)
1. **Actions → "Release WHOOP Core (AltStore → Cloudflare Pages)" → Run workflow.** Inputs:
   - **pages_project** — your project name (default `whoop-core`)
   - **base_url** — leave blank unless you've attached a custom domain
   - **version** — optional (defaults to `package.json`); **must increase** for AltStore to see an update
   - **notes** — optional "what's new"
2. When it finishes, the run **Summary** prints your source URL: `https://<project>.pages.dev/apps.json`.

## Add the source in AltStore (one time)
1. AltStore → **Browse → Sources → edit (＋)** → add `https://<project>.pages.dev/apps.json`.
2. Open the source → install **WHOOP Core**.

## Shipping an update later
1. Bump `version` in `package.json` (or pass **version** to the workflow).
2. Re-run the Release workflow (same `pages_project`). It rebuilds and redeploys.
3. Phone: AltStore → **My Apps** shows the update.

## Files & local equivalents
- Deployed to Pages root: `WHOOP-Core.ipa`, `apps.json`, `icon.png` (also saved as the
  `WHOOP-Core-altstore-dist` artifact for one-off Sideloadly installs).
- `npm run icon` → `dist/icon.png` (dependency-free PNG, cyan ECG glyph).
- `node tools/make-altstore-source.mjs --base <url> --ipa dist/WHOOP-Core.ipa --out dist/apps.json --notes "…"`
  → `apps.json` with `size` + `sha256` from the `.ipa`; modern `versions[]` + legacy fields
  (works on both AltStore and SideStore).

The plain unsigned-`.ipa` workflow (`build.yml`) still exists for one-off Sideloadly installs;
`release.yml` is the AltStore/OTA path.
