#!/usr/bin/env node
/*
 * calibrate.mjs — tune the scores.js CALIBRATE constants by regressing OUR outputs
 * against WHOOP's official numbers (the answer-key from tools/whoop-api.mjs).
 *
 * This is supervised calibration, not trial-and-error: WHOOP's cloud is the ground truth,
 * we fit coefficients to match it, and report the residual error.
 *
 *   RECOVERY  fits from the API alone (it gives both inputs HRV/RHR and the answer %).
 *             → runs TODAY with zero BLE captures.
 *   STRAIN    needs HR load from a capture day, anchored to that day's API strain.
 *   SLEEP     needs sleep duration + need (extend whoop-api.mjs first) — stub for now.
 *
 * Inputs (all LOCAL + gitignored under calibration/ and captures/):
 *   calibration/whoop-official.txt   ← node tools/whoop-api.mjs 30 > calibration/whoop-official.txt
 *   captures/*.txt                   ← drop-box captures (HR streams for strain)
 *   calibration/profile.json (opt)   ← {"age":30,"sex":"m","restingHr":50,"maxHr":0}
 *
 * Outputs:
 *   prints fitted constants + before/after RMSE
 *   writes calibration/coeffs.json + a paste-ready snippet for src/scores.js
 *
 * Run:  node tools/calibrate.mjs            (defaults)
 *       node tools/calibrate.mjs --days 30  (limit answer-key window)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import {
  maxHeartRate, makeStrainAccumulator, strainFromLoad, STRAIN_SCALE,
  rollingStats, recoveryScore, RECOVERY_WEIGHTS,
  sleepNeedMinutes, sleepPerformance, SLEEP_NEED,
  classifySleepStages, summarizeStages, SLEEP_STAGE_PARAMS,
  detectSleepWindow,
} from '../src/scores.js';
import { decodeCapture, buildSleepEpochs, dayKey } from './whoop-decode.mjs';

const ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAL_DIR  = path.join(ROOT, 'calibration');
const CAP_DIR  = path.join(ROOT, 'captures');
const DATA     = path.join(CAL_DIR, 'whoop-data.json');     // rich JSON from whoop-api.mjs (preferred)
const ANSWERS  = path.join(CAL_DIR, 'whoop-official.txt');  // legacy printed table (fallback)
const PROFILE  = path.join(CAL_DIR, 'profile.json');
const OUT      = path.join(CAL_DIR, 'coeffs.json');

const args = process.argv.slice(2);
const daysArg = (()=>{ const i=args.indexOf('--days'); return i>=0 ? Number(args[i+1]) : Infinity; })();

const fix = (n,d=2)=> (n==null||Number.isNaN(n)) ? '—' : Number(n).toFixed(d);
const rmse = (rows, predict)=>{ let s=0,n=0; for(const r of rows){ const e=predict(r)-r.y; if(Number.isFinite(e)){ s+=e*e; n++; } } return n? Math.sqrt(s/n) : NaN; };

/* ---------------------------- tiny optimizers ----------------------------- */
// Golden-section minimization of a 1-D unimodal-ish loss on [a,b].
function goldenMin(f, a, b, iters=90){
  const g=(Math.sqrt(5)-1)/2;
  let c=b-g*(b-a), d=a+g*(b-a), fc=f(c), fd=f(d);
  for(let i=0;i<iters;i++){
    if(fc<fd){ b=d; d=c; fd=fc; c=b-g*(b-a); fc=f(c); }
    else     { a=c; c=d; fc=fd; d=a+g*(b-a); fd=f(d); }
  }
  return (a+b)/2;
}
// Coordinate descent: golden-search each param in turn, repeat. Robust for smooth losses.
function coordDescent(loss, x0, ranges, rounds=14){
  const x=x0.slice();
  for(let r=0;r<rounds;r++)
    for(let j=0;j<x.length;j++)
      x[j]=goldenMin(v=>{ const y=x.slice(); y[j]=v; return loss(y); }, ranges[j][0], ranges[j][1]);
  return x;
}

