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
import { makeStrainAccumulator, maxHeartRate, sleepNeedMinutes, rollingStats, recoveryScore } from './scores.js';
import * as store from './store.js';

/* ----------------------------- GATT map ----------------------------------- */
const SVC    = 'fd4b0001-cce1-4033-93ce-002d5875f58a';   // custom command service
const TX     = 'fd4b0002-cce1-4033-93ce-002d5875f58a';   // command_to_strap   (write)
const RX_CMD = 'fd4b0003-cce1-4033-93ce-002d5875f58a';   // command_from_strap (notify)
const RX_EVT = 'fd4b0004-cce1-4033-93ce-002d5875f58a';   // events_from_strap  (notify)
const RX_DAT = 'fd4b0005-cce1-4033-93ce-002d5875f58a';   // data_from_strap    (notify)
const RX_HF  = 'fd4b0007-cce1-4033-93ce-002d5875f58a';   // hi-rate / IMU stream (notify) — the 6th char WHOOP uses for raw IMU
// All five WHOOP GATT service families (from op0/p.java). The 5.0 uses fd4b, but high-rate IMU may live on
// another family entirely — declare them all so iOS will discover/allow them, then we subscribe to every
// notify characteristic we find (listGatt).
const WHOOP_SERVICES = [
  'fd4b0001-cce1-4033-93ce-002d5875f58a',
  '61080001-8d6d-82b8-614a-1c8cb0f8dcc6',
  '11500001-6215-11ee-8c99-0242ac120002',
  '8a580001-2fe8-4796-9267-b87a2b0c8234',
  '59830001-5955-419b-bb8d-c8262926af23',
];

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
           headOk, payOk, truncated, payloadHex:hex(payload), rawHex:hex(f), payloadBytes:payload };
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
const state = { hr:null, hrvMs:null, restHr:null, hrCount:0, hrSum:0, strainAcc:null, recovery:null, sleep:null,
                skinTempC:null, spo2:null };   // band-derived from the (47) record on the last pull
let lastHrTs=0;

/* ----- on-device history cache (from the IndexedDB store) — drives the REAL-data screens -----
   The detail screens (Sleep/Strain/Trends/Recovery) read live from here when we have stored nights,
   falling back to SAMPLE only when the store is empty. Refreshed on launch + after every pull. */
let histDays = [];                                            // newest-first day summaries from the store
function computeRecoveryTrend(){
  const asc=[...histDays].reverse();                          // oldest→newest for trailing baselines
  for(let i=0;i<asc.length;i++){ const d=asc[i];
    const prior=asc.slice(Math.max(0,i-14),i).filter(x=>x.hrvMs&&x.restHr);
    if(d.hrvMs&&d.restHr&&prior.length>=3){
      const hrvBase=rollingStats(prior.map(x=>x.hrvMs)), rhrBase=rollingStats(prior.map(x=>x.restHr));
      d.rec=recoveryScore({ hrv:d.hrvMs, hrvBase, rhr:d.restHr, rhrBase,
        skinTempC:d.skinTempC, skinTempBase:prior.length?prior.reduce((a,x)=>a+(x.skinTempC||0),0)/prior.length:null,
        spo2:d.spo2, sleepPerformance:d.sleep&&d.sleep.performance!=null?d.sleep.performance/100:null });
    } else d.rec=null;
  }
}
async function refreshHist(){
  try{ histDays = await store.listDays(); }catch(e){ histDays=[]; }
  computeRecoveryTrend();
  // patch live state with the most recent night so Home tiles reflect real data
  const ls=histDays.find(d=>d.sleep), ld=histDays[0];
  if(ld){ if(ld.hrvMs!=null && state.hrvMs==null) state.hrvMs=ld.hrvMs; if(ld.restHr!=null && state.restHr==null) state.restHr=ld.restHr; }
  if(['sleep','strain','trends','recovery','overview'].includes(curScreen)) showScreen(curScreen);
}
const latestDay   = ()=> histDays[0]||null;
const latestSleep = ()=> histDays.find(d=>d.sleep)||null;

/* ----------------------------- rings + renders ---------------------------- */
const RING_C = 2*Math.PI*88;
const recColor = (p)=> p>=67 ? 'var(--rec-green)' : p>=34 ? 'var(--rec-yellow)' : 'var(--rec-red)';
function setRing(id, pct, color){ const el=$(id); if(!el) return;
  pct=Math.max(0,Math.min(100,pct||0));
  el.style.strokeDasharray=RING_C; el.style.strokeDashoffset=RING_C*(1-pct/100);
  if(color) el.style.stroke=color; }

// Rich representative data so every screen + interactive graph is fully populated until real
// captures/decoding fill them in. Replaced by live/decoded values once available.
const STAGE={ awake:{c:'var(--st-awake)',nm:'Awake',lane:0}, rem:{c:'var(--st-rem)',nm:'REM',lane:1},
  light:{c:'var(--st-light)',nm:'Light',lane:2}, sws:{c:'var(--st-sws)',nm:'Deep (SWS)',lane:3} };
const ZONE_COL=['#ffffff','#adc2cd','#479ac2','#fcac5d','#fcac5d','#ff6422'];  // WHOOP strain_zone_0..5
const ZONE_NM=['Zone 0','Zone 1','Zone 2','Zone 3','Zone 4','Zone 5'];
const ZONE_DESC=['Restorative','Very light','Light','Moderate','Hard','Max'];
const ZONE_PCT=['50–60%','60–70%','70–80%','80–90%','90–100%','Max'];

let _s=12345; const rnd=()=>{ _s=(_s*1103515245+12345)&0x7fffffff; return _s/0x7fffffff; };
// 24h HR @ 5-min resolution (288 pts) with clock labels — drives the scrollable HR graph.
function genHR24(){
  const a=[]; _s=99;
  for(let i=0;i<288;i++){ const min=i*5, h=min/60;
    const hh=String(Math.floor(min/60)).padStart(2,'0'), mm=String(min%60).padStart(2,'0');
    let v;
    if(h<6.7)        v=50+Math.sin(h/6.7*Math.PI)*6 + (rnd()-0.5)*4;             // asleep
    else if(h<7.5)   v=58+(h-6.7)*18;                                           // waking
    else if(h>16.8&&h<18.1) v=120+58*Math.exp(-Math.pow(h-17.4,2)/0.05);        // workout spike
    else             v=70+Math.sin((h-7)/24*2*Math.PI)*10 + (rnd()-0.5)*9;      // daytime
    a.push({t:hh+':'+mm, v:Math.max(46,Math.round(v))});
  }
  return a;
}
function bars(seed,n,base,amp){ const a=[]; _s=seed; for(let i=0;i<n;i++) a.push({v:Math.max(8,Math.min(100,Math.round(base+amp*Math.sin(i/2.3)+(rnd()-0.5)*22))), t:'-'+(n-i-1)+'d'}); return a; }

const SAMPLE = {
  recovery:{ pct:64, vow:'HRV is in your normal range and resting heart rate is low — you’re recovered and primed for moderate-to-high strain today.',
    hrv:78, rhr:51, resp:14.2, spo2:96, skin:33.8,
    metrics:[
      {nm:'Heart rate variability', val:78,   unit:'ms',  lo:55,   hi:95,   today:78},
      {nm:'Resting heart rate',     val:51,   unit:'bpm', lo:47,   hi:58,   today:51},
      {nm:'Respiratory rate',       val:14.2, unit:'rpm', lo:13.4, hi:15.4, today:14.2},
      {nm:'Blood oxygen',           val:96,   unit:'%',   lo:95,   hi:99,   today:96},
      {nm:'Skin temperature',       val:33.8, unit:'°C', lo:33.1, hi:34.5, today:33.8} ],
    trend:[71,58,66,49,74,62,80,55,69,64,72,60,67,64].map((v,i)=>({v,t:'-'+(13-i)+'d'})) },
  strain:{ day:11.3, optLo:10.5, optHi:14.5, cal:2150, avg:78, max:152, maxHr:186,
    vow:'A moderate day. You’re tracking just under your optimal strain — a short session would top it off.',
    zones:[5400,4200,3000,2400,1200,360],
    workouts:[ {nm:'Running', t:'5:12 pm', dur:46*60, strain:9.8, cal:540, avg:148, max:175},
               {nm:'Walking', t:'8:30 am', dur:32*60, strain:3.1, cal:160, avg:96,  max:118} ] },
  sleep:{ perf:88, eff:92, consistency:74, respiratory:14.2, debtMin:62, inBedMin:455, disturbances:11,
    segs:[{s:'awake',m:8},{s:'light',m:55},{s:'rem',m:25},{s:'sws',m:40},{s:'light',m:35},
          {s:'sws',m:30},{s:'rem',m:30},{s:'light',m:45},{s:'awake',m:6},{s:'rem',m:35},
          {s:'light',m:40},{s:'sws',m:18},{s:'rem',m:25}],
    need:{ baseline:432, debt:62, strain:24, nap:-38 } },
  stress:{ now:1.4 },
  health:[
    {nm:'Heart rate',         key:'hr',   unit:' bpm', lo:48,  hi:160,  val:null, live:true},
    {nm:'HRV (rmssd)',        key:'hrv',  unit:' ms',  lo:55,  hi:95,   val:78},
    {nm:'Resting heart rate', key:'rhr',  unit:' bpm', lo:47,  hi:58,   val:51},
    {nm:'Respiratory rate',   key:'resp', unit:' rpm', lo:13.4,hi:15.4, val:14.2},
    {nm:'Blood oxygen',       key:'spo2', unit:'%',    lo:95,  hi:99,   val:96},
    {nm:'Skin temperature',   key:'skin', unit:'°C',lo:33.1,hi:34.5,val:33.8} ],
  trends:{
    '1W':{ rec:bars(1,7,64,18),  strain:bars(2,7,11,5),  sleep:bars(3,7,82,12) },
    '1M':{ rec:bars(4,30,62,20), strain:bars(5,30,11,6), sleep:bars(6,30,80,14) },
    '6M':{ rec:bars(7,26,63,16), strain:bars(8,26,12,5), sleep:bars(9,26,81,12) },
  },
};
SAMPLE.strain.hr24 = genHR24();
SAMPLE.strain.hr   = SAMPLE.strain.hr24.filter((_,i)=>i%12===0);    // hourly sparkline
SAMPLE.stress.day  = SAMPLE.strain.hr24.map(p=>({t:p.t, v:Math.max(0,Math.min(3,(p.v-52)/40))}));

/* ----------------------------- chart components --------------------------- */
// SVG presentation attributes don't resolve CSS var() on WebKit — map our theme vars to hex.
const CSSVAR={'var(--rec-green)':'#00f19f','var(--rec-yellow)':'#ffde00','var(--rec-red)':'#ff0026',
  'var(--sleep)':'#7ba1bb','var(--strain)':'#0093e7','var(--st-awake)':'#969696','var(--st-rem)':'#7ba1bb',
  'var(--st-light)':'#479ac2','var(--st-sws)':'#14384d'};
const cssColor=(c)=> CSSVAR[c]||c;
// Interactive, horizontally-scrollable line chart with a drag-to-read scrub readout.
// host: container el · series: [{t,v}] or [number] · opts: {color,h,fill,min,max,unit,fmt,ppP,bands}
let _chartId=0;
function interactiveChart(host, series, opts={}){
  if(!host) return;
  const o=Object.assign({color:'#3aa0ff',h:130,fill:true,min:null,max:null,unit:'',fmt:v=>Math.round(v),ppP:0,bands:null}, opts);
  o.color=cssColor(o.color);
  const pts=series.map((s,i)=> (typeof s==='number')?{t:'',v:s}:{t:s.t||'',v:s.v});
  const n=pts.length; if(!n){ host.innerHTML=''; return; }
  const vals=pts.map(p=>p.v);
  const mn=o.min!=null?o.min:Math.min(...vals), mx=o.max!=null?o.max:Math.max(...vals), rg=(mx-mn)||1;
  const cw=Math.max(240,(host.clientWidth||320));
  const innerW=o.ppP? Math.max(cw, Math.round(n*o.ppP)) : cw;
  const H=o.h, padT=16, padB=18, P=8;
  const X=i=> P + i*(innerW-2*P)/Math.max(1,n-1);
  const Y=v=> padT + (1-(v-mn)/rg)*(H-padT-padB);
  let line=''; pts.forEach((p,i)=>{ line+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(p.v).toFixed(1)+' '; });
  const area=`M${X(0).toFixed(1)} ${H-padB} `+pts.map((p,i)=>'L'+X(i).toFixed(1)+' '+Y(p.v).toFixed(1)).join(' ')+` L${X(n-1).toFixed(1)} ${H-padB} Z`;
  let bands=''; if(o.bands) for(const b of o.bands){ const y1=Y(b.hi),y2=Y(b.lo);
    bands+=`<rect x="0" y="${y1.toFixed(1)}" width="${innerW}" height="${Math.max(0,y2-y1).toFixed(1)}" fill="${b.c}" opacity="0.10"/>`; }
  let ticks=''; const step=Math.max(1,Math.round(n/6));
  for(let i=0;i<n;i+=step){ if(pts[i].t) ticks+=`<text x="${X(i).toFixed(1)}" y="${H-4}" fill="var(--dimmer)" font-size="9" text-anchor="middle">${pts[i].t}</text>`; }
  const id='ch'+(++_chartId);
  host.innerHTML=
    `<div class="ichart"><div class="ichart-scroll"><svg id="${id}" width="${innerW}" height="${H}" viewBox="0 0 ${innerW} ${H}" style="display:block;touch-action:pan-x">
      ${bands}${o.fill?`<path d="${area}" fill="${o.color}" opacity="0.14"/>`:''}
      <path d="${line}" fill="none" stroke="${o.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${ticks}<line class="scrub" x1="0" y1="${padT}" x2="0" y2="${H-padB}" stroke="#fff" stroke-width="1" opacity="0"/>
      <circle class="scrubdot" r="4" fill="#fff" stroke="${o.color}" stroke-width="2" opacity="0"/>
    </svg></div><div class="ichart-tip"></div></div>`;
  const svg=host.querySelector('svg'), scrub=svg.querySelector('.scrub'), dot=svg.querySelector('.scrubdot'),
        tip=host.querySelector('.ichart-tip'), scroller=host.querySelector('.ichart-scroll');
  const at=(clientX)=>{ const r=svg.getBoundingClientRect(); const sx=clientX-r.left;
    let i=Math.round((sx-P)/((innerW-2*P)/Math.max(1,n-1))); i=Math.max(0,Math.min(n-1,i));
    const x=X(i), y=Y(pts[i].v);
    scrub.setAttribute('x1',x); scrub.setAttribute('x2',x); scrub.setAttribute('opacity','0.45');
    dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.setAttribute('opacity','1');
    tip.innerHTML=`<b>${o.fmt(pts[i].v)}${o.unit}</b>${pts[i].t?`<span>${pts[i].t}</span>`:''}`; tip.style.opacity='1';
    const vis=x-scroller.scrollLeft, tw=tip.offsetWidth||56;
    tip.style.left=Math.max(2,Math.min(scroller.clientWidth-tw-2, vis-tw/2))+'px'; };
  const end=()=>{ scrub.setAttribute('opacity','0'); dot.setAttribute('opacity','0'); tip.style.opacity='0'; };
  svg.addEventListener('pointerdown',e=>at(e.clientX));
  svg.addEventListener('pointermove',e=>{ if(e.buttons||e.pressure>0) at(e.clientX); });
  svg.addEventListener('pointerup',end); svg.addEventListener('pointercancel',end); svg.addEventListener('pointerleave',end);
}
function hypnogram(segs){
  const tot=segs.reduce((a,s)=>a+s.m,0)||1, w=320,h=96,lh=h/4; let x=0,r='';
  for(const s of segs){ const sw=s.m/tot*w, L=STAGE[s.s].lane;
    r+=`<rect x="${x.toFixed(1)}" y="${(L*lh+3).toFixed(1)}" width="${Math.max(sw-1,1).toFixed(1)}" height="${(lh-6).toFixed(1)}" rx="2" fill="${cssColor(STAGE[s.s].c)}"/>`;
    x+=sw; }
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px">${r}</svg>`;
}
function metricRows(ms){
  return ms.map(m=>{
    const today=(m.today!=null?m.today:m.val);
    const span=(m.hi-m.lo)||1, pad=span*0.6, lo2=m.lo-pad, tr=(m.hi+pad)-lo2;
    const bandL=(m.lo-lo2)/tr*100, bandW=(m.hi-m.lo)/tr*100, mk=Math.max(2,Math.min(98,(today-lo2)/tr*100));
    const ok=today>=m.lo&&today<=m.hi, flag=ok?'var(--rec-green)':'var(--rec-yellow)';
    const shown=(m.val==null?'—':m.val);
    return `<div class="mrow"><div class="top"><span class="nm">${m.nm}<span class="flag" style="background:${flag}"></span></span>`+
      `<span class="vv">${shown}<small> ${m.unit}</small></span></div>`+
      `<div class="rng"><div class="band" style="left:${bandL}%;width:${bandW}%"></div><div class="mk" style="left:${mk}%;background:${flag}"></div></div>`+
      `<div class="sub"><span>typical ${m.lo}–${m.hi} ${m.unit}</span><span>vs 30-day</span></div></div>`;
  }).join('');
}
function zoneRows(zones,maxHr){
  const mx=Math.max(...zones)||1;
  return zones.map((s,i)=>`<div class="zrow"><span class="zlab" style="color:${ZONE_COL[i]}">${ZONE_NM[i]}</span>`+
    `<span class="zdesc">${ZONE_DESC[i]} · ${ZONE_PCT[i]}</span><span class="zb"><i style="width:${(s/mx*100).toFixed(0)}%;background:${ZONE_COL[i]}"></i></span>`+
    `<span class="zt">${fmtDur(s)}</span></div>`).join('');
}
function stressGauge(v){
  const pct=Math.max(2,Math.min(98, v/3*100)), lab=v<1?'Low':v<2?'Moderate':'High',
        col=v<1?'var(--rec-green)':v<2?'var(--rec-yellow)':'var(--rec-red)';
  return `<div class="gauge"><div class="gbar"><div class="gmk" style="left:${pct}%;border-color:${col}"></div></div>`+
    `<div class="gscale"><span>Low</span><span>Moderate</span><span>High</span></div>`+
    `<div class="gval">${v.toFixed(1)}<small> / 3</small> · <span style="color:${col}">${lab}</span></div></div>`;
}

