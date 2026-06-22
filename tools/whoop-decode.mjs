#!/usr/bin/env node
/*
 * whoop-decode.mjs — clean-room decoder for the BLE frames WHOOP Core captures.
 *
 * Pure ESM, no deps, no DOM. Mirrors the framing + REALTIME_DATA(40) layout that
 * src/app.js already verified against real captures, factored out here so the
 * calibration harness (tools/calibrate.mjs) can replay capture files offline.
 * Protocol facts only — contains no WHOOP source.
 *
 * Capture line format (drop-box / dumpCapture):  ISO_TIMESTAMP \t CHANNEL \t HEX
 */

export const PKT = { 35:'COMMAND', 36:'COMMAND_RESPONSE', 40:'REALTIME_DATA', 43:'REALTIME_RAW_DATA',
  47:'HISTORICAL_DATA', 48:'EVENT', 49:'METADATA', 50:'CONSOLE_LOGS', 51:'REALTIME_IMU',
  52:'HISTORICAL_IMU', 53:'REL_PUFFIN_EVENTS', 54:'PUFFIN_EVENTS', 56:'PUFFIN_METADATA' };

/* ----------------------------- CRC + framing ------------------------------ */
function crc16_modbus(bytes){ let crc=0xFFFF; for(const b of bytes){ crc^=b; for(let i=0;i<8;i++) crc=(crc&1)?((crc>>>1)^0xA001):(crc>>>1); } return crc&0xFFFF; }
const CRC32_TABLE=(()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; } return t; })();
function crc32(bytes){ let c=0xFFFFFFFF; for(const b of bytes) c=CRC32_TABLE[(c^b)&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }

export function hexToBytes(h){
  h=String(h).trim().replace(/\s+/g,'');
  const a=new Uint8Array(h.length>>1);
  for(let i=0;i<a.length;i++) a[i]=parseInt(h.substr(i*2,2),16);
  return a;
}

/** Decode one raw frame (hex string or Uint8Array). Same logic as app.js parseFrame. */
export function parseFrame(f){
  if(typeof f==='string') f=hexToBytes(f);
  if(f.length<8 || f[0]!==0xAA) return { error:'no 0xAA / short' };
  const declared=f[2]|(f[3]<<8);
  const headOk=crc16_modbus(f.slice(0,6))===(f[6]|(f[7]<<8));
  const truncated=f.length < 8+declared;
  let payload, payOk=null;
  if(truncated){ payload=f.slice(8); }
  else{
    payload=f.slice(8, f.length-4);
    const got=f.slice(f.length-4), c=crc32(payload);
    payOk = got[0]===(c&0xFF) && got[1]===((c>>>8)&0xFF) && got[2]===((c>>>16)&0xFF) && got[3]===((c>>>24)&0xFF);
  }
  const pt=payload[0];
  return { packetType:pt, name:PKT[pt]||('?'+pt), sequence:payload[1], code:payload[2], headOk, payOk, truncated, payload };
}

/* ----------------------------- payload decoders --------------------------- */
// REALTIME_DATA(40): payload[8]=HR bpm, [9]=RR-present flag, [10..11]=RR interval ms (LE).
// Verified in src/app.js against real captures (mean HR ≈ 60000 / mean RR).
export function decodeRealtime(payload){
  if(!payload || payload[0]!==40 || payload.length<9) return null;
  const hr=payload[8];
  const hasRR = payload[9]===1 && payload.length>=12;
  const rr = hasRR ? (payload[10]|(payload[11]<<8)) : 0;     // already milliseconds in (40)
  return { hr: hr>0?hr:null, rr: rr>0?rr:null };
}

// HISTORICAL_DATA(47): the band's buffered per-second samples — a whole active day, not
// just the connected window. Layout verified against a real read-only Sync-history capture
// (band serial 5A00977378, fw 50.36.2.0; records 72551.. @ 2026-06-18 11:28, 1 s apart):
//   [0]      = 0x2f packet type
//   [1]=seq, [2]=0x80 sub-code
//   [3..6]   = record index    (u32 LE, monotonic +1)
//   [7..10]  = unix timestamp   (u32 LE seconds) — verified +1 s per record
//   [11..12] = block/marker (0x2666 / 0x251e) — not needed
//   [14]     = heart rate (bpm) — verified: smooth trend, and 60000/RR ≈ HR
//   [15]     = RR count (0/1/2), then [16..] = RR intervals (u16 LE ms)  ← CONFIRMED on a 2nd 5.0
//              capture (2026-06-21, fw-unknown band): 112-byte records, mean RR 870 ms ≈ 69 bpm.
//   [37,41,45] = accel/orientation as 3× IEEE-754 f32 LE (g units) — CONFIRMED: |vector| = 1.005 g
//              steady at rest (y≈−1.0 g gravity axis). This is the actigraphy signal for sleep movement.
// NOTE: this firmware frames buffered history as HISTORICAL_DATA(47), NOT EVENT(48) — 2486 (47) frames
// in one "Sync full history" run, fully decodable here. EVENT(48) on this band = sparse connection/state
// events only. The 5.0 EVENT(48)-framed history (decodeHistoricalEvent) is a separate firmware/mode.
// One (47) frame = one 1-second record → returns a single sample; decodeCapture aggregates.
export function decodeHistorical(payload){
  if(!payload || payload[0]!==47 || payload.length<15) return null;
  const u32 = (o)=> (payload[o]|(payload[o+1]<<8)|(payload[o+2]<<16)|(payload[o+3]<<24))>>>0;
  const ts = u32(7);
  if(ts < 1500000000 || ts > 4000000000) return null;       // sane unix window (2017..2096)
  const hr = payload[14];
  // RR (tentative): count at [15], then u16 LE ms; kept only when physiologically plausible.
  const rr = [];
  const n = payload[15];
  if(n>0 && n<=4 && payload.length >= 16+2*n){
    for(let i=0;i<n;i++){ const v = payload[16+2*i] | (payload[17+2*i]<<8); if(v>250 && v<2500) rr.push(v); }
  }
  // Accel/orientation triplet (g): f32 LE at 37/41/45. Only present in the 112-byte rich record.
  // NB (per decompiled WHOOP APK, 2026-06-22): this is a PROCESSED orientation/gravity vector (|v|≈1.0 g),
  // NOT WHOOP's raw IMU. Raw high-rate actigraphy is a separate int16 6-axis R21 record (cmd 105) — see CLAUDE.md.
  let acc = null;
  if(payload.length >= 49){
    const f32 = (o)=> new DataView(new Uint8Array(payload.slice(o,o+4)).buffer).getFloat32(0, true);
    const x=f32(37), y=f32(41), z=f32(45), mag=Math.sqrt(x*x+y*y+z*z);
    if(mag>0.3 && mag<4 && [x,y,z].every(Number.isFinite)) acc = { x, y, z, mag };  // plausible g-vector only
  }
  return [{ t: ts*1000, hr: hr>0?hr:null, rr: rr.length?rr:null, acc }];
}

// HISTORICAL via EVENT(48): on WHOOP 5.0 the buffered dump is NOT framed as HISTORICAL_DATA(47) —
// the band streams its records as EVENT(48) frames between METADATA(49) HISTORY_START/END. Verified
// against a real "Sync full history" capture (band 5A0097737378, fw 50.36.2.0; batch 3 = clean 30-s
// periodic records 2026-05-11 02:15..02:23):
//   [0]      = 0x30 packet type (48 EVENT)
//   [1]=seq, [2]=subcode  (0x03 = periodic metrics record, 0x3f = its companion; other subcodes are
//                          connection / device-info events that carry no sample timestamp)
//   [3]      = 0x00
//   [4..7]   = unix timestamp (u32 LE seconds) — verified +30 s per periodic record
//   [8..11]  = sub-second counter (varies; not a monotonic +1 index)
//   [12..]   = subtype-specific metric fields (HR/RR offsets not yet pinned — need a fuller capture)
// Returns one sample per *timestamped* EVENT (untimestamped boot/info events are skipped). HR is left
// null until its offset is validated against an overnight dump with a WHOOP-app reference.
export function decodeHistoricalEvent(payload){
  if(!payload || payload[0]!==48 || payload.length<8) return null;
  const u32 = (o)=> (payload[o]|(payload[o+1]<<8)|(payload[o+2]<<16)|(payload[o+3]<<24))>>>0;
  const ts = u32(4);
  if(ts < 1500000000 || ts > 4000000000) return null;      // skip events with no sample timestamp
  return { t: ts*1000, idx: u32(8), sub: payload[2], hr: null, rr: null };
}

// METADATA(49): frames the historical dump. [2]=type (1=HISTORY_START, 2=HISTORY_END,
// 3=HISTORY_COMPLETE). HISTORY_END carries the `trim` (flash-record index to ack) — per the
// community 4.0 spec it's a u32 LE at body offset 13. The 5.0 layout may differ, so we also surface
// the u32 candidates at a few offsets to confirm which one the band actually wants as the ack trim.
export const META = { 1:'HISTORY_START', 2:'HISTORY_END', 3:'HISTORY_COMPLETE' };
export function decodeMetadata(payload){
  if(!payload || payload[0]!==49) return null;
  const type = payload[2];
  const u32 = (o)=> (o+4<=payload.length) ? ((payload[o]|(payload[o+1]<<8)|(payload[o+2]<<16)|(payload[o+3]<<24))>>>0) : null;
  const out = { type, name: META[type]||('?'+type) };
  if(type===2){ // HISTORY_END — expose trim candidates for offline confirmation of the 5.0 offset
    out.trim = u32(13);                     // documented (4.0) primary
    out.trimCandidates = { '@3':u32(3), '@5':u32(5), '@9':u32(9), '@13':u32(13), '@17':u32(17) };
    out.unix = u32(3);
  }
  return out;
}

// Build 30-second sleep epochs from decoded HR + RR (+ optional accel) streams: mean HR, HRV (RMSSD over
// the epoch's RR), and a movement metric. When the accel g-vector stream is supplied we use TRUE
// actigraphy (mean |Δvector| between consecutive samples — a real activity count); otherwise we fall
// back to the legacy HR-volatility proxy. These epochs feed scores.classifySleepStages(). epochSeconds
// default 30 (one PSG epoch).
export function buildSleepEpochs(hr, rrs, accel = [], epochSeconds = 30){
  if(typeof accel === 'number'){ epochSeconds = accel; accel = []; }   // back-compat: (hr, rrs, epochSeconds)
  if(!hr || !hr.length) return [];
  const W = epochSeconds*1000;
  const t0 = hr[0].t, tN = hr[hr.length-1].t;
  const epochs = [];
  for(let start=t0; start<=tN; start+=W){
    const end = start+W;
    const hh = hr.filter(s=> s.t>=start && s.t<end).map(s=>s.hr);
    const rr = rrs.filter(s=> s.t>=start && s.t<end).map(s=>s.rr);
    if(!hh.length) continue;
    const mean = hh.reduce((a,b)=>a+b,0)/hh.length;
    const sd = hh.length>1 ? Math.sqrt(hh.reduce((a,b)=>a+(b-mean)**2,0)/(hh.length-1)) : 0;
    let rmssd = null;
    if(rr.length>2){ let s=0,n=0; for(let i=1;i<rr.length;i++){ const d=rr[i]-rr[i-1]; s+=d*d; n++; } rmssd = n?Math.sqrt(s/n):null; }
    // Movement: prefer real actigraphy from the accel g-vector; fall back to HR volatility if absent.
    const av = accel.filter(s=> s.t>=start && s.t<end);
    let move, moveSrc;
    if(av.length>1){ let s=0; for(let i=1;i<av.length;i++){ const d=Math.hypot(av[i].x-av[i-1].x, av[i].y-av[i-1].y, av[i].z-av[i-1].z); s+=d; } move=+(s/(av.length-1)).toFixed(4); moveSrc='accel'; }
    else { move=+sd.toFixed(2); moveSrc='hrvol'; }
    epochs.push({ t:start, hr:Math.round(mean), rmssd: rmssd!=null?Math.round(rmssd):null, move, moveSrc });
  }
  return epochs;
}

/* ----------------------------- capture replay ----------------------------- */
/** One capture line → { t:ms, channel, frame } | null */
export function parseCaptureLine(line){
  const i1=line.indexOf('\t'); if(i1<0) return null;
  const i2=line.indexOf('\t', i1+1); if(i2<0) return null;
  const t=Date.parse(line.slice(0,i1));
  const channel=line.slice(i1+1, i2);
  const hexStr=line.slice(i2+1).trim();
  if(Number.isNaN(t) || !hexStr) return null;
  return { t, channel, frame: parseFrame(hexStr) };
}

/** Whole capture text → time-ordered HR samples, RR intervals, and historical-sync metadata. */
export function decodeCapture(text){
  const hr=[], rrs=[], accel=[], meta=[], histEvents=[];
  let frames=0, realtime=0, historical=0, metadata=0, inHistory=false;
  for(const line of text.split(/\r?\n/)){
    const c=parseCaptureLine(line); if(!c || c.frame.error) continue;
    frames++;
    const p=c.frame.payload;
    const rt=decodeRealtime(p);
    if(rt){ realtime++; if(rt.hr) hr.push({ t:c.t, hr:rt.hr }); if(rt.rr) rrs.push({ t:c.t, rr:rt.rr }); }
    if(p && p[0]===47){ historical++; const h=decodeHistorical(p); if(h && h.length) for(const s of h){
      if(s.hr) hr.push({ t:s.t, hr:s.hr });
      if(s.rr) for(const v of s.rr) rrs.push({ t:s.t, rr:v });    // (47) carries RR too — collect it for HRV
      if(s.acc) accel.push({ t:s.t, ...s.acc }); } }              // and an accel g-vector for actigraphy
    if(p && p[0]===49){ metadata++; const m=decodeMetadata(p);
      if(m){ meta.push({ t:c.t, ...m }); if(m.type===1) inHistory=true; else if(m.type===2||m.type===3) inHistory=false; } }
    // EVENT(48) inside a HISTORY_START/END window = a 5.0 buffered record (see decodeHistoricalEvent).
    if(p && p[0]===48 && inHistory){ const e=decodeHistoricalEvent(p);
      if(e){ historical++; histEvents.push(e); if(e.hr) hr.push({ t:e.t, hr:e.hr }); } }
  }
  hr.sort((a,b)=>a.t-b.t); rrs.sort((a,b)=>a.t-b.t); accel.sort((a,b)=>a.t-b.t); histEvents.sort((a,b)=>a.t-b.t);
  return { hr, rrs, accel, meta, histEvents, stats:{ frames, realtime, historical, metadata } };
}

export const dayKey = (ms)=> new Date(ms).toISOString().slice(0,10);

/* ---------------------------- HR-offset probe ----------------------------- */
// The 5.0 EVENT(48) historical record carries HR somewhere in its metric tail ([12..]); the offset
// isn't pinned yet (decodeHistoricalEvent leaves hr:null). This brute-forces it: for every candidate
// byte offset it pulls that byte across all periodic records of one subcode, in timestamp order, and
// scores it like real HR — mostly in 30..180 bpm, several distinct values (not a flag/constant), and
// smooth between +30 s samples (small median |Δ|). On 4.0 the analogous test confirmed HR@14, so the
// strongest candidate here is the offset to wire into decodeHistoricalEvent. Pure heuristic — confirm
// the winner against a WHOOP-app reference night before trusting it.
export function scanHrOffsets(text, { minRange=30, maxRange=180, offsets=null }={}){
  // Gather periodic EVENT(48) records (inside a HISTORY window, with a sane sample ts), grouped by subcode.
  const bySub = new Map();
  let inHistory=false, longest=0;
  for(const line of text.split(/\r?\n/)){
    const c=parseCaptureLine(line); if(!c || c.frame.error) continue;
    const p=c.frame.payload; if(!p) continue;
    if(p[0]===49){ const t=p[2]; if(t===1) inHistory=true; else if(t===2||t===3) inHistory=false; continue; }
    if(p[0]!==48 || !inHistory) continue;
    const ts=(p[4]|(p[5]<<8)|(p[6]<<16)|(p[7]<<24))>>>0;
    if(ts<1500000000 || ts>4000000000) continue;     // skip untimestamped boot/info events
    const sub=p[2];
    if(!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push({ ts, payload:p });
    if(p.length>longest) longest=p.length;
  }
  const scan = offsets || Array.from({length:Math.max(0,longest-12)}, (_,i)=>12+i);  // metric tail [12..]
  const results=[];
  for(const [sub, recs] of bySub){
    if(recs.length<10) continue;                       // too few to judge
    recs.sort((a,b)=>a.ts-b.ts);
    const dts = recs.slice(1).map((r,i)=> r.ts-recs[i].ts).filter(d=>d>0).sort((a,b)=>a-b);
    const periodSec = dts.length ? dts[dts.length>>1] : null;   // median sample spacing
    for(const o of scan){
      const vals = recs.filter(r=> r.payload.length>o).map(r=> r.payload[o]);
      if(vals.length<10) continue;
      const inRange = vals.filter(v=> v>=minRange && v<=maxRange);
      const inFrac = inRange.length/vals.length;
      const distinct = new Set(inRange).size;
      let mad=null;                                    // median |Δ| between consecutive in-range samples
      if(inRange.length>2){ const d=inRange.slice(1).map((v,i)=>Math.abs(v-inRange[i])).sort((a,b)=>a-b); mad=d[d.length>>1]; }
      // Score: want high in-range coverage, real variation (≥5 distinct), and smooth steps (small mad, but >0).
      const varyOk = distinct>=5 ? 1 : distinct/5;
      const smooth = mad==null ? 0 : 1/(1+mad);
      const score = +(inFrac*varyOk*(0.3+0.7*smooth)).toFixed(4);
      results.push({ sub:'0x'+sub.toString(16).padStart(2,'0'), offset:o, n:vals.length, periodSec,
        inFrac:+inFrac.toFixed(3), distinct, medAbsDelta:mad,
        mean:+(inRange.reduce((a,b)=>a+b,0)/(inRange.length||1)).toFixed(1), score });
    }
  }
  results.sort((a,b)=> b.score-a.score);
  return results;
}

/* IMU / Phase-2 scanner: group frames by record-type code (payload[0]) and, for each, expose the int16
   little-endian column structure so the R21 (int16 6-axis accel+gyro) layout can be reverse-engineered
   from a real capture. Live sensor channels stand out as the int16 offsets with high variance across
   records (especially during the "shake" portion); header/count bytes are near-constant. */
export function scanImu(text){
  const byType = new Map();
  for(const line of text.split(/\r?\n/)){
    const c=parseCaptureLine(line); if(!c || c.frame.error) continue;
    const p=c.frame.payload; if(!p || !p.length) continue;
    const pt=p[0]; let e=byType.get(pt);
    if(!e){ e={ pt, name:c.frame.name, count:0, lens:{}, recs:[] }; byType.set(pt,e); }
    e.count++; e.lens[p.length]=(e.lens[p.length]||0)+1;
    if(e.recs.length<5000) e.recs.push(p);
  }
  return byType;
}
// int16 LE column stats for the modal-length records of one type.
export function imuColumns(recs){
  const lens={}; for(const r of recs) lens[r.length]=(lens[r.length]||0)+1;
  const L=+Object.entries(lens).sort((a,b)=>b[1]-a[1])[0][0];
  const same=recs.filter(r=>r.length===L);
  const cols=[];
  for(let o=0;o+1<L;o++){                                  // try BOTH alignments (o step 1) for int16 LE
    const vals=same.map(r=> (r[o] | (r[o+1]<<8))<<16>>16); // signed 16-bit
    const n=vals.length, mean=vals.reduce((a,b)=>a+b,0)/n;
    const mn=Math.min(...vals), mx=Math.max(...vals);
    const sd=Math.sqrt(vals.reduce((a,b)=>a+(b-mean)*(b-mean),0)/n);
    cols.push({ off:o, mean:Math.round(mean), min:mn, max:mx, sd:Math.round(sd), range:mx-mn });
  }
  return { L, n:same.length, cols };
}

/* ------------------------------- CLI entry -------------------------------- */
// node tools/whoop-decode.mjs --scan-hr [file ...]   (defaults to every captures/*.txt)
if(import.meta.url === `file://${process.argv[1]}`){
  const args = process.argv.slice(2);
  if(args[0]==='--scan-hr'){
    const { readFileSync, readdirSync, existsSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.dirname(new URL('.', import.meta.url).pathname);
    let files = args.slice(1);
    if(!files.length){ const dir=path.join(root,'captures');
      files = existsSync(dir) ? readdirSync(dir).filter(f=>f.endsWith('.txt')).map(f=>path.join(dir,f)) : []; }
    if(!files.length){ console.error('No capture files. Drop captures/*.txt or pass paths: --scan-hr FILE…'); process.exit(1); }
    const text = files.map(f=> readFileSync(f,'utf8')).join('\n');
    const { stats, histEvents } = decodeCapture(text);
    console.log(`\nScanned ${files.length} file(s): ${stats.frames} frames, ${histEvents.length} timestamped EVENT(48) records.`);
    const rows = scanHrOffsets(text);
    if(!rows.length){ console.log('No periodic EVENT(48) records inside a HISTORY window — capture a worn-night "Sync full history" run first.'); process.exit(0); }
    console.log('\nHR-offset candidates (best first) — look for high inFrac, distinct ≥5, small medAbsDelta, mean 50–70:\n');
    console.log(['sub','offset','n','periodSec','inFrac','distinct','medAbsΔ','mean','score'].join('\t'));
    for(const r of rows.slice(0,15))
      console.log([r.sub, r.offset, r.n, r.periodSec, r.inFrac, r.distinct, r.medAbsDelta, r.mean, r.score].join('\t'));
    console.log('\nWire the top offset into decodeHistoricalEvent (payload[<offset>]) once a WHOOP-app night confirms it.');
  } else if(args[0]==='--scan-imu'){
    const { readFileSync } = await import('node:fs');
    const files = args.slice(1);
    if(!files.length){ console.error('Usage: node tools/whoop-decode.mjs --scan-imu <capture.txt> [more…]'); process.exit(1); }
    const text = files.map(f=> readFileSync(f,'utf8')).join('\n');
    const byType = scanImu(text);
    const KNOWN = new Set([40,47,48,49,50,36,35]);
    const types = [...byType.values()].sort((a,b)=>b.count-a.count);
    console.log('\nRecord types seen (payload[0]):\n');
    console.log(['code','name','count','lengths(len×n)'].join('\t'));
    for(const e of types){
      const lens=Object.entries(e.lens).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([l,n])=>`${l}×${n}`).join(' ');
      console.log([e.pt, e.name, e.count, lens].join('\t') + (KNOWN.has(e.pt)?'':'   ← candidate IMU/new'));
    }
    // Deep-dive every non-known (candidate) type: int16 column variance → live sensor channels.
    for(const e of types){
      if(KNOWN.has(e.pt) || e.count<5) continue;
      const { L, n, cols } = imuColumns(e.recs);
      console.log(`\n── type ${e.pt} (${e.name}) · ${n} records of modal length ${L}B ──`);
      console.log('high-variance int16 LE offsets (the live accel/gyro channels stand out):');
      console.log(['off','mean','min','max','sd','range'].join('\t'));
      for(const c of [...cols].sort((a,b)=>b.sd-a.sd).slice(0,16))
        console.log([c.off, c.mean, c.min, c.max, c.sd, c.range].join('\t'));
      console.log('\nfirst 3 records (hex) for structure:');
      for(const r of e.recs.slice(0,3)) console.log('  '+Buffer.from(r).toString('hex'));
      console.log('\nGuide: 3 accel axes → one ≈ ±gravity (≈ ±2048/4096/8192/16384 counts for ±2g int16), two ≈ 0 at rest;');
      console.log('3 gyro axes ≈ 0 at rest, spike on shake. Constant offsets = header (timestamp / sample counts).');
    }
    if(types.every(e=>KNOWN.has(e.pt))) console.log('\n⚠ No new record type appeared — the IMU toggle (cmd 105/106) may need a different data byte, or IMU isn’t enabled. Try the realtime toggle while moving the band.');
  } else {
    console.error('Usage: node tools/whoop-decode.mjs --scan-hr [file ...]\n       node tools/whoop-decode.mjs --scan-imu <capture.txt>');
    process.exit(1);
  }
}