/* ----------------------------- answer-key --------------------------------- */
// Preferred: the rich JSON sidecar whoop-api.mjs writes (every field). Fallback: parse the
// printed table (date recovery strain sleep% HRV RHR — no resp/sleep detail).
function loadAnswers(){
  if(existsSync(DATA)){
    const rows=JSON.parse(readFileSync(DATA,'utf8'));
    rows.sort((a,b)=> a.date<b.date ? -1 : 1);
    return { rows, source:'whoop-data.json', rich:true };
  }
  if(existsSync(ANSWERS)){
    const num=(t)=>{ if(t==null||t==='—') return null; const v=parseFloat(String(t).replace('%','')); return Number.isFinite(v)?v:null; };
    const rows=[];
    for(const line of readFileSync(ANSWERS,'utf8').split(/\r?\n/)){
      const m=line.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/); if(!m) continue;
      const t=m[2].trim().split(/\s+/);
      rows.push({ date:m[1], recovery:num(t[0]), strain:num(t[1]), sleepPerf:num(t[2]), hrv:num(t[3]), rhr:num(t[4]) });
    }
    rows.sort((a,b)=> a.date<b.date ? -1 : 1);
    return { rows, source:'whoop-official.txt (legacy table — no resp/sleep detail)', rich:false };
  }
  return null;
}

/* ----------------------------- captures ----------------------------------- */
const MAX_DT = 4; // s — cap the gap between HR samples so connection drops don't inflate load
// A store-export day (sent from the app's "Send range → laptop") → the same {hr,rrs,accel} streams decodeCapture
// produces, so both calibration paths share one code path. Units: the store keeps ts in SECONDS, accel as g×1000,
// skin as °C×100; here we convert to the calibrator's ms / g / °C. Needs a raw export (the range-send uses raw).
function storeDayToStreams(day){
  const r = day && day.raw;
  if(!r || !r.ts || !r.ts.length) return null;
  const hr=[], rrs=[], accel=[];
  for(let i=0;i<r.ts.length;i++){
    const tms = r.ts[i]*1000;
    if(r.hr && r.hr[i]>0) hr.push({ t:tms, hr:r.hr[i] });
    if(r.rr && r.rr[i]>0) rrs.push({ t:tms, rr:r.rr[i] });
    if(r.ax && (r.ax[i]||r.ay[i]||r.az[i])) accel.push({ t:tms, x:r.ax[i]/1000, y:r.ay[i]/1000, z:r.az[i]/1000 });
  }
  return { hr, rrs, accel };
}
function loadCaptures(profile){
  if(!existsSync(CAP_DIR)) return {};
  const maxHr = profile.maxHr>0 ? profile.maxHr : maxHeartRate(profile.age||30);
  const byDay = {}; // date → { load, seconds, samples }
  for(const f of readdirSync(CAP_DIR)){
    if(f.endsWith('.json')){                                  // store-export from the app (per-day decoded streams)
      let exp; try{ exp=JSON.parse(readFileSync(path.join(CAP_DIR, f),'utf8')); }catch{ continue; }
      for(const day of (exp&&exp.days)||[]){
        const st=storeDayToStreams(day); if(!st || !st.hr.length){ continue; }
        const acc=makeStrainAccumulator({ restingHr:profile.restingHr||50, maxHr, sex:profile.sex||'m' });
        let prevT=null;
        for(const s of st.hr){ const dt = prevT==null?1:Math.min(MAX_DT,(s.t-prevT)/1000);
          if(dt>0){ acc.add(s.hr, dt); const d=(byDay[day.day] ||= {load:0,seconds:0,samples:0}); d.seconds+=dt; d.samples++; } prevT=s.t; }
        const d=(byDay[day.day] ||= {load:0,seconds:0,samples:0}); d.load+=acc.load;
        console.log(`  · ${f} [${day.day}]: ${st.hr.length} HR samples (store-export)`);
      }
      continue;
    }
    if(!f.endsWith('.txt')) continue;
    const { hr, stats } = decodeCapture(readFileSync(path.join(CAP_DIR, f), 'utf8'));
    if(!hr.length){ console.log(`  · ${f}: ${stats.frames} frames, no HR decoded (realtime=${stats.realtime}, historical=${stats.historical})`); continue; }
    // Group consecutive samples by day, accumulating TRIMP load with capped dt.
    let acc=null, curDay=null, prevT=null;
    const flush=(day)=>{ if(acc && curDay){ const d=(byDay[curDay] ||= {load:0,seconds:0,samples:0}); d.load+=acc.load; } };
    for(const s of hr){
      const day=dayKey(s.t);
      if(day!==curDay){ flush(); curDay=day; acc=makeStrainAccumulator({ restingHr:profile.restingHr||50, maxHr, sex:profile.sex||'m' }); prevT=null; }
      const dt = prevT==null ? 1 : Math.min(MAX_DT, (s.t-prevT)/1000);
      if(dt>0){ acc.add(s.hr, dt); const d=(byDay[day] ||= {load:0,seconds:0,samples:0}); d.seconds+=dt; d.samples++; }
      prevT=s.t;
    }
    flush();
    console.log(`  · ${f}: ${hr.length} HR samples across ${new Set(hr.map(s=>dayKey(s.t))).size} day(s)`);
  }
  return byDay;
}