/* ----------------------------- screen renders ----------------------------- */
const sleepTotals=(segs)=>{ const t={awake:0,light:0,rem:0,sws:0}; for(const x of segs) t[x.s]+=x.m; return t; };
function recState(p){ return p>=67?'Recovered':p>=34?'Adequate':'Low'; }

function renderOverview(){
  const S=SAMPLE; const t=sleepTotals(S.sleep.segs); const asleep=t.light+t.rem+t.sws;
  setRing('ov-arc', S.recovery.pct, recColor(S.recovery.pct)); setField('ov-rec', S.recovery.pct);
  setField('ov-rec-state', recState(S.recovery.pct));
  setHTML('ov-sleep', S.sleep.perf+'<small>%</small>'); setField('ov-sleep-sub', fmtMs(asleep)+' asleep');
  setField('ov-strain', S.strain.day.toFixed(1));
  setHTML('ov-hr',  (state.hr!=null?state.hr:'—')+'<small>bpm</small>');
  setHTML('ov-hrv', (state.hrvMs!=null?state.hrvMs:S.recovery.hrv)+'<small>ms</small>');
  interactiveChart($('ov-hrcurve'), S.strain.hr, {color:'#3aa0ff',h:90,unit:' bpm'});
  renderHealth(); renderStress();
}
function renderHealth(){
  const host=$('ov-health'); if(!host) return;
  const rows=SAMPLE.health.map(m=>{
    let v=m.val, real=false;
    if(m.key==='hr'){ v=state.hr; }
    else if(m.key==='hrv'&&state.hrvMs!=null){ v=state.hrvMs; }
    else if(m.key==='skin'&&state.skinTempC!=null){ v=+state.skinTempC.toFixed(1); real=true; }
    else if(m.key==='spo2'&&state.spo2!=null){ v=state.spo2; real=true; }
    const shown=(v==null?'—':v);
    const ok=v==null?true:(v>=m.lo&&v<=m.hi), flag=v==null?'var(--dimmer)':(ok?'var(--rec-green)':'var(--rec-yellow)');
    return `<div class="hrow"><span class="hk"><span class="flag" style="background:${flag}"></span>${m.nm}${m.live?' <i class="livedot"></i>':real?' <span class="soon" style="border-color:var(--rec-green);color:var(--rec-green)">band</span>':''}</span>`+
      `<span class="hv">${shown}<small>${m.unit}</small></span><span class="hr-rng">${m.lo}–${m.hi}</span></div>`;
  }).join('');
  host.innerHTML=rows;
}
function renderStress(){
  const host=$('ov-stress'); if(!host) return;
  let v=SAMPLE.stress.now;
  if(state.hr!=null){ const hrComp=Math.max(0,Math.min(3,(state.hr-52)/40));
    const hrvComp=state.hrvMs!=null?Math.max(0,Math.min(3,(70-state.hrvMs)/22)):hrComp;
    v=Math.round((hrComp*0.6+hrvComp*0.4)*10)/10; }
  host.innerHTML=stressGauge(v);
}
function renderRecovery(){
  const R=SAMPLE.recovery, c=recColor(R.pct);
  setField('rec-pct', R.pct); setRing('rec-arc', R.pct, c);
  setField('rec-state', recState(R.pct)); setField('rec-vow', R.vow);
  setHTML('rec-metrics', metricRows(R.metrics));
  interactiveChart($('rec-trend'), R.trend, {color:c,h:120,unit:'%',min:0,max:100});
  setField('rec-trend-avg', 'avg '+Math.round(R.trend.reduce((a,b)=>a+b.v,0)/R.trend.length)+'%');
}
// Flip a hand-coded screen's "preview · sample" badge to "your data" (green) once it's backed by the store.
function markPreview(sectionId, isSample){
  const sec=$(sectionId); if(!sec) return; const p=sec.querySelector('.preview'); if(!p) return;
  p.textContent = isSample ? 'preview · sample' : 'your data';
  p.style.color = isSample ? '' : 'var(--rec-green)';
  p.style.borderColor = isSample ? '' : 'var(--rec-green)';
}
// Adapt a stored day's sleep summary → the shape renderSleep expects.
function sleepFromStore(d){
  const sl=d.sleep;
  return { perf: sl.performance!=null?sl.performance:0, eff:null, consistency:null, respiratory:null,
    debtMin:0, inBedMin:sl.inBedMin, disturbances:sl.disturbances||0, segs:sl.segs||[],
    need:{ baseline:sl.needBaselineMin||480, debt:0, strain:Math.max(0,(sl.needMin||0)-(sl.needBaselineMin||480)), nap:0 } };
}
// Adapt a stored day → the shape renderStrain expects. Calories estimated from TRIMP load; workouts come from
// activity detection (not built yet) so the list stays empty until then.
function strainFromStore(d){
  const zs=d.zoneSeconds||[0,0,0,0,0,0];
  return { day:d.strain||0, optLo:Math.max(0,(d.strain||0)-2), optHi:(d.strain||0)+3,
    cal: d.strain?Math.round(d.strain*180):0, avg:d.avgHr||0, max:d.maxHr||0, maxHr:effMaxHr(),
    vow:`Your stored day: strain ${(d.strain||0).toFixed(1)}, average HR ${d.avgHr||'—'} bpm over ${d.spanH||0}h on-band.`,
    zones:zs, workouts:[], hr24:[], hr:[] };
}
function renderStrain(){
  const real=latestDay();
  if(real){ const S=strainFromStore(real); markPreview('s-strain', false); return renderStrainWith(S); }
  markPreview('s-strain', true); renderStrainWith(SAMPLE.strain);
}
function renderStrainWith(S){
  const live=state.strainAcc?state.strainAcc.strain:null;
  setField('str-val', S.day.toFixed(1));
  const mk=$('str-mk'); if(mk) mk.style.left=(S.day/21*100)+'%';
  const opt=$('str-opt'); if(opt){ opt.style.left=(S.optLo/21*100)+'%'; opt.style.width=((S.optHi-S.optLo)/21*100)+'%'; }
  setField('str-optlbl', `optimal ${S.optLo}–${S.optHi}`);
  setField('str-vow', S.vow);
  setField('str-hrnow', state.hr!=null?('live '+state.hr+' bpm'):(live!=null?('live strain '+live.toFixed(1)):'live —'));
  interactiveChart($('str-hrcurve'), S.hr24||[], {color:'#3aa0ff',h:140,unit:' bpm',ppP:5,
    bands:[{lo:0,hi:S.maxHr*0.6,c:ZONE_COL[0]},{lo:S.maxHr*0.9,hi:300,c:ZONE_COL[5]}]});
  setHTML('str-zones', zoneRows(S.zones, S.maxHr));
  setField('str-cal', S.cal); setField('str-avg', S.avg); setField('str-max', S.max);
  const wk=$('str-workouts');
  if(wk) wk.innerHTML=S.workouts.length? S.workouts.map(w=>`<div class="wk"><div class="wk-top"><span class="wk-nm">${w.nm}</span><span class="wk-str">${w.strain.toFixed(1)}</span></div>`+
    `<div class="wk-sub">${w.t} · ${fmtDur(w.dur)} · ${w.cal} cal · avg ${w.avg} · max ${w.max} bpm</div></div>`).join('')
    : '<div class="muted" style="font-size:12px">No tagged activities — automatic activity detection is coming. Your whole-day strain above is computed from the band.</div>';
}
function renderSleep(){
  const real=latestSleep();
  const S = real ? sleepFromStore(real) : SAMPLE.sleep;
  markPreview('s-sleep', !real);
  const t=sleepTotals(S.segs);
  const asleep=t.light+t.rem+t.sws, inbed=asleep+t.awake;
  setField('slp-pct', S.perf); setRing('slp-arc', S.perf, 'var(--sleep)');
  setField('slp-hours', fmtMs(asleep)+' asleep · '+fmtMs(inbed)+' in bed');
  setHTML('slp-hypno', hypnogram(S.segs));
  setHTML('slp-stages', ['rem','sws','light','awake'].map(k=>`<div class="stg"><span class="sw" style="background:${STAGE[k].c}"></span>`+
    `<span class="nm">${STAGE[k].nm}</span><span class="tm">${fmtMs(t[k])}</span><span class="pc">${Math.round(t[k]/inbed*100)}%</span></div>`).join(''));
  // sleep need breakdown
  const need=S.need, needTot=Math.max(1,need.baseline+need.debt+need.strain);
  const nb=$('slp-needbar');
  if(nb) nb.innerHTML=[['baseline',need.baseline,'var(--sleep)'],['sleep debt',need.debt,'#ff9f3a'],['recent strain',need.strain,'#3aa0ff']]
    .map(p=>`<i style="width:${(p[1]/needTot*100).toFixed(1)}%;background:${p[2]}" title="${p[0]}"></i>`).join('');
  setHTML('slp-needrows', [['Baseline need',need.baseline],['From sleep debt',need.debt],['From recent strain',need.strain],['Credited from naps',need.nap]]
    .map(p=>`<div class="metric"><span class="k">${p[0]}</span><span class="v">${p[1]<0?'−':''}${fmtMs(Math.abs(p[1]))}</span></div>`).join(''));
  const dayStrain = (latestDay()&&latestDay().strain) || SAMPLE.strain.day;
  setField('slp-need', fmtMs(sleepNeedMinutes({dayStrain})));
  setField('slp-debt', fmtMs(S.debtMin)); setField('slp-eff', S.eff!=null?S.eff+'%':'—');
  setField('slp-consistency', S.consistency!=null?S.consistency+'%':'—'); setField('slp-resp', S.respiratory!=null?S.respiratory.toFixed(1):'—');
  setField('slp-disturb', S.disturbances); setField('slp-inbed', fmtMs(S.inBedMin));
}
let trendPeriod='1W';
function renderTrends(){
  document.querySelectorAll('#trend-seg button').forEach(b=>b.classList.toggle('active', b.dataset.period===trendPeriod));
  const N={'1W':7,'1M':30,'6M':180}[trendPeriod]||7;
  const days=histDays.slice(0,N).reverse();                  // oldest→newest within the window
  const haveReal = days.length>=2;
  markPreview('s-trends', !haveReal);
  let rec, strain, sleep;
  if(haveReal){
    const lbl=(d)=>d.day.slice(5);
    rec=days.filter(d=>d.rec!=null).map(d=>({t:lbl(d),v:d.rec}));
    strain=days.map(d=>({t:lbl(d),v:+(d.strain||0)}));
    sleep=days.filter(d=>d.sleep&&d.sleep.performance!=null).map(d=>({t:lbl(d),v:d.sleep.performance}));
  } else { const s=SAMPLE.trends[trendPeriod]; rec=s.rec; strain=s.strain; sleep=s.sleep; }
  const avg=(a)=> a.length?Math.round(a.reduce((x,y)=>x+y.v,0)/a.length):null;
  const plot=(id,data,opts,avgId,fmt)=>{ const host=$(id);
    if(data&&data.length){ interactiveChart(host,data,opts); const a=avg(data); setField(avgId, a!=null?('avg '+(fmt?fmt(data):a)) : '—'); }
    else { if(host) host.innerHTML='<div class="muted" style="padding:18px 4px;font-size:12px">Not enough nights yet — pull a few days and this fills in.</div>'; setField(avgId,'—'); } };
  plot('tr-rec', rec, {color:recColor(avg(rec)||0),h:120,unit:'%',min:0,max:100}, 'tr-rec-avg', d=>avg(d)+'%');
  plot('tr-strain', strain, {color:'#3aa0ff',h:120,fmt:v=>v.toFixed(1),min:0,max:21}, 'tr-strain-avg', d=>(d.reduce((x,y)=>x+y.v,0)/d.length).toFixed(1));
  plot('tr-sleep', sleep, {color:'var(--sleep)',h:120,unit:'%',min:0,max:100}, 'tr-sleep-avg', d=>avg(d)+'%');
}

/* ===================== navigation: 5 tabs + push/back detail stack ========= */
// Bottom tabs mirror the WHOOP app (Home / Health / Coaching / Community / Profile). Pillar details
// (Recovery/Sleep/Strain/Trends) and every secondary screen are PUSHED onto a back-stack from tiles/menus.
let curTab='overview', curScreen='overview', navStack=[];
const HAND_RENDER={ overview:renderOverview, recovery:renderRecovery, strain:renderStrain, sleep:renderSleep, trends:renderTrends };
function renderScreen(name){ if(HAND_RENDER[name]) HAND_RENDER[name](); }
function renderAll(){ showScreen(curScreen); }
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('on', s.id==='s-'+id));
  const sec=SECTION_MAP[id];
  if(sec){ const host=$('s-'+id); if(host){ try{ host.innerHTML = sec.build(); }   // generated screen
      catch(e){ host.innerHTML = `<div class="card"><div class="err">screen “${id}” error: ${e.message}</div></div>`; } } }
  else renderScreen(id);                                                      // hand-coded screen
  if(id==='storage') renderStorage();                                         // async-fill the on-phone history
  window.scrollTo(0,0);
}
function goScreen(id){
  if(id===curScreen) return;
  navStack.push(curScreen); curScreen=id;
  document.body.classList.add('detail'); const bb=$('backbtn'); if(bb) bb.classList.add('on');
  showScreen(id);
}
function goBack(){
  curScreen = navStack.pop() || curTab;
  if(!navStack.length){ document.body.classList.remove('detail'); const bb=$('backbtn'); if(bb) bb.classList.remove('on'); }
  showScreen(curScreen);
}
function showTab(name){
  curTab=name; curScreen=name; navStack=[];
  document.body.classList.remove('detail'); const bb=$('backbtn'); if(bb) bb.classList.remove('on');
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
  showScreen(name);
}
// Live updates from the BLE feed — patch only the cheap fields on whatever screen is visible.
function updateLive(){
  setHTML('ov-hr',  (state.hr!=null?state.hr:'—')+'<small>bpm</small>');
  setHTML('ov-hrv', (state.hrvMs!=null?state.hrvMs:SAMPLE.recovery.hrv)+'<small>ms</small>');
  if(curScreen==='overview'){ renderHealth(); renderStress(); }
  else if(curScreen==='strain') setField('str-hrnow', state.hr!=null?('live '+state.hr+' bpm'):'live —');
  else if(SECTION_MAP[curScreen] && LIVE_SCREENS.has(curScreen)){ const h=$('s-'+curScreen); if(h) h.innerHTML=SECTION_MAP[curScreen].build(); }
}

/* ===================== interaction layer — WHOOP-faithful behaviours ========
   Reproduces the WHOOP app's interaction model (mapped from its nav graphs) in our own code:
   in-screen tab/period controls, the centre FAB fan-out, Stealth Mode, and real handlers for the
   buttons (Journal, Share, alarm, Stress session). All local + our-data; nothing copied. */
