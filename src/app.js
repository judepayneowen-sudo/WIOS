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
const RX_HF  = 'fd4b0007-cce1-4033-93ce-002d5875f58a';   // hi-rate / IMU stream (notify) — the 6th char WHOOP uses for raw IMU

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
const state = { hr:null, hrvMs:null, restHr:null, hrCount:0, hrSum:0, strainAcc:null, recovery:null, sleep:null };
let lastHrTs=0;

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
const ZONE_COL=['#1d6fae','#2a8fd8','#3aa0ff','#7c5cff','#ff9f3a','#ff3b5c'];
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
const CSSVAR={'var(--rec-green)':'#16ec84','var(--rec-yellow)':'#ffde2e','var(--rec-red)':'#ff3b5c',
  'var(--sleep)':'#7c5cff','var(--strain)':'#3aa0ff','var(--st-awake)':'#9aa0a8','var(--st-rem)':'#9b8cff',
  'var(--st-light)':'#4a78d6','var(--st-sws)':'#27408b'};
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
    let v=m.val; if(m.key==='hr') v=state.hr; else if(m.key==='hrv'&&state.hrvMs!=null) v=state.hrvMs;
    const shown=(v==null?'—':v);
    const ok=v==null?true:(v>=m.lo&&v<=m.hi), flag=v==null?'var(--dimmer)':(ok?'var(--rec-green)':'var(--rec-yellow)');
    return `<div class="hrow"><span class="hk"><span class="flag" style="background:${flag}"></span>${m.nm}${m.live?' <i class="livedot"></i>':''}</span>`+
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
function renderStrain(){
  const S=SAMPLE.strain, live=state.strainAcc?state.strainAcc.strain:null;
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
  if(wk) wk.innerHTML=S.workouts.map(w=>`<div class="wk"><div class="wk-top"><span class="wk-nm">${w.nm}</span><span class="wk-str">${w.strain.toFixed(1)}</span></div>`+
    `<div class="wk-sub">${w.t} · ${fmtDur(w.dur)} · ${w.cal} cal · avg ${w.avg} · max ${w.max} bpm</div></div>`).join('');
}
function renderSleep(){
  const S=SAMPLE.sleep, t=sleepTotals(S.segs);
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
  setField('slp-need', fmtMs(sleepNeedMinutes({dayStrain:SAMPLE.strain.day})));
  setField('slp-debt', fmtMs(S.debtMin)); setField('slp-eff', S.eff+'%');
  setField('slp-consistency', S.consistency+'%'); setField('slp-resp', S.respiratory.toFixed(1));
  setField('slp-disturb', S.disturbances); setField('slp-inbed', fmtMs(S.inBedMin));
}
let trendPeriod='1W';
function renderTrends(){
  const d=SAMPLE.trends[trendPeriod];
  document.querySelectorAll('#trend-seg button').forEach(b=>b.classList.toggle('active', b.dataset.period===trendPeriod));
  const avg=(a)=>Math.round(a.reduce((x,y)=>x+y.v,0)/a.length);
  interactiveChart($('tr-rec'), d.rec, {color:recColor(avg(d.rec)),h:120,unit:'%',min:0,max:100});
  setField('tr-rec-avg','avg '+avg(d.rec)+'%');
  interactiveChart($('tr-strain'), d.strain, {color:'#3aa0ff',h:120,fmt:v=>v.toFixed(1),min:0,max:21});
  setField('tr-strain-avg','avg '+(d.strain.reduce((x,y)=>x+y.v,0)/d.strain.length).toFixed(1));
  interactiveChart($('tr-sleep'), d.sleep, {color:'var(--sleep)',h:120,unit:'%',min:0,max:100});
  setField('tr-sleep-avg','avg '+avg(d.sleep)+'%');
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
    + navRow('hormonal','❤','Hormonal Insights','Menstrual cycle · pregnancy')
    + card(navRow('advancedlabs','🧪','Advanced Labs','Blood biomarker results')+navRow('whooplabs','🔬','WHOOP Labs','Research studies')) },

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
    hd('Health Monitor','live & resting')
    + card(SAMPLE.health.map(m=>{ let v=m.val; if(m.key==='hr') v=state.hr; else if(m.key==='hrv'&&state.hrvMs!=null) v=state.hrvMs;
        const shown=(v==null?'—':v); const ok=v==null?true:(v>=m.lo&&v<=m.hi);
        return `<div class="hrow"><span class="hk"><span class="flag" style="background:${v==null?'var(--dimmer)':ok?'var(--rec-green)':'var(--rec-yellow)'}"></span>${m.nm}${m.live?' <i class="livedot"></i>':''}</span><span class="hv">${shown}<small>${m.unit}</small></span><span class="hr-rng">${m.lo}–${m.hi}</span></div>`; }).join(''))
    + card(hd('Heart Screener','ECG-style')+scaffold('WHOOP’s background screening / heart screener is a cloud “labrador” report. SpO₂, skin-temp & respiratory rate are <b>not</b> band-decodable (cloud-only per the APK) — shown here from the last cloud sync.')) },

  // ----- DETAIL: Stress Monitor -----
  { id:'stress', build:()=>{
    let v=SAMPLE.stress.now;
    if(state.hr!=null){ const hrC=Math.max(0,Math.min(3,(state.hr-52)/40)); const hrvC=state.hrvMs!=null?Math.max(0,Math.min(3,(70-state.hrvMs)/22)):hrC; v=Math.round((hrC*0.6+hrvC*0.4)*10)/10; }
    return hd('Stress Monitor','live · 0–3')
    + card(stressGauge(v))
    + card(hd('Today')+kvr('Day stress','—')+kvr('Sleep stress','—')+kvr('High / Medium / Low','— / — / —'))
    + card(`<button class="act" style="width:100%">Start a Stress Session</button>`+scaffold('<div style="margin-top:8px">Live stress = our HRV/HR blend (calibratable). Day & sleep stress totals come once we accumulate sessions.</div>')); } },

  // ----- DETAIL: Journal -----
  { id:'journal', build:()=>
    hd('Journal','behaviours that affect recovery')
    + card(['Alcohol','Caffeine late','Screen time in bed','Stressful day','Read in bed','Magnesium','Ate late','Shared bed','Sick / ill','Travel / jet lag']
        .map(b=>`<div class="hrow"><span class="hk">${b}</span><span class="hv"><span class="soon" style="border-color:var(--strain);color:var(--strain)">log</span></span></div>`).join(''))
    + card(hd('Journal Insights')+scaffold('Once you log behaviours across nights, we correlate each against your recovery delta — the same as WHOOP’s “behaviours that helped/hurt”.')) },

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
    + card(`<button class="act" style="width:100%">Set a smart alarm</button>`+scaffold('<div style="margin-top:8px">Bedtime/wake derive from our sleep-need model (calibrated) + your consistency. Haptic alarm needs the band alarm command (cmd 66/68).</div>')); } },

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
    + card(hd('Menstrual Cycle')+kvr('Phase','— (follicular / ovulatory / luteal / menstrual)')+kvr('Cycle day','—')+`<button class="act" style="width:100%;margin-top:10px">Log period</button>`)
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
    hd('Stealth Mode')
    + card(scaffold('Hide all metrics for a defined period — band keeps recording, scores are concealed.'))
    + card(`<button class="act" style="width:100%">Turn on Stealth Mode</button>`) },

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
    + card(`<div class="chips">${['Recovery','Sleep','Day Strain','HRV'].map(m=>`<span class="chip">${m}</span>`).join('')}</div>`+`<button class="act" style="width:100%;margin-top:12px">Share card</button>`) },

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
  for(const id of ['dailysync','hello','battery','range','rthr','synchist','fullsync','bandcheck','forcetrim','imurt','imuprobe','disconnect','csend']){ const el=$(id); if(el) el.disabled=!on; }
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
  let idx, ts, hr, key;
  if(p[0]===48){                                   // 5.0 EVENT(48) record: ts@4, counter@8, HR offset TBD
    ts=u32at(p,4);
    if(ts<1500000000||ts>4000000000) return;       // skip untimestamped boot/info events
    idx=u32at(p,8); hr=0; key='e'+ts+':'+p[2];      // dedup by timestamp+subcode (counter isn't a clean idx)
  }else{                                            // 4.0 HISTORICAL_DATA(47): idx@3, ts@7, HR@14
    idx=u32at(p,3); ts=u32at(p,7); hr=p.length>14?p[14]:0; key='h'+idx;
  }
  if(!pullSeen.has(key)){ pullSeen.add(key); pullRecords.push({idx,ts,hr,src:p[0]}); }
}
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
    showPullPreview({ nd, minTs, maxTs, hrs, hv });               // on-device readout so a bad night shows immediately
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
// Scan a get_data_range payload for the oldest plausible record timestamp (u32 within now±window).
function parseDataRangeOldest(p){
  const nowS=Math.floor(Date.now()/1000), lo=nowS-3*86400, hi=nowS+3600; let oldest=null;
  for(let o=3;o+4<=p.length;o++){ const v=(p[o]|(p[o+1]<<8)|(p[o+2]<<16)|(p[o+3]<<24))>>>0;
    if(v>=lo && v<=hi && (oldest===null||v<oldest)) oldest=v; }
  return oldest;
}
let dataRangeRaw=null;   // last raw get_data_range response (for read-pointer analysis)
async function readOldest(){ dataRangeOldestTs=null; dataRangeRaw=null; await send(34,[],'get_data_range'); await delay(1500); return dataRangeOldestTs; }
const tsStr=(t)=> t ? new Date(t*1000).toLocaleString() : '(not parsed)';

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
  const first=pullRecords.reduce((m,r)=> r.ts<m.ts?r:m, pullRecords[0]);
  return { ts:first.ts, trim:drain.endTrim };
}
// The historical dump reads from the TRIM (the commit cursor); FORCE_TRIM (cmd 25) moves it. The seek
// converts time→trim using this rate, refined live from probes (~15 s per trim unit on the 5.0).
let SEC_PER_TRIM = 15.0;     // refined live from probes

