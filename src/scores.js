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
export const RECOVERY_WEIGHTS = { hrv: 1.1, rhr: 0.6, resp: 0.3, sleep: 0.5 }; // CALIBRATE
export function recoveryScore({
  hrv, hrvBase, rhr, rhrBase, respRate = null, respBase = null,
  sleepPerformance = null, weights = RECOVERY_WEIGHTS,
} = {}) {
  let s = 0;
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

// Stage classification needs decoded actigraphy (IMU) + HR/PPG epochs we don't have yet.
// Placeholder so the pipeline is wired end-to-end; returns null until real epoch features
// arrive. summarizeStages tallies minutes per stage from a sequence of epochs.
export function classifySleepStage(/* epoch */) { return null; } // TODO: needs decoded IMU/PPG
export function summarizeStages(stages, epochSeconds = 30) {
  const min = { awake: 0, light: 0, sws: 0, rem: 0 };
  for (const s of stages) if (s && min[s] != null) min[s] += epochSeconds / 60;
  return min;
}