const lget = (k,d=null)=>{ try{ const v=localStorage.getItem('wc.'+k); return v==null?d:JSON.parse(v); }catch(e){ return d; } };
const lset = (k,v)=>{ try{ localStorage.setItem('wc.'+k, JSON.stringify(v)); }catch(e){} };
function toast(msg,cls='ok'){ log(msg,cls);
  let t=$('toast'); if(!t){ t=document.createElement('div'); t.id='toast'; document.body.appendChild(t); }
  t.textContent=msg; t.className='show'; clearTimeout(toast._t); toast._t=setTimeout(()=>t.className='',2200); }

// In-screen tab/segment state: STAB[screenId] = active key. tabBar() renders a segmented control; a
// [data-stab="screen:key"] click sets it and re-renders that screen.
const STAB = {};
const stab = (screen, def)=> STAB[screen] || def;
function tabBar(screen, tabs, def){ const cur=stab(screen,def);
  return `<div class="seg">${tabs.map(([k,l])=>`<button class="${k===cur?'active':''}" data-stab="${screen}:${k}">${l}</button>`).join('')}</div>`; }

// Stealth Mode — WHOOP hides all metrics; we blur value elements via a body class (persisted).
let stealthOn = lget('stealth', false);
function applyStealth(){ document.body.classList.toggle('stealth', !!stealthOn); }

// Centre FAB fan-out (WHOOP's middle button → Start Activity / Strength / Journal).
function toggleFab(force){ const s=$('fabsheet'); if(!s) return;
  const open = force!=null?force : !s.classList.contains('on'); s.classList.toggle('on', open);
  const b=$('fab'); if(b) b.classList.toggle('on', open); }

// One delegated handler for every [data-act] button — the real behaviours behind WHOOP's controls.
function doAction(act){
  switch(act){
    case 'fab': toggleFab(); break;
    case 'fab-activity': toggleFab(false); goScreen('activities'); break;
    case 'fab-strength': toggleFab(false); goScreen('strength'); break;
    case 'fab-journal':  toggleFab(false); goScreen('journal'); break;
    case 'stealth': stealthOn=!stealthOn; lset('stealth',stealthOn); applyStealth();
      toast(stealthOn?'Stealth Mode on — metrics hidden':'Stealth Mode off'); rerender(); break;
    case 'stress-session': STAB['stress']='session'; goScreen('stress'); startStressSession(); break;
    case 'share': shareMetric(); break;
    case 'alarm': setSmartAlarm(); break;
    case 'log-journal': logJournal(); break;
    case 'log-period': { const d=new Date().toISOString().slice(0,10); const j=lget('periods',[]); j.push(d); lset('periods',j);
      toast('Period logged for today'); break; }
    default: break;
  }
}
function rerender(){ const h=$('s-'+curScreen); if(SECTION_MAP[curScreen]&&h) h.innerHTML=SECTION_MAP[curScreen].build(); else renderScreen(curScreen); }

// Journal: toggle behaviours, persisted per day (WHOOP's daily behaviour survey).
function toggleBehaviour(name){ const day=new Date().toISOString().slice(0,10); const j=lget('journal',{}); j[day]=j[day]||{};
  j[day][name]=!j[day][name]; lset('journal',j); rerender(); }
function logJournal(){ toast('Journal saved'); goBack(); }

// Share — the iOS share sheet with a recovery/strain/sleep summary card (text).
async function shareMetric(){
  const txt=`WHOOP Core — Recovery ${SAMPLE.recovery.pct}% · Sleep ${SAMPLE.sleep.perf}% · Day Strain ${SAMPLE.strain.day.toFixed(1)}`;
  try{ if(navigator.share){ await navigator.share({ title:'WHOOP Core', text:txt }); return; } }catch(e){ if(e&&e.name==='AbortError') return; }
  try{ await navigator.clipboard.writeText(txt); toast('Copied to clipboard'); }catch(e){ toast('Share unavailable','err'); }
}

// Smart alarm — the band has real alarm commands (SET_ALARM_TIME=66 / RUN_ALARM=68). Store the time and,
// if connected, program the band (behind a confirm since it writes to the strap).
function setSmartAlarm(){
  const cur=lget('alarm','07:00');
  const t=window.prompt('Smart alarm — wake by (HH:MM, 24h). The band buzzes silently at this time.', cur);
  if(!t || !/^\d{1,2}:\d{2}$/.test(t)) return;
  lset('alarm',t); toast('Alarm set for '+t);
  if(deviceId && window.confirm(`Program the band to buzz at ${t}? (sends SET_ALARM_TIME to the strap)`)){
    const [h,m]=t.split(':').map(Number); send(66,[h&0xFF,m&0xFF],'set_alarm_time'); toast('Sent alarm '+t+' to band');
  }
  rerender();
}

// Stress Session — a guided 60 s reading using our live HRV/HR stress estimate (WHOOP's Stress Monitor session).
let _stressT=null, _stressEnd=0;
function startStressSession(){ _stressEnd=Date.now()+60000; clearInterval(_stressT);
  _stressT=setInterval(()=>{ if(Date.now()>=_stressEnd){ clearInterval(_stressT); _stressT=null; }
    if(curScreen==='stress') rerender(); }, 1000);
}

/* ===================== generated screens — every WHOOP section ==============
   A data-driven registry mirroring the WHOOP app's information architecture (mapped from the decompiled
   APK). Each entry.build() returns the screen HTML using our design system + our computed data where we
   have it, or a labelled scaffold ("our calibration goes here") where we don't yet. Navigation is by
   data-nav="<id>" (delegated click → goScreen). This is the canvas we fill with our own code. */
const hd   = (t, sub='')=>`<div class="hd"><div class="t">${t}</div>${sub?`<span class="muted">${sub}</span>`:''}</div>`;
const card = (inner, cls='')=>`<div class="card ${cls}">${inner}</div>`;
const cardNav = (id, inner)=>`<div class="card go" data-nav="${id}">${inner}</div>`;
const navRow = (id, ic, tt, sub='', right='<span class="nch">›</span>')=>
  `<div class="navrow" data-nav="${id}"><span class="nic">${ic}</span><span class="ntx"><div class="ntt">${tt}</div>${sub?`<div class="nsb">${sub}</div>`:''}</span>${right}</div>`;