// FORCE_TRIM (cmd 25) — forces the TRIM (the commit cursor the historical dump actually reads from; it's
// the value we ack). Unlike cmd 33 (a separate read pointer that didn't move the dump), this should move
// the dump's start. Uses the same date/time box as Seek; sends the trim directly (no page conversion),
// then probes where the dump starts and refines. EXPERIMENTAL — only on data WHOOP already has.
async function forceTrimSeek(){
  if(!deviceId){ log('connect first','err'); return false; }
  const v=$('seekdt').value; const target=v ? Math.floor(Date.parse(v)/1000) : NaN;
  if(!Number.isFinite(target)){ log('pick a date & time (the “Night to pull” box) first','err'); return false; }
  log(`🎯 FORCE_TRIM (cmd 25) to ${new Date(target*1000).toLocaleString()} …`,'cmd');
  let a=await probeReadPos();
  if(!a || a.trim==null){ log('probe failed — no records / no trim.','err'); return false; }
  log(`start: read head at ${tsStr(a.ts)} (trim ${a.trim})`,'dim');
  for(let iter=1; iter<=4; iter++){
    let trimEst=Math.round(a.trim + (target - a.ts)/SEC_PER_TRIM); if(trimEst<0) trimEst=0;
    log(`→ FORCE_TRIM (cmd 25) = ${trimEst} [iter ${iter}, ${SEC_PER_TRIM.toFixed(1)} s/trim]`,'cmd');
    await send(20,[],'abort'); await delay(300);
    await send(25,[trimEst&0xFF,(trimEst>>>8)&0xFF,(trimEst>>>16)&0xFF,(trimEst>>>24)&0xFF, 0,0,0,0],'force_trim'); await delay(500);
    const b=await probeReadPos();
    if(!b || b.trim==null){ log('no records after FORCE_TRIM — may be past the end. Try an earlier time.','err'); return false; }
    const errMin=(b.ts-target)/60;
    log(`landed at ${tsStr(b.ts)} (trim ${b.trim}) — off by ${errMin.toFixed(0)} min`, Math.abs(errMin)<15?'ok':'cmd');
    if(b.ts===a.ts && b.trim===a.trim && iter>1){ log('✗ FORCE_TRIM did not move the read head. Save the file — the console will show what cmd 25 did.','err'); return false; }
    if(Math.abs(errMin)<10){ log('🎉 Within 10 min — FORCE_TRIM rewound the dump to that night.','ok'); return true; }
    if(b.trim!==a.trim){ const r=(b.ts-a.ts)/(b.trim-a.trim); if(r>1 && r<120) SEC_PER_TRIM=r; }
    a=b;
  }
  log('Got as close as it could — pulling from here.','dim');
  return true;
}

