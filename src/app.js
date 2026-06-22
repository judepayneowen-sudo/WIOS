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
  // Buffered records arrive as HISTORICAL_DATA(47) on 4.0, but as EVENT(48) on 5.0 — capture both.
  if(pulling && (info.packetType===47||info.packetType===48) && info.payloadBytes) onPullRecord(info.payloadBytes);
  if(pulling && info.packetType===49 && info.payloadBytes) onHistMeta(info.payloadBytes);  // METADATA: HISTORY_END trim / COMPLETE
  if(info.packetType===36 && info.code===0x22 && info.payloadBytes){     // get_data_range response
    dataRangeRaw = info.payloadBytes;                                    // keep raw for pointer analysis
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
  for(const id of ['hello','battery','range','rthr','synchist','fullsync','bandcheck','ptrread','ptrset','seekbtn','hfsync','pwrcycle','softreboot','disconnect','csend']){ const el=$(id); if(el) el.disabled=!on; }
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
let pulling=false; const pullRecords=[]; const pullSeen=new Set();
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
  if(!window.confirm(msg)) { log('full sync cancelled — let the WHOOP app sync first, or use Quick sync (read-only).','dim'); return; }
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
          else if(guard%20===0) log(`  …${pullRecords.length} records up to ${new Date(pullMaxTs()*1000).toLocaleTimeString()} (idx ${pullMax().idx})`,'dim');
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
  }catch(e){ log('sync error: '+e.message,'err'); }
  finally{ pulling=false; const bb=$('fullsync'); if(bb){ bb.textContent='Sync full history'; bb.classList.remove('live'); } }
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
// EXPERIMENT (safe — cmd 96 is a documented sync command, not firmware): the WHOOP 5.0 protocol
// (per the whoop-vault project) requires ENTER_HIGH_FREQ_SYNC (cmd 96) BEFORE send_historical_data —
// a handshake we've never sent. Test whether entering that mode re-initialises the read session to the
// OLDEST record (the rewind we want). Sends cmd 96, then probes where the next dump starts.
async function hfSyncProbe(){
  if(!deviceId){ log('connect first','err'); return; }
  log('Before (baseline):','cmd');
  const before=await probeReadPos();
  if(before) log(`  dump currently starts at ${tsStr(before.ts)} (trim ${before.trim})`,'dim');
  log('→ enter_high_freq_sync (cmd 96)','cmd');
  await send(96,[0x01],'enter_high_freq_sync'); await delay(700);
  const after=await probeReadPos();
  if(!after){ log('no records after cmd 96 — try again.','err'); return; }
  log(`After cmd 96: dump starts at ${tsStr(after.ts)} (trim ${after.trim})`,'ok');
  if(before && after.trim<before.trim-50) log(`🎉 cmd 96 REWOUND the read session by ${before.trim-after.trim} units — toward the oldest! This is the controllable reset. Save the file.`,'ok');
  else log('cmd 96 did not rewind the read start (same place). Save the file anyway — the console may show what it did.','dim');
}
// THE REWIND TRIGGER (from the decompiled WHOOP command enum via whoop-vault): POWER_CYCLE_STRAP=32 and
// REBOOT_STRAP=29 reboot the band — exactly what the official app's "device reboot" does. A power-style
// reset clears RAM and rewinds the historical read pointer to the OLDEST flash record (observed 2026-06-21,
// reboot reason 0x0007). cmd 32 (power cycle) is the strongest candidate; cmd 29 is the softer reboot.
// NOT a firmware/brick command — but it does reboot, so confirm first.
async function rebootStrap(cmd, name){
  if(!deviceId){ log('connect first','err'); return; }
  if(!window.confirm(`Send ${name} (cmd ${cmd})? This reboots the band — the same thing the official WHOOP app's "device reboot" does. The goal: rewind the read pointer to the oldest record so the next Sync full history re-reads everything (the calibration data).\n\nThe band will disconnect and reboot (~20–40s).\n\nFIRST make sure the official WHOOP app is force-closed, so it can't re-sync and undo the rewind.\n\nContinue?`)) { log('reboot cancelled','dim'); return; }
  log(`→ ${name} (cmd ${cmd}) — band rebooting & disconnecting…`,'cmd');
  await send(cmd,[],name);
  log('Sent. Wait ~30s, RECONNECT, then immediately tap Sync full history (before the WHOOP app reconnects). If it starts from days ago, the rewind worked 🎯. Save the file.','ok');
}
// Read-only: dump the band's current data range + read-pointer candidates, and pre-fill the lowest
// (usually the oldest/read pointer) into the cmd 33 box. Changes nothing on the band.
async function probePointer(){
  if(!deviceId){ log('connect first','err'); return; }
  log('Reading data range + pointers (read-only, changes nothing)…','cmd');
  const ts=await readOldest();
  const cands=pointerCandidates(dataRangeRaw);
  if(!cands.length){ log('No pointer candidates parsed (buffer may be empty). Oldest: '+tsStr(ts),'err'); return; }
  log(`📍 oldest stored: ${tsStr(ts)}. Pointer candidates: ${cands.map(c=>`@${c.off}=${c.val}`).join('  ')}`,'ok');
  const lo=Math.min(...cands.map(c=>c.val));
  const inp=$('ptrval'); if(inp) inp.value=lo;
  log(`Lowest (likely the read pointer) = ${lo} → pre-filled. To test REWIND: drain destructively, read again, then set this back to a value from BEFORE the drain.`,'dim');
}
// Send set_read_pointer (cmd 33) with the chosen value+encoding, then re-read to see if the pointer moved.
// cmd 33 is NOT a critical/brick command and only moves a read pointer — safe to experiment.
async function setPointer(){
  if(!deviceId){ log('connect first','err'); return; }
  const val=parseInt($('ptrval').value,10);
  if(!Number.isFinite(val)){ log('read the pointer first, or type a value','err'); return; }
  const enc=$('ptrenc').value;
  const data = enc==='u16le' ? [val&0xFF,(val>>>8)&0xFF]
            : enc==='u32be' ? [(val>>>24)&0xFF,(val>>>16)&0xFF,(val>>>8)&0xFF,val&0xFF]
            : enc==='u64le' ? [val&0xFF,(val>>>8)&0xFF,(val>>>16)&0xFF,(val>>>24)&0xFF,0,0,0,0]  // [lo32][hi32=0]
            : [val&0xFF,(val>>>8)&0xFF,(val>>>16)&0xFF,(val>>>24)&0xFF];   // u32le default
  const beforeTs=await readOldest(), beforeC=pointerCandidates(dataRangeRaw).map(c=>c.val).join(',');
  log(`→ set_read_pointer (cmd 33) = ${val} (${enc}) [${data.map(b=>b.toString(16).padStart(2,'0')).join(' ')}]`,'cmd');
  await send(33, data, 'set_read_pointer'); await delay(900);
  const afterTs=await readOldest(), afterC=pointerCandidates(dataRangeRaw).map(c=>c.val).join(',');
  log(`BEFORE  oldest ${tsStr(beforeTs)} · pointers [${beforeC}]`,'cmd');
  log(`AFTER   oldest ${tsStr(afterTs)} · pointers [${afterC}]`,'cmd');
  // Honest verdict: the NEWEST pointer naturally creeps up as the band records, so a tiny forward change
  // isn't cmd 33. What matters is the OLDEST timestamp jumping BACKWARD — that's a true rewind.
  const dt = (beforeTs && afterTs) ? (afterTs - beforeTs) : null;   // seconds; negative = went backward
  if(dt!=null && dt < -10) log(`🎉 REWIND! oldest jumped BACK ${Math.round(-dt)}s (${tsStr(beforeTs)} → ${tsStr(afterTs)}). cmd 33 (${enc}) moved the read pointer backward — this is exactly what lets WHOOP re-read after our pull. Save file & send it.`,'ok');
  else if(dt!=null && dt > 60) log(`cmd 33 (${enc}) pushed the read pointer FORWARD ${Math.round(dt)}s (skips data). Good news: it responds to our value — try a LOWER value to rewind instead.`,'ok');
  else log(`✗ No clear move with ${enc}. (Ignore tiny pointer wiggles — the newest pointer drifts up on its own as the band records.) Try another encoding, or a value far from the current one, on a buffer with more than a few minutes of data.`,'dim');
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
// SEEK TO A TIME: the read pointer is a flash counter linear with time (~15 s/unit, from capture analysis).
// Convert the target date/time → a pointer estimate, cmd 33 to it, probe where we landed, refine the rate
// from the two anchors, and repeat. Converging proves cmd 33 seeks AND lands us on the chosen night — then
// a normal Sync full history pulls just that night instead of walking days from the start.
let SEC_PER_TRIM = 15.0;     // refined live from probes
let TRIM_PER_PAGE = 3.0;     // the band addresses the read pointer by flash PAGE; trim ≈ 3 × page (refined live)
async function seekToTime(){
  if(!deviceId){ log('connect first','err'); return; }
  const v=$('seekdt').value; const target=v ? Math.floor(Date.parse(v)/1000) : NaN;
  if(!Number.isFinite(target)){ log('pick a date & time to seek to','err'); return; }
  // cmd 33 = "Force Read Pointer" — payload is [page u32 LE][wrap u32 LE]. The band confirmed this in its
  // console ("Command Force Read Pointer; read page:N wrap count:0"). page ≈ trim/TRIM_PER_PAGE.
  const sendPage=async(page)=>{ const p=Math.max(0,Math.round(page));
    await send(20,[],'abort'); await delay(300);   // clear any active transfer (avoids "transfer already active")
    await send(33, [p&0xFF,(p>>>8)&0xFF,(p>>>16)&0xFF,(p>>>24)&0xFF, 0,0,0,0], 'force_read_pointer'); await delay(500); return p; };
  log(`🎯 Seeking to ${new Date(target*1000).toLocaleString()} …`,'cmd');
  let a=await probeReadPos();
  if(!a || a.trim==null){ log('probe failed — no records / no trim. Connect and make sure the band has buffered data.','err'); return; }
  log(`start: read head at ${tsStr(a.ts)} (trim ${a.trim}, page ≈ ${Math.round(a.trim/TRIM_PER_PAGE)})`,'dim');
  for(let iter=1; iter<=4; iter++){
    const trimEst=Math.round(a.trim + (target - a.ts)/SEC_PER_TRIM);
    const pageEst=Math.round(trimEst/TRIM_PER_PAGE);
    log(`→ Force Read Pointer (cmd 33) page ${Math.max(0,pageEst)} (trim≈${trimEst}) [iter ${iter}, ${SEC_PER_TRIM.toFixed(1)} s/trim ÷ ${TRIM_PER_PAGE.toFixed(2)}]`,'cmd');
    await sendPage(pageEst);
    const b=await probeReadPos();
    if(!b || b.trim==null){ log('no records after the seek — the page may be past the end. Try an earlier time.','err'); return; }
    const errMin=(b.ts-target)/60;
    log(`landed at ${tsStr(b.ts)} (trim ${b.trim}, page ≈ ${Math.round(b.trim/TRIM_PER_PAGE)}) — off by ${errMin.toFixed(0)} min`, Math.abs(errMin)<15?'ok':'cmd');
    if(b.ts===a.ts && b.trim===a.trim && iter>1){ log('✗ The read head did NOT move. Save the file — the band console will show the page it used so the factor can be fixed.','err'); return; }
    if(Math.abs(errMin)<10){ log('✅ Within 10 min of target. Now tap “Sync full history” to pull this night — it starts here, not from days ago.','ok'); return; }
    if(b.trim!==a.trim){ const r=(b.ts-a.ts)/(b.trim-a.trim); if(r>1 && r<120) SEC_PER_TRIM=r; }   // refine s/trim
    a=b;
  }
  log('Got as close as it could — tap “Sync full history” to pull from here (Save the file so the page factor can be refined).','dim');
}

// Read-only: report the band's SYNC CURSOR (oldest not-yet-committed point). IMPORTANT: this is only a
// logical marker, NOT what's physically stored — the band keeps days of records in its NOR flash and a
// full "Sync full history" reads them from the start regardless of this cursor (proven 2026-06-21: pulled
// 4-day-old records while this cursor read "today"). So don't trust it to mean data is gone.
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
  $('fullsync').onclick    = drainHistory;
  $('bandcheck').onclick   = checkBandBuffer;
  $('ptrread').onclick     = probePointer;
  $('ptrset').onclick      = setPointer;
  $('seekbtn').onclick     = seekToTime;
  $('hfsync').onclick      = hfSyncProbe;
  $('pwrcycle').onclick    = ()=>rebootStrap(32,'POWER_CYCLE_STRAP');
  $('softreboot').onclick  = ()=>rebootStrap(29,'REBOOT_STRAP');
  { const am=$('ackmode'); if(am) am.onchange = (e)=>{ ackMode = e.target.value;
      log(ackMode==='normal' ? 'Ack mode: NORMAL (real protocol — frees records, destructive).'
        : `Ack mode: 🧪 EXPERIMENT “${ackMode}”. Only run Sync full history on already-synced data.`, ackMode==='normal'?'dim':'cmd'); }; }
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
