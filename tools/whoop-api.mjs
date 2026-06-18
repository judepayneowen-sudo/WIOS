#!/usr/bin/env node
/*
 * whoop-api.mjs — pull WHOOP's OFFICIAL scores (the calibration answer-key).
 *
 * OAuths into the WHOOP developer API once, then prints recent Recovery / Strain /
 * Sleep / HRV / RHR so they can be paired with WHOOP Core captures to calibrate scores.js.
 *
 * Desktop tool (Node 18+). Credentials live in a LOCAL, gitignored file — never in the
 * repo, never printed. See tools/WHOOP-API.md for one-time setup.
 *
 *   node tools/whoop-api.mjs auth     # one-time browser sign-in
 *   node tools/whoop-api.mjs 7        # print the last 7 days (default)
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const AUTH  = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API   = 'https://api.prod.whoop.com/developer/v2';
const REDIRECT = 'http://localhost:8765/callback';
const SCOPES = ['read:recovery','read:cycles','read:sleep','read:profile','offline'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.whoop.env');
const TOK_FILE = path.join(ROOT, '.whoop-tokens.json');
const CAL_DIR  = path.join(ROOT, 'calibration');
const DATA_OUT = path.join(CAL_DIR, 'whoop-data.json');

function cfg(){
  let id = process.env.WHOOP_CLIENT_ID, secret = process.env.WHOOP_CLIENT_SECRET;
  if((!id || !secret) && existsSync(ENV_FILE)){
    for(const line of readFileSync(ENV_FILE,'utf8').split(/\r?\n/)){
      const m = line.match(/^\s*(WHOOP_CLIENT_ID|WHOOP_CLIENT_SECRET)\s*=\s*(.*?)\s*$/);
      if(m){ if(m[1]==='WHOOP_CLIENT_ID') id ||= m[2]; else secret ||= m[2]; }
    }
  }
  if(!id || !secret){
    console.error('Missing credentials. Create a .whoop.env file in the repo root with:\n  WHOOP_CLIENT_ID=...\n  WHOOP_CLIENT_SECRET=...\n(see tools/WHOOP-API.md)');
    process.exit(1);
  }
  return { id, secret };
}

function openBrowser(url){
  try{
    if(process.platform==='win32') spawn('cmd',['/c','start','""',url],{stdio:'ignore',detached:true}).unref();
    else spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore',detached:true}).unref();
  }catch{}
}

const saveTokens = (t)=>{ t.obtained_at = Date.now(); writeFileSync(TOK_FILE, JSON.stringify(t,null,2)); };
const loadTokens = ()=> existsSync(TOK_FILE) ? JSON.parse(readFileSync(TOK_FILE,'utf8')) : null;

async function postForm(body){
  const r = await fetch(TOKEN, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body: new URLSearchParams(body) });
  if(!r.ok) throw new Error('token endpoint '+r.status+': '+await r.text());
  return r.json();
}

function waitForCode(state){
  return new Promise((resolve,reject)=>{
    const server = http.createServer((req,res)=>{
      const u = new URL(req.url, REDIRECT);
      if(u.pathname !== '/callback'){ res.writeHead(404); res.end(); return; }
      res.writeHead(200,{'content-type':'text/html'});
      res.end('<h2 style="font-family:sans-serif">WHOOP authorized — you can close this tab and return to the terminal.</h2>');
      server.close();
      if(u.searchParams.get('state') !== state) return reject(new Error('OAuth state mismatch'));
      const code = u.searchParams.get('code');
      code ? resolve(code) : reject(new Error('no code in redirect: '+u.search));
    });
    server.listen(8765, ()=> console.log('waiting for the WHOOP redirect on '+REDIRECT+' …'));
    setTimeout(()=>{ server.close(); reject(new Error('timed out waiting for authorization')); }, 180000);
  });
}

async function authorize(){
  const { id, secret } = cfg();
  const state = Math.random().toString(36).slice(2);
  const url = `${AUTH}?response_type=code&client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPES.join(' '))}&state=${state}`;
  console.log('\nAuthorize in your browser (opening automatically; or paste this URL):\n\n'+url+'\n');
  openBrowser(url);
  const code = await waitForCode(state);
  const tok = await postForm({ grant_type:'authorization_code', code, redirect_uri:REDIRECT, client_id:id, client_secret:secret });
  saveTokens(tok);
  console.log('authorized ✓  tokens saved to .whoop-tokens.json (gitignored)');
  return tok;
}

async function accessToken(){
  const { id, secret } = cfg();
  let t = loadTokens();
  if(!t) t = await authorize();
  const expired = Date.now() >= (t.obtained_at||0) + ((t.expires_in||3600)-60)*1000;
  if(expired && t.refresh_token){
    t = await postForm({ grant_type:'refresh_token', refresh_token:t.refresh_token, client_id:id, client_secret:secret, scope:'offline' });
    saveTokens(t);   // refresh tokens rotate — always persist the new one
  }
  return t.access_token;
}

async function get(pathname, token, params={}){
  const u = new URL(API+pathname);
  for(const [k,v] of Object.entries(params)) if(v!=null) u.searchParams.set(k,v);
  const r = await fetch(u, { headers:{ authorization:'Bearer '+token } });
  if(!r.ok) throw new Error(pathname+' → '+r.status+': '+await r.text());
  return r.json();
}

const day = (d)=> new Date(d).toISOString().slice(0,10);
const cell = (v,suf='',w=9)=> ((v==null||Number.isNaN(v)) ? '—' : (v+suf)).padEnd(w);
const mins = (milli)=> milli==null ? null : +(milli/60000).toFixed(1);   // ms → minutes

async function pull(days){
  const token = await accessToken();
  const end = new Date(), start = new Date(Date.now()-days*864e5);
  const p = { start:start.toISOString(), end:end.toISOString(), limit:25 };
  const [recovery, cycles, sleep, profile] = await Promise.all([
    get('/recovery', token, p), get('/cycle', token, p),
    get('/activity/sleep', token, p), get('/user/profile/basic', token),
  ]);

  const rows = {};
  const row = (k)=> (rows[k] ||= { date:k });

  // Cycle → strain + HR summary
  for(const c of (cycles.records||[])){
    const r=row(day(c.start)), s=c.score||{};
    r.strain=s.strain; r.avgHr=s.average_heart_rate; r.maxHr=s.max_heart_rate; r.kilojoule=s.kilojoule;
  }
  // Recovery → recovery%, HRV, RHR, SpO2, skin temp
  for(const x of (recovery.records||[])){
    const r=row(day(x.created_at)), s=x.score||{};
    r.recovery=s.recovery_score; r.hrv=s.hrv_rmssd_milli!=null?Math.round(s.hrv_rmssd_milli):null;
    r.rhr=s.resting_heart_rate; r.spo2=s.spo2_percentage; r.skinTemp=s.skin_temp_celsius;
    r.calibrating=s.user_calibrating||false;
  }
  // Sleep → keep the main night (non-nap, longest in-bed) per day; pull every field
  const nights={};
  for(const s of (sleep.records||[])){
    if(s.nap) continue;
    const k=day(s.end||s.start), inbed=s.score?.stage_summary?.total_in_bed_time_milli ?? 0;
    if(!nights[k] || inbed>nights[k]._inbed) nights[k]={ rec:s, _inbed:inbed };
  }
  for(const [k,{rec}] of Object.entries(nights)){
    const r=row(k), sc=rec.score||{}, st=sc.stage_summary||{}, nd=sc.sleep_needed||{};
    const asleep=(st.total_light_sleep_time_milli||0)+(st.total_slow_wave_sleep_time_milli||0)+(st.total_rem_sleep_time_milli||0);
    const need=(nd.baseline_milli||0)+(nd.need_from_sleep_debt_milli||0)+(nd.need_from_recent_strain_milli||0)-(nd.need_from_recent_nap_milli||0);
    r.sleepPerf=sc.sleep_performance_percentage; r.sleepEff=sc.sleep_efficiency_percentage;
    r.sleepConsistency=sc.sleep_consistency_percentage; r.resp=sc.respiratory_rate;
    r.asleepMin=mins(asleep); r.inBedMin=mins(st.total_in_bed_time_milli); r.awakeMin=mins(st.total_awake_time_milli);
    r.lightMin=mins(st.total_light_sleep_time_milli); r.swsMin=mins(st.total_slow_wave_sleep_time_milli); r.remMin=mins(st.total_rem_sleep_time_milli);
    r.needMin=mins(need); r.needBaselineMin=mins(nd.baseline_milli); r.needDebtMin=mins(nd.need_from_sleep_debt_milli);
    r.needStrainMin=mins(nd.need_from_recent_strain_milli); r.needNapMin=mins(nd.need_from_recent_nap_milli);
  }

  const ordered = Object.keys(rows).sort();                 // ascending for the JSON
  const data = ordered.map(k=>rows[k]);
  mkdirSync(CAL_DIR, { recursive:true });
  writeFileSync(DATA_OUT, JSON.stringify(data, null, 2));

  console.log(`\nWHOOP official scores — ${profile.first_name||''} ${profile.last_name||''} (last ${days} days)`);
  console.log(`Wrote ${path.relative(ROOT, DATA_OUT)} (${data.length} days, all fields) → run: npm run calibrate\n`);
  console.log('date         recovery  strain   sleep%   HRV   RHR   RESP   sleep   need');
  console.log('-----------  --------  -------  -------  ----  ----  -----  ------  ------');
  for(const k of ordered.reverse()){
    const r=rows[k];
    console.log(
      k.padEnd(13)+cell(r.recovery,'%',10)+cell(r.strain?.toFixed?.(1),'',9)+cell(r.sleepPerf,'%',9)+
      cell(r.hrv,'',6)+cell(r.rhr,'',6)+cell(r.resp?.toFixed?.(1),'',7)+
      cell(r.asleepMin!=null?(r.asleepMin/60).toFixed(1)+'h':null,'',8)+cell(r.needMin!=null?(r.needMin/60).toFixed(1)+'h':null,'',8));
  }
  console.log('\n(HRV = rmssd ms · RESP = breaths/min · sleep/need in hours. All fields are in the JSON above.)');
}

const arg = process.argv[2];
try{
  if(arg==='auth') await authorize();
  else await pull(Number.parseInt(arg,10) || 7);
}catch(e){ console.error('\nerror: '+e.message); process.exit(1); }
