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

/* ----------------------------- tabs --------------------------------------- */
let curTab='overview';
function renderScreen(name){
  if(name==='overview') renderOverview();
  else if(name==='recovery') renderRecovery();
  else if(name==='strain') renderStrain();
  else if(name==='sleep') renderSleep();
  else if(name==='trends') renderTrends();
}
function renderAll(){ renderScreen(curTab); }
// Live updates from the BLE feed — patch only the cheap fields, never rebuild charts.
function updateLive(){
  setHTML('ov-hr',  (state.hr!=null?state.hr:'—')+'<small>bpm</small>');
  setHTML('ov-hrv', (state.hrvMs!=null?state.hrvMs:SAMPLE.recovery.hrv)+'<small>ms</small>');
  if(curTab==='overview'){ renderHealth(); renderStress(); }
  if(curTab==='strain') setField('str-hrnow', state.hr!=null?('live '+state.hr+' bpm'):'live —');
}
function showTab(name){
  curTab=name;
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('on', s.id==='s-'+name));
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
  window.scrollTo(0,0); renderScreen(name);
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
  updateLive();
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
let capturing=false; const capture=[]; const CAP_MAX=100000;  // big enough to hold a full overnight pull for file export
function renderRt(){ const el=$('rt'); if(!el) return;
  const rows=Object.keys(rt.counts).sort().map(k=>`${k}:${rt.counts[k]}`);
  el.textContent = rows.length ? rows.join('   ') : 'none yet'; }
function onFrame(label, dv){
  const info=parseFrame(dv); logFrame('RX['+label+']', info);
  if(!info.error){ const k=info.name; rt.counts[k]=(rt.counts[k]||0)+1; renderRt(); }
  // REALTIME_DATA(40) decoded from real captures: [8]=HR bpm, [9]=RR-present flag,
  // [10..12)=RR interval ms (verified: mean HR byte ≈ 60000/mean RR).
  if(info.packetType===40 && info.payloadBytes && info.payloadBytes.length>=12){
    const p=info.payloadBytes, hr=p[8], rr=(p[9]===1)?(p[10]|(p[11]<<8)):0;
    if(hr>0) state.hr=hr;
    if(rr>0){ pushRR(rr); state.hrvMs=rmssd(); }
    if(hr>0||rr>0) updateLive();
    log(`  → HR ${hr} bpm${rr?('  RR '+rr+' ms'):''}`, 'ok');
  }
  if(histSync && (info.packetType===47 || info.packetType===48)){
    if(info.packetType===47) histCount++;
    if(histAck){ clearTimeout(histAckTimer);          // read-only mode skips the ack/commit
      histAckTimer=setTimeout(()=>{ if(histSync && histAck) send(23, HIST_ACK, 'hist_ack'); }, 800); }
  }
  if(pulling && info.packetType===47 && info.payloadBytes) onPullRecord(info.payloadBytes);
  if(info.packetType===36 && info.code===0x22 && info.payloadBytes){     // get_data_range response → grab oldest buffered ts
    const ts=parseDataRangeOldest(info.payloadBytes); if(ts) dataRangeOldestTs=ts;
  }
  if(capturing){ capture.push({t:Date.now(), ch:label, hex:info.rawHex}); if(capture.length>CAP_MAX) capture.shift(); }
}
const captureText = ()=> capture.map(c=>`${new Date(c.t).toISOString()}\t${c.ch}\t${c.hex}`).join('\n');
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
  for(const id of ['hello','battery','range','rthr','synchist','pullnight','trimtest','disconnect','csend']){ const el=$(id); if(el) el.disabled=!on; }
  const c=$('connect'); if(c) c.disabled=on;
}
// cmd 3 = toggle_realtime_hr: data [01] starts the REALTIME_DATA(40) stream, [00] stops it.
let rtHrOn=false;
async function toggleRealtimeHr(){
  rtHrOn=!rtHrOn;
  await send(3,[rtHrOn?0x01:0x00], rtHrOn?'toggle_realtime_hr ON':'toggle_realtime_hr OFF');
  const b=$('rthr'); if(b){ b.textContent='Realtime HR: '+(rtHrOn?'on':'off'); b.classList.toggle('live',rtHrOn); }
}
// Historical sync (payloads per goose): get_data_range(34,[]) → send_historical_data(22,[]); the band
// then streams HISTORICAL_DATA(47). We ack each burst with historical_data_result(23,[1,0,0,0,0,0,0,0,0])
// to keep it flowing, and abort_historical_transmits(20) to stop.
// histAck: when false (Read-only box ticked) we stream HISTORICAL_DATA(47) but never send the
// historical_data_result(23) commit, so the band keeps the data for the official app to sync.
let histSync=false, histAck=true, histAckTimer=null, histCount=0;
const HIST_ACK=[1,0,0,0,0,0,0,0,0];
async function syncHistory(){
  if(!deviceId){ log('connect first','err'); return; }
  const ro=$('histro');
  if(histSync){ histSync=false; clearTimeout(histAckTimer);
    await send(20,[],'abort_historical_transmits');
    const b=$('synchist'); if(b){ b.textContent='Sync history'; b.classList.remove('live'); }
    if(ro) ro.disabled=false;
    log(`history sync stopped — ${histCount} HISTORICAL packets (${histAck?'committed/acked':'read-only — NOT acked, left on band'}). Send to laptop.`, 'ok'); return; }
  histSync=true; histCount=0;
  histAck = !(ro && ro.checked);
  // Acked sync COMMITS = wipes the buffer off the band (and it won't reach WHOOP's cloud). That's the
  // Phase-2 standalone mechanism (we become the band's sync client) — NOT for the calibration phase.
  // Confirm-gate it so it can't wipe by accident during calibration. See CLAUDE.md.
  if(histAck && !confirm('Acked sync COMMITS history = it WIPES that data off the band, and it will NOT reach WHOOP\'s cloud. Only do this when YOU are the sole consumer (after cancelling WHOOP). Continue?')){
    histAck=false; if(ro) ro.checked=true; log('kept read-only — acked sync cancelled','dim');
  }
  if(ro) ro.disabled=true;
  if(!capturing){ capturing=true; const c=$('capture'); if(c){ c.textContent='Stop capture'; c.classList.add('live'); } log('capture auto-started','ok'); }
  const b=$('synchist'); if(b){ b.textContent='Stop sync'; b.classList.add('live'); }
  log(histAck ? 'history sync (will acknowledge/commit each burst)'
             : 'history sync — READ-ONLY: streaming but NOT acknowledging, so the data stays on the band for the official app', 'ok');
  log('→ get_data_range','cmd'); await send(34,[],'get_data_range');
  await new Promise(r=>setTimeout(r,1200));
  log('→ send_historical_data (streaming…)','cmd'); await send(22,[],'send_historical_data');
  log(histAck ? 'leave ~30–60s while HISTORICAL packets stream, then Send to laptop. Tap again to stop.'
             : 'leave ~30–60s. If HISTORICAL stays at 0, the band may need acks — untick Read-only and retry. Tap again to stop.','ok');
}