// Overnight epochs per night for sleep-STAGE calibration. Decodes the historical HR+RR from every
// capture, builds 30-s epochs, and groups them by the date the night *ends* (so a 23:00→07:00 sleep
// keys to the wake-up day, matching how WHOOP dates a sleep). Returns { 'YYYY-MM-DD': epochs[] }.
function loadSleepEpochs(){
  if(!existsSync(CAP_DIR)) return {};
  const byNight = {};
  for(const f of readdirSync(CAP_DIR)){
    if(f.endsWith('.json')){                                  // store-export: rebuild epochs from raw (correct units)
      let exp; try{ exp=JSON.parse(readFileSync(path.join(CAP_DIR, f),'utf8')); }catch{ continue; }
      for(const day of (exp&&exp.days)||[]){
        const st=storeDayToStreams(day); if(!st || !st.hr.length) continue;
        for(const e of buildSleepEpochs(st.hr, st.rrs, st.accel)) (byNight[dayKey(e.t)] ||= []).push(e);
      }
      continue;
    }
    if(!f.endsWith('.txt')) continue;
    const { hr, rrs, accel, stats } = decodeCapture(readFileSync(path.join(CAP_DIR, f), 'utf8'));
    if(stats.historical===0 || !hr.length) continue;       // stages need the overnight historical stream
    for(const e of buildSleepEpochs(hr, rrs, accel)) (byNight[dayKey(e.t)] ||= []).push(e);  // real accel actigraphy when present
  }
  for(const k of Object.keys(byNight)) byNight[k].sort((a,b)=>a.t-b.t);
  return byNight;
}

/* =============================== main ===================================== */
console.log('\nWHOOP Core — score calibration\n' + '='.repeat(34));

const loaded = loadAnswers();
if(!loaded){
  console.error(`\nNo answer-key found in ${path.relative(ROOT, CAL_DIR)}/. Generate it first:`);
  console.error('  node tools/whoop-api.mjs auth      # one-time sign-in');
  console.error('  node tools/whoop-api.mjs 60        # writes calibration/whoop-data.json');
  process.exit(1);
}
let answers = loaded.rows;
if(Number.isFinite(daysArg)) answers = answers.slice(-daysArg);
console.log(`Answer-key: ${answers.length} days (${answers[0]?.date} → ${answers.at(-1)?.date}) from ${loaded.source}`);

let profile = { age:30, sex:'m', restingHr:50, maxHr:0 };
if(existsSync(PROFILE)){ try{ profile={...profile, ...JSON.parse(readFileSync(PROFILE,'utf8'))}; }catch{} }
console.log(`Profile: age ${profile.age}, sex ${profile.sex}, restingHr ${profile.restingHr}, maxHr ${profile.maxHr||('Tanaka→'+maxHeartRate(profile.age))}`);

console.log('\nCaptures:');
const capByDay = loadCaptures(profile);
if(!Object.keys(capByDay).length) console.log('  (none decoded — strain scale will be skipped; recovery still fits from the API)');

const fitted = { recovery: { ...RECOVERY_WEIGHTS }, strainScale: STRAIN_SCALE, sleepNeed: { ...SLEEP_NEED } };

