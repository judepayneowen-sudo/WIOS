/* Sanity tests for the scores module. Run: node test/scores.test.mjs
   Pure-function checks — no band, no DOM. Asserts monotonicity and sane ranges,
   not exact WHOOP values (those calibrate constants once we have real data). */
import {
  maxHeartRate, hrReserveFraction, hrZone, trimpIncrement, strainFromLoad,
  makeStrainAccumulator, rollingStats, zScore, recoveryScore,
  sleepNeedMinutes, sleepPerformance, summarizeStages,
  percentile, nightBaselines, classifySleepStage, classifySleepStages, STAGE,
  detectSleepWindow,
  sleepConsistency, vo2maxFromRun, vo2maxFromHrRatio, leanBodyMass, whoopAge,
} from '../src/scores.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };
const approx = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

/* HR / zones */
ok(maxHeartRate(30) === 187, 'maxHeartRate(30)=187');
ok(approx(hrReserveFraction(120, 50, 190), (120 - 50) / (190 - 50), 1e-9), 'HRR fraction');
ok(hrReserveFraction(40, 50, 190) === 0 && hrReserveFraction(999, 50, 190) === 1, 'HRR clamps');
ok(hrZone(80, 200) === 0 && hrZone(120, 200) === 2 && hrZone(190, 200) === 5, 'zones map 0/2/5');

/* strain */
ok(trimpIncrement(0.8, 1) > trimpIncrement(0.4, 1), 'TRIMP rises with intensity');
ok(strainFromLoad(0) === 0, 'zero load → 0 strain');
ok(strainFromLoad(50) < strainFromLoad(150) && strainFromLoad(1e6) <= 21, 'strain monotonic & capped ≤21');
const acc = makeStrainAccumulator({ restingHr: 50, maxHr: 190, sex: 'm' });
for (let i = 0; i < 600; i++) acc.add(150, 1); // 10 min at 150 bpm
ok(acc.load > 0 && acc.strain > 0 && acc.strain <= 21, 'accumulator builds strain');
ok(acc.zoneSeconds.reduce((a, b) => a + b, 0) === 600, 'accumulator tallies all seconds');

/* baselines + recovery */
const hrvBase = rollingStats([60, 65, 58, 62, 70, 55, 63]);
const rhrBase = rollingStats([52, 50, 54, 51, 53, 49, 52]);
ok(hrvBase.mean > 0 && hrvBase.sd > 0, 'rollingStats produces mean+sd');
ok(zScore(hrvBase.mean, hrvBase) === 0, 'z of mean is 0');
const recHi = recoveryScore({ hrv: 85, hrvBase, rhr: 47, rhrBase });   // high HRV, low RHR
const recLo = recoveryScore({ hrv: 45, hrvBase, rhr: 60, rhrBase });   // low HRV, high RHR
ok(recHi > 50 && recLo < 50 && recHi > recLo, `recovery hi>50>lo (${recHi} vs ${recLo})`);
ok(recHi <= 100 && recLo >= 0, 'recovery within 0..100');
// band-derived modifiers (skin temp @65, SpO2 @74 from the (47) record): a temp deviation and low SpO2 hurt
const recBaseB = recoveryScore({ hrv: 70, hrvBase, rhr: 52, rhrBase });
ok(recoveryScore({ hrv: 70, hrvBase, rhr: 52, rhrBase, skinTempC: 36.5, skinTempBase: 33.5 }) < recBaseB, 'skin-temp deviation lowers recovery');
ok(recoveryScore({ hrv: 70, hrvBase, rhr: 52, rhrBase, spo2: 90 }) < recBaseB, 'low SpO2 lowers recovery');
ok(recoveryScore({ hrv: 70, hrvBase, rhr: 52, rhrBase, spo2: 98 }) === recBaseB, 'normal SpO2 is neutral');

/* sleep */
const need = sleepNeedMinutes({ baselineMin: 480, debtMin: 120, dayStrain: 14, napMin: 0 });
ok(need > 480, 'need exceeds baseline with debt + strain');
ok(sleepNeedMinutes({ dayStrain: 18 }) > sleepNeedMinutes({ dayStrain: 5 }), 'more strain → more need');
ok(approx(sleepPerformance(450, 500) * 100, 90), 'sleep performance 450/500 = 90%');
ok(sleepPerformance(600, 500) === 1, 'performance caps at 1');
const stages = summarizeStages(['light', 'light', 'sws', 'rem', 'awake'], 30);
ok(approx(stages.light, 1) && approx(stages.sws, 0.5), 'stage minutes tally');

