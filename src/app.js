/*
 * WHOOP Core — standalone iOS reader (Capacitor + CoreBluetooth via @capacitor-community/bluetooth-le).
 *
 * iOS/CoreBluetooth performs WHOOP's on-demand BLE encryption automatically, so the custom
 * fd4b command service (unreachable on Windows) works here. Protocol is an independent
 * clean-room implementation of the GOOSE/Gen5 frame format, verified byte-identical to the
 * known get_hello fixture (aa0108000001e67123019101363e5c8d).
 *
 * Two halves:
 *   - WHOOP-style screens (Overview / Recovery / Strain / Sleep) — the permanent app.
 *   - A DEV / SETUP block (clearly fenced below) — connection + capture + command tooling
 *     used to extract & decode the data. Delete that block + the Setup tab to retire it.
 */
import { BleClient, numbersToDataView } from '@capacitor-community/bluetooth-le';
import { SplashScreen } from '@capacitor/splash-screen';
import { makeStrainAccumulator, maxHeartRate, sleepNeedMinutes } from './scores.js';

/* ----------------------------- GATT map ----------------------------------- */
const SVC    = 'fd4b0001-cce1-4033-93ce-002d5875f58a';   // custom command service
const TX     = 'fd4b0002-cce1-4033-93ce-002d5875f58a';   // command_to_strap   (write)
const RX_CMD = 'fd4b0003-cce1-4033-93ce-002d5875f58a';   // command_from_strap (notify)
const RX_EVT = 'fd4b0004-cce1-4033-93ce-002d5875f58a';   // events_from_strap  (notify)
const RX_DAT = 'fd4b0005-cce1-4033-93ce-002d5875f58a';   // data_from_strap    (notify)

const HR_SVC   = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEAS  = '00002a37-0000-1000-8000-00805f9b34fb';
const BATT_SVC = '0000180f-0000-1000-8000-00805f9b34fb';
const BATT_LVL = '00002a19-0000-1000-8000-00805f9b34fb';
const DEV_SVC  = '0000180a-0000-1000-8000-00805f9b34fb';
const DEV_MFR  = '00002a29-0000-1000-8000-00805f9b34fb';
const DEV_MODEL= '00002a24-0000-1000-8000-00805f9b34fb';
const DEV_SERIAL='00002a25-0000-1000-8000-00805f9b34fb';
const DEV_FW   = '00002a26-0000-1000-8000-00805f9b34fb';

const PACKET_TYPE_COMMAND = 35;
const PKT = {35:'COMMAND',36:'COMMAND_RESPONSE',40:'REALTIME_DATA',43:'REALTIME_RAW_DATA',
  47:'HISTORICAL_DATA',48:'EVENT',49:'METADATA',50:'CONSOLE_LOGS',51:'REALTIME_IMU',
  52:'HISTORICAL_IMU',53:'REL_PUFFIN_EVENTS',54:'PUFFIN_EVENTS',56:'PUFFIN_METADATA'};

/* ----------------------------- CRC + framing ------------------------------ */
function crc16_modbus(bytes){
  let crc = 0xFFFF;
  for(const b of bytes){ crc ^= b; for(let i=0;i<8;i++) crc = (crc&1)?((crc>>>1)^0xA001):(crc>>>1); }
  return crc & 0xFFFF;
}
const CRC32_TABLE = (()=>{ const t=new Uint32Array(256);
  for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; } return t; })();