/* ----------------------------- RECOVERY ----------------------------------- */
// Per-day features with a rolling personal baseline (prior ≤30 days), per WHOOP's
// "30-day baseline". Fit weights {hrv, rhr, resp, sleep, bias} to API recovery%.
// resp is fit only when the data has respiratory rate (rich JSON); otherwise dropped.
console.log('\n— Recovery —');
const BASE_WIN = 30, MIN_BASE = 5;
const haveResp = answers.some(d=> d.resp!=null);
const recRows = [];
for(let i=0;i<answers.length;i++){
  const d=answers[i];
  if(d.recovery==null || d.hrv==null || d.rhr==null) continue;
  const prior = answers.slice(Math.max(0,i-BASE_WIN), i).filter(x=>x.hrv!=null && x.rhr!=null);
  if(prior.length < MIN_BASE) continue;
  const respPrior = prior.filter(x=>x.resp!=null).map(x=>x.resp);
  recRows.push({
    hrv:d.hrv, rhr:d.rhr, resp:d.resp ?? null,
    hrvBase: rollingStats(prior.map(x=>x.hrv)),
    rhrBase: rollingStats(prior.map(x=>x.rhr)),
    respBase: respPrior.length>=MIN_BASE ? rollingStats(respPrior) : null,
    sleepPerformance: d.sleepPerf!=null ? d.sleepPerf/100 : null,
    y: d.recovery,
  });
}
if(recRows.length < 6){
  console.log(`  only ${recRows.length} day(s) have HRV+RHR+baseline — need ~10+ for a good fit. Pull more: node tools/whoop-api.mjs 90`);
} else {
  // params: [hrv, rhr, resp, sleep, bias]
  const predict = (w)=> (r)=> recoveryScore({
    hrv:r.hrv, hrvBase:r.hrvBase, rhr:r.rhr, rhrBase:r.rhrBase,
    respRate:r.resp, respBase:r.respBase, sleepPerformance:r.sleepPerformance,
    weights:{ hrv:w[0], rhr:w[1], resp:w[2], sleep:w[3], bias:w[4] },
  });
  const x0 = [RECOVERY_WEIGHTS.hrv, RECOVERY_WEIGHTS.rhr, RECOVERY_WEIGHTS.resp, RECOVERY_WEIGHTS.sleep, RECOVERY_WEIGHTS.bias||0];
  const ranges = [[0,3],[0,3], haveResp?[0,3]:[RECOVERY_WEIGHTS.resp,RECOVERY_WEIGHTS.resp], [0,3],[-4,4]];
  const loss = (w)=> rmse(recRows, predict(w));
  const before = rmse(recRows, predict(x0));
  const w = coordDescent(loss, x0, ranges);
  fitted.recovery = { hrv:+w[0].toFixed(3), rhr:+w[1].toFixed(3), resp:+w[2].toFixed(3), sleep:+w[3].toFixed(3), bias:+w[4].toFixed(3) };
  console.log(`  fit on ${recRows.length} days · RMSE ${fix(before,1)}% → ${fix(loss(w),1)}% recovery`);
  console.log(`  weights: hrv ${fix(w[0],2)}  rhr ${fix(w[1],2)}  resp ${haveResp?fix(w[2],2):'(no data — kept '+RECOVERY_WEIGHTS.resp+')'}  sleep ${fix(w[3],2)}  bias ${fix(w[4],2)}`);
}

/* ----------------------------- STRAIN ------------------------------------- */
console.log('\n— Strain —');
const strainPairs = [];
for(const d of answers){
  const cap = capByDay[d.date];
  if(d.strain!=null && cap && cap.load>0) strainPairs.push({ date:d.date, load:cap.load, y:d.strain, mins:cap.seconds/60 });
}
if(!strainPairs.length){
  console.log('  no capture day overlaps an API strain day. Capture a full active day (band connected),');
  console.log('  Send to laptop, then re-run. (A short capture only covers part of the day → partial load.)');
} else {
  for(const p of strainPairs) console.log(`  · ${p.date}: load ${fix(p.load,1)} over ${fix(p.mins,0)} min  → WHOOP strain ${fix(p.y,1)}`);
  // strain = 21·(1 − e^(−load/scale)); fit scale to minimize MSE across pairs.
  const loss=(s)=> rmse(strainPairs, p=> strainFromLoad(p.load, s[0]));
  const before = rmse(strainPairs, p=> strainFromLoad(p.load, STRAIN_SCALE));
  const s = goldenMin(v=> loss([v]), 1, 5000);
  fitted.strainScale = +s.toFixed(1);
  console.log(`  STRAIN_SCALE ${STRAIN_SCALE} → ${fix(s,1)}   ·  RMSE ${fix(before,2)} → ${fix(loss([s]),2)} strain`);
  if(strainPairs.some(p=> p.mins < 180)) console.log('  ⚠ some capture days cover <3h — load is partial, so the scale is biased low. Treat as provisional until a full-day (47) capture lands.');
}