const kvr  = (k,v)=>`<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const prog = (frac,c='var(--strain)')=>`<div class="prog"><i style="width:${Math.max(0,Math.min(1,frac))*100}%;background:${c}"></i></div>`;
const soonTag = '<span class="soon">our data soon</span>';
const scaffold = (txt)=>`<div class="muted" style="font-size:12px;line-height:1.55">${txt}</div>`;
const liveHr = ()=> state.hr!=null?state.hr:'—';
const liveHrv= ()=> state.hrvMs!=null?state.hrvMs:SAMPLE.recovery.hrv;

const SECTIONS = [
  // ----- TAB HUB: HEALTH (WHOOP Age / vitals / stress / screener) -----
  { id:'health', build:()=>
    hd('Health','WHOOP Age · vitals')
    + cardNav('healthspan', `<div class="hero"><div class="hv" style="color:var(--rec-green)">—<small style="font-size:20px"> yrs</small></div><div class="hl">WHOOP Age</div><div class="hs">Pace of aging · VO₂ max · steps — ${soonTag}</div></div>`)
    + cardNav('healthmonitor', hd('Health Monitor')+`<div class="kv"><span class="k">Heart rate <i class="livedot"></i></span><span class="v">${liveHr()}<small> bpm</small></span></div>`+kvr('HRV','<span class="v">'+liveHrv()+'<small> ms</small></span>')+kvr('Resting HR',SAMPLE.recovery.rhr+' bpm'))
    + cardNav('stress', hd('Stress Monitor','live')+`<div class="muted" style="font-size:13px">Day stress, sleep stress & live Stress Sessions — from HRV.</div>`)
    + cardNav('recovery', hd('Recovery')+`<div class="muted" style="font-size:13px">HRV, resting HR, respiratory rate, SpO₂, skin temp.</div>`)
    + card(navRow('storage','💾','Stored data','Nights kept on this phone · Day Strain'))
    + navRow('hormonal','❤','Hormonal Insights','Menstrual cycle · pregnancy')
    + card(navRow('advancedlabs','🧪','Advanced Labs','Blood biomarker results')+navRow('whooplabs','🔬','WHOOP Labs','Research studies')) },

  // ----- DETAIL: STORED DATA (on-phone IndexedDB history — Phase 2 substrate) -----
  // build() is synchronous but the data is async (IndexedDB), so it returns a skeleton and showScreen()
  // kicks renderStorage() to fill #storage-body once the day rows load.
  { id:'storage', build:()=>
    hd('Stored data','on this phone')
    + card(`<div class="muted" style="font-size:12px;line-height:1.55">Every history pull is kept here on the phone — bucketed by night, dedup-merged so re-pulling the same night updates rather than duplicates. This is the standalone (Phase 2) data store that feeds your scores without the cloud.</div>`)
    + `<div id="storage-body"><div class="card"><div class="muted">Loading…</div></div></div>` },

  // ----- TAB HUB: COACHING -----
  { id:'coaching', build:()=>
    hd('Coaching')
    + cardNav('coach', `<div class="hd"><div class="t">WHOOP Coach</div><span class="soon">AI · scaffold</span></div><div class="bub ai">Ask me about your recovery, sleep or strain. I’ll tailor advice to your data.</div>`)
    + cardNav('weeklyplan', hd('Weekly Plan')+`<div class="muted" style="font-size:13px;margin-bottom:8px">This week’s strain target & planned activities.</div>`+prog(0.45)+`<div class="muted" style="font-size:11px;margin-top:6px">9.1 of 20.0 weekly strain</div>`)
    + cardNav('sleepcoach', hd('Sleep Coach')+`<div class="muted" style="font-size:13px">Tonight’s recommended bedtime & wake to hit your sleep need.</div>`)
    + cardNav('insights', hd('AI Insights & Stories')+`<div class="muted" style="font-size:13px">Weekly & monthly performance recaps, behaviour correlations.</div>`)
    + cardNav('journal', hd('Journal')+`<div class="muted" style="font-size:13px">Log behaviours → see what moves your recovery.</div>`) },

  // ----- TAB HUB: COMMUNITY -----
  { id:'community', build:()=>
    hd('Community')
    + card(hd('Teams')+`<div class="muted" style="font-size:13px">Browse, create & manage teams. ${soonTag}</div>`)
    + cardNav('achievements', hd('Achievements')+`<div class="muted" style="font-size:13px">Badges, streaks & personal milestones.</div>`)
    + card(hd('Leaderboards')+`<div class="navlist">`
        +`<div class="navrow"><span class="nic">🏃</span><span class="ntx"><div class="ntt">Strain</div><div class="nsb">Weekly</div></span><span class="nval">—</span></div>`
        +`<div class="navrow"><span class="nic">☾</span><span class="ntx"><div class="ntt">Sleep</div><div class="nsb">Weekly</div></span><span class="nval">—</span></div>`
        +`<div class="navrow"><span class="nic">♥</span><span class="ntx"><div class="ntt">Recovery</div><div class="nsb">Weekly</div></span><span class="nval">—</span></div></div>`)
    + navRow('share','↗','Share','Shareable metric cards') },

  // ----- TAB HUB: PROFILE -----
  { id:'profile', build:()=>{
    const p=profile||{};
    return hd('Profile')
    + card(`<div style="display:flex;align-items:center;gap:14px"><div class="avatar">${(p.first||'W')[0]}</div><div><div style="font-size:18px;font-weight:700">${p.first||'WHOOP'} ${p.last||'Core'}</div><div class="muted">Age ${p.age||'—'} · ${p.sex==='f'?'Female':'Male'} · RHR ${p.restingHr||'—'}</div></div></div>`)
    + card(`<div class="navlist">`
        + navRow('healthspan','✦','Member Levels & WHOOP Age')
        + navRow('membership','◆','Membership & Billing')
        + navRow('prs','🏅','Personal Records')
        + navRow('achievements','🏆','Achievements & Streaks')
        + navRow('hormonal','❤','Hormonal Insights') + `</div>`)
    + card(`<div class="navlist">`
        + navRow('settings','⚙','Settings')
        + navRow('integrations','🔗','Integrations','Strava · Health Connect')
        + navRow('device','📟','Device & Battery')
        + navRow('setup','🧪','Calibration & data pull')
        + navRow('stealth','🌙','Stealth Mode') + `</div>`)
    + card(navRow('trends','📈','Trends','Recovery · Strain · Sleep over time')); } },

  // ----- DETAIL: WHOOP Age / Healthspan -----
  { id:'healthspan', build:()=>
    hd('WHOOP Age')
    + card(`<div class="hero"><div class="hv" style="color:var(--rec-green)">—</div><div class="hl">WHOOP Age (yrs)</div><div class="hs">Pace of aging — how fast you’re ageing vs calendar time</div></div>`)
    + card(hd('Contributors')+kvr('VO₂ Max','<span class="v">— <small>ml/kg/min</small></span>')+kvr('Steps','—')+kvr('Sleep','—')+kvr('Strain','—')+kvr('Resting HR',SAMPLE.recovery.rhr+' bpm')+kvr('Lean body mass','—'))
    + card(hd('Sub-metrics')+navRow('vo2max','🫁','VO₂ Max')+navRow('steps','👣','Steps'))
    + card(scaffold('<b>WHOOP Age</b> is WHOOP-cloud-computed from VO₂ max, steps, sleep, strain & vitals. We’ll compute a calibrated estimate from the band once these inputs are decoded (Phase 2). Scaffolded here, ready to fill.')) },

  { id:'vo2max', build:()=>hd('VO₂ Max')
    + card(`<div class="hero"><div class="hv" style="color:var(--strain)">—</div><div class="hl">ml / kg / min</div></div>`)
    + card(scaffold('Estimated from HR response to strain/steps. We’ll derive this from band HR + activity once calibrated.')) },

  { id:'steps', build:()=>hd('Steps')
    + card(`<div class="hero"><div class="hv">—</div><div class="hl">steps today</div></div>`+prog(0))
    + card(scaffold('Step count needs the raw <b>R21 IMU</b> stream (int16 6-axis, cmd 105) → a pedometer over accel. On the band-RE roadmap.')) },

  // ----- DETAIL: Health Monitor (live vitals + screener) -----
  { id:'healthmonitor', build:()=>
    hd('Health Monitor','live · band-derived')
    + card(SAMPLE.health.map(m=>{ let v=m.val, real=false;
        if(m.key==='hr') v=state.hr; else if(m.key==='hrv'&&state.hrvMs!=null) v=state.hrvMs;
        else if(m.key==='skin'&&state.skinTempC!=null){ v=+state.skinTempC.toFixed(1); real=true; }
        else if(m.key==='spo2'&&state.spo2!=null){ v=state.spo2; real=true; }
        const shown=(v==null?'—':v); const ok=v==null?true:(v>=m.lo&&v<=m.hi);
        return `<div class="hrow"><span class="hk"><span class="flag" style="background:${v==null?'var(--dimmer)':ok?'var(--rec-green)':'var(--rec-yellow)'}"></span>${m.nm}${m.live?' <i class="livedot"></i>':real?' <span class="soon" style="border-color:var(--rec-green);color:var(--rec-green)">band</span>':''}</span><span class="hv">${shown}<small>${m.unit}</small></span><span class="hr-rng">${m.lo}–${m.hi}</span></div>`; }).join(''))
    + card(hd('Heart Screener','ECG-style')+scaffold('Heart screener is a cloud “labrador” report. <b>Skin temperature and SpO₂ are now read straight off the band</b> (decoded from the (47) record — skin-temp @65, SpO₂ @74) and update after each history pull — no cloud needed.')) },

  // ----- DETAIL: Stress Monitor -----
  { id:'stress', build:()=>{
    let v=SAMPLE.stress.now;
    if(state.hr!=null){ const hrC=Math.max(0,Math.min(3,(state.hr-52)/40)); const hrvC=state.hrvMs!=null?Math.max(0,Math.min(3,(70-state.hrvMs)/22)):hrC; v=Math.round((hrC*0.6+hrvC*0.4)*10)/10; }
    const tab=stab('stress','home');
    const head=hd('Stress Monitor','live · 0–3')+tabBar('stress',[['home','Monitor'],['session','Session'],['edu','About']],'home');
    if(tab==='edu') return head + card(hd('What is Stress?')+scaffold('Stress is estimated continuously from your heart-rate variability and heart rate — higher HR + lower HRV ⇒ higher stress. A guided Session paces your breathing to bring it down. Calibratable to your baselines.'));
    if(tab==='session'){ const left=Math.max(0,Math.ceil((_stressEnd-Date.now())/1000)); const running=left>0;
      return head + card(`<div style="text-align:center;padding:6px"><div class="big" style="font-size:40px;color:var(--rec-green)">${running?left+'s':'Ready'}</div><div class="muted" style="letter-spacing:1px">${running?'BREATHE — IN 4s · OUT 6s':'60-second guided reading'}</div></div>`+stressGauge(v))
        + card(running?`<div class="muted" style="text-align:center">live stress ${v.toFixed(1)} / 3 — keep breathing slowly…</div>`:`<button class="act" style="width:100%" data-act="stress-session">Start a 60-second session</button>`); }
    return head
    + card(stressGauge(v))
    + card(hd('Today')+kvr('Day stress','—')+kvr('Sleep stress','—')+kvr('High / Medium / Low','— / — / —'))
    + card(`<button class="act" style="width:100%" data-act="stress-session">Start a Stress Session</button>`+scaffold('<div style="margin-top:8px">Live stress = our HRV/HR blend (calibratable). Day & sleep stress totals come once we accumulate sessions.</div>')); } },

  // ----- DETAIL: Journal -----
  { id:'journal', build:()=>{
    const day=new Date().toISOString().slice(0,10); const j=(lget('journal',{})[day])||{};
    const behaviours=['Alcohol','Caffeine late','Screen time in bed','Stressful day','Read in bed','Magnesium','Ate late','Shared bed','Sick / ill','Travel / jet lag'];
    return hd('Journal',`today · ${Object.values(j).filter(Boolean).length} logged`)
    + card(behaviours.map(b=>{ const on=!!j[b];
        return `<div class="hrow" data-beh="${b}" style="cursor:pointer"><span class="hk">${b}</span><span class="hv"><span class="soon" style="${on?'border-color:var(--rec-green);color:#06121f;background:var(--rec-green)':'border-color:var(--strain);color:var(--strain)'}">${on?'✓ yes':'log'}</span></span></div>`; }).join(''))
    + `<button class="act" style="width:100%" data-act="log-journal">Save journal</button>`
    + card(hd('Journal Insights')+scaffold('Logged across nights, we correlate each behaviour against your recovery delta — the same as WHOOP’s “behaviours that helped/hurt”.')); } },

  // ----- DETAIL: Weekly Plan -----
  { id:'weeklyplan', build:()=>
    hd('Weekly Plan')
    + card(hd('Weekly strain target')+`<div style="font-size:40px;font-weight:700;color:var(--strain)">9.1 <small style="font-size:16px;color:var(--dim)">/ 20.0</small></div>`+prog(0.455)+`<div class="muted" style="font-size:11px;margin-top:6px">on track · 4 days left</div>`)
    + card(hd('Planned activities')+['Mon — Run 40m','Wed — Strength','Fri — Run 30m','Sun — Long walk'].map(a=>`<div class="kv"><span class="k">${a.split(' — ')[0]}</span><span class="v" style="font-weight:500">${a.split(' — ')[1]}</span></div>`).join(''))
    + card(scaffold('Hub-and-spoke planner (strain target → contributors → activities/behaviours). Targets will come from our strain model + recovery trend.')) },

  // ----- DETAIL: Sleep Coach -----
  { id:'sleepcoach', build:()=>{
    const need=sleepNeedMinutes({dayStrain:SAMPLE.strain.day});
    return hd('Sleep Coach')
    + card(hd('Tonight’s plan')+kvr('Sleep need',fmtMs(need))+kvr('Recommended bedtime','—')+kvr('Wake target','—')+kvr('For',`${SAMPLE.sleep.perf}% performance`))
    + card(`<button class="act" style="width:100%" data-act="alarm">Set a smart alarm</button>`+scaffold('<div style="margin-top:8px">Bedtime/wake derive from our sleep-need model (calibrated) + your consistency. Haptic alarm needs the band alarm command (cmd 66/68).</div>')); } },

  // ----- DETAIL: WHOOP Coach (AI) -----
  { id:'coach', build:()=>
    hd('WHOOP Coach','AI')
    + card(`<div style="display:flex;flex-direction:column">
        <div class="bub ai">Morning! Your recovery calibration is dialling in. Ask me anything about today.</div>
        <div class="bub me">How should I train today?</div>
        <div class="bub ai">Once your recovery score is live from the band, I’ll base this on it. For now: moderate strain ≈ 10–14 looks right given last night’s sleep (${SAMPLE.sleep.perf}%).</div>
        <div class="chips"><span class="chip">Why this recovery?</span><span class="chip">Plan my week</span><span class="chip">Improve my sleep</span></div></div>`)
    + card(scaffold('Scaffold for an on-device coach. Could wire to a local model or the Claude API, grounded in our computed metrics — no WHOOP subscription needed.')) },

  // ----- DETAIL: AI Insights / Stories / Deep Dive -----
  { id:'insights', build:()=>
    hd('Insights & Stories')
    + card(hd('Weekly recap')+scaffold('A full-screen “story” recap of the week (recovery trend, best/worst night, strain). Built from our trends data.'))
    + card(hd('Deep Dive')+scaffold('Metric-correlation analysis — which behaviours/metrics moved your recovery. Needs journal + several days of data.'))
    + card(hd('Monthly performance assessment')+kvr('Avg recovery',Math.round(SAMPLE.recovery.trend.reduce((a,b)=>a+b.v,0)/SAMPLE.recovery.trend.length)+'%')+kvr('Avg day strain',SAMPLE.strain.day.toFixed(1))+kvr('Avg sleep',SAMPLE.sleep.perf+'%')) },

  // ----- DETAIL: Activities / Workouts -----
  { id:'activities', build:()=>
    hd('Activities','today')
    + card(SAMPLE.strain.workouts.map(w=>`<div class="wk"><div class="wk-top"><span class="wk-nm">${w.nm}</span><span class="wk-str">${w.strain.toFixed(1)}</span></div><div class="wk-sub">${w.t} · ${fmtDur(w.dur)} · ${w.cal} cal · avg ${w.avg} · max ${w.max} bpm</div></div>`).join(''))
    + card(`<button class="act" style="width:100%" data-nav="strength">Start an activity</button>`)
    + card(hd('Heart-rate zones · day')+zoneRows(SAMPLE.strain.zones, SAMPLE.strain.maxHr)) },

  // ----- DETAIL: Strength Trainer -----
  { id:'strength', build:()=>
    hd('Strength Trainer')
    + card(hd('Templates')+['Full body','Push','Pull','Legs','Upper'].map(t=>navRow('strength','🏋',t,'',`<span class="nch">›</span>`)).join(''))
    + card(hd('Filter by equipment')+`<div class="chips">${['Barbell','Dumbbell','Kettlebell','Cable','Bodyweight','Trap bar','Rings'].map(e=>`<span class="chip">${e}</span>`).join('')}</div>`)
    + card(scaffold('Sets/reps/weight per exercise → muscular load. We’d fold this into Strain. Movement detection needs the IMU stream.')) },

  // ----- DETAIL: Personal Records -----
  { id:'prs', build:()=>
    hd('Personal Records')
    + card(['Longest sleep','Highest day strain','Best recovery','Lowest resting HR','Highest HRV']
        .map(r=>`<div class="kv"><span class="k">${r}</span><span class="v">—</span></div>`).join(''))
    + card(scaffold('PRs computed from your history as it accumulates — longest sleep, peak strain, best recovery, lowest RHR, highest HRV.')) },

  // ----- DETAIL: Achievements -----
  { id:'achievements', build:()=>
    hd('Achievements')
    + card(hd('Streaks')+kvr('Current sleep-consistency streak','—')+kvr('All-time best','—')+kvr('Days worn','—'))
    + card(`<div class="statgrid">${['🏅','🔥','⭐','🌙','⚡','🏆'].map(e=>`<div><div class="v">${e}</div><div class="k">locked</div></div>`).join('')}</div>`)
    + card(scaffold('Badges & streaks unlock from your own logged history.')) },

  // ----- DETAIL: Hormonal Insights -----
  { id:'hormonal', build:()=>
    hd('Hormonal Insights')
    + card(hd('Menstrual Cycle')+kvr('Phase','— (follicular / ovulatory / luteal / menstrual)')+kvr('Cycle day','—')+`<button class="act" style="width:100%;margin-top:10px" data-act="log-period">Log period</button>`)
    + card(hd('Pregnancy')+kvr('Trimester','—')+kvr('Due date','—'))
    + card(scaffold('Cycle-phase & pregnancy-adjusted baselines. Driven by your logging + our recovery baselines; no cloud needed.')) },

  // ----- DETAIL: Advanced Labs (biomarkers) -----
  { id:'advancedlabs', build:()=>
    hd('Advanced Labs','blood biomarkers')
    + card(hd('Latest panel')+['Cholesterol','HbA1c','Vitamin D','Ferritin','Testosterone','Cortisol','CRP']
        .map(b=>`<div class="kv"><span class="k">${b}</span><span class="v">— <span class="soon">no result</span></span></div>`).join(''))
    + card(scaffold('WHOOP’s blood-biomarker add-on (cloud lab results + reference ranges). We can display imported results; there’s no band data here.')) },

  // ----- DETAIL: WHOOP Labs (studies) -----
  { id:'whooplabs', build:()=>
    hd('WHOOP Labs','research studies')
    + card(['Sleep & recovery study','HRV & training load','Resting HR trends'].map(s=>navRow('whooplabs','🔬',s,'open enrolment')).join(''))
    + card(scaffold('Research campaigns (protocol + enrolment). Informational — listed for completeness.')) },

  // ----- DETAIL: Membership -----
  { id:'membership', build:()=>
    hd('Membership')
    + card(`<div class="hd"><div class="t">WHOOP Core (standalone)</div>${pillTag('ACTIVE','var(--rec-green)')}</div><div class="muted" style="font-size:13px;margin-top:6px">This app’s goal: run your Recovery / Sleep / Strain from the band alone, so the paid WHOOP membership can be cancelled.</div>`)
    + card(hd('Plans')+navRow('membership','◆','One','Basic')+navRow('membership','◆','Peak','+ Health Monitor, Stress')+navRow('membership','◆','Life','+ Advanced Labs'))
    + card(scaffold('Mirrors WHOOP’s plan tiers (One/Peak/Life) for parity. Our build replaces the subscription, not sells one.')) },

  // ----- DETAIL: Settings -----
  { id:'settings', build:()=>
    hd('Settings')
    + card(`<div class="navlist">`+[['My Account','profile'],['Membership & Billing','membership'],['Profile Info','setup'],['Integrations','integrations'],['Stealth Mode','stealth'],['Advanced Labs','advancedlabs']].map(([t,id])=>navRow(id,'›',t)).join('')+`</div>`)
    + card(hd('Device')+`<div class="navlist">`+navRow('device','📟','Pair / battery / firmware')+navRow('setup','🧪','Erase, power-cycle, calibrate')+`</div>`)
    + card(hd('Toggles')+['Activity detection','HR broadcast','Raw data collection','Notifications'].map(t=>`<div class="hrow"><span class="hk">${t}</span><span class="hv"><span class="soon">off</span></span></div>`).join('')) },

  // ----- DETAIL: Stealth Mode -----
  { id:'stealth', build:()=>
    hd('Stealth Mode', stealthOn?'on':'off')
    + card(scaffold('Hide all metrics — the band keeps recording, scores are concealed (blurred) until you turn it off.'))
    + card(`<button class="act ${stealthOn?'live':''}" style="width:100%" data-act="stealth">${stealthOn?'Turn off Stealth Mode':'Turn on Stealth Mode'}</button>`) },

  // ----- DETAIL: Integrations -----
  { id:'integrations', build:()=>
    hd('Integrations')
    + card(`<div class="navlist">`
        + navRow('integrations','🟧','Strava','Sync activities')
        + navRow('integrations','🟩','Health Connect','HR · HRV · sleep · activity')
        + navRow('integrations','📂','Apple Health / Files','Export captures') + `</div>`)
    + card(scaffold('Push our computed metrics out (Strava, Android Health Connect, Files). The laptop drop-box is already a working export.')) },

  // ----- DETAIL: Share -----
  { id:'share', build:()=>
    hd('Share')
    + card(`<div style="text-align:center;padding:10px"><div style="font-size:46px;font-weight:700;color:var(--rec-green)">${SAMPLE.recovery.pct}%</div><div class="muted" style="letter-spacing:2px">RECOVERY</div></div>`)
    + card(`<div class="chips">${['Recovery','Sleep','Day Strain','HRV'].map(m=>`<span class="chip">${m}</span>`).join('')}</div>`+`<button class="act" style="width:100%;margin-top:12px" data-act="share">Share card</button>`) },

  // ----- DETAIL: Device (pairing / battery / firmware) -----
  { id:'device', build:()=>
    hd('Device')
    + card(`<div style="font-family:ui-monospace,monospace;font-size:13px"><span id="dot2" class="dot ${deviceId?'on':''}"></span>${deviceId?'connected':'not connected'}</div>`
        + `<div class="row" style="margin-top:8px;gap:14px;font-size:12px;color:var(--dim)"><span>model <b style="color:#fff">${$('model')?.textContent||'—'}</b></span><span>fw <b style="color:#fff">${$('fw')?.textContent||'—'}</b></span><span>batt <b style="color:#fff">${$('batt')?.textContent||'—'}</b></span></div>`)
    + card(hd('Sync & data')+navRow('setup','🧪','Calibration & history pull','Pull last night, send to laptop'))
    + card(scaffold('Pairing, battery, last-sync time and firmware live on the band (cmds confirmed from the APK). The Calibration screen has the working pull + device controls.')) },
];
const SECTION_MAP = Object.fromEntries(SECTIONS.map(s=>[s.id,s]));
const LIVE_SCREENS = new Set(['health','healthmonitor','stress']);   // rebuilt on each live HR tick
function pillTag(txt,c){ return `<span class="pill" style="background:${c}">${txt}</span>`; }
function buildSections(){ const host=$('genscreens'); if(!host) return;
  host.innerHTML = SECTIONS.map(s=>`<section class="screen" id="s-${s.id}"></section>`).join(''); }

/* ----------------------------- live HR feed ------------------------------- */
function onHR(dv){
  const hr=parseHeartRate(dv);
  if(!(hr>0)) return;
  const now=Date.now(); const dt=lastHrTs?(now-lastHrTs)/1000:1; lastHrTs=now;
  state.hr=hr; state.hrCount++; state.hrSum+=hr;
  state.restHr = state.restHr==null? hr : Math.min(state.restHr, hr);
  if(state.strainAcc && dt>0 && dt<15) state.strainAcc.add(hr, dt);
  state.hrvMs = rmssd();
  updateLive();
}

/* ===================== DEV / SETUP (remove after extraction) =====================
   Connection, device info, raw-frame capture/dump, and the custom-command sender used
   to pull data off the band for decoding. To retire: delete this block, the Setup
   <section> + tab button in index.html, and the profile bit graduates to Settings.   */
function logEl(){ return $('log'); }
function log(msg, cls='dim'){ const el=logEl(); if(!el) return; const d=document.createElement('div');
  d.className='ln '+cls; d.textContent='['+new Date().toLocaleTimeString()+'] '+msg;
  el.appendChild(d); while(el.childElementCount>400) el.removeChild(el.firstChild); el.scrollTop=el.scrollHeight; }
function logFrame(dir, info){
  if(info.error){ log(`${dir} ${info.rawHex} ⟶ ${info.error}`,'err'); return; }
  const ok=(info.headOk && info.payOk!==false)?'✓':'⚠';
  log(`${dir} ${info.name} seq=${info.sequence} code=${info.code} [h:${info.headOk?'ok':'BAD'} p:${info.payOk===null?'-':info.payOk?'ok':'BAD'}] ${ok}`, info.packetType===48?'evt':'rx');
  log(`     payload=${info.payloadHex}`,'dim');
}
function setStatus(t, on){ setField('status', t); const d=$('dot'); if(d) d.classList.toggle('on', !!on); }

const rt = { counts:{} };
let capturing=false; const capture=[]; const CAP_MAX=100000, CAP_TRIM=10000;  // ring buffer for file export
let _rtT=null;
function renderRt(){ if(_rtT) return; _rtT=setTimeout(()=>{ _rtT=null; const el=$('rt'); if(!el) return;  // throttle DOM updates
  const rows=Object.keys(rt.counts).sort().map(k=>`${k}:${rt.counts[k]}`);
  el.textContent = rows.length ? rows.join('   ') : 'none yet'; }, 250); }
function onFrame(label, dv){
  const info=parseFrame(dv);
  if(!pulling || info.error) logFrame('RX['+label+']', info);   // per-frame logging floods the DOM during a bulk pull — suppress it then
  if(!info.error){ const k=info.name; rt.counts[k]=(rt.counts[k]||0)+1; renderRt(); }
  // REALTIME_DATA(40) decoded from real captures: [8]=HR bpm, [9]=RR-present flag,
  // [10..12)=RR interval ms (verified: mean HR byte ≈ 60000/mean RR).
  if(!pulling && info.packetType===40 && info.payloadBytes && info.payloadBytes.length>=12){
    const p=info.payloadBytes, hr=p[8], rr=(p[9]===1)?(p[10]|(p[11]<<8)):0;
    if(hr>0) state.hr=hr;
    if(rr>0){ pushRR(rr); state.hrvMs=rmssd(); }
    if(hr>0||rr>0) updateLive();
    log(`  → HR ${hr} bpm${rr?('  RR '+rr+' ms'):''}`, 'ok');
  }
  // Buffered records arrive as HISTORICAL_DATA(47) on 4.0, but as EVENT(48) on 5.0 — capture both.
  if(pulling && (info.packetType===47||info.packetType===48) && info.payloadBytes) onPullRecord(info.payloadBytes);
  if(pulling && info.packetType===49 && info.payloadBytes) onHistMeta(info.payloadBytes);  // METADATA: HISTORY_END trim / COMPLETE
  if(info.packetType===36 && info.code===0x22 && info.payloadBytes){     // get_data_range response
    dataRangeRaw = info.payloadBytes;                                    // keep raw for pointer analysis
    const ts=parseDataRangeOldest(info.payloadBytes); if(ts) dataRangeOldestTs=ts;
  }
  if(capturing){ capture.push({t:Date.now(), ch:label, hex:info.rawHex});
    if(capture.length>CAP_MAX+CAP_TRIM) capture.splice(0, CAP_TRIM); }   // trim in chunks, not shift-per-frame (O(n²))
}
const captureText = ()=> capture.map(c=>`${new Date(c.t).toISOString()}\t${c.ch}\t${c.hex}`).join('\n');

// Pull the band-resident vitals out of the rich (47) records of a pull → state (median over the pull).
// skin temp = every record; SpO2 = only the sleep records that sampled it. These are real Recovery inputs.
function updateBandVitals(recs){
  const temps=recs.filter(r=>r.skinTempC!=null).map(r=>r.skinTempC);
  const spo2s=recs.filter(r=>r.spo2!=null).map(r=>r.spo2);
  if(temps.length) state.skinTempC=median(temps);
  if(spo2s.length) state.spo2=median(spo2s);
  if(temps.length||spo2s.length)
    log(`band vitals from this pull: ${temps.length?('skin '+state.skinTempC.toFixed(1)+'°C'):''}${spo2s.length?('  ·  SpO₂ '+state.spo2+'% ('+spo2s.length+' readings)'):''}`,'ok');
}

// On-device readout after a pull — records / window / HR / a plain verdict, so a short or empty night is
// obvious before you walk away (no laptop round-trip needed). Fed the same numbers drainHistory computes.
function showPullPreview({ nd, minTs, maxTs, hrs, hv }){
  const card=$('pvcard'); if(!card) return;
  card.style.display='block';
  setField('pv-dur', nd ? hrs : '—');
  setField('pv-records', nd ? `${nd}` : 'none');
  setField('pv-span', nd ? `${new Date(minTs*1000).toLocaleString()} → ${new Date(maxTs*1000).toLocaleTimeString()}` : '—');
  setField('pv-hr', (hv&&hv.length) ? `${Math.min(...hv)}–${Math.max(...hv)} bpm · avg ${Math.round(hv.reduce((a,c)=>a+c,0)/hv.length)}` : 'no HR decoded');
  const durH = nd ? (maxTs-minTs)/3600 : 0;
  const v=$('pv-verdict'); if(!v) return;
  if(durH>=5){ v.className='ln ok';  v.textContent=`✅ Looks like a full night (${hrs}). Save / send it, then note WHOOP's sleep numbers for this date.`; }
  else if(durH>=1){ v.className='ln cmd'; v.textContent=`⚠️ Partial capture (${hrs}) — good for strain, light for sleep. You can still save it.`; }
  else if(nd){ v.className='ln dim'; v.textContent=`ℹ️ Very short (${hrs}). Wear it a full night and re-pull.`; }
  else { v.className='ln err'; v.textContent='No records pulled — check the seek landed on the night, then try again.'; }
}
// ⭐ Phase-2 persistence: keep a copy of every pull ON THE PHONE (IndexedDB via src/store.js). Bucketed +
// dedup-merged by local day, so re-pulling a night updates rather than duplicates. Never lets a storage hiccup
// break the pull. Refreshes the History screen if it's open.
async function persistPull(dump){
  if(!dump || !dump.length) return;
  try{
    const saved = await store.ingest(dump, profile);
    if(saved.length){
      const d = saved[0];
      log(`💾 Stored on phone: ${saved.map(s=>s.day).join(', ')} — ${d.n} records, Day Strain ${d.strain}${d.sleep?`, sleep ${d.sleep.asleepMin}m`:''}. View under Health → Stored data.`,'ok');
      await refreshHist();                                    // refresh the real-data screens (Sleep/Strain/Trends)
      if(curScreen==='storage') renderStorage();
    }
  }catch(e){ log('on-phone store failed (pull still fine): '+e.message,'err'); }
}
// Render the on-phone history (async — IndexedDB). Called by showScreen when the 'storage' screen opens and
// by persistPull after a new night lands. Lists each stored night with its summary + Day Strain, plus
// per-night delete and a clear-all. Pure read of src/store.js; all our own data.
// Sleep block for a stored night: the standalone auto-detected window + classified stages (no WHOOP cloud).
function sleepBlock(sl){
  if(!sl) return '';
  const hm=(m)=> m!=null? `${Math.floor(m/60)}h ${String(Math.round(m%60)).padStart(2,'0')}m` : '—';
  const t=(ms)=> new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const bar=(c,m)=>{ const tot=(sl.remMin||0)+(sl.swsMin||0)+(sl.lightMin||0)+(sl.awakeMin||0)||1;
    return `<i style="width:${Math.round((m||0)/tot*100)}%;background:${c}"></i>`; };
  return `<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--line)">`
    +`<div class="kv"><span class="k">Sleep <span class="soon" style="margin-left:4px">on-device</span></span><span class="v">${hm(sl.asleepMin)} asleep${sl.performance!=null?` · ${sl.performance}%`:''}</span></div>`
    +`<div class="prog" style="display:flex;height:8px;margin:6px 0">${bar('var(--st-rem)',sl.remMin)}${bar('var(--st-light)',sl.lightMin)}${bar('var(--st-sws)',sl.swsMin)}${bar('var(--st-awake)',sl.awakeMin)}</div>`
    +`<div class="kv"><span class="k">REM / Deep / Light / Awake</span><span class="v">${sl.remMin} / ${sl.swsMin} / ${sl.lightMin} / ${sl.awakeMin} m</span></div>`
    +`<div class="kv"><span class="k">Window</span><span class="v">${t(sl.start)}–${t(sl.end)} (${hm(sl.inBedMin)})</span></div>`
    +`</div>`;
}
// Export the whole on-phone store as one compact JSON (per-day summaries + 30-s epochs) — the file to share
// for off-device calibration. Accumulates across all pulls, so a week captured over several pulls exports as
// a single file. Tries the iOS share sheet (AirDrop / Save to Files / Messages), falls back to a download.
async function exportStore(){
  let data; try{ data = await store.exportAll(); }catch(e){ log('export failed: '+e.message,'err'); return; }
  if(!data.days.length){ log('nothing stored yet to export','err'); return; }
  const json=JSON.stringify(data), kb=(json.length/1024).toFixed(0);
  const fname=`wios-export-${new Date().toISOString().slice(0,10)}.json`;
  try{
    const file=new File([json], fname, {type:'application/json'});
    if(navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))){
      await navigator.share({files:[file], title:fname});
      log(`✓ exported ${data.days.length} day(s) · ${kb} KB via share sheet`,'ok'); return; }
  }catch(e){ if(e&&e.name==='AbortError'){ log('export cancelled','dim'); return; } }
  try{ const url=URL.createObjectURL(new Blob([json],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url; a.download=fname; a.click(); setTimeout(()=>URL.revokeObjectURL(url),4000);
    log(`✓ exported ${data.days.length} day(s) · ${kb} KB (saved file)`,'ok'); }
  catch(e){ log('export failed: '+e.message,'err'); }
}
async function renderStorage(){
  const body=$('storage-body'); if(!body) return;
  let days, use;
  try{ days=await store.listDays(); use=await store.usage(); }
  catch(e){ body.innerHTML=`<div class="card"><div class="err">store error: ${e.message}</div></div>`; return; }
  if(!days.length){ body.innerHTML=`<div class="card"><div class="muted">No nights stored yet. Pull a night (Setup → “Pull last night → laptop”) and it’s saved here automatically.</div></div>`; return; }
  const fmtDay=(k)=>{ const [y,m,d]=k.split('-'); return new Date(+y,+m-1,+d).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}); };
  const mb=(b)=> b? (b/1048576).toFixed(1)+' MB':'—';
  const totalRecords=days.reduce((a,d)=>a+(d.n||0),0);
  const dimBtn='width:100%;opacity:.6;border-color:var(--line);color:var(--dim)';
  let html=`<div class="card"><div class="kv"><span class="k">Nights stored</span><span class="v">${days.length}</span></div>`
    +`<div class="kv"><span class="k">Total records</span><span class="v">${totalRecords.toLocaleString()}</span></div>`
    +`<div class="kv"><span class="k">Storage used</span><span class="v">${mb(use.usedBytes)}</span></div></div>`;
  for(const d of days){
    html+=`<div class="card">`
      +`<div class="hd"><div class="t">${fmtDay(d.day)}</div><span class="preview">${d.spanH||0}h · ${(d.n||0).toLocaleString()} rec</span></div>`
      +`<div class="kv"><span class="k">Day Strain</span><span class="v" style="color:var(--strain)">${d.strain??'—'}</span></div>`
      +`<div class="kv"><span class="k">Avg / resting HR</span><span class="v">${d.avgHr??'—'} / ${d.restHr??'—'} bpm</span></div>`
      +`<div class="kv"><span class="k">HRV (RMSSD)</span><span class="v">${d.hrvMs??'—'} ms</span></div>`
      +`<div class="kv"><span class="k">Skin temp / SpO₂</span><span class="v">${d.skinTempC!=null?d.skinTempC+'°C':'—'} / ${d.spo2!=null?d.spo2+'%':'—'}</span></div>`
      +`<div class="kv"><span class="k">Movement index</span><span class="v">${d.activity??'—'}${d.activeMin!=null?` · ~${d.activeMin}m active`:''}</span></div>`
      +sleepBlock(d.sleep)
      +`<button class="act" data-del="${d.day}" style="${dimBtn};margin-top:8px">Delete this night</button>`
      +`</div>`;
  }
  html+=`<button class="act" id="storage-export" style="width:100%;margin-top:6px">Export all → share for calibration</button>`;
  html+=`<button class="act" id="storage-clear" style="${dimBtn};margin-top:6px">Clear all stored data</button>`;
  body.innerHTML=html;
  { const ex=$('storage-export'); if(ex) ex.onclick=exportStore; }
  body.querySelectorAll('[data-del]').forEach(b=> b.onclick=async()=>{ if(window.confirm(`Delete stored data for ${b.dataset.del}?`)){ await store.removeDay(b.dataset.del); renderStorage(); } });
  const cl=$('storage-clear'); if(cl) cl.onclick=async()=>{ if(window.confirm('Delete ALL stored data on this phone? This cannot be undone.')){ await store.clearAll(); renderStorage(); } };
}
function dumpCapture(){
  const text=captureText();
  const ta=$('dump'); ta.value=text||'(nothing captured)'; ta.style.display='block'; ta.focus(); ta.select();
  navigator.clipboard?.writeText(text).then(
    ()=>log('copied to clipboard ('+capture.length+' frames) — paste it to Claude','ok'),
    ()=>log('shown below — select all & copy ('+capture.length+' frames)','dim'));
}
// Save the whole capture as a .txt file via the iOS share sheet ("Save to Files" / AirDrop),
// so large overnight pulls bypass the clipboard's size limit. Falls back to a blob download.
async function downloadCapture(){
  const text=captureText();
  if(!text){ log('nothing captured yet — connect and capture first','err'); return; }
  const fname=`whoop-capture-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.txt`;
  try{
    const file=new File([text], fname, { type:'text/plain' });
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      await navigator.share({ files:[file], title:fname });
      log(`shared ${capture.length} frames as ${fname} — choose “Save to Files”, then upload it to Claude`,'ok');
      return;
    }
  }catch(e){ if(e && e.name==='AbortError'){ log('save cancelled','dim'); return; } }  // else fall through to blob
  try{
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain'}));
    const a=document.createElement('a'); a.href=url; a.download=fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    log(`saved ${fname} (${capture.length} frames) — find it in Files, then upload to Claude`,'ok');
  }catch(e){ log('save failed: '+e.message,'err'); }
}
// Drop-box: POST the capture straight to the laptop helper (tools/whoop-dropbox.py) over LAN.
// CapacitorHttp (enabled in capacitor.config.json) routes this natively, bypassing the
// webview's CORS / mixed-content gate; Info.plist NSAllowsLocalNetworking permits cleartext LAN.
const LKEY='whoopcore.laphost';
function loadLapHost(){ try{ return localStorage.getItem(LKEY)||'192.168.0.196:8787'; }catch(e){ return '192.168.0.196:8787'; } }
async function sendToLaptop(){
  const host=(($('laphost')&&$('laphost').value)||'').trim();
  if(!/^[\w.\-]+:\d{2,5}$/.test(host)){ log('enter laptop as IP:port, e.g. 192.168.0.196:8787','err'); return; }
  try{ localStorage.setItem(LKEY, host); }catch(e){}
  const text=captureText();
  if(!text){ log('nothing captured yet — connect and capture first','err'); return; }
  const url=`http://${host}/capture`;
  log(`sending ${capture.length} frames → ${url} …`,'cmd');
  const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(), 8000);
  try{
    const res=await fetch(url,{ method:'POST', headers:{'Content-Type':'text/plain'}, body:text, signal:ctrl.signal });
    clearTimeout(to);
    if(res.ok){ const t=await res.text().catch(()=>''); log(`✓ sent to laptop (${capture.length} frames). ${t}`.trim(),'ok'); }
    else log(`laptop responded ${res.status} — is the drop-box running on ${host}?`,'err');
  }catch(e){ clearTimeout(to);
    log(`send failed: ${e.name==='AbortError'?'timed out':e.message}. If iOS just asked to allow local network access, tap Allow then Send again. Otherwise check the drop-box is running and the IP:port matches.`,'err');
  }
}
function parseHexData(s){ s=(s||'').trim(); if(!s) return [];
  return s.split(/[\s,]+/).filter(Boolean).map(x=>parseInt(x,16)&0xFF); }
