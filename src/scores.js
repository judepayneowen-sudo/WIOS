/*
 * WHOOP Core — scores (recovery / strain / sleep).
 *
 * Clean-room approximations of WHOOP's *published behaviour*, not its proprietary
 * formulas. Everything here is pure (no BLE, no DOM, no Node APIs) so it bundles into
 * the iOS webview AND runs under `node test/scores.test.mjs`. Constants flagged
 * `CALIBRATE` are placeholders to be tuned by regressing our outputs against the real
 * numbers the WHOOP app shows for the same day — that's the job once live decoding lands.
 *
 * Inputs we expect to feed these once the fd4b live stream is decoded:
 *   - continuous HR (bpm) + dt  → strain
 *   - per-night HRV (RMSSD), resting HR, respiratory rate, + personal baselines → recovery
 *   - asleep/awake durations (+ stages, eventually) → sleep performance
 */

/* ----------------------------- small math --------------------------------- */
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const logistic = (x) => 1 / (1 + Math.exp(-x));

/** Sample mean + sample SD (n-1). Used for personal HRV/RHR baselines. */
export function rollingStats(xs) {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd };
}
/** z = (x - mean) / sd, guarded against missing/zero-variance baselines. */
export function zScore(x, stats) {
  if (!stats || stats.mean == null || !stats.sd) return 0;
  return (x - stats.mean) / stats.sd;
}

/* ----------------------------- HR zones ----------------------------------- */
/** Tanaka (2001): more accurate across ages than 220−age. */
export function maxHeartRate(age) { return Math.round(208 - 0.7 * age); }

/** Karvonen heart-rate-reserve fraction, clamped to [0,1]. */
export function hrReserveFraction(hr, restingHr, maxHr) {
  const denom = maxHr - restingHr;
  if (denom <= 0) return 0;
  return clamp((hr - restingHr) / denom, 0, 1);
}

/** WHOOP-style zones as a fraction of MAX HR. Returns 0..5. */
export const ZONE_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9]; // <50%=z0, then z1..z5
export function hrZone(hr, maxHr) {
  const f = hr / maxHr;
  let z = 0;
  for (const e of ZONE_EDGES) if (f >= e) z++;
  return z; // 0..5
}

/* ----------------------------- strain ------------------------------------- */
// Banister TRIMP increment: weights time exponentially toward higher intensity,
// which matches how WHOOP strain accrues far faster in high HR zones.
export function trimpIncrement(hrFrac, dtMinutes, sex = 'm') {
  const b = sex === 'f' ? 1.67 : 1.92;
  const k = sex === 'f' ? 0.86 : 0.64;
  return dtMinutes * hrFrac * k * Math.exp(b * hrFrac);
}

// WHOOP strain is a 0–21 logarithmic (Borg-derived) scale that saturates. We map
// accumulated TRIMP load through a saturating exponential. SCALE sets how much load
// reaches a given strain — CALIBRATE against a few known (load, WHOOP-strain) pairs.
export const STRAIN_SCALE = 120; // CALIBRATE (TRIMP units)
export function strainFromLoad(load, scale = STRAIN_SCALE) {
  if (load <= 0) return 0;
  return +(21 * (1 - Math.exp(-load / scale))).toFixed(1);
}

/**
 * Feed HR samples as they stream in; read .load / .strain anytime.
 *   const s = makeStrainAccumulator({ restingHr: 52, maxHr: 190, sex: 'm' });
 *   s.add(hrBpm, dtSeconds);  // call per realtime HR sample
 *   s.strain;                 // current day strain (0–21)
 */
export function makeStrainAccumulator({ restingHr, maxHr, sex = 'm', scale = STRAIN_SCALE }) {
  let load = 0;
  const zoneSeconds = [0, 0, 0, 0, 0, 0];
  return {
    add(hr, dtSeconds) {
      if (!(hr > 0) || !(dtSeconds > 0)) return;
      zoneSeconds[hrZone(hr, maxHr)] += dtSeconds;
      load += trimpIncrement(hrReserveFraction(hr, restingHr, maxHr), dtSeconds / 60, sex);
    },
    get load() { return load; },
    get strain() { return strainFromLoad(load, scale); },
    get zoneSeconds() { return zoneSeconds.slice(); },
    reset() { load = 0; zoneSeconds.fill(0); },
  };
}