/* --- Full-night pull: read-only pagination via set_read_pointer (cmd 33) ------------
   The plain sync only returns the oldest ~30 records because get_data_range(34) resets the
   read pointer and nothing advances it without a commit. This walks the pointer forward
   burst-by-burst with set_read_pointer and pulls the whole buffer — WITHOUT ever sending the
   historical_data_result(23) commit/ack, so the band keeps everything for the official app.
   cmd 33's payload encoding is unknown, so the first run AUTO-PROBES: after each burst stalls
   it tries each candidate encoding of (lastRecordIndex+1) until one actually advances, then
   locks onto the winner for the rest of the pull. (47) layout: [3..6]=record idx u32 LE,
   [7..10]=unix ts u32 LE, [14]=HR — per tools/whoop-decode.mjs.                              */
const delay = (ms)=> new Promise(r=>setTimeout(r,ms));
const QUIET_MS = 1500, BURST_MAX_MS = 9000;
const u32le = (n)=> [n&0xFF,(n>>>8)&0xFF,(n>>>16)&0xFF,(n>>>24)&0xFF];
const u64le = (n)=> [...u32le(n>>>0), ...u32le(Math.floor(n/4294967296))];
// Candidate set_read_pointer payloads, tried in order until one advances the stream.
const POINTER_ENCODINGS = [
  { id:'idx-u32', bytes:(idx,ts)=> u32le(idx) },
  { id:'idx-u64', bytes:(idx,ts)=> u64le(idx) },
  { id:'ts-u32',  bytes:(idx,ts)=> u32le(ts)  },
];
let pulling=false; const pullRecords=[]; const pullSeen=new Set();
let burstResolve=null, burstQuietT=null, burstHardT=null;
const u32at = (p,o)=> (p[o]|(p[o+1]<<8)|(p[o+2]<<16)|(p[o+3]<<24))>>>0;
function onPullRecord(p){
  if(p.length<11) return;
  const idx=u32at(p,3), ts=u32at(p,7), hr=p.length>14?p[14]:0;
  if(!pullSeen.has(idx)){ pullSeen.add(idx); pullRecords.push({idx,ts,hr}); }
  if(burstResolve){ clearTimeout(burstQuietT);     // each record resets the inter-burst quiet timer
    burstQuietT=setTimeout(()=>{ const r=burstResolve; burstResolve=null; clearTimeout(burstHardT); r&&r(); }, QUIET_MS); }
}
// Resolve when the current burst goes quiet (QUIET_MS with no new 47) or BURST_MAX_MS elapses.
function waitBurst(){
  return new Promise(res=>{
    burstResolve=res;
    burstQuietT=setTimeout(()=>{ const r=burstResolve; burstResolve=null; clearTimeout(burstHardT); r&&r(); }, QUIET_MS);
    burstHardT =setTimeout(()=>{ const r=burstResolve; burstResolve=null; clearTimeout(burstQuietT); r&&r(); }, BURST_MAX_MS);
  });
}
const pullMax   = ()=> pullRecords.reduce((m,r)=> r.idx>m.idx?r:m, {idx:-1,ts:0});
const pullMinTs = ()=> pullRecords.reduce((m,r)=> r.ts<m?r.ts:m, Infinity);
const pullMaxTs = ()=> pullRecords.reduce((m,r)=> r.ts>m?r.ts:m, 0);

