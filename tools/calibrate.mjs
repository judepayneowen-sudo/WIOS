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
  sleepNeedMinutes, strainNeedMinutes, sleepPerformance, SLEEP_NEED,
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
// Collect every capture's HR samples into ONE flat, time-sorted stream [{t(ms), hr}]. Strain then windows this by
// WHOOP's physiological cycle [start,end] (not the calendar day), because Day Strain accrues over the wake→wake
// cycle — grouping by midnight split workouts across the wrong day and destroyed the load↔strain correlation.
function collectHr(){
  if(!existsSync(CAP_DIR)) return [];
  const samples = [];
  for(const f of readdirSync(CAP_DIR)){
    if(f.endsWith('.json')){                                  // store-export from the app (per-day decoded streams)
      let exp; try{ exp=JSON.parse(readFileSync(path.join(CAP_DIR, f),'utf8')); }catch{ continue; }
      for(const day of (exp&&exp.days)||[]){
        const st=storeDayToStreams(day); if(!st || !st.hr.length) continue;
        for(const s of st.hr) samples.push(s);
        console.log(`  · ${f} [${day.day}]: ${st.hr.length} HR samples (store-export)`);
      }
      continue;
    }
    if(!f.endsWith('.txt')) continue;
    const { hr, stats } = decodeCapture(readFileSync(path.join(CAP_DIR, f), 'utf8'));
    if(!hr.length){ console.log(`  · ${f}: ${stats.frames} frames, no HR decoded (realtime=${stats.realtime}, historical=${stats.historical})`); continue; }
    for(const s of hr) samples.push(s);
    console.log(`  · ${f}: ${hr.length} HR samples across ${new Set(hr.map(s=>dayKey(s.t))).size} day(s)`);
  }
  samples.sort((a,b)=> a.t-b.t);
  return samples;
}
// Accumulate TRIMP load over a time window [startMs,endMs) from the flat sample stream, capping inter-sample dt so
// connection drops don't inflate it. Returns { load, seconds } (seconds = actual captured coverage in the window).
function loadInWindow(samples, startMs, endMs, restingHr, maxHr, sex){
  const acc = makeStrainAccumulator({ restingHr, maxHr, sex });
  let prevT=null, seconds=0;
  for(const s of samples){
    if(s.t < startMs) continue;
    if(s.t >= endMs) break;
    if(!(s.hr>0)){ prevT=s.t; continue; }
    const dt = prevT==null ? 1 : Math.min(MAX_DT, (s.t-prevT)/1000);
    if(dt>0){ acc.add(s.hr, dt); seconds+=dt; }
    prevT=s.t;
  }
  return { load:acc.load, seconds };
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

// WHOOP's own measured physiology, pulled from the answer-key so strain load matches WHOOP's RHR/maxHR:
//   rhrByDate    — per-day resting_heart_rate (recovery already uses this; now strain does too)
//   observedMaxHr — the highest workout max_heart_rate WHOOP recorded.
const rhrByDate = {};
let observedMaxHr = 0;
for(const d of answers){
  if(d.rhr>0) rhrByDate[d.date] = d.rhr;
  if(d.maxHr>0 && d.maxHr<230) observedMaxHr = Math.max(observedMaxHr, d.maxHr);
}
const fallbackRhr = profile.restingHr>0 ? profile.restingHr : 50;
const rhrFor = (date)=> rhrByDate[date]>0 ? rhrByDate[date] : fallbackRhr;
// Max HR EXACTLY as the app computes it (effMaxHr): explicit profile value wins, else the observed peak FLOORED at
// the Tanaka age estimate — a short window with no hard effort gives a too-low observed max (here 156 vs 187), which
// compresses the HRR zones and wildly inflates load. Flooring keeps the calibrator and the app on the SAME maxHR so
// the fitted STRAIN_SCALE actually transfers to the phone.
const tanaka = maxHeartRate(profile.age||30);
const maxHr = profile.maxHr>0 ? profile.maxHr : Math.max(observedMaxHr, tanaka);
const maxHrSrc = profile.maxHr>0 ? 'profile' : (observedMaxHr>tanaka ? 'observed peak' : `Tanaka floor (observed ${observedMaxHr||'—'})`);
const rhrVals = Object.values(rhrByDate);
console.log(`WHOOP physiology: RHR ${rhrVals.length?fix(Math.min(...rhrVals),0)+'–'+fix(Math.max(...rhrVals),0)+' bpm over '+rhrVals.length+' days':'(none — fallback '+fallbackRhr+')'} · maxHR ${maxHr} (${maxHrSrc})`);

console.log('\nCaptures:');
const hrSamples = collectHr();
if(!hrSamples.length) console.log('  (none decoded — strain scale will be skipped; recovery still fits from the API)');

/* ------------------- DATA COVERAGE: app-captured hours vs WHOOP cloud hours ------------------- *
 * Calibration pairs OUR band-derived scores against WHOOP's full-day cloud scores. If our capture for a day is
 * partial, that pairing is wrong — so before fitting, report per-day how many hours we captured vs how many WHOOP
 * recorded, for BOTH the overnight sleep window (vs WHOOP's in-bed time) and the wake→wake cycle (vs its span).
 * Low-coverage days are flagged (and the fits below already exclude them) so the calibration stays accurate. */
function capturedHours(samples, startMs, endMs){
  let prev=null, sec=0;
  for(const s of samples){ if(s.t<startMs) continue; if(s.t>=endMs) break;
    const dt = prev==null?1:Math.min(MAX_DT,(s.t-prev)/1000); if(dt>0) sec+=dt; prev=s.t; }
  return sec/3600;
}
const hh=(h)=>{ if(h==null) return '—'; const m=Math.round(h*60); return Math.floor(m/60)+'h'+String(m%60).padStart(2,'0'); };   // minute-rollover safe
const SLEEP_OK=0.90, DAY_OK=0.60;   // coverage thresholds for calibration-grade data
const coverage = [];   // exposed for the fits: { date, sleepCov, dayCov }
if(hrSamples.length){
  console.log('\n— Data coverage (app captured vs WHOOP cloud) —');
  console.log('  date          sleep: app / whoop (cov)      day: app / whoop (cov)');
  console.log('  -----------   ---------------------------   ---------------------------');
  let partS=0, partD=0, okS=0, okD=0;
  for(const d of answers){
    let sCol='—'.padEnd(27), dCol='—', sc=null, dc=null;
    if(d.sleepStart && d.sleepEnd && d.inBedMin!=null){
      const appH=capturedHours(hrSamples, Date.parse(d.sleepStart), Date.parse(d.sleepEnd)), whoopH=d.inBedMin/60;
      if(appH>0.05){ sc=whoopH>0?appH/whoopH:0; sCol=`${hh(appH)} / ${hh(whoopH)} (${(sc*100).toFixed(0)}%)`.padEnd(27); sc>=SLEEP_OK?okS++:partS++; } }
    if(d.cycleStart){
      const s=Date.parse(d.cycleStart), e=d.cycleEnd?Date.parse(d.cycleEnd):s+24*3600e3;
      const appH=capturedHours(hrSamples,s,e), whoopH=(e-s)/3600e3;
      if(appH>0.05){ dc=whoopH>0?appH/whoopH:0; dCol=`${hh(appH)} / ${hh(whoopH)} (${(dc*100).toFixed(0)}%)`; dc>=DAY_OK?okD++:partD++; } }
    coverage.push({ date:d.date, sleepCov:sc, dayCov:dc });
    const settled = d.recovery!=null ? (d.calibrating ? ' ⏳ WHOOP calibrating' : ' ✓ settled') : '';
    if(sc!=null || dc!=null) console.log(`  ${d.date}    ${sCol}   ${dCol}${settled}`);
  }
  console.log(`  ⓘ sleep calibration-grade (≥${SLEEP_OK*100}%): ${okS} night(s), ${partS} partial · day/strain grade (≥${DAY_OK*100}%): ${okD} day(s), ${partD} partial.`);
  if(partS||partD) console.log('  → Re-sync the partial nights/days fully (or FORCE_TRIM back to them) so calibration only uses complete data.');
}

const fitted = { recovery: { ...RECOVERY_WEIGHTS }, strainScale: STRAIN_SCALE, sleepNeed: { ...SLEEP_NEED } };

/* ----------------------------- RECOVERY ----------------------------------- */
// Per-day features with a rolling personal baseline (prior ≤30 days), per WHOOP's
// "30-day baseline". Fit weights {hrv, rhr, resp, sleep, bias} to API recovery%.
// resp is fit only when the data has respiratory rate (rich JSON); otherwise dropped.
console.log('\n— Recovery —');
const BASE_WIN = 30;
const haveResp = answers.some(d=> d.resp!=null);
const buildRecRows = (minBase, settledOnly)=>{
  const rows=[];
  for(let i=0;i<answers.length;i++){
    const d=answers[i];
    if(d.recovery==null || d.hrv==null || d.rhr==null) continue;
    if(settledOnly && d.calibrating) continue;            // skip days WHOOP was still calibrating (its score is provisional)
    const prior = answers.slice(Math.max(0,i-BASE_WIN), i).filter(x=>x.hrv!=null && x.rhr!=null);
    if(prior.length < minBase) continue;
    const respPrior = prior.filter(x=>x.resp!=null).map(x=>x.resp);
    rows.push({
      hrv:Math.log(d.hrv), rhr:d.rhr, resp:d.resp ?? null,   // HRV z-score on ln(RMSSD) — must match app.js computeRecoveryTrend
      hrvBase: rollingStats(prior.map(x=>Math.log(x.hrv))),
      rhrBase: rollingStats(prior.map(x=>x.rhr)),
      respBase: respPrior.length>=minBase ? rollingStats(respPrior) : null,
      sleepPerformance: d.sleepPerf!=null ? d.sleepPerf/100 : null,
      y: d.recovery,
    });
  }
  return rows;
};
// WHOOP personalizes over ~30 days; during that window it flags days user_calibrating=true and its OWN scores are
// provisional. Fitting to those chases a moving target, so PREFER settled days (calibrating=false), only falling back
// to including calibrating days if too few settled exist. Within each, use a 5-day personal baseline, else a 3-day one.
const nRec = answers.filter(d=>d.recovery!=null).length;
const nCalib = answers.filter(d=>d.recovery!=null && d.calibrating).length;
console.log(`  WHOOP answer-key: ${nRec-nCalib} settled day(s), ${nCalib} still-calibrating (user_calibrating=true).`);
let minBase = 5, settledOnly = true, recRows = buildRecRows(5, true);
if(recRows.length < 6){ const r3 = buildRecRows(3, true); if(r3.length > recRows.length){ minBase = 3; recRows = r3; } }
if(recRows.length < 6){                                   // too few settled days → include calibrating days (fit is flagged provisional)
  settledOnly = false; minBase = 5; recRows = buildRecRows(5, false);
  if(recRows.length < 6){ const r3 = buildRecRows(3, false); if(r3.length > recRows.length){ minBase = 3; recRows = r3; } }
}
const recProvisional = !settledOnly || minBase < 5 || recRows.length < 10;
if(recRows.length < 6){
  console.log(`  only ${recRows.length} day(s) have HRV+RHR+baseline. Keep wearing + let the WHOOP app sync, re-pull daily.`);
  console.log("  WHOOP's own scores settle ~30 days in, so re-pull LATE in the trial for the truest fit. Recovery keeps its peer-derived defaults until then.");
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
  console.log(`  fit on ${recRows.length} ${settledOnly?'WHOOP-settled ':''}days (${minBase}-day baseline) · RMSE ${fix(before,1)}% → ${fix(loss(w),1)}% recovery${recProvisional?'   ⚠ PROVISIONAL — '+(settledOnly?'few days':'INCLUDES still-calibrating WHOOP days; re-pull settled days late in the trial')+'; re-pull as more accrue':''}`);
  console.log(`  weights: hrv ${fix(w[0],2)}  rhr ${fix(w[1],2)}  resp ${haveResp?fix(w[2],2):'(no data — kept '+RECOVERY_WEIGHTS.resp+')'}  sleep ${fix(w[3],2)}  bias ${fix(w[4],2)}`);
}

/* ----------------------------- STRAIN ------------------------------------- */
// Accumulate load over each WHOOP CYCLE window [cycleStart,cycleEnd] (wake→wake), not the calendar day, and fit only
// on cycles our capture actually COVERS — a half-captured cycle yields partial load that no single scale can match
// to a full-day strain. Coverage = captured seconds ÷ cycle length; fit on ≥MIN_COVER, list the rest as provisional.
console.log('\n— Strain —');
const MIN_COVER = 0.6;   // need ≥60% of the cycle captured for a trustworthy load↔strain pair
const allPairs = [];
for(const d of answers){
  if(d.strain==null || !d.cycleStart) continue;
  const start = Date.parse(d.cycleStart);
  const end = d.cycleEnd ? Date.parse(d.cycleEnd) : start + 24*3600e3;   // open current cycle → cap at +24h
  if(!(end>start)) continue;
  const { load, seconds } = loadInWindow(hrSamples, start, end, rhrFor(d.date), maxHr, profile.sex||'m');
  if(seconds < 60) continue;                                              // essentially no capture in this cycle
  allPairs.push({ date:d.date, load, y:d.strain, mins:seconds/60, coverage: seconds/((end-start)/1000) });
}
const strainPairs = allPairs.filter(p=> p.coverage>=MIN_COVER && p.load>0);
if(!allPairs.length){
  console.log('  no capture overlaps an API cycle with a strain score. Wear the band a full day (band connected),');
  console.log('  Send range → laptop, then re-run.');
} else {
  for(const p of allPairs.sort((a,b)=>a.date<b.date?-1:1))
    console.log(`  · ${p.date}: load ${fix(p.load,1)} over ${fix(p.mins,0)} min (${(p.coverage*100).toFixed(0)}% of cycle)  → WHOOP strain ${fix(p.y,1)}${p.coverage<MIN_COVER?'   ⤵ partial — excluded from fit':''}`);
  if(strainPairs.length < 3){
    console.log(`  only ${strainPairs.length} cycle(s) have ≥${MIN_COVER*100}% coverage — too few to fit a reliable scale. Keeping STRAIN_SCALE ${STRAIN_SCALE}.`);
    console.log('  Capture more FULL days (wear it + keep WHOOP Core connected dawn→dawn) and re-run.');
  } else {
    // strain = 21·(1 − e^(−load/scale)); fit scale to minimize MSE across the well-covered pairs.
    const loss=(s)=> rmse(strainPairs, p=> strainFromLoad(p.load, s[0]));
    const before = rmse(strainPairs, p=> strainFromLoad(p.load, STRAIN_SCALE));
    const s = goldenMin(v=> loss([v]), 1, 100000);   // patent weight·minute load units → scale is ~thousands
    fitted.strainScale = +s.toFixed(1);
    console.log(`  fit on ${strainPairs.length} well-covered cycle(s) · STRAIN_SCALE ${STRAIN_SCALE} → ${fix(s,1)}   ·  RMSE ${fix(before,2)} → ${fix(loss([s]),2)} strain`);
  }
}

/* ----------------------------- SLEEP -------------------------------------- */
// WHOOP exposes its own need breakdown, so we read its constants straight off it:
//   baselineMin  = its baseline need; strainSat = the saturation of the patent strain-need logistic.
// The strain term's SHAPE is WHOOP's published constant (patent US 11,627,946 B2):
//   need_from_strain(min) = 60·strainSat / (1 + e^((17−strain)/3.5))
// so we fit only the saturation `strainSat` by regressing the API's need_from_recent_strain_milli against
// that fixed shape (strainSat = needStrainMin / (60/(1+e^((17−strain)/3.5))), averaged). We can't isolate raw
// sleep-debt (WHOOP gives only the transformed debt term), so debtRepayFrac stays default. Then we VALIDATE
// the performance formula (asleep ÷ need) against WHOOP's sleep_performance_percentage.
console.log('\n— Sleep —');
const sleepDays = answers.filter(d=> d.needBaselineMin!=null && d.asleepMin!=null && d.needMin!=null);
if(!sleepDays.length){
  console.log('  no sleep detail in the answer-key. Re-pull with the updated whoop-api.mjs (writes whoop-data.json).');
} else {
  const baseDays = sleepDays.filter(d=> d.needBaselineMin>0);
  const strainDays = sleepDays.filter(d=> d.needStrainMin!=null && d.strain>0);
  const mean = (a)=> a.reduce((x,y)=>x+y,0)/a.length;
  const baselineMin = baseDays.length ? Math.round(mean(baseDays.map(d=>d.needBaselineMin))) : SLEEP_NEED.baselineMin;
  // shape factor of the patent logistic for that day's strain; strainSat = observed need ÷ shape
  const shape = (i)=> 60 / (1 + Math.exp((SLEEP_NEED.strainMid - i) / SLEEP_NEED.strainSlope));
  const strainSat = strainDays.length ? +mean(strainDays.map(d=> d.needStrainMin / shape(d.strain))).toFixed(2) : SLEEP_NEED.strainSat;
  fitted.sleepNeed = { baselineMin, debtRepayFrac: SLEEP_NEED.debtRepayFrac, strainSat, strainMid: SLEEP_NEED.strainMid, strainSlope: SLEEP_NEED.strainSlope };

  // Validate the performance formula on WHOOP's own need + our asleep figure.
  const perfRows = sleepDays.filter(d=> d.sleepPerf!=null).map(d=> ({ y:d.sleepPerf }) ); // y only used for rmse shape
  const perfErr = (()=>{ let s=0,n=0; for(const d of sleepDays){ if(d.sleepPerf==null) continue;
    const p = sleepPerformance(d.asleepMin, d.needMin)*100; const e=p-d.sleepPerf; s+=e*e; n++; } return n? Math.sqrt(s/n):NaN; })();

  console.log(`  baseline need ${baselineMin} min (${(baselineMin/60).toFixed(1)}h)  ·  strainSat ${strainSat}h (patent logistic, +${(strainNeedMinutes?strainNeedMinutes(21,fitted.sleepNeed):60*strainSat).toFixed(0)} min at strain 21)   (from ${baseDays.length}/${strainDays.length} days)`);
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
// Only fit stages on nights our capture actually covers (≥SLEEP_OK of WHOOP's in-bed time) — a partial night's
// stage minutes can't match WHOOP's full-night summary, so including it would bias the thresholds.
const covByDate = Object.fromEntries(coverage.map(c=>[c.date,c]));
const lowCov = [];
const stageRows = answers
  .filter(d=> d.remMin!=null && d.swsMin!=null && d.lightMin!=null && stageNights[d.date]?.length>=20)
  .filter(d=>{ const c=covByDate[d.date]; if(c && c.sleepCov!=null && c.sleepCov<SLEEP_OK){ lowCov.push(d.date); return false; } return true; })
  .map(d=> ({ date:d.date, epochs:trimToWindow(stageNights[d.date], d),
              whoop:{ rem:d.remMin, sws:d.swsMin, light:d.lightMin, awake:d.awakeMin||0 } }));
if(lowCov.length) console.log(`  (excluded ${lowCov.length} partial-coverage night(s) from the stage fit: ${lowCov.join(', ')})`);
if(!stageRows.length){
  console.log('  no night has BOTH a decoded overnight epoch stream AND WHOOP stage minutes yet.');
  console.log('  Get one: wear it overnight → "Sync full history" → Send to laptop → re-run. (Then this fits');
  console.log('  SLEEP_STAGE_PARAMS to your own nights.) Until then the classifier uses its default thresholds.');
} else {
  // Fit the most impactful thresholds; keep restHrPct + smoothing fixed (structural, not data-driven).
  const KEYS = ['wakeMove','wakeHrRel','deepHrRel','deepHrv','remHrRel','remHrv'];
  // Each range must BRACKET the param's default (in SLEEP_STAGE_PARAMS) — otherwise goldenMin searches the wrong
  // scale and rails at a bound (the old [1,6] for wakeMove, whose default is 0.109, returned a meaningless 6 that
  // disabled movement-based wake detection). wakeMove is accel-actigraphy (~0.1), the *HrRel are HR fractions.
  const RANGES = { wakeMove:[0.02,0.4], wakeHrRel:[0.2,0.7], deepHrRel:[0.04,0.2], deepHrv:[1.0,1.8], remHrRel:[0.03,0.2], remHrv:[0.6,1.05] };
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