/* ----------------------------- recovery ----------------------------------- */
// HRV is the dominant driver, then resting HR (inverted), then respiratory rate
// (inverted), with a small sleep-performance nudge. Each term is a z-score vs the
// person's own baseline, combined and squashed to 0–100%.
export const RECOVERY_WEIGHTS = { hrv: 1.1, rhr: 0.6, resp: 0.3, sleep: 0.5, bias: 0 }; // CALIBRATE
export function recoveryScore({
  hrv, hrvBase, rhr, rhrBase, respRate = null, respBase = null,
  sleepPerformance = null, weights = RECOVERY_WEIGHTS,
} = {}) {
  let s = weights.bias || 0; // intercept: shifts the baseline-day recovery off 50% (CALIBRATE)
  if (hrv != null && hrvBase) s += weights.hrv * zScore(hrv, hrvBase);
  if (rhr != null && rhrBase) s -= weights.rhr * zScore(rhr, rhrBase);   // lower RHR is better
  if (respRate != null && respBase) s -= weights.resp * zScore(respRate, respBase); // lower is better
  if (sleepPerformance != null) s += weights.sleep * (sleepPerformance - 0.9) * 5;  // ~0.9 perf = neutral
  return Math.round(100 * logistic(s));
}

/* ----------------------------- sleep -------------------------------------- */
export const STAGE = { AWAKE: 'awake', LIGHT: 'light', SWS: 'sws', REM: 'rem' };

// Sleep need = baseline + a fraction of accumulated debt + extra demanded by the day's
// strain − credit for naps. (WHOOP also adds a sickness term we don't model yet.)
export const SLEEP_NEED = { baselineMin: 480, debtRepayFrac: 0.35, minPerStrain: 3 }; // CALIBRATE
export function sleepNeedMinutes({
  baselineMin = SLEEP_NEED.baselineMin, debtMin = 0, dayStrain = 0, napMin = 0,
  debtRepayFrac = SLEEP_NEED.debtRepayFrac, minPerStrain = SLEEP_NEED.minPerStrain,
} = {}) {
  return Math.max(0, baselineMin + debtRepayFrac * debtMin + minPerStrain * dayStrain - napMin);
}
/** Fraction 0..1 of need actually slept (WHOOP shows this as Sleep Performance %). */
export function sleepPerformance(asleepMin, needMin) {
  if (!(needMin > 0)) return null;
  return clamp(asleepMin / needMin, 0, 1);
}

// --- Stage classifier (heuristic, calibratable) ---------------------------------
// We CANNOT match WHOOP's exact hypnogram — WHOOP stages sleep in its cloud with a proprietary,
// PSG-trained model that leaves with the subscription. So, like the open-source WHOOP projects, we
// run our own cardiopulmonary + actigraphy classifier on the band's raw overnight stream and CALIBRATE
// its thresholds to match WHOOP's per-night stage SUMMARY (REM/SWS/Light/Wake minutes) during Phase 1.
//
// Per-epoch (30 s) features, relative to that night's own baselines:
//   hrRel  = (hr − restingHr) / restingHr     elevation above the night's sleeping-resting HR
//   hrvRel = rmssd / nightMedianRMSSD          parasympathetic tone (high in deep, low in REM/wake)
//   move   = HR volatility proxy (until the accel tail of (47)/HISTORICAL_IMU(52) is decoded)
// Decision (established wearable approach): movement/HR-driven WAKE; low-HR + high-HRV ⇒ DEEP(SWS);
// low-movement + elevated/variable HR + lower HRV ⇒ REM; otherwise LIGHT. A min-duration smoothing pass
// removes 30 s flicker (real hypnograms hold a stage for minutes).
// Calibrated 2026-06-21 against WHOOP's official stage summary for the night of Thu Jun 18 (Awake 17 /
// Light 286 / Deep 129 / REM 111 min), on a band-recovered (47) capture → 4% total-minute error; the same
// params cross-checked sane on the Jun 18→19 night (3% wake / 49% light / 28% deep / 20% REM). NOTE: move
// is now the accel actigraphy metric (mean |Δ g-vector| per epoch, ~0–0.5), not the old HR-volatility proxy.
export const SLEEP_STAGE_PARAMS = {
  restHrPct: 0.15,   // resting HR = this percentile of the night's epoch HRs
  wakeMove:  0.30,   // accel actigraphy above this ⇒ Wake
  wakeHrRel: 0.45,   // HR ≥ resting×(1+this) ⇒ Wake
  deepHrRel: 0.06,   // HR within resting×(1+this) ⇒ Deep candidate
  deepHrv:   1.20,   // rmssd ≥ this×median ⇒ Deep candidate
  remHrRel:  0.22,   // HR ≥ resting×(1+this) with low move ⇒ REM candidate
  remHrv:    0.75,   // rmssd ≤ this×median ⇒ REM candidate
  smoothEpochs: 5,   // min consecutive epochs a stage must persist (median smoothing)
};

