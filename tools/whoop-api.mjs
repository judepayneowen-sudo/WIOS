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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const AUTH  = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API   = 'https://api.prod.whoop.com/developer/v2';
const REDIRECT = 'http://localhost:8765/callback';
const SCOPES = ['read:recovery','read:cycles','read:sleep','read:profile','offline'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.whoop.env');
const TOK_FILE = path.join(ROOT, '.whoop-tokens.json');

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

async function pull(days){
  const token = await accessToken();
  const end = new Date(), start = new Date(Date.now()-days*864e5);
  const p = { start:start.toISOString(), end:end.toISOString(), limit:25 };
  const [recovery, cycles, sleep, profile] = await Promise.all([
    get('/recovery', token, p), get('/cycle', token, p),
    get('/activity/sleep', token, p), get('/user/profile/basic', token),
  ]);
  const rows = {};
  const row = (k)=> (rows[k] ||= {});
  for(const c of (cycles.records||[]))   { const r=row(day(c.start)); r.strain=c.score?.strain; }
  for(const x of (recovery.records||[])) { const r=row(day(x.created_at)); r.rec=x.score?.recovery_score; r.hrv=x.score?.hrv_rmssd_milli; r.rhr=x.score?.resting_heart_rate; }
  for(const s of (sleep.records||[]))    { const r=row(day(s.end||s.start)); r.sleep=s.score?.sleep_performance_percentage; }

  console.log(`\nWHOOP official scores — ${profile.first_name||''} ${profile.last_name||''} (last ${days} days)`);
  console.log('Paste this with your WHOOP Core capture so the scores can be calibrated:\n');
  console.log('date         recovery  strain   sleep%   HRV       RHR');
  console.log('-----------  --------  -------  -------  --------  -----');
  for(const k of Object.keys(rows).sort().reverse()){
    const r = rows[k];
    console.log(k.padEnd(13)+cell(r.rec,'%',10)+cell(r.strain?.toFixed?.(1),'',9)+cell(r.sleep,'%',9)+cell(r.hrv!=null?Math.round(r.hrv):null,'',10)+cell(r.rhr,'',5));
  }
  console.log('\n(HRV is rmssd in the API\'s native units — compare relative trend to the app\'s HRV.)');
}

const arg = process.argv[2];
try{
  if(arg==='auth') await authorize();
  else await pull(Number.parseInt(arg,10) || 7);
}catch(e){ console.error('\nerror: '+e.message); process.exit(1); }