/* ----------------------------- SLEEP -------------------------------------- */
// WHOOP exposes its own need breakdown, so we read two constants straight off it:
//   baselineMin  = its baseline need; minPerStrain = its strain-driven need per strain point.
// We can't isolate raw sleep-debt (WHOOP only gives the already-transformed debt term), so
// debtRepayFrac stays at its default. Then we VALIDATE our performance formula
// (asleep ÷ need) against WHOOP's sleep_performance_percentage.
console.log('\n— Sleep —');
const sleepDays = answers.filter(d=> d.needBaselineMin!=null && d.asleepMin!=null && d.needMin!=null);
if(!sleepDays.length){
  console.log('  no sleep detail in the answer-key. Re-pull with the updated whoop-api.mjs (writes whoop-data.json).');
} else {
  const baseDays = sleepDays.filter(d=> d.needBaselineMin>0);
  const strainDays = sleepDays.filter(d=> d.needStrainMin!=null && d.strain>0);
  const mean = (a)=> a.reduce((x,y)=>x+y,0)/a.length;
  const baselineMin = baseDays.length ? Math.round(mean(baseDays.map(d=>d.needBaselineMin))) : SLEEP_NEED.baselineMin;
  const minPerStrain = strainDays.length ? +mean(strainDays.map(d=> d.needStrainMin/d.strain)).toFixed(2) : SLEEP_NEED.minPerStrain;
  fitted.sleepNeed = { baselineMin, debtRepayFrac: SLEEP_NEED.debtRepayFrac, minPerStrain };

  // Validate the performance formula on WHOOP's own need + our asleep figure.
  const perfRows = sleepDays.filter(d=> d.sleepPerf!=null).map(d=> ({ y:d.sleepPerf }) ); // y only used for rmse shape
  const perfErr = (()=>{ let s=0,n=0; for(const d of sleepDays){ if(d.sleepPerf==null) continue;
    const p = sleepPerformance(d.asleepMin, d.needMin)*100; const e=p-d.sleepPerf; s+=e*e; n++; } return n? Math.sqrt(s/n):NaN; })();

  console.log(`  baseline need ${baselineMin} min (${(baselineMin/60).toFixed(1)}h)  ·  minPerStrain ${minPerStrain} min/pt   (from ${baseDays.length}/${strainDays.length} days)`);
  console.log(`  performance formula (asleep ÷ need) vs WHOOP: RMSE ${fix(perfErr,1)}%  over ${perfRows.length} days`);
  console.log('  debtRepayFrac kept at '+SLEEP_NEED.debtRepayFrac+' (WHOOP doesn’t expose raw debt to fit it).');
}