const CRITICAL_COMMANDS = { 36:'start_firmware_load',37:'load_firmware_data',38:'process_firmware_image',
  39:'set_led_drive',41:'set_tia_gain',43:'set_bias_offset' };
function enableDev(on){
  for(const id of ['dailysync','hello','battery','range','rthr','synchist','fullsync','bandcheck','forcetrim','showoldest','imurt','imuraw','imuprobe','hifreq','gattbtn','disconnect','csend']){ const el=$(id); if(el) el.disabled=!on; }
  const c=$('connect'); if(c) c.disabled=on;
}
// cmd 3 = toggle_realtime_hr: data [01] starts the REALTIME_DATA(40) stream, [00] stops it.
let rtHrOn=false;
async function toggleRealtimeHr(){
  rtHrOn=!rtHrOn;
  await send(3,[rtHrOn?0x01:0x00], rtHrOn?'toggle_realtime_hr ON':'toggle_realtime_hr OFF');
  const b=$('rthr'); if(b){ b.textContent='Realtime HR: '+(rtHrOn?'on':'off'); b.classList.toggle('live',rtHrOn); }
}
// Historical sync — WHOOP's documented dump protocol (clean-room; per community RE + our 5.0 captures).
// send_historical_data(22) makes the band stream batches of HISTORICAL_DATA(47), each framed by a
// METADATA(49) HISTORY_START(1) … HISTORY_END(2). We acknowledge a batch with
// historical_data_result(23) = [01][u32le trim][u32le 0], where `trim` is the flash-record index from
// that batch's HISTORY_END. The band frees those records, advances its read cursor, and sends the next
// batch — looping until METADATA(49) HISTORY_COMPLETE(3). NON-DESTRUCTIVE: the ack moves a cursor, not a
// delete; the official WHOOP app re-reads by rewinding its own. (cmd 33/set_read_pointer is NOT part of
// this protocol — earlier pointer guesses were a red herring; the real bug was acking with trim=0.)
const META_HISTORY_START=1, META_HISTORY_END=2, META_HISTORY_COMPLETE=3;