async function pullNight(){
  if(!deviceId){ log('connect first','err'); return; }
  if(pulling){ pulling=false; log('pull: stop requested — halting after this burst','dim');
    const b=$('pullnight'); if(b){ b.textContent='Pull full night'; b.classList.remove('live'); } return; }
  pulling=true; pullRecords.length=0; pullSeen.clear();
  if(!capturing){ capturing=true; const c=$('capture'); if(c){ c.textContent='Stop capture'; c.classList.add('live'); } log('capture auto-started','ok'); }
  const b=$('pullnight'); if(b){ b.textContent='Stop pull'; b.classList.add('live'); }
  log('FULL-NIGHT PULL — read-only, auto-probing set_read_pointer. Never acks/commits (cmd 23), so nothing is wiped.','ok');
  try{
    log('→ get_data_range (open transfer)','cmd'); await send(34,[],'get_data_range'); await delay(1200);
    log('→ send_historical_data (baseline burst)…','cmd'); await send(22,[],'send_historical_data'); await waitBurst();
    let enc=null, max=pullMax().idx, guard=0;
    log(`baseline: ${pullRecords.length} records, up to idx ${max>=0?max:'—'}`, 'ok');
    if(max<0) log('no HISTORICAL(47) at all — reconnect, or nothing is buffered. Stopping.','err');
    while(pulling && max>=0 && guard++<3000){
      const cur=pullMax(); const target=cur.idx+1, ts=cur.ts+1;
      let advanced=false;
      for(const cand of (enc?[enc]:POINTER_ENCODINGS)){
        if(!pulling) break;
        log(`→ set_read_pointer[${cand.id}] → idx ${target}`,'cmd');
        await send(33, cand.bytes(target,ts), 'set_read_pointer'); await delay(300);
        await send(22,[],'send_historical_data'); await waitBurst();
        const nm=pullMax().idx;
        if(nm>max){ enc=cand; max=nm; advanced=true;
          log(`  ✓ ${cand.id} advanced → idx ${max} (${pullRecords.length} records)`, 'ok'); break; }
        log(`  ✗ ${cand.id}: no advance`, 'dim');
      }
      if(!advanced){ log(`reached the end (or no pointer format advanced past idx ${max}). Stopping.`, enc?'ok':'err'); break; }
      if(pullRecords.length>120000){ log('record cap reached — stopping','dim'); break; }
    }
    const span = pullRecords.length ? `${new Date(pullMinTs()*1000).toLocaleString()} → ${new Date(pullMaxTs()*1000).toLocaleString()}` : '—';
    const hrs  = pullRecords.length ? ((pullMaxTs()-pullMinTs())/3600).toFixed(1)+'h' : '0h';
    log(`PULL DONE: ${pullRecords.length} records spanning ${hrs} (${span}); pointer format = ${enc?enc.id:'NONE FOUND'}. Now tap Save file / Send to laptop.`, 'ok');
  }catch(e){ log('pull error: '+e.message,'err'); }
  finally{ pulling=false; const bb=$('pullnight'); if(bb){ bb.textContent='Pull full night'; bb.classList.remove('live'); } }
}

/* --- Trim test: is the ack destructive? (one-button, safe) -----------------------------
   To get past the ~30-record window the band wants an ack (historical_data_result/23) for flow
   control. The open question is whether that ack also COMMITS/trims the buffer (which would stop
   the official WHOOP app from syncing the same data → no calibration answer-key). This test pokes
   ONLY the oldest ~60 records (read oldest-first, so it never reaches last night), then re-reads
   the data range to see if the oldest buffered timestamp moved. Oldest unchanged ⇒ ack is
   non-destructive; oldest advanced ⇒ ack deleted what we read. Either way it stops after 2 windows. */