function crc32(bytes){ let c=0xFFFFFFFF; for(const b of bytes) c=CRC32_TABLE[(c^b)&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function padLen(n){ const r=n%4; return r===0?0:4-r; }

function buildCommand(sequence, command, data=[]){
  let payload=[PACKET_TYPE_COMMAND, sequence&0xFF, command&0xFF, ...data];
  for(let p=padLen(payload.length); p>0; p--) payload.push(0x00);
  const pc=crc32(payload), declared=payload.length+4;
  const head=[0xAA,0x01,declared&0xFF,(declared>>>8)&0xFF,0x00,0x01];
  const hc=crc16_modbus(head);
  return [...head, hc&0xFF,(hc>>>8)&0xFF, ...payload, pc&0xFF,(pc>>>8)&0xFF,(pc>>>16)&0xFF,(pc>>>24)&0xFF];
}
const hex = (a)=>Array.from(a, b=>b.toString(16).padStart(2,'0')).join('');
const dvBytes = (dv)=> new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

function parseFrame(dv){
  const f = dvBytes(dv);
  if(f.length<8 || f[0]!==0xAA) return {error:'no 0xAA / short', rawHex:hex(f)};
  const declared=f[2]|(f[3]<<8);
  const headOk=crc16_modbus(f.slice(0,6))===(f[6]|(f[7]<<8));
  const truncated=f.length < 8+declared;
  let payload, payOk=null;
  if(truncated){ payload=f.slice(8); }
  else{ payload=f.slice(8,f.length-4); const got=f.slice(f.length-4); const c=crc32(payload);
    payOk = got[0]===(c&0xFF)&&got[1]===((c>>>8)&0xFF)&&got[2]===((c>>>16)&0xFF)&&got[3]===((c>>>24)&0xFF); }
  const pt=payload[0];
  return { packetType:pt, name:PKT[pt]||('?'+pt), sequence:payload[1], code:payload[2],
           headOk, payOk, truncated, payloadHex:hex(payload), rawHex:hex(f) };
}

/* ----------------------------- HRV (RMSSD) -------------------------------- */
const rr = [];           // recent RR intervals in ms
function pushRR(ms){ rr.push(ms); while(rr.length>60) rr.shift(); }
function rmssd(){
  if(rr.length<3) return null;
  let s=0,n=0; for(let i=1;i<rr.length;i++){ const d=rr[i]-rr[i-1]; s+=d*d; n++; }
  return n? Math.round(Math.sqrt(s/n)) : null;
}
function parseHeartRate(dv){
  const b=dvBytes(dv); const flags=b[0]; let i=1; let hr;
  if(flags&0x01){ hr=b[i]|(b[i+1]<<8); i+=2; } else { hr=b[i]; i+=1; }
  if(flags&0x08) i+=2;                                  // energy expended present → skip
  if(flags&0x10){ for(; i+1<b.length; i+=2){ const rrU=b[i]|(b[i+1]<<8); pushRR(Math.round(rrU*1000/1024)); } }
  return hr;
}

/* ----------------------------- small UI helpers --------------------------- */
const $ = (id)=>document.getElementById(id);
const setField = (id,v)=>{ const el=$(id); if(el) el.textContent=v; };
const setHTML  = (id,h)=>{ const el=$(id); if(el) el.innerHTML=h; };
function fmtMs(min){ min=Math.round(min); return Math.floor(min/60)+'h '+String(min%60).padStart(2,'0')+'m'; }
function fmtDur(s){ s=Math.round(s); const m=Math.floor(s/60); return m+':'+String(s%60).padStart(2,'0'); }

/* ----------------------------- profile ------------------------------------ */
const PKEY='whoopcore.profile';
const DEF_PROFILE={age:30,sex:'m',restingHr:50,maxHr:0};
function loadProfile(){ try{ return {...DEF_PROFILE, ...JSON.parse(localStorage.getItem(PKEY)||'{}')}; }catch(e){ return {...DEF_PROFILE}; } }
let profile=loadProfile();
const effMaxHr = ()=> profile.maxHr>0 ? profile.maxHr : maxHeartRate(profile.age||30);
const newStrainAcc = ()=> makeStrainAccumulator({ restingHr:profile.restingHr||50, maxHr:effMaxHr(), sex:profile.sex||'m' });

/* ----------------------------- live state --------------------------------- */
const state = { hr:null, hrvMs:null, restHr:null, hrCount:0, hrSum:0, strainAcc:null, recovery:null, sleep:null };
let lastHrTs=0;

/* ----------------------------- rings + renders ---------------------------- */
const RING_C = 2*Math.PI*88;
const recColor = (p)=> p>=67 ? 'var(--rec-green)' : p>=34 ? 'var(--rec-yellow)' : 'var(--rec-red)';
function setRing(id, pct, color){ const el=$(id); if(!el) return;
  pct=Math.max(0,Math.min(100,pct||0));
  el.style.strokeDasharray=RING_C; el.style.strokeDashoffset=RING_C*(1-pct/100);
  if(color) el.style.stroke=color; }

// Representative sample data so the WHOOP-style layout + graphs are fully visible
// until real captures are decoded. Replaced by live/decoded values once available.
const SAMPLE = {
  recovery:{ pct:64, vow:'HRV is in your normal range and resting heart rate is low — you’re recovered and primed for moderate-to-high strain today.',
    metrics:[
      {nm:'Heart rate variability', val:78,   unit:'ms',  lo:55,   hi:95,   today:78},
      {nm:'Resting heart rate',     val:51,   unit:'bpm', lo:47,   hi:58,   today:51},
      {nm:'Respiratory rate',       val:14.2, unit:'rpm', lo:13.4, hi:15.4, today:14.2},
      {nm:'Blood oxygen',           val:96,   unit:'%',   lo:95,   hi:99,   today:96},
      {nm:'Skin temperature',       val:33.8, unit:'°C', lo:33.1, hi:34.5, today:33.8} ],
    trend:[71,58,66,49,74,62,80,55,69,64,72,60,67,64] },
  strain:{ day:11.3, cal:2150, avg:78, max:152,
    vow:'A moderate day. You’re tracking just under your optimal strain — a short session would top it off.',
    zones:[5400,4200,3000,2400,1200,360],
    hr:[58,60,61,63,72,96,138,120,90,78,74,82,112,150,128,92,74,67,80,104,88,70,63,60] },
  sleep:{ perf:88, debtMin:62, eff:92,
    segs:[{s:'awake',m:8},{s:'light',m:55},{s:'rem',m:25},{s:'sws',m:40},{s:'light',m:35},
          {s:'sws',m:30},{s:'rem',m:30},{s:'light',m:45},{s:'awake',m:6},{s:'rem',m:35},
          {s:'light',m:40},{s:'sws',m:18},{s:'rem',m:25}] }
};
const STAGE={ awake:{c:'var(--st-awake)',nm:'Awake',lane:0}, rem:{c:'var(--st-rem)',nm:'REM',lane:1},
  light:{c:'var(--st-light)',nm:'Light',lane:2}, sws:{c:'var(--st-sws)',nm:'Deep (SWS)',lane:3} };
const ZONE_COL=['#1d6fae','#2a8fd8','#3aa0ff','#7c5cff','#ff9f3a','#ff3b5c'];
const ZONE_NM=['Restorative','Very light','Light','Moderate','Hard','Max'];

function lineChart(values,{color='#3aa0ff',h=64,fill=true}={}){
  if(!values||!values.length) return '';
  const w=320,p=5,mn=Math.min(...values),mx=Math.max(...values),rg=(mx-mn)||1;
  const X=i=>p+i*(w-2*p)/(values.length-1), Y=v=>p+(1-(v-mn)/rg)*(h-2*p);
  const pts=values.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  const area=`M${X(0).toFixed(1)},${h-p} L`+pts.join(' L')+` L${X(values.length-1).toFixed(1)},${h-p} Z`;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px">`+
    (fill?`<path d="${area}" fill="${color}" opacity="0.13"/>`:'')+
    `<path d="M${pts.join(' L')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function hypnogram(segs){
  const tot=segs.reduce((a,s)=>a+s.m,0)||1, w=320,h=96,lh=h/4; let x=0,r='';
  for(const s of segs){ const sw=s.m/tot*w, L=STAGE[s.s].lane;
    r+=`<rect x="${x.toFixed(1)}" y="${(L*lh+3).toFixed(1)}" width="${Math.max(sw-1,1).toFixed(1)}" height="${(lh-6).toFixed(1)}" rx="2" fill="${STAGE[s.s].c}"/>`;
    x+=sw; }
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px">${r}</svg>`;
}
function metricRows(ms){
  return ms.map(m=>{
    const span=(m.hi-m.lo)||1, pad=span*0.6, lo2=m.lo-pad, tr=(m.hi+pad)-lo2;
    const bandL=(m.lo-lo2)/tr*100, bandW=(m.hi-m.lo)/tr*100, mk=Math.max(2,Math.min(98,(m.today-lo2)/tr*100));
    const ok=m.today>=m.lo&&m.today<=m.hi, flag=ok?'var(--rec-green)':'var(--rec-yellow)';
    return `<div class="mrow"><div class="top"><span class="nm">${m.nm}<span class="flag" style="background:${flag}"></span></span>`+
      `<span class="vv">${m.val}<small> ${m.unit}</small></span></div>`+
      `<div class="rng"><div class="band" style="left:${bandL}%;width:${bandW}%"></div><div class="mk" style="left:${mk}%;background:${flag}"></div></div>`+
      `<div class="sub"><span>typical ${m.lo}–${m.hi} ${m.unit}</span><span>vs 30-day</span></div></div>`;
  }).join('');
}

function renderOverview(){
  const S=SAMPLE; const asleep=S.sleep.segs.filter(x=>x.s!=='awake').reduce((a,x)=>a+x.m,0);
  setRing('ov-arc', S.recovery.pct, recColor(S.recovery.pct)); setField('ov-rec', S.recovery.pct);
  setField('ov-rec-state', S.recovery.pct>=67?'Recovered':S.recovery.pct>=34?'Adequate':'Low');
  setHTML('ov-sleep', S.sleep.perf+'<small>%</small>'); setField('ov-sleep-sub', fmtMs(asleep)+' asleep');
  setField('ov-strain', S.strain.day.toFixed(1));
  setHTML('ov-hr',  (state.hr!=null?state.hr:'—')+'<small>bpm</small>');
  setHTML('ov-hrv', (state.hrvMs!=null?state.hrvMs:S.recovery.metrics[0].val)+'<small>ms</small>');
}
function renderRecovery(){
  const R=SAMPLE.recovery;
  setField('rec-pct', R.pct); setRing('rec-arc', R.pct, recColor(R.pct));
  setField('rec-state', R.pct>=67?'Recovered':R.pct>=34?'Adequate':'Low');
  setField('rec-vow', R.vow);
  setHTML('rec-metrics', metricRows(R.metrics));
  setHTML('rec-trend', lineChart(R.trend,{color:recColor(R.pct),h:64}));
  setField('rec-trend-avg', 'avg '+Math.round(R.trend.reduce((a,b)=>a+b,0)/R.trend.length)+'%');
}
function renderStrain(){
  const S=SAMPLE.strain, live=state.strainAcc?state.strainAcc.strain:null;
  setField('str-val', S.day.toFixed(1));
  const mk=$('str-mk'); if(mk) mk.style.left=(S.day/21*100)+'%';
  setField('str-vow', S.vow);
  setField('str-hrnow', state.hr!=null?('live '+state.hr+' bpm'):(live!=null?('live strain '+live.toFixed(1)):'live —'));
  setHTML('str-hrcurve', lineChart(S.hr,{color:'#3aa0ff',h:72}));
  const zc=$('str-zones'); if(zc){ const mx=Math.max(...S.zones)||1;
    zc.innerHTML=S.zones.map((s,i)=>`<div class="zone"><span class="lab" style="width:74px">${ZONE_NM[i]}</span><span class="zb"><i style="width:${(s/mx*100).toFixed(0)}%;background:${ZONE_COL[i]}"></i></span><span class="zt">${fmtDur(s)}</span></div>`).join(''); }
  setField('str-cal', S.cal); setField('str-avg', S.avg); setField('str-max', S.max);
}
function renderSleep(){
  const S=SAMPLE.sleep, tot={awake:0,light:0,rem:0,sws:0};
  for(const x of S.segs) tot[x.s]+=x.m;
  const asleep=tot.light+tot.rem+tot.sws, inbed=asleep+tot.awake;
  setField('slp-pct', S.perf); setRing('slp-arc', S.perf, 'var(--sleep)');
  setField('slp-hours', fmtMs(asleep)+' asleep');
  setHTML('slp-hypno', hypnogram(S.segs));
  setHTML('slp-stages', ['rem','sws','light','awake'].map(k=>`<div class="stg"><span class="sw" style="background:${STAGE[k].c}"></span>`+
    `<span class="nm">${STAGE[k].nm}</span><span class="tm">${fmtMs(tot[k])}</span><span class="pc">${Math.round(tot[k]/inbed*100)}%</span></div>`).join(''));
  setField('slp-need', fmtMs(sleepNeedMinutes({dayStrain:SAMPLE.strain.day})));
  setField('slp-debt', fmtMs(S.debtMin)); setField('slp-eff', S.eff+'%');
}
function renderAll(){ renderOverview(); renderRecovery(); renderStrain(); renderSleep(); }

/* ----------------------------- tabs --------------------------------------- */
function showTab(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('on', s.id==='s-'+name));
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
  window.scrollTo(0,0); renderAll();
}

/* ----------------------------- live HR feed ------------------------------- */
function onHR(dv){
  const hr=parseHeartRate(dv);
  if(!(hr>0)) return;
  const now=Date.now(); const dt=lastHrTs?(now-lastHrTs)/1000:1; lastHrTs=now;
  state.hr=hr; state.hrCount++; state.hrSum+=hr;
  state.restHr = state.restHr==null? hr : Math.min(state.restHr, hr);
  if(state.strainAcc && dt>0 && dt<15) state.strainAcc.add(hr, dt);
  state.hrvMs = rmssd();
  renderAll();
}

/* ===================== DEV / SETUP (remove after extraction) =====================
   Connection, device info, raw-frame capture/dump, and the custom-command sender used
   to pull data off the band for decoding. To retire: delete this block, the Setup
   <section> + tab button in index.html, and the profile bit graduates to Settings.   */
function logEl(){ return $('log'); }
function log(msg, cls='dim'){ const el=logEl(); if(!el) return; const d=document.createElement('div');
  d.className='ln '+cls; d.textContent='['+new Date().toLocaleTimeString()+'] '+msg;
  el.appendChild(d); el.scrollTop=el.scrollHeight; }
function logFrame(dir, info){
  if(info.error){ log(`${dir} ${info.rawHex} ⟶ ${info.error}`,'err'); return; }
  const ok=(info.headOk && info.payOk!==false)?'✓':'⚠';
  log(`${dir} ${info.name} seq=${info.sequence} code=${info.code} [h:${info.headOk?'ok':'BAD'} p:${info.payOk===null?'-':info.payOk?'ok':'BAD'}] ${ok}`, info.packetType===48?'evt':'rx');
  log(`     payload=${info.payloadHex}`,'dim');
}
function setStatus(t, on){ setField('status', t); const d=$('dot'); if(d) d.classList.toggle('on', !!on); }

const rt = { counts:{} };
let capturing=false; const capture=[]; const CAP_MAX=20000;
function renderRt(){ const el=$('rt'); if(!el) return;
  const rows=Object.keys(rt.counts).sort().map(k=>`${k}:${rt.counts[k]}`);
  el.textContent = rows.length ? rows.join('   ') : 'none yet'; }
function onFrame(label, dv){
  const info=parseFrame(dv); logFrame('RX['+label+']', info);
  if(!info.error){ const k=info.name; rt.counts[k]=(rt.counts[k]||0)+1; renderRt(); }
  if(capturing){ capture.push({t:Date.now(), ch:label, hex:info.rawHex}); if(capture.length>CAP_MAX) capture.shift(); }
}
function dumpCapture(){
  const text=capture.map(c=>`${new Date(c.t).toISOString()}\t${c.ch}\t${c.hex}`).join('\n');
  const ta=$('dump'); ta.value=text||'(nothing captured)'; ta.style.display='block'; ta.focus(); ta.select();
  navigator.clipboard?.writeText(text).then(
    ()=>log('copied to clipboard ('+capture.length+' frames) — paste it to Claude','ok'),
    ()=>log('shown below — select all & copy ('+capture.length+' frames)','dim'));
}
function parseHexData(s){ s=(s||'').trim(); if(!s) return [];
  return s.split(/[\s,]+/).filter(Boolean).map(x=>parseInt(x,16)&0xFF); }
const CRITICAL_COMMANDS = { 36:'start_firmware_load',37:'load_firmware_data',38:'process_firmware_image',
  39:'set_led_drive',41:'set_tia_gain',43:'set_bias_offset' };
function enableDev(on){
  for(const id of ['hello','battery','range','rthr','disconnect','csend']){ const el=$(id); if(el) el.disabled=!on; }
  const c=$('connect'); if(c) c.disabled=on;
}
// cmd 3 = toggle_realtime_hr: data [01] starts the REALTIME_DATA(40) stream, [00] stops it.
let rtHrOn=false;
async function toggleRealtimeHr(){
  rtHrOn=!rtHrOn;
  await send(3,[rtHrOn?0x01:0x00], rtHrOn?'toggle_realtime_hr ON':'toggle_realtime_hr OFF');
  const b=$('rthr'); if(b){ b.textContent='Realtime HR: '+(rtHrOn?'on':'off'); b.classList.toggle('live',rtHrOn); }
}
/* ===================== END DEV/SETUP ===================== */

/* ----------------------------- BLE flow ----------------------------------- */
let deviceId=null, seq=1;

async function connect(){
  try{
    rt.counts={}; renderRt();
    state.hrCount=0; state.hrSum=0; state.restHr=null; lastHrTs=0; rr.length=0;
    state.strainAcc=newStrainAcc();
    setStatus('initialising…');
    await BleClient.initialize();
    log('select your WHOOP in the chooser…');
    const device=await BleClient.requestDevice({ namePrefix:'WHOOP', optionalServices:[SVC,HR_SVC,BATT_SVC,DEV_SVC] });
    deviceId=device.deviceId;
    log(`selected: ${device.name||'WHOOP'} [${deviceId}]`);
    setStatus('connecting…');
    await BleClient.connect(deviceId, onDisconnect);
    setStatus('connected — '+(device.name||'WHOOP'), true);
    enableDev(true);

    try{ const b=await BleClient.read(deviceId,BATT_SVC,BATT_LVL); setField('batt', b.getUint8(0)+'%'); }catch(e){ log('battery read: '+e.message,'err'); }
    for(const [ch,id] of [[DEV_MODEL,'model'],[DEV_FW,'fw'],[DEV_SERIAL,'serial'],[DEV_MFR,'mfr']]){
      try{ const v=await BleClient.read(deviceId,DEV_SVC,ch); setField(id, new TextDecoder().decode(v).replace(/\0/g,'').trim()); }catch(e){}
    }
    try{ await BleClient.startNotifications(deviceId,HR_SVC,HR_MEAS, onHR); log('subscribed: live Heart Rate ✓','ok'); }
    catch(e){ log('HR subscribe failed: '+e.message,'err'); }
    for(const [ch,label] of [[RX_CMD,'command_from_strap'],[RX_EVT,'events_from_strap'],[RX_DAT,'data_from_strap']]){
      try{ await BleClient.startNotifications(deviceId,SVC,ch,(v)=>onFrame(label,v)); log('subscribed: '+label+' ✓','ok'); }
      catch(e){ log('subscribe '+label+' FAILED: '+e.message,'err'); }
    }
    log('connected. Live HR is flowing — see the Strain/Overview tabs.','ok');
    renderAll();
  }catch(e){ log('connect error: '+e.message,'err'); setStatus('not connected'); }
}

async function send(command, data=[], label=''){
  if(!deviceId){ log('not connected','err'); return; }
  const frame=buildCommand(seq,command,data);
  try{ await BleClient.write(deviceId,SVC,TX,numbersToDataView(frame));
    log(`TX ${label||command} seq=${seq}  ${hex(frame)}`,'cmd'); seq=(seq+1)&0xFF; if(seq===0) seq=1;
  }catch(e){ log('TX failed: '+e.message,'err'); }
}
async function onDisconnect(){ setStatus('disconnected'); enableDev(false);
  rtHrOn=false; const b=$('rthr'); if(b){ b.textContent='Realtime HR: off'; b.classList.remove('live'); }
  log('device disconnected.','err'); }

function selfTest(){
  const built=hex(buildCommand(1,145,[0x01]));
  log(built==='aa0108000001e67123019101363e5c8d' ? 'self-test: protocol OK ✓' : 'self-test FAILED: '+built, built==='aa0108000001e67123019101363e5c8d'?'ok':'err');
}

/* ----------------------------- profile form ------------------------------- */
function fillProfileForm(){ $('p-age').value=profile.age||''; $('p-sex').value=profile.sex||'m';
  $('p-rhr').value=profile.restingHr||''; $('p-mhr').value=profile.maxHr||''; }
function saveProfileForm(){
  profile={ age:parseInt($('p-age').value,10)||30, sex:$('p-sex').value==='f'?'f':'m',
            restingHr:parseInt($('p-rhr').value,10)||50, maxHr:parseInt($('p-mhr').value,10)||0 };
  localStorage.setItem(PKEY, JSON.stringify(profile));
  state.strainAcc=newStrainAcc();                       // note: resets live strain accumulation
  setField('p-note', `saved · max HR ${effMaxHr()} bpm`);
  renderAll();
}

/* ----------------------------- wire up ------------------------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  SplashScreen.hide().catch(()=>{});
  document.querySelectorAll('#tabs button').forEach(b=> b.onclick=()=>showTab(b.dataset.tab));
  document.querySelectorAll('[data-go]').forEach(el=> el.onclick=()=>showTab(el.dataset.go));
  fillProfileForm();
  selfTest();
  $('connect').onclick    = connect;
  $('disconnect').onclick = async ()=>{ if(deviceId){ try{ await BleClient.disconnect(deviceId); }catch(e){} } };
  $('hello').onclick      = ()=>send(145,[0x01],'get_hello');
  $('battery').onclick    = ()=>send(26,[],'get_battery_level');
  $('range').onclick      = ()=>send(34,[],'get_data_range');
  $('rthr').onclick       = toggleRealtimeHr;
  $('p-save').onclick     = saveProfileForm;
  $('csend').onclick      = ()=>{ const code=parseInt($('ccode').value,10);
    if(!Number.isFinite(code)){ log('enter a command number','err'); return; }
    const danger=CRITICAL_COMMANDS[code];
    if(danger && !confirm(`⚠ Command ${code} (${danger}) can load firmware or rewrite optical-sensor config and may brick or misconfigure your band.\n\nSend it anyway?`)){
      log(`blocked critical command ${code} (${danger})`,'err'); return; }
    send(code, parseHexData($('cdata').value), danger?`cmd${code}!`:'cmd'+code); };
  $('capture').onclick    = ()=>{ capturing=!capturing;
    $('capture').textContent=capturing?'Stop capture':'Start capture'; $('capture').classList.toggle('live',capturing);
    log('capture '+(capturing?'started':'stopped')+' ('+capture.length+' frames held)', capturing?'ok':'dim'); };
  $('dumpbtn').onclick    = dumpCapture;
  $('clear').onclick      = ()=>{ const el=logEl(); if(el) el.innerHTML=''; };
  enableDev(false);
  renderRt();
  renderAll();
});