// Quick sync (read-only): stream just the first window, never ack — nothing changes on the band.
async function syncHistory(){
  if(!deviceId){ log('connect first','err'); return; }
  if(pulling){ pulling=false; await send(20,[],'abort_historical_transmits');
    const b=$('synchist'); if(b){ b.textContent='Quick sync (read-only)'; b.classList.remove('live'); }
    log(`quick sync stopped — ${pullRecords.length} HISTORICAL record(s) captured (read-only, nothing acked). Save file / Send to laptop.`,'ok'); return; }
  pulling=true; drain=null; pullRecords.length=0; pullSeen.clear();
  if(!capturing){ capturing=true; const c=$('capture'); if(c){ c.textContent='Stop capture'; c.classList.add('live'); } log('capture auto-started','ok'); }
  const b=$('synchist'); if(b){ b.textContent='Stop sync'; b.classList.add('live'); }
  log('QUICK SYNC — read-only: streaming the first window, NOT acknowledging, so nothing changes on the band.','ok');
  log('→ get_data_range','cmd'); await send(34,[],'get_data_range'); await delay(1200);
  log('→ send_historical_data (streaming…)','cmd'); await send(22,[0x00],'send_historical_data');
  log('leave ~20–30s, then tap again to stop and Save file.','ok');
}

/* --- Historical pull plumbing (shared by quick sync + full drain) -------------------
   HISTORICAL_DATA(47) layout (verified on 5.0): [3..6]=record idx u32 LE, [7..10]=unix ts u32 LE,
   [14]=HR. We collect records; the drain advances one batch per ack, keyed off HISTORY_END.        */
const delay = (ms)=> new Promise(r=>setTimeout(r,ms));
const BURST_MAX_MS = 9000;   // safety cap: max wait for a batch's HISTORY_END before giving up on it
const u32le = (n)=> [n&0xFF,(n>>>8)&0xFF,(n>>>16)&0xFF,(n>>>24)&0xFF];
let pulling=false; let autoExport=false; let skipDrainConfirm=false; const pullRecords=[]; const pullSeen=new Set();
const u32at = (p,o)=> (p[o]|(p[o+1]<<8)|(p[o+2]<<16)|(p[o+3]<<24))>>>0;
function onPullRecord(p){
  if(p.length<11) return;
  let idx, ts, hr, key, skinTempC=null, spo2=null, acc=null, rr=null, respRate=null;
  if(p[0]===48){                                   // 5.0 EVENT(48) record: ts@4, counter@8, HR offset TBD
    ts=u32at(p,4);
    if(ts<1500000000||ts>4000000000) return;       // skip untimestamped boot/info events
    idx=u32at(p,8); hr=0; key='e'+ts+':'+p[2];      // dedup by timestamp+subcode (counter isn't a clean idx)
  }else{                                            // 4.0 HISTORICAL_DATA(47): idx@3, ts@7, HR@14
    idx=u32at(p,3); ts=u32at(p,7); hr=p.length>14?p[14]:0; key='h'+idx;
    if(p.length>=75){                               // rich (47) R10 record — see decodeHistorical for the map
      const t=(p[65]|(p[66]<<8))<<16>>16; if(t>2000&&t<4500) skinTempC=t/100;  // skin temp @65 int16/100
      const s=p[74]; if(s>=80&&s<=100) spo2=s;                                  // SpO2 @74
      const r=p[72]; if(r>=5&&r<=30) respRate=r;                               // resp rate @72 (tentative)
    }
    if(p.length>=49){                               // RAW accel triplet f32 LE @37/41/45 (the actigraphy/step signal)
      const f32=(o)=> new DataView(new Uint8Array([p[o],p[o+1],p[o+2],p[o+3]]).buffer).getFloat32(0,true);
      const x=f32(37), y=f32(41), z=f32(45), m=Math.sqrt(x*x+y*y+z*z);
      if(m>0.1&&m<6&&[x,y,z].every(Number.isFinite)) acc={x,y,z};   // store the vector → |Δ| actigraphy in the store
    }
    const nrr=p[15];                                // RR (tentative): count@15 then u16 LE ms @16…
    if(nrr>0&&nrr<=4&&p.length>=16+2*nrr){ const v=p[16]|(p[17]<<8); if(v>250&&v<2500) rr=v; }
  }
  if(!pullSeen.has(key)){ pullSeen.add(key); pullRecords.push({idx,ts,hr,src:p[0],skinTempC,spo2,acc,rr,respRate}); }
}
const median = (a)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
const pullMax   = ()=> pullRecords.reduce((m,r)=> r.idx>m.idx?r:m, {idx:-1,ts:0});
const pullMaxTs = ()=> pullRecords.reduce((m,r)=> r.ts>m?r.ts:m, 0);

// --- METADATA(49) tracking during a full drain: HISTORY_END trim + completion flag. ---
let drain=null;
const newDrain = ()=> ({ endTrim:null, endRaw:null, endSeen:false, endCount:0, complete:false, strategy:null });
function onHistMeta(p){
  if(!drain) return;
  const code=p[2];
  if(code===META_HISTORY_END){ drain.endRaw=p; drain.endTrim = p.length>=17 ? u32at(p,13) : null; drain.endSeen=true; drain.endCount++; }
  else if(code===META_HISTORY_COMPLETE){ drain.complete=true; }
}
// Wait until the band finishes the NEXT batch — i.e. a fresh HISTORY_END (endCount ticks up) or
// HISTORY_COMPLETE — rather than idling QUIET_MS after every batch. HISTORY_END already marks the batch
// boundary (all its records precede it), so we can ack immediately. This removes ~1.5s of dead time per
// batch, the dominant cost over a full-night drain (hundreds of batches). BURST_MAX_MS is the safety net.
function waitBatch(prevEndCount){
  return new Promise(res=>{
    const t0=Date.now();
    (function poll(){
      if(!pulling || !drain) return res();
      if(drain.complete || drain.endCount>prevEndCount) return res();
      if(Date.now()-t0 >= BURST_MAX_MS) return res();
      setTimeout(poll, 40);
    })();
  });
}
// The trim the ack must echo to release the next batch. Documented primary: HISTORY_END's u32 @ off 13.
// 5.0's METADATA layout may differ, so on the FIRST batch we auto-probe these sources and lock whichever
// advances the stream; thereafter we recompute it from each new batch using the locked strategy.
const TRIM_STRATEGIES = [
  { id:'HISTORY_END@13', get:()=> drain.endTrim },
  { id:'HISTORY_END@9',  get:()=> drain.endRaw && drain.endRaw.length>=13 ? u32at(drain.endRaw,9) : null },
  { id:'HISTORY_END@5',  get:()=> drain.endRaw && drain.endRaw.length>=9  ? u32at(drain.endRaw,5) : null },
  { id:'maxRecordIdx',   get:()=> { const m=pullMax().idx; return m>=0?m:null; } },
  { id:'maxRecordIdx+1', get:()=> { const m=pullMax().idx; return m>=0?m+1:null; } },
];
// Ack payload variants for the historical drain. NORMAL is the real protocol ([01][trim][0]) and FREES
// the acked records (DESTRUCTIVE to data WHOOP hasn't synced). The EXPERIMENT variants are guesses at an
// "advance the stream WITHOUT freeing" ack — to be tried ONLY on data WHOOP has already synced. After a
// run, compare the "oldest BEFORE/AFTER" log line: if the oldest didn't move, we advanced non-destructively.
let ackMode = 'normal';
const ACK_BUILDERS = {
  normal:  (trim)=> [0x01, ...u32le(trim>>>0), 0,0,0,0],   // real protocol — frees records (DESTRUCTIVE)
  status0: (trim)=> [0x00, ...u32le(trim>>>0), 0,0,0,0],   // experiment A: leading status 0x00 not 0x01
  trim2nd: (trim)=> [0x01, 0,0,0,0, ...u32le(trim>>>0)],   // experiment B: trim in the 2nd u32 slot, 1st=0
  s0trim2: (trim)=> [0x00, 0,0,0,0, ...u32le(trim>>>0)],   // experiment C: status 0x00 AND trim in 2nd slot
};
const ackPayload = (trim)=> (ACK_BUILDERS[ackMode]||ACK_BUILDERS.normal)(trim>>>0);

// Sync full history: the ACK-loop drain. DESTRUCTIVE in 'normal' ack mode (frees the records it pulls).
async function drainHistory(){
  if(!deviceId){ log('connect first','err'); return; }
  if(pulling){ pulling=false; const b=$('fullsync'); if(b){ b.textContent='Sync full history'; b.classList.remove('live'); } log('sync: stop requested — halting after this batch','dim'); return; }
  // ⚠️ DESTRUCTIVE: the ack-loop advances the band's commit cursor and frees the acked records. If the
  // official WHOOP app has NOT already synced this data, it is permanently lost from WHOOP (observed
  // 2026-06-21: a full night was pulled here, then WHOOP only had post-pull data). Guard it. The
  // experiment ack modes are guesses at a non-destructive advance — only safe on already-synced data.
  const msg = ackMode==='normal'
    ? '⚠️ Sync full history advances the band’s sync cursor and FREES the records it pulls. Any data the official WHOOP app has NOT already synced will be PERMANENTLY LOST from WHOOP.\n\nMake sure the WHOOP app has fully synced FIRST, then continue.\n\nProceed with the full (destructive) drain?'
    : `🧪 EXPERIMENT mode “${ackMode}” — testing whether the band will hand over history WITHOUT freeing it.\n\nRun this only on THROWAWAY data you don’t mind losing (e.g. an hour of daytime wear with the WHOOP app force-closed) — if the experiment fails it still frees that data. Afterwards, read the “oldest BEFORE / AFTER” line: if the oldest did NOT move, the read was non-destructive.\n\nContinue the experiment?`;
  if(!skipDrainConfirm && !window.confirm(msg)) { log('full sync cancelled — let the WHOOP app sync first, or use Quick sync (read-only).','dim'); return; }
  pulling=true; drain=newDrain(); pullRecords.length=0; pullSeen.clear();
  if(!capturing){ capturing=true; const c=$('capture'); if(c){ c.textContent='Stop capture'; c.classList.add('live'); } log('capture auto-started','ok'); }
  const b=$('fullsync'); if(b){ b.textContent='Stop sync'; b.classList.add('live'); }
  log(ackMode==='normal'
    ? 'SYNC FULL HISTORY — ACK-loop drain (ack each HISTORY_END trim until HISTORY_COMPLETE). ⚠️ DESTRUCTIVE to data the WHOOP app hasn’t already synced — the ack frees the records on the band.'
    : `SYNC FULL HISTORY — 🧪 EXPERIMENT ack mode “${ackMode}”. Watch the oldest BEFORE/AFTER line to see if it freed the records.`, 'ok');
  let before=null;
  try{
    before=await readOldest(); log(`oldest buffered BEFORE: ${tsStr(before)}`,'cmd');
    log('→ send_historical_data','cmd'); const e0=drain.endCount; await send(22,[0x00],'send_historical_data'); await waitBatch(e0);
    log(`batch 1: ${pullRecords.length} record(s)${pullRecords.length?` up to idx ${pullMax().idx}`:''}${drain.endTrim!=null?`, HISTORY_END trim=${drain.endTrim}`:' (no HISTORY_END parsed)'}`, pullRecords.length?'ok':'err');
    let guard=0, stalls=0, reprimes=0;
    while(pulling && guard++<100000){
      if(drain.complete){ log('HISTORY_COMPLETE — whole buffer delivered ✓','ok'); break; }
      const prev=pullRecords.length;
      const strategies = drain.strategy ? TRIM_STRATEGIES.filter(s=>s.id===drain.strategy) : TRIM_STRATEGIES;
      let advanced=false;
      for(const st of strategies){
        if(!pulling) break;
        const trim=st.get(); if(trim==null) continue;
        if(!drain.strategy) log(`→ ack trim via ${st.id} = ${trim}`,'cmd');
        const eN=drain.endCount; await send(23, ackPayload(trim), 'historical_data_result'); await waitBatch(eN);
        if(drain.complete || pullRecords.length>prev){
          advanced=true;
          if(!drain.strategy){ drain.strategy=st.id; log(`  ✓ ${st.id} advanced → ${pullRecords.length} records (idx ${pullMax().idx})`,'ok'); }
          else if(guard%20===0){ const behindH=(Date.now()/1000 - pullMaxTs())/3600;
            log(`  …${pullRecords.length} records · data covers up to ${new Date(pullMaxTs()*1000).toLocaleTimeString()} (${behindH<0.5?'≈ now — almost done':behindH.toFixed(1)+'h behind now, still going'})`,'dim'); }
          break;
        }
        if(!drain.strategy) log(`  ✗ ${st.id}: no advance`,'dim');
      }
      // Don't bail on the first quiet gap: mid-buffer the band pauses between batches, and after it frees
      // acked records the stream can need re-priming with another send_historical_data(22). Be patient and
      // re-prime a few times before concluding we've truly hit the end of the buffer (HISTORY_COMPLETE).
      if(advanced){ stalls=0; reprimes=0; }
      else if(++stalls < 2){ await delay(800); }                                  // band may just be slow between batches
      else if(reprimes++ < 4){ stalls=0;
        log(`stream idle at ${drain.strategy?`idx ${pullMax().idx}`:'start'} — re-priming send_historical_data [${reprimes}/4]`,'dim');
        const eR=drain.endCount; await send(22,[0x00],'send_historical_data'); await waitBatch(eR);
      }
      else { log(`stopped — no further batches after ${reprimes} re-primes (${drain.strategy?`end of buffer at idx ${pullMax().idx}`:'no trim format advanced the stream'}).`, drain.strategy?'ok':'err'); break; }
      if(pullRecords.length>300000){ log('record cap reached — stopping','dim'); break; }
    }
    await send(20,[],'abort_historical_transmits'); await delay(400);
    const after=await readOldest();
    // Coverage must come from the dense dump records (HISTORICAL_DATA 47), NOT sparse EVENT(48) connection
    // blips — a single reconnect event at "now" otherwise inflates the span to a phantom ~16h. Fall back to
    // all records only if this firmware delivered the dump as EVENT(48) (no 47 present).
    const dump = pullRecords.filter(r=>r.src===47).length ? pullRecords.filter(r=>r.src===47) : pullRecords;
    const n=pullRecords.length, nd=dump.length, hv=dump.filter(r=>r.hr>0).map(r=>r.hr);
    const minTs=dump.reduce((m,r)=>r.ts<m?r.ts:m,Infinity), maxTs=dump.reduce((m,r)=>r.ts>m?r.ts:m,0);
    const span=nd?`${new Date(minTs*1000).toLocaleString()} → ${new Date(maxTs*1000).toLocaleString()}`:'—';
    const hrs=nd?((maxTs-minTs)/3600).toFixed(1)+'h':'0h';
    const sane=hv.length?`HR ${Math.min(...hv)}–${Math.max(...hv)}, avg ${Math.round(hv.reduce((a,c)=>a+c,0)/hv.length)} bpm`:'no HR decoded';
    updateBandVitals(dump);                                       // pull skin temp + SpO2 out of the (47) records
    showPullPreview({ nd, minTs, maxTs, hrs, hv });               // on-device readout so a bad night shows immediately
    await persistPull(dump);                                      // ⭐ keep a copy ON THE PHONE (Phase 2 store)
    log(`SYNC ${drain.complete?'COMPLETE':'STOPPED'}: ${nd} data records spanning ${hrs} (${span}); ${sane}. trim strategy=${drain.strategy||'NONE'}.`, nd>60?'ok':'err');
    log(`oldest BEFORE ${tsStr(before)} · AFTER ${tsStr(after)}`,'cmd');
    // Verdict: did the oldest-buffered pointer move? If it advanced, the ack FREED records (destructive).
    if(before && after){
      const movedH = (after - before)/3600;
      if(movedH > 0.05) log(`🔴 DESTRUCTIVE: the band’s oldest data jumped forward ${movedH.toFixed(1)}h — those records were freed and the WHOOP app can no longer get them.`, ackMode==='normal'?'err':'err');
      else log(`🟢 NON-DESTRUCTIVE this run: the band’s oldest data did NOT move${ackMode!=='normal'?` — experiment “${ackMode}” advanced the stream without freeing! 🎉`:''}.`,'ok');
    }
    if(nd>60) log(`✅ Pulled ${nd} data records over ${hrs}${drain.complete?'':' (STOPPED early — tap Sync full history again to continue from the new cursor)'}. Now Save file / Send to laptop.`,'ok');
    else if(!drain.strategy) log('⚠️ Only the first window returned — no trim format advanced the stream. The 5.0 HISTORY_END layout may differ; Save file / Send to laptop so I can read the METADATA(49) offsets and lock the trim.','err');
    else log('ℹ️ Little buffered — wear it on-wrist a few hours (some activity / a night) and retry. Save file anyway.','dim');
    // One-tap flow: ship the capture off the phone automatically — to the laptop drop-box if its address is
    // set, otherwise pop the iOS share sheet (Save to Files) as a fallback. Only when we actually got a night.
    if(autoExport && nd>60){
      const host=(($('laphost')&&$('laphost').value)||'').trim();
      if(/^[\w.\-]+:\d{2,5}$/.test(host)){ log('③ Auto-sending to laptop…','cmd'); await sendToLaptop(); }
      else { log('③ No laptop address set — opening Save-to-Files instead…','dim'); await downloadCapture(); }
    }
  }catch(e){ log('sync error: '+e.message,'err'); }
  finally{ pulling=false; autoExport=false;
    const bb=$('fullsync'); if(bb){ bb.textContent='Sync full history'; bb.classList.remove('live'); }
    const db=$('dailysync'); if(db){ db.textContent='Pull last night → laptop'; db.classList.remove('live'); } }
}

