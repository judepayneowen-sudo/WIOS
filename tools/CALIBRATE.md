# Calibrating scores.js against WHOOP's official numbers

`scores.js` reproduces WHOOP's *published behaviour* (the algorithm shapes), but the exact
weights are proprietary. We don't guess them — we **fit** them against WHOOP's own scores,
which the developer API hands back as ground truth. That turns calibration into supervised
regression, not trial-and-error.

| Score | Inputs we fit | Answer source | Runs without a band? |
|-------|---------------|---------------|----------------------|
| **Recovery** | HRV (lnRMSSD), resting HR, **respiratory rate**, sleep% → weights + bias | API `recovery_score` | ✅ yes — API gives inputs *and* answer |
| **Strain** | HR stream → TRIMP load → `STRAIN_SCALE` | API `cycle.strain` | ❌ needs ≥1 capture day |
| **Sleep** | baseline need + min-per-strain; validates asleep ÷ need | API `sleep_needed` + `sleep_performance` | ✅ yes — fit from the API breakdown |

## What known science it's built on

- **Recovery** — weighted, baseline-normalised blend of HRV (dominant, ~60–65%), resting HR
  (~20%), respiratory rate (~15%), each z-scored against your own rolling ~30-day baseline,
  squashed through a logistic. (WHOOP "The Locker" HRV guide.)
- **Strain** — logarithmic **0–21** scale (Borg-derived) over **HR-zone-weighted load**; we
  accumulate Banister **TRIMP** (time × intensity, exponential toward high zones) and map it
  through `21·(1 − e^(−load/scale))`. (WHOOP "Strain 101".)

The harness fits the free constants in those shapes — it does not invent the algorithm.

## Step 1 — get the answer-key (once you have API access)

One-time setup is in [WHOOP-API.md](WHOOP-API.md). Then:

```sh
node tools/whoop-api.mjs auth     # one-time browser sign-in
node tools/whoop-api.mjs 60        # 60 days = a solid recovery fit
```

That prints the human table **and** writes `calibration/whoop-data.json` with every field
(HRV, RHR, resp, SpO₂, skin temp, strain, all sleep stages + need breakdown) — that JSON is
what the harness reads. `calibration/` is gitignored — your personal WHOOP data never leaves
the machine.

Optional — drop your profile so strain load uses your real zones:

```json
// calibration/profile.json
{ "age": 30, "sex": "m", "restingHr": 50, "maxHr": 0 }
```

`maxHr: 0` → estimated via Tanaka (208 − 0.7·age).

## Step 2 — (for strain) capture a real day

Connect the band in WHOOP Core, leave **Start capture** running through an active day, then
tap **Send to laptop** (drop-box → `captures/*.txt`). The harness reads HR from
`REALTIME_DATA(40)` frames. A short capture only covers the connected window, so its load is
*partial* and the fitted scale is provisional — a full-day `HISTORICAL_DATA(47)` capture is
the real anchor (its decode is the one remaining TODO in `whoop-decode.mjs`).

## Step 3 — fit

```sh
npm run calibrate            # or: node tools/calibrate.mjs --days 30
```

It prints before/after RMSE per score and writes `calibration/coeffs.json`, e.g.:

```
— Recovery —
  fit on 41 days · RMSE 14.2% → 5.8% recovery
  weights: hrv 1.34  rhr 0.71  resp 0.39  sleep 0.42  bias -0.30
— Strain —
  · 2026-06-17: load 88.0 over 240 min → WHOOP strain 11.3
  STRAIN_SCALE 120 → 96.4 · RMSE 2.10 → 0.04 strain
— Sleep —
  baseline need 478 min (8.0h) · minPerStrain 3.4 min/pt
  performance formula (asleep ÷ need) vs WHOOP: RMSE 0.6%
```

## Step 4 — adopt the constants

Paste the printed values into `src/scores.js` (`RECOVERY_WEIGHTS`, `STRAIN_SCALE`, `SLEEP_NEED`), then:

```sh
npm test          # sanity ranges still hold
npm run sync      # rebuild www/app.js for the iOS app
```

Re-run whenever you've gathered more days/captures — more data, tighter fit.