// ── ONE-TAP daily calibration pull (Phase 1): FORCE_TRIM back to last night → drain → auto-export. ──
// In calibration mode the WHOOP app syncs first (creating the cloud answer-key) and ITS sync advances the
// band's commit cursor PAST that night — so a plain Sync would start at "now" and pull nothing. We rewind
// with FORCE_TRIM (cmd 25) to the chosen evening (data persists ~4–5 days in flash), then drain that night
// and ship it straight to the laptop drop-box. Defaults the target to ~20:00 yesterday if the box is empty.
function toLocalInput(d){ const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
async function dailySync(){
  if(!deviceId){ log('connect first','err'); return; }
  if(pulling){ await drainHistory(); return; }                 // already running → let the button stop it
  if(!$('seekdt').value){ const d=new Date(); d.setDate(d.getDate()-1); d.setHours(20,0,0,0);
    $('seekdt').value = toLocalInput(d); log(`night not set — defaulting to last night (${d.toLocaleString()})`,'dim'); }
  // One confirm for the whole managed pull (then suppress drainHistory's per-pass confirm).
  if(!window.confirm('⚠️ Pull last night off the band? This advances the band’s sync cursor and FREES the records it reads, so let the official WHOOP app sync FIRST. It keeps draining until it reaches this morning, so the whole sleep window is captured.\n\nProceed?')){
    log('daily pull cancelled — let the WHOOP app sync first.','dim'); return; }
  { const db=$('dailysync'); if(db){ db.textContent='Syncing… (tap to stop)'; db.classList.add('live'); } }
  skipDrainConfirm = true; autoExport = false;                 // we confirm once here and export once at the end
  const agg = { n:0, minTs:Infinity, maxTs:0, hv:[] };          // aggregate across continuation passes
  let lastMax = 0;
  try{
    for(let pass=1; pass<=8; pass++){
      if(pass===1) log('① Rewinding to last night (FORCE_TRIM)…','cmd');
      else { $('seekdt').value = toLocalInput(new Date(lastMax)); log(`↻ Continuing from ${new Date(lastMax).toLocaleTimeString()} (pass ${pass})…`,'cmd'); }
      const ok = await forceTrimSeek();
      if(!ok){ if(pass===1){ log('seek failed — nothing pulled. Adjust “Night to pull” and tap again.','err'); return; } break; }
      log(`② Draining the night${pass>1?` (pass ${pass})`:''}…`,'cmd');
      await drainHistory();
      for(const r of pullRecords) if(r.src===47){ agg.n++; if(r.ts<agg.minTs)agg.minTs=r.ts; if(r.ts>agg.maxTs)agg.maxTs=r.ts; if(r.hr>0)agg.hv.push(r.hr); }
      const passMaxMs = pullMaxTs()*1000;
      if(!pulling && passMaxMs<=lastMax){ break; }              // user stopped, no new ground → done
      if(passMaxMs <= lastMax + 60000){ log('no further records — reached the end of the buffer.','dim'); break; }
      lastMax = passMaxMs;
      if(Date.now() - lastMax < 20*60000){ log('✓ Caught up to now — whole night captured.','ok'); break; }
      if(pass===8) log('reached pass limit — stopping. Tap again if more remains.','dim');
    }
  }
  catch(e){ log('daily pull error: '+e.message,'err'); }
  finally{ skipDrainConfirm=false; const db=$('dailysync'); if(db){ db.textContent='Pull last night → laptop'; db.classList.remove('live'); } }
  // One aggregate preview + one export for the whole multi-pass capture.
  const hrs = agg.n ? ((agg.maxTs-agg.minTs)/3600).toFixed(1)+'h' : '0h';
  showPullPreview({ nd:agg.n, minTs:agg.minTs, maxTs:agg.maxTs, hrs, hv:agg.hv });
  if(agg.n>60){
    const host=(($('laphost')&&$('laphost').value)||'').trim();
    if(/^[\w.\-]+:\d{2,5}$/.test(host)){ log('③ Auto-sending the full night to laptop…','cmd'); await sendToLaptop(); }
    else { log('③ No laptop address set — opening Save-to-Files…','dim'); await downloadCapture(); }
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
  if(imuRtOn) startCaptureIfNeeded();
  await send(106,[imuRtOn?0x01:0x00], imuRtOn?'toggle_imu_mode ON (realtime IMU)':'toggle_imu_mode OFF');
  const b=$('imurt'); if(b){ b.textContent='Realtime IMU: '+(imuRtOn?'on':'off'); b.classList.toggle('live',imuRtOn); }
  if(imuRtOn) log('🟢 IMU ON. Do this slowly so the axes are decodable: hold the band FLAT & STILL ~5s, then tilt onto each edge (X), each end (Y), face-down (Z) ~3s each, then SHAKE ~3s. Watch the fd4b counter for a NEW packet type. Then turn off & Send to laptop.','ok');
  else log('IMU off. Save file / Send to laptop — I’ll decode the int16 6-axis layout (gravity ≈ ±1 g on whichever axis is down; gyro ≈ 0 at rest).','ok');
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
    for(const [ch,label] of [[RX_CMD,'command_from_strap'],[RX_EVT,'events_from_strap'],[RX_DAT,'data_from_strap'],[RX_HF,'hifreq_from_strap']]){
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
  pulling=false; drain=null;
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
  renderAll();
}

/* ----------------------------- wire up ------------------------------------ */
document.addEventListener('DOMContentLoaded', ()=>{
  SplashScreen.hide().catch(()=>{});
  buildSections();                                   // create the generated detail/hub screens
  document.querySelectorAll('#tabs button').forEach(b=> b.onclick=()=>showTab(b.dataset.tab));
  document.querySelectorAll('[data-go]').forEach(el=> el.onclick=()=>goScreen(el.dataset.go));
  // delegated navigation: any element with data-nav pushes a detail screen; data-back / the back button pops.
  document.addEventListener('click', (e)=>{ const n=e.target.closest('[data-nav]'); if(n){ goScreen(n.dataset.nav); return; }
    if(e.target.closest('[data-back]')) goBack(); });
  { const bb=$('backbtn'); if(bb) bb.onclick=goBack; }
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
  { const a=$('imurt'); if(a) a.onclick=toggleImuRealtime; }
  { const a=$('imuprobe'); if(a) a.onclick=imuHistoricalProbe; }
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
});