let dataRangeOldestTs=null;
// Scan a get_data_range payload for the oldest plausible record timestamp (u32 within now±window). A real
// response (2026-06-24) carried the structured fields oldest=May-11 (44 days back) and newest=now — proving
// the band can hold far more than WHOOP's "up to 14 days" spec. The old 15-day window CLIPPED that true
// oldest (44 d > 15 d), leaving only the "now" field in range → it wrongly reported "oldest = now". Widen to
// 90 days; the only out-of-range junk u32 in that frame was a 2030 value, excluded by the hi bound.
function parseDataRangeOldest(p){
  const nowS=Math.floor(Date.now()/1000), lo=nowS-90*86400, hi=nowS+3600; let oldest=null;
  for(let o=3;o+4<=p.length;o++){ const v=(p[o]|(p[o+1]<<8)|(p[o+2]<<16)|(p[o+3]<<24))>>>0;
    if(v>=lo && v<=hi && (oldest===null||v<oldest)) oldest=v; }
  return oldest;
}
let dataRangeRaw=null;   // last raw get_data_range response (for read-pointer analysis)
async function readOldest(){ dataRangeOldestTs=null; dataRangeRaw=null; await send(34,[],'get_data_range'); await delay(1500); return dataRangeOldestTs; }
const tsStr=(t)=> t ? new Date(t*1000).toLocaleString() : '(not parsed)';

// Show the band's data range from its get_data_range marker — READ-ONLY (sends no FORCE_TRIM, moves nothing,
// frees nothing). Reports the oldest record still on flash so you know the earliest date you can pull, and drops
// it into the date box for convenience. Picking any time at/after this is safe to seek to.
async function showOldest(){
  if(!deviceId){ log('connect first','err'); return null; }
  const out=$('oldestout');
  if(out) out.innerHTML='Oldest on flash: <b style="color:#fff">reading…</b>';
  log('→ get_data_range (read-only)…','cmd');
  const ts=await readOldest();
  if(!ts){
    if(out) out.innerHTML='Oldest on flash: <b style="color:var(--bad,#f66)">couldn’t parse</b> — try again';
    log('could not parse an oldest ts from get_data_range.','err'); return null;
  }
  const ageD=((Date.now()/1000)-ts)/86400;
  if(out) out.innerHTML=`Oldest on flash: <b style="color:#fff">${tsStr(ts)}</b> <span style="color:var(--dimmer)">(${ageD.toFixed(1)} d ago)</span>`;
  $('seekdt').value = toLocalInput(new Date(ts*1000));               // drop into the date box as a starting point
  log(`oldest on flash ≈ ${tsStr(ts)} (${ageD.toFixed(1)} d ago). Pick any time at/after this, then “Trim to date & sync”.`,'ok');
  return ts;
}


// The historical read/write pointers live in the get_data_range response header as small counters
// (~thousands–tens-of-thousands), NOT the big record index. Pull the clean ones (top 2 bytes zero) so we
// can feed the right number space to set_read_pointer (cmd 33) — the old attempts used the record idx and
// never moved the pointer. Verified on a real 5.0 response: pointers cluster at ~18,842 / 18,846 / 22,700.
function pointerCandidates(p){
  const out=[]; if(!p) return out;
  const end=Math.min(p.length-4, 26);                 // pointers sit in the response header block
  for(let o=3;o<=end;o++){ const v=(p[o]|(p[o+1]<<8)|(p[o+2]<<16)|(p[o+3]<<24))>>>0;
    if(v>=1000 && v<65536) out.push({off:o, val:v}); }
  return out;
}
// Read-only PROBE: stream just the first batch from the current read position, capture (ts, trim) =
// where the read pointer sits, then ABORT without acking (non-destructive). This is the ground-truth
// feedback for the seek — the first streamed record is exactly where the read head is.
async function probeReadPos(){
  const wasPulling=pulling; pulling=true; drain=newDrain(); pullRecords.length=0; pullSeen.clear();
  await send(22,[0x00],'send_historical_data');
  const t0=Date.now();
  while(Date.now()-t0<6000){ if(pullRecords.length>0 && drain.endSeen) break; await delay(100); }
  pulling=wasPulling;
  await send(20,[],'abort_historical_transmits'); await delay(300);
  if(!pullRecords.length) return null;
  // The read head is where the dump STARTS, i.e. the first records that arrived — NOT the minimum ts. Bursts
  // stream non-monotonically (a single window was seen holding both 06:45 and 03:57 on 2026-06-24), so taking
  // the min ts gave a noisy/wrong landing. Use the median of the first few arrivals — robust to a stray.
  const head=pullRecords.slice(0,7).map(r=>r.ts).filter(t=>t>1500000000).sort((a,b)=>a-b);
  if(!head.length) return null;
  return { ts:head[head.length>>1], trim:drain.endTrim };
}
// Approx time↔trim rate. The band's trim grows ~1300–2200 units/hour while worn (≈1.6–4 s per trim unit) and
// varies with activity, so this is only the SEED for the first jump — every probe refines it from real feedback.
const SEED_S_PER_TRIM = 3.0;
// NEVER FORCE_TRIM below this. Trims near 0 point into ERASED flash and HARD-REBOOT the band (reason 0x0007);
// valid recent data sits at much higher trims. This is the backstop that makes the crash structurally impossible.
const MIN_SAFE_TRIM = 2000;

// Send FORCE_TRIM (cmd 25) to a specific trim: abort any in-flight dump, then set the commit cursor. Floors the
// value at MIN_SAFE_TRIM so no caller can ever drive the band into the erased-flash crash zone.
async function forceTrimTo(trim){
  trim=Math.max(MIN_SAFE_TRIM,Math.round(trim));
  await send(20,[],'abort'); await delay(300);
  await send(25,[trim&0xFF,(trim>>>8)&0xFF,(trim>>>16)&0xFF,(trim>>>24)&0xFF, 0,0,0,0],'force_trim'); await delay(500);
}

// FORCE_TRIM seek — REBUILT 2026-06-24 from the ground up on everything the captures taught us. The dump
// streams from the "trim" (commit cursor); FORCE_TRIM (cmd 25) moves it. Hard facts the rebuild respects:
//   • trim ↑ = newer; the WRITE POINTER (≈ now's trim) is the CEILING — above it the band clamps to "now".
//   • trims near 0 are ERASED flash and HARD-REBOOT the band — never go there (MIN_SAFE_TRIM + range gate).
//   • time↔trim is monotonic but variable-rate, so ANCHOR at now and jump by a MEASURED rate, refined each probe.
// Method: gate the target to the valid range (get_data_range), anchor at the current head (a plain probe — no
// FORCE_TRIM, so safe — which also gives the ceiling), then jump trim = anchorTrim + (target−anchorTs)/rate,
// CLAMPED to [floor, ceiling], probe where it landed, refine the rate from the (ts,trim) feedback, repeat.
// Lands at/just before the target so the drain reads forward through the window. Never sends an out-of-range or
// near-zero trim → no clamp-to-now, no crash. (This is the anchor+rate method that worked originally; the later
// binary-search rewrite discarded the rate and groped upward from trim 0 = the crash zone.)
async function forceTrimSeek(){
  if(!deviceId){ log('connect first','err'); return false; }
  const v=$('seekdt').value; const target=v ? Math.floor(Date.parse(v)/1000) : NaN;
  if(!Number.isFinite(target)){ log('pick a date & time first','err'); return false; }
  log(`🎯 Seeking to ${new Date(target*1000).toLocaleString()} …`,'cmd');
  const oldestTs=await readOldest();                              // valid-range floor (read-only, never crashes)
  const now=await probeReadPos();                                 // anchor at the head; its trim = the ceiling
  if(!now || now.trim==null){ log('probe failed — connect and keep the app in the foreground.','err'); return false; }
  const ceil=now.trim;
  log(`now: ${tsStr(now.ts)} @ trim ${ceil}${oldestTs?` · oldest ≈ ${tsStr(oldestTs)}`:''}`,'dim');
  if(target >= now.ts-60){ log('that time is at/after the newest data — nothing to rewind. Pulling from here.','cmd'); return true; }
  if(oldestTs && target < oldestTs-60){ log(`that time has rolled off the band (oldest ≈ ${tsStr(oldestTs)}). Pick a later time.`,'err'); return false; }
  let sPerTrim=SEED_S_PER_TRIM, floor=Math.max(MIN_SAFE_TRIM, Math.round(ceil*0.04));
  let aTs=now.ts, aTrim=ceil, best=null, reboots=0;
  const clampTrim=(t)=> Math.min(ceil-1, Math.max(floor, Math.round(t)));
  for(let iter=1; iter<=6; iter++){
    let est=clampTrim(aTrim + (target-aTs)/sPerTrim);             // trim↑=newer ⇒ older target ⇒ lower trim
    if(est===aTrim) est=clampTrim(aTrim-1000);                    // guarantee movement
    log(`→ FORCE_TRIM ${est} [iter ${iter}, ${sPerTrim.toFixed(1)} s/trim, range ${floor}…${ceil}]`,'cmd');
    await forceTrimTo(est);
    let m=await probeReadPos(); if(!m){ await delay(400); m=await probeReadPos(); }
    if(linkDown){ reboots++; floor=Math.max(floor,est+2500);
      log(`⚠️ band reset at trim ${est} — raising the floor and reconnecting.`,'err');
      if(reboots>=2){ log('too many resets — pick a more recent time.','err'); return false; }
      if(!await reconnect()) return false; continue; }
    if(!m || m.ts==null){ floor=Math.max(floor,est+2500); log('empty here — near the erased edge; raising the floor.','dim'); continue; }
    const errMin=(m.ts-target)/60;
    log(`landed ${tsStr(m.ts)} @ trim ${m.trim} — ${errMin>0?'+':''}${errMin.toFixed(0)} min`, Math.abs(errMin)<15?'ok':'cmd');
    if(m.ts<=target && (!best||m.ts>best.ts)) best=m;             // best safe landing = newest at/before target
    if(errMin>=-20 && errMin<=5){ await forceTrimTo(m.trim); log('🎉 Landed at/just before the target — pulling from here.','ok'); return true; }
    if(m.trim!==aTrim){ const r=(aTs-m.ts)/(aTrim-m.trim); if(r>0.3 && r<20) sPerTrim=r; }   // refine local rate
    aTs=m.ts; aTrim=m.trim;
  }
  if(best){ await forceTrimTo(best.trim); log(`landed at ${tsStr(best.ts)} — closest at/before the target. Pulling from here.`,'ok'); return true; }
  log('couldn’t converge — try a slightly later time.','err'); return false;
}