let dataRangeOldestTs=null;
// Scan a get_data_range payload for the oldest plausible record timestamp (u32 within now±window).
function parseDataRangeOldest(p){
  const nowS=Math.floor(Date.now()/1000), lo=nowS-3*86400, hi=nowS+3600; let oldest=null;
  for(let o=3;o+4<=p.length;o++){ const v=(p[o]|(p[o+1]<<8)|(p[o+2]<<16)|(p[o+3]<<24))>>>0;
    if(v>=lo && v<=hi && (oldest===null||v<oldest)) oldest=v; }
  return oldest;
}
async function readOldest(){ dataRangeOldestTs=null; await send(34,[],'get_data_range'); await delay(1500); return dataRangeOldestTs; }
const tsStr=(t)=> t ? new Date(t*1000).toLocaleString() : '(not parsed)';

// Answered (2026-06-20): the ack COMMITS to the read pointer = wipes the buffer. That's expected — it
// is the normal full-sync mechanism for Phase 2 / standalone (we become the band's sync client). This
// destructive one-shot test is disabled so we don't wipe during the cloud-calibration phase; use
// "Sync history" (acked, confirm-gated) deliberately when you're the sole consumer. See CLAUDE.md.
async function trimTest(){
  log('Trim test already answered: the ack COMMITS = wipes the band buffer (the normal Phase-2 full-sync mechanism). Disabled here to avoid wiping during calibration — use Sync history (acked) deliberately when you\'re the sole consumer.', 'dim');
  return;
}
async function _trimTest_disabled(){
  if(!deviceId){ log('connect first','err'); return; }
  if(pulling){ log('a pull/test is already running — stop it first','err'); return; }
  if(!capturing){ capturing=true; const c=$('capture'); if(c){ c.textContent='Stop capture'; c.classList.add('live'); } }
  const b=$('trimtest'); if(b){ b.disabled=true; b.textContent='Trim test…'; b.classList.add('live'); }
  log('TRIM TEST — pokes only the OLDEST ~60 records (never last night). Checks if acking deletes data.','ok');
  pulling=true; pullRecords.length=0; pullSeen.clear();
  try{
    const before=await readOldest();
    log(`oldest BEFORE: ${tsStr(before)}`,'cmd');

    log('→ send_historical_data (window 1, no ack)…','cmd');
    await send(22,[],'send_historical_data'); await waitBurst();
    const w1=pullRecords.length;
    log(`window 1: ${w1} record(s)`, w1?'ok':'err');

    log('→ historical_data_result ACK [01 00×8] (flow-control, commit-pointer 0)…','cmd');
    await send(23,HIST_ACK,'hist_ack'); await waitBurst();
    const w2=pullRecords.length;
    log(`after ack: ${w2} total — ${w2>w1?('+'+(w2-w1)+' new ⇒ flow control WORKS'):'no new records'}`, w2>w1?'ok':'err');

    log('→ abort_historical_transmits','cmd');
    await send(20,[],'abort_historical_transmits'); await delay(1000);

    const after=await readOldest();
    log(`oldest AFTER:  ${tsStr(after)}`,'cmd');

    if(before && after){
      const moved=after-before;
      if(moved<=2) log(`✅ NON-DESTRUCTIVE: oldest unchanged (Δ${moved}s) — acking does NOT delete. A normal acked Sync history is safe and keeps the data for WHOOP.`,'ok');
      else log(`⚠️ DESTRUCTIVE: oldest jumped +${moved}s — the ack DELETED window 1. Don't acked-sync real data; we need a non-committing path.`,'err');
    } else log('could not parse data range — Save file and send it to me.','err');
    log(`TRIM TEST DONE — w1=${w1}, w2=${w2}, oldestΔ=${(before&&after)?(after-before)+'s':'?'}. Now Save file / Send to laptop.`,'ok');
  }catch(e){ log('trim test error: '+e.message,'err'); }
  finally{ pulling=false; const bb=$('trimtest'); if(bb){ bb.disabled=false; bb.textContent='Trim test (safe)'; bb.classList.remove('live'); } }
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
  histSync=false; clearTimeout(histAckTimer); const sb=$('synchist'); if(sb){ sb.textContent='Sync history'; sb.classList.remove('live'); }
  pulling=false; const pb=$('pullnight'); if(pb){ pb.textContent='Pull full night'; pb.classList.remove('live'); }
  const tb=$('trimtest'); if(tb){ tb.textContent='Trim test (safe)'; tb.classList.remove('live'); }
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
  $('synchist').onclick   = syncHistory;
  $('pullnight').onclick   = pullNight;
  $('trimtest').onclick    = trimTest;
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
