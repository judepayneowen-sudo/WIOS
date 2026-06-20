/* Sanity tests for the scores module. Run: node test/scores.test.mjs
   Pure-function checks — no band, no DOM. Asserts monotonicity and sane ranges,
   not exact WHOOP values (those calibrate constants once we have real data). */
import {
  maxHeartRate, hrReserveFraction, hrZone, trimpIncrement, strainFromLoad,
  makeStrainAccumulator, rollingStats, zScore, recoveryScore,
  sleepNeedMinutes, sleepPerformance, summarizeStages,
  percentile, nightBaselines, classifySleepStage, classifySleepStages, STAGE,
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
const base = { restHr: 50, hrvMed: 55 };
ok(classifySleepStage({ hr: 50, rmssd: 85, move: 0.4 }, base) === STAGE.SWS, 'deep: low HR + high HRV → SWS');
ok(classifySleepStage({ hr: 56, rmssd: 38, move: 1.0 }, base) === STAGE.REM, 'REM: HR up, HRV down, still → REM');
ok(classifySleepStage({ hr: 72, rmssd: 40, move: 6.0 }, base) === STAGE.AWAKE, 'wake: high movement → AWAKE');
ok(classifySleepStage({ hr: 55, rmssd: 55, move: 1.0 }, base) === STAGE.LIGHT, 'intermediate → LIGHT');
// Whole-night hypnogram: runs of each stage survive smoothing and all four stages appear.
const night = [];
const push = (n, e) => { for (let i = 0; i < n; i++) night.push({ t: night.length * 30000, ...e }); };
push(10, { hr: 50, rmssd: 85, move: 0.4 });  // deep
push(10, { hr: 55, rmssd: 55, move: 1.0 });  // light
push(10, { hr: 56, rmssd: 38, move: 1.0 });  // rem
push(6,  { hr: 72, rmssd: 40, move: 6.0 });  // wake
const bl = nightBaselines(night);
ok(bl.restHr <= 52 && bl.hrvMed > 0, `night baselines sane (restHr ${bl.restHr|0}, hrvMed ${bl.hrvMed|0})`);
const hypno = classifySleepStages(night);
const tally = summarizeStages(hypno);
ok(tally.sws > 0 && tally.light > 0 && tally.rem > 0 && tally.awake > 0, `all four stages present (${JSON.stringify(tally)})`);
ok(hypno.length === night.length, 'one stage per epoch');

console.log(`\nscores: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