/** p-th percentile (0..1) of a numeric array, linear interpolation. */
export function percentile(xs, p) {
  const a = xs.filter((x) => x != null).slice().sort((m, n) => m - n);
  if (!a.length) return null;
  const i = clamp(p, 0, 1) * (a.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/** Night baselines from the epoch stream: sleeping-resting HR + median HRV. */
export function nightBaselines(epochs, params = SLEEP_STAGE_PARAMS) {
  const hrs = epochs.map((e) => e.hr).filter((x) => x > 0);
  const rmssds = epochs.map((e) => e.rmssd).filter((x) => x > 0);
  return {
    restHr: percentile(hrs, params.restHrPct) ?? (hrs.length ? Math.min(...hrs) : 60),
    hrvMed: percentile(rmssds, 0.5) ?? null,
  };
}

/** Classify one epoch given the night's baselines. Returns a STAGE value. */
export function classifySleepStage(epoch, base, params = SLEEP_STAGE_PARAMS) {
  if (!epoch || !(epoch.hr > 0) || !base) return STAGE.LIGHT;
  const hrRel = (epoch.hr - base.restHr) / Math.max(1, base.restHr);
  const hrvRel = (base.hrvMed && epoch.rmssd > 0) ? epoch.rmssd / base.hrvMed : 1;
  const move = epoch.move ?? 0;
  if (move >= params.wakeMove || hrRel >= params.wakeHrRel) return STAGE.AWAKE;
  if (hrRel <= params.deepHrRel && hrvRel >= params.deepHrv) return STAGE.SWS;
  if (hrRel >= params.remHrRel && hrvRel <= params.remHrv) return STAGE.REM;
  return STAGE.LIGHT;
}

/** Median-smooth a stage sequence so no stage persists fewer than `win` epochs. */
export function smoothStages(stages, win = SLEEP_STAGE_PARAMS.smoothEpochs) {
  if (win <= 1 || stages.length < win) return stages.slice();
  const out = stages.slice();
  for (let i = 0; i < stages.length; i++) {
    const a = Math.max(0, i - Math.floor(win / 2)), b = Math.min(stages.length, a + win);
    const counts = {};
    for (let j = a; j < b; j++) counts[stages[j]] = (counts[stages[j]] || 0) + 1;
    out[i] = Object.keys(counts).reduce((m, k) => (counts[k] > (counts[m] || 0) ? k : m), out[i]);
  }
  return out;
}

/** Full hypnogram from an epoch stream → array of STAGE values (smoothed). */
export function classifySleepStages(epochs, params = SLEEP_STAGE_PARAMS) {
  if (!epochs || !epochs.length) return [];
  const base = nightBaselines(epochs, params);
  return smoothStages(epochs.map((e) => classifySleepStage(e, base, params)), params.smoothEpochs);
}

// summarizeStages tallies minutes per stage from a sequence of epochs.
export function summarizeStages(stages, epochSeconds = 30) {
  const min = { awake: 0, light: 0, sws: 0, rem: 0 };
  for (const s of stages) if (s && min[s] != null) min[s] += epochSeconds / 60;
  return min;
}