/* ------------------------- SLEEP STAGES (hypnogram) ----------------------- */
// We can't match WHOOP's exact stages (cloud model), so we fit OUR classifier's thresholds to match
// WHOOP's per-night stage SUMMARY (REM/SWS/Light/Wake minutes). Needs overnight captures decoded into
// epochs — i.e. a working "Sync full history" pull over a night that WHOOP also scored.
console.log('\n— Sleep stages —');
const stageNights = loadSleepEpochs();
// Trim each capture to WHOOP's actual in-bed window [sleepStart, sleepEnd] when known, so a wide pull
// (we default the seek to ~20:00, capturing pre-bed evening) is compared like-for-like against WHOOP's
// stage_summary, which only covers real sleep. When the API window is absent (hand-pasted nights, Phase 2),
// fall back to our own detectSleepWindow; only use the whole capture if even that fails.
const trimToWindow = (epochs, d)=>{
  const s = d.sleepStart ? Date.parse(d.sleepStart) : NaN, e = d.sleepEnd ? Date.parse(d.sleepEnd) : NaN;
  if(Number.isFinite(s) && Number.isFinite(e)){
    const t = epochs.filter(ep=> ep.t>=s && ep.t<=e);
    if(t.length>=20) return t;
  }
  const w = detectSleepWindow(epochs);                          // auto-detect fallback
  if(w){ const t = epochs.slice(w.startIdx, w.endIdx+1); if(t.length>=20) return t; }
  return epochs;
};
const stageRows = answers
  .filter(d=> d.remMin!=null && d.swsMin!=null && d.lightMin!=null && stageNights[d.date]?.length>=20)
  .map(d=> ({ date:d.date, epochs:trimToWindow(stageNights[d.date], d),
              whoop:{ rem:d.remMin, sws:d.swsMin, light:d.lightMin, awake:d.awakeMin||0 } }));
if(!stageRows.length){
  console.log('  no night has BOTH a decoded overnight epoch stream AND WHOOP stage minutes yet.');
  console.log('  Get one: wear it overnight → "Sync full history" → Send to laptop → re-run. (Then this fits');
  console.log('  SLEEP_STAGE_PARAMS to your own nights.) Until then the classifier uses its default thresholds.');
} else {
  // Fit the most impactful thresholds; keep restHrPct + smoothing fixed (structural, not data-driven).
  const KEYS = ['wakeMove','wakeHrRel','deepHrRel','deepHrv','remHrRel','remHrv'];
  const RANGES = { wakeMove:[1,6], wakeHrRel:[0.1,0.4], deepHrRel:[0.02,0.15], deepHrv:[0.9,1.4], remHrRel:[0.03,0.2], remHrv:[0.7,1.05] };
  const toParams = (v)=> ({ ...SLEEP_STAGE_PARAMS, ...Object.fromEntries(KEYS.map((k,i)=>[k,v[i]])) });
  // Loss = RMSE across all (night × stage) minute errors.
  const loss = (v)=>{ const P=toParams(v); let s=0,n=0;
    for(const r of stageRows){ const m=summarizeStages(classifySleepStages(r.epochs, P));
      for(const st of ['rem','sws','light','awake']){ const e=m[st]-r.whoop[st]; if(Number.isFinite(e)){ s+=e*e; n++; } } }
    return n? Math.sqrt(s/n) : NaN; };
  const x0 = KEYS.map(k=> SLEEP_STAGE_PARAMS[k]);
  const before = loss(x0);
  const xv = coordDescent(loss, x0, KEYS.map(k=>RANGES[k]));
  const fittedStages = toParams(xv);
  for(const k of KEYS) fittedStages[k] = +fittedStages[k].toFixed(3);
  fitted.sleepStageParams = fittedStages;
  console.log(`  fit on ${stageRows.length} night(s) · stage-minute RMSE ${fix(before,1)} → ${fix(loss(xv),1)} min`);
  console.log(`  params: ${KEYS.map(k=>`${k} ${fix(fittedStages[k],2)}`).join('  ')}`);
}

/* ----------------------------- write -------------------------------------- */
if(!existsSync(CAL_DIR)) mkdirSync(CAL_DIR, { recursive:true });
writeFileSync(OUT, JSON.stringify(fitted, null, 2));
console.log('\n' + '='.repeat(34));
console.log(`Wrote ${path.relative(ROOT, OUT)}. Paste into src/scores.js:`);
console.log(`  export const RECOVERY_WEIGHTS = ${JSON.stringify(fitted.recovery)};`);
console.log(`  export const STRAIN_SCALE = ${fitted.strainScale};`);
console.log(`  export const SLEEP_NEED = ${JSON.stringify(fitted.sleepNeed)};`);
if(fitted.sleepStageParams) console.log(`  export const SLEEP_STAGE_PARAMS = ${JSON.stringify(fitted.sleepStageParams)};`);
console.log('Then: npm test && npm run sync\n');
