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
//   [15]     = RR count, then [16..] = RR intervals (u16 LE ms)  ← TENTATIVE
//   [~25..]  = IEEE-754 floats (accel/orientation, for sleep activity) — not decoded yet
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
  return [{ t: ts*1000, hr: hr>0?hr:null, rr: rr.length?rr:null }];
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

/** Whole capture text → time-ordered HR samples and RR intervals. */
export function decodeCapture(text){
  const hr=[], rrs=[];
  let frames=0, realtime=0, historical=0;
  for(const line of text.split(/\r?\n/)){
    const c=parseCaptureLine(line); if(!c || c.frame.error) continue;
    frames++;
    const p=c.frame.payload;
    const rt=decodeRealtime(p);
    if(rt){ realtime++; if(rt.hr) hr.push({ t:c.t, hr:rt.hr }); if(rt.rr) rrs.push({ t:c.t, rr:rt.rr }); }
    if(p && p[0]===47){ historical++; const h=decodeHistorical(p); if(h && h.length) for(const s of h){ if(s.hr) hr.push(s); } }
  }
  hr.sort((a,b)=>a.t-b.t); rrs.sort((a,b)=>a.t-b.t);
  return { hr, rrs, stats:{ frames, realtime, historical } };
}

export const dayKey = (ms)=> new Date(ms).toISOString().slice(0,10);
