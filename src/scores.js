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

/** Legacy %-of-MAX-HR zones (kept for back-compat/tests). Returns 0..5. */
export const ZONE_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9]; // <50%=z0, then z1..z5
export function hrZone(hr, maxHr) {
  const f = hr / maxHr;
  let z = 0;
  for (const e of ZONE_EDGES) if (f >= e) z++;
  return z; // 0..5
}

// WHOOP's actual strain zones use HEART-RATE RESERVE (HRR / Karvonen), not raw %max — confirmed from WHOOP's
// published material (2026-06-25): targetHR = (HRmax − RHR)·pct + RHR, with zone edges at 40/60/70/80/90 %HRR.
// This matches the z0–z5 `zone_durations` WHOOP exposes via its API, so our zone tally calibrates 1:1 against it.
export const ZONE_EDGES_HRR = [0.4, 0.6, 0.7, 0.8, 0.9]; // <40%HRR=z0, then z1..z5
export function hrZoneReserve(hr, restingHr, maxHr) {
  const f = hrReserveFraction(hr, restingHr, maxHr);
  let z = 0;
  for (const e of ZONE_EDGES_HRR) if (f >= e) z++;
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
      zoneSeconds[hrZoneReserve(hr, restingHr, maxHr)] += dtSeconds;   // HRR zones (WHOOP's method) → calibrate to API zone_durations
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
export const RECOVERY_WEIGHTS = { hrv: 1.1, rhr: 0.6, resp: 0.3, sleep: 0.5, skinTemp: 0.4, spo2: 0.15, bias: 0 }; // CALIBRATE
export function recoveryScore({
  hrv, hrvBase, rhr, rhrBase, respRate = null, respBase = null,
  skinTempC = null, skinTempBase = null, spo2 = null,
  sleepPerformance = null, weights = RECOVERY_WEIGHTS,
} = {}) {
  let s = weights.bias || 0; // intercept: shifts the baseline-day recovery off 50% (CALIBRATE)
  if (hrv != null && hrvBase) s += weights.hrv * zScore(hrv, hrvBase);
  if (rhr != null && rhrBase) s -= weights.rhr * zScore(rhr, rhrBase);   // lower RHR is better
  if (respRate != null && respBase) s -= weights.resp * zScore(respRate, respBase); // lower is better
  // Band-derived (from the (47) record): a skin-temp deviation either way and low SpO2 both hurt recovery.
  if (skinTempC != null && skinTempBase != null) s -= (weights.skinTemp || 0) * Math.abs(skinTempC - skinTempBase);
  if (spo2 != null && spo2 < 97) s -= (weights.spo2 || 0) * (97 - spo2);
  if (sleepPerformance != null) s += weights.sleep * (sleepPerformance - 0.9) * 5;  // ~0.9 perf = neutral
  return Math.round(100 * logistic(s));
}

/* ----------------------------- sleep -------------------------------------- */
export const STAGE = { AWAKE: 'awake', LIGHT: 'light', SWS: 'sws', REM: 'rem' };

// Sleep need = baseline + a fraction of accumulated debt + extra demanded by the day's
// strain − credit for naps. (WHOOP also adds a sickness term we don't model yet.)
//
// The strain term uses WHOOP's OWN published functional form (patent US 11,627,946 B2): the additional sleep
// need from a day's strain `i` (0–21) is a logistic that saturates — f(i) = strainSat / (1 + e^((mid−i)/slope))
// HOURS, with the patent's disclosed constants mid=17, slope=3.5 and saturation ≈1.7 h at max strain. So a
// rest day (i≈3) adds ~minutes while an all-out day (i≈20) adds ~70–80 min — matching WHOOP's behaviour far
// better than the old linear `minPerStrain·i`. Only strainSat is calibrated (regress against the API's
// `need_from_recent_strain_milli`); the shape (mid/slope) is WHOOP's published constant.
export const SLEEP_NEED = { baselineMin: 480, debtRepayFrac: 0.35, strainSat: 1.7, strainMid: 17, strainSlope: 3.5 }; // CALIBRATE strainSat
/** Additional sleep-need MINUTES demanded by a day's strain (0–21), per the WHOOP patent logistic. */
export function strainNeedMinutes(dayStrain = 0, p = SLEEP_NEED) {
  return 60 * p.strainSat / (1 + Math.exp((p.strainMid - dayStrain) / p.strainSlope));
}
export function sleepNeedMinutes({
  baselineMin = SLEEP_NEED.baselineMin, debtMin = 0, dayStrain = 0, napMin = 0,
  debtRepayFrac = SLEEP_NEED.debtRepayFrac, strainSat = SLEEP_NEED.strainSat,
  strainMid = SLEEP_NEED.strainMid, strainSlope = SLEEP_NEED.strainSlope,
} = {}) {
  const strainMin = strainNeedMinutes(dayStrain, { strainSat, strainMid, strainSlope });
  return Math.max(0, baselineMin + debtRepayFrac * debtMin + strainMin - napMin);
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
// Calibrated 2026-06-22 against WHOOP's official stage summary for the night of Sun Jun 21→22 (Awake 13 /
// Light 174 / Deep 91 / REM 93 min) on a COMPLETE band-recovered (47) capture trimmed to WHOOP's in-bed
// window (02:50→09:02) → stage-minute RMSE 27→4 min (Light 42% / Deep 26% / REM 29% vs WHOOP 48/24/25).
// ⚠️ Fit on a single night (6 params / 4 stage-totals → under-determined); re-fit across multiple nights
// via `npm run calibrate:all` as they accumulate, to avoid overfit. move = accel actigraphy metric
// (mean |Δ g-vector| per epoch, ~0–0.5), not the old HR-volatility proxy.
export const SLEEP_STAGE_PARAMS = {
  restHrPct: 0.15,   // resting HR = this percentile of the night's epoch HRs
  wakeMove:  0.109,  // accel actigraphy above this ⇒ Wake
  wakeHrRel: 0.483,  // HR ≥ resting×(1+this) ⇒ Wake
  deepHrRel: 0.121,  // HR within resting×(1+this) ⇒ Deep candidate
  deepHrv:   1.50,   // rmssd ≥ this×median ⇒ Deep candidate
  remHrRel:  0.086,  // HR ≥ resting×(1+this) with low move ⇒ REM candidate
  remHrv:    0.795,  // rmssd ≤ this×median ⇒ REM candidate
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

// --- Automatic sleep-window detection -------------------------------------------
// PHASE-2 ESSENTIAL: standalone there is no WHOOP cloud to mark [sleepStart, sleepEnd], so we find the
// night ourselves from the epoch stream. Movement is the cleanest discriminator (the accel actigraphy
// collapses to ~0 during sleep), with HR rejecting sedentary-but-awake periods (sitting still = low move
// but elevated HR). Method: flag epochs that are BOTH low-HR and low-movement, bridge brief arousals,
// take the longest consolidated block, then extend its edges outward through contiguous low-MOVEMENT
// epochs to capture light-sleep onset/offset (where HR is still settling). Validated against WHOOP's
// Jun-2026 in-bed durations to ~8 min. Returns {start,end,startIdx,endIdx,durMin,restHr} (epoch .t in ms)
// or null. Tune via SLEEP_WINDOW_PARAMS; do not chase WHOOP's exact onset (it counts pre-sleep latency).
export const SLEEP_WINDOW_PARAMS = { hrFloorPct: 0.10, hrMargin: 0.18, moveQuietPct: 0.55, bridgeMin: 20, edgeMoveMult: 2.0 };
export function detectSleepWindow(epochs, params = SLEEP_WINDOW_PARAMS) {
  if (!epochs || epochs.length < 20) return null;
  const ES = (epochs[1] && epochs[0]) ? (epochs[1].t - epochs[0].t) / 1000 : 30;
  const hrs = epochs.map((e) => e.hr).filter((x) => x > 0);
  const moves = epochs.map((e) => e.move || 0).filter((m) => m > 0);
  if (!hrs.length) return null;
  const restHr = percentile(hrs, params.hrFloorPct);
  const hrThr = restHr * (1 + params.hrMargin);
  const moveThr = moves.length ? percentile(moves, params.moveQuietPct) : 0.02;
  const edgeMove = moveThr * params.edgeMoveMult;
  const quiet = epochs.map((e) => (e.hr > 0 && e.hr <= hrThr && (e.move || 0) <= moveThr) ? 1 : 0);
  const bridge = Math.round(params.bridgeMin * 60 / ES);
  const q = quiet.slice();
  for (let i = 0; i < q.length; i++) {                          // bridge short awake gaps inside sleep
    if (!quiet[i]) {
      let j = i; while (j < q.length && !quiet[j]) j++;
      if (j - i <= bridge && i > 0 && j < q.length) for (let k = i; k < j; k++) q[k] = 1;
      i = j;
    }
  }
  let bs = -1, be = -1, cs = -1;                                // longest run of q===1
  for (let i = 0; i <= q.length; i++) {
    if (i < q.length && q[i]) { if (cs < 0) cs = i; }
    else { if (cs >= 0) { if (be - bs < i - cs) { bs = cs; be = i; } cs = -1; } }
  }
  if (bs < 0) return null;
  let s = bs, e = Math.min(be, epochs.length - 1);              // extend edges through low-movement epochs
  while (s > 0 && (epochs[s - 1].move || 0) <= edgeMove) s--;
  while (e < epochs.length - 1 && (epochs[e + 1].move || 0) <= edgeMove) e++;
  return { start: epochs[s].t, end: epochs[e].t, startIdx: s, endIdx: e,
           durMin: Math.round((epochs[e].t - epochs[s].t) / 60000), restHr: Math.round(restHr) };
}

/* ===================== Healthspan / WHOOP Age =================================
 * WHOOP Age (Pace of Aging) is a model over ~9 health metrics. It's reproducible the same way as sleep:
 * WHOOP's value is the answer-key (read off the app), and we compute the inputs from band + profile. These
 * are the input estimators + a transparent linear Age model; all weights/anchors are CALIBRATE placeholders
 * to be fit against the user's WHOOP Age over a calibration week. Inputs still needing band work: Steps
 * (accel walking-detection — needs a calibration walk) and VO2 max (needs a GPS-paced run). */

// Sleep consistency 0–100: how stable bedtime + wake time are night-to-night (WHOOP uses ~last 4 days). Lower
// night-to-night variation in sleep onset and offset → higher consistency. `windows` = [{start,end}] ms.
export const SLEEP_CONSISTENCY = { devFloorMin: 15, devCeilMin: 120 }; // ≤15 min dev → 100%, ≥120 min → 0% (CALIBRATE)
export function sleepConsistency(windows, params = SLEEP_CONSISTENCY) {
  const w = (windows || []).filter((x) => x && x.start != null && x.end != null);
  if (w.length < 2) return null;
  const tod = (ms) => { const d = ((ms / 60000) % 1440 + 1440) % 1440; return d; }; // minutes into local-ish day
  // circular mean-absolute-deviation of onset and offset times across consecutive nights
  const dev = (times) => {
    let s = 0, c = 0;
    for (let i = 1; i < times.length; i++) {
      let d = Math.abs(times[i] - times[i - 1]); if (d > 720) d = 1440 - d; // wrap midnight
      s += d; c++;
    }
    return c ? s / c : 0;
  };
  const onsetDev = dev(w.map((x) => tod(x.start)));
  const offsetDev = dev(w.map((x) => tod(x.end)));
  const avgDev = (onsetDev + offsetDev) / 2;
  const { devFloorMin: lo, devCeilMin: hi } = params;
  return Math.round(100 * clamp((hi - avgDev) / (hi - lo), 0, 1));
}

// VO2 max — WHOOP's method: pair pace (phone GPS) with HR during an outdoor activity, extrapolate the
// sub-maximal VO2 to HR-max via the HR-reserve ratio. ACSM running VO2 (ml/kg/min) from speed; Fick-style
// extrapolation: VO2max = VO2@pace × (HRmax−HRrest)/(HR@pace−HRrest).
export function vo2maxFromRun({ distanceM, durationS, hrAtPace, restingHr, maxHr }) {
  if (!(distanceM > 0) || !(durationS > 0) || !(hrAtPace > 0) || !(maxHr > hrAtPace) || !(hrAtPace > restingHr)) return null;
  const speedMperMin = distanceM / (durationS / 60);
  const vo2AtPace = 0.2 * speedMperMin + 3.5;                 // ACSM walking/running gross VO2 (flat)
  const vo2max = vo2AtPace * (maxHr - restingHr) / (hrAtPace - restingHr);
  return +vo2max.toFixed(1);
}
// Standalone fallback when no GPS run is available: Uth–Sørensen–Overgaard–Pedersen HR-ratio estimate.
export function vo2maxFromHrRatio({ maxHr, restingHr }) {
  if (!(maxHr > 0) || !(restingHr > 0)) return null;
  return +(15.3 * (maxHr / restingHr)).toFixed(1);
}

// Lean body mass (kg) — Boer formula from height/weight/sex (a WHOOP Age input; profile-entered, not band).
export function leanBodyMass({ weightKg, heightCm, sex = 'm', bodyFatPct = null }) {
  if (bodyFatPct != null && weightKg > 0) return +(weightKg * (1 - bodyFatPct / 100)).toFixed(1);
  if (!(weightKg > 0) || !(heightCm > 0)) return null;
  return +(sex === 'f' ? 0.252 * weightKg + 0.473 * heightCm - 48.3
                       : 0.407 * weightKg + 0.267 * heightCm - 19.2).toFixed(1);
}

// WHOOP Age model: physiological age = chronological age + Σ wᵢ·(metric better/worse than its age-norm). Each
// term lowers age when the metric is healthier than typical-for-age and raises it when worse. Weights + norms
// are CALIBRATE placeholders (literature-anchored) to be fit to the user's WHOOP Age. Returns {age, pace,
// contributions} where pace = physiological/chronological. Only the metrics provided are used; the rest are
// skipped (and their weight redistributed implicitly by absence).
export const WHOOP_AGE = {
  // norm(age) anchors + per-unit year impact (CALIBRATE)
  vo2max:          { w: -0.18, norm: (a) => 50 - 0.30 * a },         // higher fitness → younger
  restingHr:       { w:  0.10, norm: () => 60 },                     // lower RHR → younger
  hrv:             { w: -0.06, norm: (a) => 70 - 0.5 * a },          // higher HRV → younger
  sleepConsistency:{ w: -0.05, norm: () => 75 },                     // more consistent → younger
  steps:           { w: -0.0008, norm: () => 7000 },                 // more steps → younger
  leanBodyMass:    { w: -0.05, norm: (a, sex) => sex === 'f' ? 45 : 60 },
  strain:          { w: -0.20, norm: () => 10 },                     // more (healthy) activity → younger
};
export function whoopAge({ chronoAge, sex = 'm', vo2max = null, restingHr = null, hrv = null,
  sleepConsistency: sc = null, steps = null, leanBodyMass: lbm = null, strain = null, model = WHOOP_AGE } = {}) {
  if (!(chronoAge > 0)) return null;
  const vals = { vo2max, restingHr, hrv, sleepConsistency: sc, steps, leanBodyMass: lbm, strain };
  let age = chronoAge; const contributions = {};
  for (const k of Object.keys(model)) {
    const v = vals[k]; if (v == null) continue;
    const m = model[k]; const norm = m.norm(chronoAge, sex);
    const delta = +(m.w * (v - norm)).toFixed(2);
    contributions[k] = delta; age += delta;
  }
  age = Math.max(18, +age.toFixed(1));
  return { age, pace: +(age / chronoAge).toFixed(2), contributions };
}