/* sleep-stage classifier */
ok(approx(percentile([1, 2, 3, 4, 5], 0.5), 3, 1e-9), 'percentile median');
ok(percentile([10, 20, 30], 0) === 10 && percentile([10, 20, 30], 1) === 30, 'percentile ends');
// Single-epoch classification against an explicit night baseline (restHr 50, median HRV 55).
// move is the accel actigraphy metric (~0–0.5); thresholds per the calibrated SLEEP_STAGE_PARAMS.
const base = { restHr: 50, hrvMed: 55 };
ok(classifySleepStage({ hr: 50, rmssd: 90, move: 0.01 }, base) === STAGE.SWS, 'deep: low HR + high HRV → SWS');
ok(classifySleepStage({ hr: 62, rmssd: 35, move: 0.01 }, base) === STAGE.REM, 'REM: HR up, HRV down, still → REM');
ok(classifySleepStage({ hr: 72, rmssd: 40, move: 0.50 }, base) === STAGE.AWAKE, 'wake: high movement → AWAKE');
ok(classifySleepStage({ hr: 55, rmssd: 55, move: 0.01 }, base) === STAGE.LIGHT, 'intermediate → LIGHT');
// Whole-night hypnogram: runs of each stage survive smoothing and all four stages appear.
const night = [];
const push = (n, e) => { for (let i = 0; i < n; i++) night.push({ t: night.length * 30000, ...e }); };
push(10, { hr: 50, rmssd: 90, move: 0.01 });  // deep
push(10, { hr: 55, rmssd: 55, move: 0.01 });  // light
push(10, { hr: 62, rmssd: 35, move: 0.01 });  // rem
push(8,  { hr: 72, rmssd: 40, move: 0.50 });  // wake
const bl = nightBaselines(night);
ok(bl.restHr <= 52 && bl.hrvMed > 0, `night baselines sane (restHr ${bl.restHr|0}, hrvMed ${bl.hrvMed|0})`);
const hypno = classifySleepStages(night);
const tally = summarizeStages(hypno);
ok(tally.sws > 0 && tally.light > 0 && tally.rem > 0 && tally.awake > 0, `all four stages present (${JSON.stringify(tally)})`);
ok(hypno.length === night.length, 'one stage per epoch');

// detectSleepWindow: an active evening + a consolidated low-HR/low-move sleep block + active morning.
// Should locate the block (not the awake surroundings), ~within the block's extent.
{
  const ep = [];
  const add = (n, hr, move) => { for (let i = 0; i < n; i++) ep.push({ t: ep.length * 30000, hr, move }); };
  add(120, 78, 0.15);   // 60 min active evening
  add(60,  72, 0.02);   // 30 min wind-down (low move, HR still up)
  add(600, 55, 0.005);  // 300 min core sleep (low HR, very low move)
  add(20,  68, 0.03);   // 10 min brief arousal mid-sleep (bridged)
  add(120, 52, 0.004);  // 60 min more sleep
  add(160, 84, 0.20);   // 80 min active morning
  const w = detectSleepWindow(ep);
  ok(w != null, 'detectSleepWindow finds a window');
  if (w) {
    const startMin = w.startIdx * 0.5, endMin = w.endIdx * 0.5, dur = w.durMin;
    ok(startMin >= 55 && startMin <= 100, `onset near the sleep block (got ${startMin} min)`);
    ok(endMin >= 440 && endMin <= 470, `offset at the end of sleep, before the active morning (got ${endMin} min)`);
    ok(dur >= 350 && dur <= 410, `duration spans the sleep block, mid-sleep arousal bridged (got ${dur} min)`);
    ok(w.restHr <= 58, `resting HR from the night floor (got ${w.restHr})`);
  }
  ok(detectSleepWindow([{ t: 0, hr: 60, move: 0 }]) === null, 'too few epochs → null');
}

// --- Healthspan / WHOOP Age foundation ---------------------------------------
{
  const H = 22 * 3600000; // 22:00 in ms-of-day
  // very regular schedule (22:00→06:00 every night) → high consistency; jittered → lower
  const regular = [0, 1, 2, 3].map((d) => ({ start: H + d * 60000, end: H + 8 * 3600000 + d * 60000 }));
  const jittery = [{ start: H, end: H + 8 * 3600000 }, { start: H + 100 * 60000, end: H + 8 * 3600000 + 90 * 60000 },
    { start: H - 80 * 60000, end: H + 7 * 3600000 }, { start: H + 130 * 60000, end: H + 9 * 3600000 }];
  const cReg = sleepConsistency(regular), cJit = sleepConsistency(jittery);
  ok(cReg > 90, `regular schedule → high consistency (${cReg})`);
  ok(cJit < cReg, `jittery schedule → lower consistency (${cJit} < ${cReg})`);
  ok(sleepConsistency([{ start: 0, end: 1 }]) === null, 'one night → null consistency');

  const v = vo2maxFromRun({ distanceM: 3000, durationS: 900, hrAtPace: 150, restingHr: 50, maxHr: 190 }); // 12 km/h, HR 150
  ok(v > 30 && v < 80, `VO2max from run in physiological range (${v})`);
  const vFit = vo2maxFromRun({ distanceM: 3000, durationS: 900, hrAtPace: 130, restingHr: 50, maxHr: 190 });
  ok(vFit > v, 'lower HR at the same pace → higher VO2max (fitter)');
  ok(vo2maxFromHrRatio({ maxHr: 190, restingHr: 50 }) > vo2maxFromHrRatio({ maxHr: 190, restingHr: 70 }), 'HR-ratio: lower RHR → higher VO2max');

  ok(leanBodyMass({ weightKg: 80, heightCm: 180, sex: 'm' }) > leanBodyMass({ weightKg: 60, heightCm: 180, sex: 'm' }), 'LBM rises with weight');
  ok(approx(leanBodyMass({ weightKg: 80, bodyFatPct: 25 }), 60, 0.5), 'LBM from body-fat% (80kg @25% → 60kg)');

  const fit = whoopAge({ chronoAge: 40, vo2max: 55, restingHr: 48, hrv: 90, sleepConsistency: 90, steps: 12000, strain: 14 });
  const unfit = whoopAge({ chronoAge: 40, vo2max: 30, restingHr: 72, hrv: 30, sleepConsistency: 40, steps: 3000, strain: 4 });
  ok(fit.age < 40 && unfit.age > 40, `healthier metrics → younger WHOOP Age (${fit.age} vs ${unfit.age})`);
  ok(fit.pace < 1 && unfit.pace > 1, 'pace of aging tracks age/chrono');
  ok(whoopAge({ chronoAge: 40 }).age === 40, 'no metrics → age = chronological');
}

console.log(`\nscores: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