// ── ONE-TAP daily calibration pull (Phase 1): FORCE_TRIM back to last night → drain → auto-export. ──
// In calibration mode the WHOOP app syncs first (creating the cloud answer-key) and ITS sync advances the
// band's commit cursor PAST that night — so a plain Sync would start at "now" and pull nothing. We rewind
// with FORCE_TRIM (cmd 25) to the chosen evening (WHOOP states the band stores up to 14 days), then drain that night
// and ship it straight to the laptop drop-box. Defaults the target to ~20:00 yesterday if the box is empty.
function toLocalInput(d){ const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
async function dailySync(){
  if(!deviceId){ log('connect first','err'); return; }
  if(pulling){ await drainHistory(); return; }                 // already running → let the button stop it
  if(!$('seekdt').value){ const d=new Date(); d.setDate(d.getDate()-1); d.setHours(20,0,0,0);
    $('seekdt').value = toLocalInput(d); log(`date not set — defaulting to last night (${d.toLocaleString()})`,'dim'); }
  const when=new Date($('seekdt').value);
  // One confirm for the whole managed pull (then suppress drainHistory's per-pass confirm).
  if(!window.confirm(`Trim the band to ${when.toLocaleString()} and sync everything from there into the app?\n\nIt keeps draining forward until it reaches now, then stores it on the phone (Health → Stored data).\n\n⚠️ Reading FREES those records on the band, so let the official WHOOP app sync FIRST if you still need them there.\n\nProceed?`)){
    log('sync cancelled — let the WHOOP app sync first.','dim'); return; }
  { const db=$('dailysync'); if(db){ db.textContent='Syncing… (tap to stop)'; db.classList.add('live'); } }
  skipDrainConfirm = true; autoExport = false;                 // we confirm once here and export once at the end
  const agg = { n:0, minTs:Infinity, maxTs:0, hv:[] };          // aggregate across continuation passes
  let lastMax = 0; let userStopped = false;
  const MAX_PASSES = 24;                                        // a full night across slow batches + reconnects
  try{
    for(let pass=1; pass<=MAX_PASSES; pass++){
      // If the link dropped mid-pull (the band's backstop-abort), reconnect and resume from where we got to
      // rather than losing the rest of the night. Bail only if the user stopped or we can't get back on.
      if(linkDown){ if(!await reconnect()){ break; } }
      if(pass===1) log('① Trimming to the chosen date (FORCE_TRIM)…','cmd');
      else { $('seekdt').value = toLocalInput(new Date(lastMax)); log(`↻ Continuing from ${new Date(lastMax).toLocaleTimeString()} (pass ${pass})…`,'cmd'); }
      const ok = await forceTrimSeek();
      if(!ok){
        if(linkDown){ continue; }                              // dropped during the seek → reconnect loop above
        if(pass===1){ log('seek failed — nothing pulled. Adjust “Night to pull” and tap again.','err'); return; }
        break;
      }
      log(`② Draining the night${pass>1?` (pass ${pass})`:''}…`,'cmd');
      await drainHistory();
      for(const r of pullRecords) if(r.src===47){ agg.n++; if(r.ts<agg.minTs)agg.minTs=r.ts; if(r.ts>agg.maxTs)agg.maxTs=r.ts; if(r.hr>0)agg.hv.push(r.hr); }
      const passMaxMs = pullMaxTs()*1000;
      // Distinguish a user-stop from a link-drop: linkDown means the band/BLE cut out, so resume; pulling
      // false WITHOUT linkDown means the user tapped stop.
      if(linkDown){
        if(passMaxMs>lastMax) lastMax = passMaxMs;             // bank whatever ground this partial pass gained
        log('link dropped mid-pull — will reconnect and resume from the last record received.','dim');
        continue;
      }
      if(!pulling && passMaxMs<=lastMax){ userStopped=true; break; }   // user stopped, no new ground → done
      if(passMaxMs <= lastMax + 60000){ log('no further records — reached the end of the buffer.','dim'); break; }
      lastMax = passMaxMs;
      if(Date.now() - lastMax < 20*60000){ log('✓ Caught up to now — whole night captured.','ok'); break; }
      if(pass===MAX_PASSES) log('reached pass limit — stopping. Tap again if more remains.','dim');
    }
  }
  catch(e){ log('daily pull error: '+e.message,'err'); }
  finally{ skipDrainConfirm=false; const db=$('dailysync'); if(db){ db.textContent='Trim to date & sync to app'; db.classList.remove('live'); } }
  // One aggregate preview for the whole multi-pass capture. The data is already stored on the phone (each
  // drain pass calls persistPull → store.ingest); the laptop send below is just an optional extra copy.
  const hrs = agg.n ? ((agg.maxTs-agg.minTs)/3600).toFixed(1)+'h' : '0h';
  showPullPreview({ nd:agg.n, minTs:agg.minTs, maxTs:agg.maxTs, hrs, hv:agg.hv });
  if(agg.n>60){
    log(`✅ Synced ${agg.n} records (${hrs}) into the app — see Health → Stored data.`,'ok');
    const host=(($('laphost')&&$('laphost').value)||'').trim();
    if(/^[\w.\-]+:\d{2,5}$/.test(host)){ log('③ Also sending a copy to the laptop…','cmd'); await sendToLaptop(); }
  }
}

// Read-only: report the band's SYNC CURSOR (oldest not-yet-committed point). IMPORTANT: this is only a
// logical marker, NOT what's physically stored — the band keeps days of records in its NOR flash and a
// full "Sync full history" reads them from the start regardless of this cursor (proven 2026-06-21: pulled
// 4-day-old records while this cursor read "today"). So don't trust it to mean data is gone.
/* ===================== Phase 2 — IMU / actigraphy capture (cmd 105/106) =====
   The raw high-rate IMU (int16 6-axis accel+gyro, WHOOP's "R21" record) is the unlock for true actigraphy
   (sleep movement), steps and VO₂. The APK confirms TOGGLE_IMU_MODE=106 (realtime) and
   TOGGLE_IMU_MODE_HISTORICAL=105 (historical). We don't have the byte layout (JADX gap), so these capture
   the raw stream for offline RE: `node tools/whoop-decode.mjs --scan-imu <capture>`. Both are
   NON-DESTRUCTIVE (realtime doesn't touch the buffer; the historical probe streams the first window
   without ever acking). */
function startCaptureIfNeeded(){ if(!capturing){ capturing=true; const c=$('capture'); if(c){ c.textContent='Stop capture'; c.classList.add('live'); } log('capture auto-started','ok'); } }
let imuRtOn=false;
async function toggleImuRealtime(){
  if(!deviceId){ log('connect first','err'); return; }
  imuRtOn=!imuRtOn;
  if(imuRtOn){ startCaptureIfNeeded();
    // cmd 106 alone only sets a MODE — like HR (cmd 3), the realtime engine must be running to actually
    // stream. So start the realtime engine first, then enable IMU; the IMU data should arrive on fd4b0007.
    await send(3,[0x01],'toggle_realtime_hr ON (start realtime engine)'); await delay(300);
    await send(106,[0x01],'toggle_imu_mode ON (realtime IMU)');
  } else {
    await send(106,[0x00],'toggle_imu_mode OFF'); await delay(200);
    await send(3,[0x00],'toggle_realtime_hr OFF');
  }
  const b=$('imurt'); if(b){ b.textContent='Realtime IMU: '+(imuRtOn?'on':'off'); b.classList.toggle('live',imuRtOn); }
  if(imuRtOn) log('🟢 IMU ON (realtime engine + IMU mode). Do this slowly so the axes are decodable: hold the band FLAT & STILL ~5s, then tilt onto each edge (X), each end (Y), face-down (Z) ~3s each, then SHAKE ~3s. Watch the fd4b counter for a NEW stream (likely “hifreq_from_strap”). Then turn off & Send to laptop.','ok');
  else log('IMU off. Save file / Send to laptop — I’ll decode the int16 6-axis layout (gravity ≈ ±1 g on whichever axis is down; gyro ≈ 0 at rest).','ok');
}
// Enumerate the band's full GATT and subscribe to EVERY notify characteristic on a WHOOP custom service —
// so wherever the IMU/high-rate stream lives (fd4b0007, or a 0007 on the 6108/1150/8a58/5983 families), we
// catch it. Logs the whole service/characteristic map (read it off to see what the 5.0 actually exposes).
const subscribedChars = new Set();
async function listGatt(){
  if(!deviceId){ log('connect first','err'); return; }
  let services=[];
  try{ services = await BleClient.getServices(deviceId); }
  catch(e){ log('getServices failed: '+e.message,'err'); return; }
  startCaptureIfNeeded();                                                  // so the GATT map lands in the exported file
  capture.push({ t:Date.now(), ch:'GATT', hex:`==== GATT MAP (${services.length} services) ====` });
  log(`GATT map — ${services.length} services:`,'cmd');
  let subbed=0;
  for(const s of services){
    const su=(s.uuid||'').toLowerCase();
    const std=/^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/.test(su);   // standard 16-bit BLE service
    for(const c of (s.characteristics||[])){
      const cu=(c.uuid||'').toLowerCase(), p=c.properties||{};
      const flags=['read','write','writeWithoutResponse','notify','indicate'].filter(k=>p[k]).join(',');
      capture.push({ t:Date.now(), ch:'GATT', hex:`${su} / ${cu} [${flags}]` });   // → exported, so I can read it
      log(`  ${su.slice(0,8)}/${cu.slice(0,8)} [${flags}]`,'dim');
      if((p.notify||p.indicate) && !std && !subscribedChars.has(su+cu)){
        try{ await BleClient.startNotifications(deviceId, s.uuid, c.uuid, (v)=>onFrame(su.slice(0,4)+'·'+cu.slice(0,8), v));
          subscribedChars.add(su+cu); subbed++; log(`  → subscribed ${su.slice(0,8)}/${cu.slice(0,8)} ✓`,'ok'); }
        catch(e){ log(`  → subscribe ${cu.slice(0,8)} failed: ${e.message}`,'err'); }
      }
    }
  }
  log(`✓ GATT map written to the capture (${subbed} extra notify char(s) subscribed). Now run Realtime IMU / Raw data / Historical IMU probe, then Send the capture — it now contains the full characteristic map.`, 'ok');
}

// Alternative path: START_RAW_DATA(81)/STOP_RAW_DATA(82) — the band's dedicated high-rate raw sensor stream.
let rawOn=false;
async function toggleRawData(){
  if(!deviceId){ log('connect first','err'); return; }
  rawOn=!rawOn;
  if(rawOn) startCaptureIfNeeded();
  await send(rawOn?81:82, rawOn?[0x01]:[], rawOn?'start_raw_data (cmd 81)':'stop_raw_data (cmd 82)');
  const b=$('imuraw'); if(b){ b.textContent='Raw data: '+(rawOn?'on':'off'); b.classList.toggle('live',rawOn); }
  log(rawOn?'🟢 RAW DATA ON (cmd 81). Move & shake the band; watch the fd4b counter for a new stream on the hi-rate channel. Then turn off & Send to laptop.':'Raw data off. Save file / Send to laptop.','ok');
}
async function imuHistoricalProbe(){
  if(!deviceId){ log('connect first','err'); return; }
  startCaptureIfNeeded();
  log('Historical IMU probe (READ-ONLY): enabling IMU historical mode, then streaming the first window WITHOUT acking — nothing is freed.','ok');
  await send(105,[0x01],'toggle_imu_mode_historical ON'); await delay(500);
  await send(34,[],'get_data_range'); await delay(800);
  await send(22,[0x00],'send_historical_data');
  log('streaming ~20 s — looking for R21 IMU records in the dump (watch the fd4b counter for a new type)…','dim');
  await delay(20000);
  await send(20,[],'abort_historical_transmits'); await delay(300);
  await send(105,[0x00],'toggle_imu_mode_historical OFF');
  log('✓ Done (read-only — nothing acked, non-destructive). Save file / Send to laptop so I can find & decode the R21 record.','ok');
}
// High-freq-sync probe (cmd 96): the WHOOP app enters HIGH_FREQ_SYNC before pulling — this is the most
// likely path for the band to deliver RAW high-rate records (IMU for steps, raw PPG). Read-only: enter
// high-freq, stream the first window WITHOUT acking, then exit. Scan the result for new record types/lengths.
async function hiFreqProbe(){
  if(!deviceId){ log('connect first','err'); return; }
  startCaptureIfNeeded();
  log('High-freq-sync probe (cmd 96, READ-ONLY): entering high-frequency sync, then streaming the first window without acking — testing whether it unlocks raw/IMU records.','ok');
  await send(96,[0x01],'enter_high_freq_sync'); await delay(700);
  await send(34,[],'get_data_range'); await delay(700);
  await send(22,[0x00],'send_historical_data');
  log('streaming ~20 s — watch the fd4b counter for a NEW record type or longer records…','dim');
  await delay(20000);
  await send(20,[],'abort_historical_transmits'); await delay(300);
  await send(97,[0x00],'exit_high_freq_sync');
  log('✓ Done (read-only). Save / Send the capture — I’ll scan for raw/IMU records the high-freq mode may add.','ok');
}

async function checkBandBuffer(){
  if(!deviceId){ log('connect first','err'); return; }
  log('Reading the band’s sync cursor (read-only, changes nothing)…','cmd');
  const oldest = await readOldest();
  if(!oldest){ log('Could not read the band’s data range — no timestamp came back. Try again.','err'); return; }
  const agoH = ((Date.now()/1000 - oldest)/3600).toFixed(1);
  log(`📍 Sync cursor (oldest UN-synced point): ${tsStr(oldest)} (${agoH}h ago).`,'ok');
  log('⚠️ This is just a marker, NOT what’s physically stored. The band keeps days of records in flash, and “Sync full history” reads them from the very start regardless of this cursor — so older data that looks “gone” here can usually still be pulled.','ok');
}

/* ===================== END DEV/SETUP ===================== */

/* ----------------------------- BLE flow ----------------------------------- */
let deviceId=null, seq=1; let linkDown=false;

async function connect(){
  try{
    rt.counts={}; renderRt();
    state.hrCount=0; state.hrSum=0; state.restHr=null; lastHrTs=0; rr.length=0;
    state.strainAcc=newStrainAcc();
    setStatus('initialising…');
    await BleClient.initialize();
    log('select your WHOOP in the chooser…');
    const device=await BleClient.requestDevice({ namePrefix:'WHOOP', optionalServices:[...WHOOP_SERVICES,HR_SVC,BATT_SVC,DEV_SVC] });
    deviceId=device.deviceId;
    log(`selected: ${device.name||'WHOOP'} [${deviceId}]`);
    setStatus('connecting…');
    await BleClient.connect(deviceId, onDisconnect);
    linkDown=false;
    setStatus('connected — '+(device.name||'WHOOP'), true);
    enableDev(true);

    try{ const b=await BleClient.read(deviceId,BATT_SVC,BATT_LVL); setField('batt', b.getUint8(0)+'%'); }catch(e){ log('battery read: '+e.message,'err'); }
    for(const [ch,id] of [[DEV_MODEL,'model'],[DEV_FW,'fw'],[DEV_SERIAL,'serial'],[DEV_MFR,'mfr']]){
      try{ const v=await BleClient.read(deviceId,DEV_SVC,ch); setField(id, new TextDecoder().decode(v).replace(/\0/g,'').trim()); }catch(e){}
    }
    await subscribeAll();
    log('connected. Live HR is flowing — see the Strain/Overview tabs.','ok');
    renderAll();
  }catch(e){ log('connect error: '+e.message,'err'); setStatus('not connected'); }
}

// Subscribe to HR + the four WHOOP custom-service notify channels. Shared by connect() and reconnect() so
// a dropped link can be restored with the same notifications wired back up (otherwise a resumed drain would
// reconnect but never receive any records).
async function subscribeAll(){
  try{ await BleClient.startNotifications(deviceId,HR_SVC,HR_MEAS, onHR); log('subscribed: live Heart Rate ✓','ok'); }
  catch(e){ log('HR subscribe failed: '+e.message,'err'); }
  for(const [ch,label] of [[RX_CMD,'command_from_strap'],[RX_EVT,'events_from_strap'],[RX_DAT,'data_from_strap'],[RX_HF,'hifreq_from_strap']]){
    try{ await BleClient.startNotifications(deviceId,SVC,ch,(v)=>onFrame(label,v)); subscribedChars.add((SVC+ch).toLowerCase()); log('subscribed: '+label+' ✓','ok'); }
    catch(e){ log('subscribe '+label+' FAILED: '+e.message,'err'); }
  }
}

// Re-establish a dropped BLE link to the SAME band and re-wire notifications, so a mid-pull disconnect (the
// band's "Abort History Transmit handled by backstop" we saw on 2026-06-24) can be recovered and the drain
// resumed from where it left off. Retries with exponential backoff. Returns true once reconnected.
async function reconnect(tries=6){
  if(!deviceId){ return false; }
  for(let i=0;i<tries;i++){
    const wait = Math.min(8000, 1000*Math.pow(2,i));      // 1s,2s,4s,8s,8s,8s
    log(`link down — reconnecting in ${wait/1000}s [${i+1}/${tries}]…`,'dim');
    await delay(wait);
    try{
      try{ await BleClient.disconnect(deviceId); }catch(e){}   // clear any half-open handle first
      await BleClient.connect(deviceId, onDisconnect);
      linkDown=false;
      setStatus('reconnected', true); enableDev(true);
      await subscribeAll();
      log('✓ reconnected to band.','ok');
      return true;
    }catch(e){ log('reconnect attempt failed: '+e.message,'err'); }
  }
  log('could not reconnect after several tries — stopping. Tap Pull last night again when the band is back in range.','err');
  return false;
}

async function send(command, data=[], label=''){
  if(!deviceId){ log('not connected','err'); return; }
  const frame=buildCommand(seq,command,data);
  try{ await BleClient.write(deviceId,SVC,TX,numbersToDataView(frame));
    log(`TX ${label||command} seq=${seq}  ${hex(frame)}`,'cmd'); seq=(seq+1)&0xFF; if(seq===0) seq=1;
  }catch(e){ log('TX failed: '+e.message,'err'); }
}
async function onDisconnect(){ setStatus('disconnected'); enableDev(false); linkDown=true;
  rtHrOn=false; const b=$('rthr'); if(b){ b.textContent='Realtime HR: off'; b.classList.remove('live'); }
  // Stop the active drain, but DON'T null `drain` — a managed pull (dailySync) inspects linkDown to decide
  // whether to reconnect and resume from the last record it received, rather than losing the whole night.
  pulling=false;
  const sb=$('synchist'); if(sb){ sb.textContent='Quick sync (read-only)'; sb.classList.remove('live'); }
  const fb=$('fullsync'); if(fb){ fb.textContent='Sync full history'; fb.classList.remove('live'); }
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
  // Day Strain for every stored night depends on resting/max HR + sex — recompute them with the new profile.
  store.recomputeAll(profile).then(n=>{ if(n) log(`recomputed Day Strain for ${n} stored night(s) with the new profile.`,'dim'); return refreshHist(); }).then(()=>{ if(curScreen==='storage') renderStorage(); }).catch(()=>{});
  renderAll();
}

/* ----------------------------- wire up ------------------------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  SplashScreen.hide().catch(()=>{});
  buildSections();                                   // create the generated detail/hub screens
  document.querySelectorAll('#tabs button').forEach(b=> b.onclick=()=>showTab(b.dataset.tab));
  document.querySelectorAll('[data-go]').forEach(el=> el.onclick=()=>goScreen(el.dataset.go));
  // delegated navigation: any element with data-nav pushes a detail screen; data-back / the back button pops.
  document.addEventListener('click', (e)=>{
    const a=e.target.closest('[data-act]'); if(a){ doAction(a.dataset.act); return; }
    const t=e.target.closest('[data-stab]'); if(t){ const [scr,key]=t.dataset.stab.split(':'); STAB[scr]=key; rerender(); return; }
    const beh=e.target.closest('[data-beh]'); if(beh){ toggleBehaviour(beh.dataset.beh); return; }
    const n=e.target.closest('[data-nav]'); if(n){ goScreen(n.dataset.nav); return; }
    if(e.target.closest('[data-back]')) goBack(); });
  { const bb=$('backbtn'); if(bb) bb.onclick=goBack; }
  { const f=$('fab'); if(f) f.onclick=()=>doAction('fab'); }
  applyStealth();
  document.querySelectorAll('#trend-seg button').forEach(b=> b.onclick=()=>{ trendPeriod=b.dataset.period; renderTrends(); });
  fillProfileForm();
  if($('laphost')) $('laphost').value = loadLapHost();
  selfTest();
  $('connect').onclick    = connect;
  $('disconnect').onclick = async ()=>{ if(deviceId){ try{ await BleClient.disconnect(deviceId); }catch(e){} } };
  $('hello').onclick      = ()=>send(145,[0x01],'get_hello');
  $('battery').onclick    = ()=>send(26,[],'get_battery_level');
  $('range').onclick      = ()=>send(34,[],'get_data_range');
  $('rthr').onclick       = toggleRealtimeHr;
  $('dailysync').onclick  = dailySync;
  $('synchist').onclick   = syncHistory;
  $('fullsync').onclick    = drainHistory;
  $('bandcheck').onclick   = checkBandBuffer;
  $('forcetrim').onclick   = forceTrimSeek;
  { const a=$('showoldest'); if(a) a.onclick=showOldest; }
  { const a=$('imurt'); if(a) a.onclick=toggleImuRealtime; }
  { const a=$('imuraw'); if(a) a.onclick=toggleRawData; }
  { const a=$('imuprobe'); if(a) a.onclick=imuHistoricalProbe; }
  { const a=$('hifreq'); if(a) a.onclick=hiFreqProbe; }
  { const a=$('gattbtn'); if(a) a.onclick=listGatt; }
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
  $('savefile').onclick   = downloadCapture;
  $('sendlap').onclick    = sendToLaptop;
  $('clear').onclick      = ()=>{ const el=logEl(); if(el) el.innerHTML=''; };
  enableDev(false);
  renderRt();
  renderAll();
  refreshHist();                                     // load stored nights → real-data screens (async)
});
