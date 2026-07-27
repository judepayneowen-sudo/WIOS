# Calibrating scores.js against WHOOP's official numbers

`scores.js` reproduces WHOOP's *published behaviour* (the algorithm shapes), but the exact
weights are proprietary. We don't guess them — we **fit** them against WHOOP's own scores,
which the developer API hands back as ground truth. That turns calibration into supervised
regression, not trial-and-error.

| Score | Inputs we fit | Answer source | Runs without a band? |
|-------|---------------|---------------|----------------------|
| **Recovery** | HRV (lnRMSSD), resting HR, **respiratory rate**, sleep% → weights + bias | API `recovery_score` | ✅ yes — API gives inputs *and* answer |
| **Strain** | HR stream → TRIMP load → `STRAIN_SCALE` | API `cycle.strain` | ❌ needs ≥1 capture day |
| **Sleep need** | baseline need + min-per-strain; validates asleep ÷ need | API `sleep_needed` + `sleep_performance` | ✅ yes — fit from the API breakdown |
| **Sleep stages** | `SLEEP_STAGE_PARAMS` thresholds → hypnogram | API per-night REM/SWS/Light/Wake minutes | ❌ needs an overnight `(47)` capture |

## What known science it's built on

- **Recovery** — weighted, baseline-normalised blend of HRV (dominant, ~60–65%), resting HR
  (~20%), respiratory rate (~15%), each z-scored against your own rolling ~30-day baseline,
  squashed through a logistic. (WHOOP "The Locker" HRV guide.)
- **Strain** — logarithmic **0–21** scale (Borg-derived) over **HR-zone-weighted load**; we
  accumulate Banister **TRIMP** (time × intensity, exponential toward high zones) and map it
  through `21·(1 − e^(−load/scale))`. (WHOOP "Strain 101".)

- **Sleep stages** — WHOOP stages sleep in its **cloud**, so it's not on the band and we *cannot* match
  it exactly. Instead we run a local **cardiopulmonary + actigraphy** classifier (`classifySleepStages`):
  per-30 s epoch we compare HR to the night's sleeping-resting HR, HRV (RMSSD) to the night median, and a
  movement proxy → Deep (low HR, high HRV) / REM (HR up, HRV down, still) / Wake (movement) / Light. The
  harness then tunes `SLEEP_STAGE_PARAMS` to match WHOOP's per-night **stage minutes** — "calibrated-close,
  not byte-identical" (the openwhoop/noop approach).

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
tap **Send to laptop** (drop-box → `captures/*.txt`). The harness reads HR from both
`REALTIME_DATA(40)` and `HISTORICAL_DATA(47)` frames. A short realtime capture only covers the
connected window (partial load → provisional scale); the real anchor is a full-day **Sync full
history** pull, which `(47)` decodes to per-second HR + RR for the whole day and overnight.

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
  baseline need 478 min (8.0h) · strainSat 1.7h (patent logistic, +77 min at strain 21)
  performance formula (asleep ÷ need) vs WHOOP: RMSE 0.6%
— Sleep stages —
  fit on 6 night(s) · stage-minute RMSE 41.0 → 18.3 min
  params: wakeMove 2.80  wakeHrRel 0.22  deepHrRel 0.05  deepHrv 1.12  remHrRel 0.09  remHrv 0.93
```

The **Sleep stages** line only appears once you have an overnight `HISTORICAL_DATA(47)` capture
(`Sync full history` → `Send to laptop`) for a night WHOOP also scored — until then it prints a note
and the classifier keeps its default thresholds.

## Step 4 — adopt the constants

Paste the printed values into `src/scores.js` (`RECOVERY_WEIGHTS`, `STRAIN_SCALE`, `SLEEP_NEED`,
`SLEEP_STAGE_PARAMS`), then:

```sh
npm test          # sanity ranges still hold
npm run sync      # rebuild www/app.js for the iOS app
```

Re-run whenever you've gathered more days/captures — more data, tighter fit.

## Free-trial routine — a gapless month, settling-aware

WHOOP **personalizes over ~30 days**: Recovery/Strain are scored against your own rolling baselines, and
during the first month the API flags days `user_calibrating=true` — WHOOP's *own* scores are still provisional
there. So two things matter for a trial calibration: (1) collect a **gapless** month, and (2) fit to
**settled** days. The tooling now handles (2) for you (`calibrate.mjs` prefers `calibrating=false` days and
prints the settled-vs-calibrating split); your job is (1).

**Daily (each morning):**
1. **Wear the band 24/7** — including sleep (that's where HRV/RHR/stages come from).
2. **Let the official WHOOP app sync FIRST.** It creates the cloud answer-key AND is required before our pull
   (our sync's ack *frees* records — see the destructive-read note). Open the WHOOP app, let it finish.
3. **Open WHOOP Core → tap the sync pill** (or Setup → *Trim to date & sync*) to store the night on the phone.
4. Glance at **Health → Stored data → Calibration readiness**: it shows days collected (of 30) and any
   missing-vs-off-wrist gaps. If it flags gaps, tap **Scan & fill gaps** — but re-pull **within ~2 weeks**
   before flash rolls off. Off-wrist stretches are expected (not worn) and need no action.

**Weekly:**
```sh
npm run calibrate:all      # pulls 30 days of answer-key, then fits (prefers WHOOP-settled days)
```

**End of trial:** do a final `calibrate:all` once you have the most settled days you can, adopt the constants
(Step 4). The archive in `calibration/whoop-data.json` is permanent — after the trial the API is gone, so the
days you banked are all you'll ever have. The recovery fit stays flagged **PROVISIONAL** until it has enough
settled days; that flag clearing is your signal the fit is trustworthy.
