// src/store.js — on-device persistence for decoded band data (Phase 2).
//
// WHY: the historical pull decodes thousands of (47) records per night, but until now they only lived in
// memory and were shipped off to the laptop. For the standalone end-goal the PHONE has to keep its own copy:
// accumulate nights/days, survive app restarts, and feed scores.js without re-pulling (re-pulling is
// destructive — the ack frees the records). This module is that store.
//
// HOW: IndexedDB (WKWebView gives it hundreds of MB — localStorage caps at ~5 MB, far too small for ~86k
// 1 Hz samples/day). Two object stores:
//   • `days` — keyed by local day "YYYY-MM-DD", the heavy columnar payload (typed arrays). One row per day.
//   • `meta` — keyed by the same day, a light summary (counts, spans, computed scores) for fast listing
//             without loading the megabyte-sized arrays.
// Each pull is ingested by bucketing its records into local days and MERGING into any existing day (dedup by
// timestamp — a re-pull of the same night must not double-count). After a merge the day's summary + Day
// Strain are recomputed from the full merged series.

import { makeStrainAccumulator, maxHeartRate, percentile,
         detectSleepWindow, classifySleepStages, summarizeStages,
         sleepNeedMinutes, sleepPerformance } from './scores.js';

const DB_NAME = 'whoopcore', VERSION = 2;
const DAYS = 'days', META = 'meta', MISC = 'misc';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {                          // additive migrations only — existing day data is preserved
      const db = r.result;
      if (!db.objectStoreNames.contains(DAYS)) db.createObjectStore(DAYS, { keyPath: 'day' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'day' });
      if (!db.objectStoreNames.contains(MISC)) db.createObjectStore(MISC, { keyPath: 'k' });   // kv: last raw capture, etc.
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
// Persist the last raw capture so a pull survives an app restart (re-Save / re-Send to laptop without re-pulling).
export async function saveLastCapture(text, meta = {}) {
  const db = await open();
  await wrap(db.transaction(MISC, 'readwrite').objectStore(MISC).put({ k: 'lastCapture', text, ...meta, at: Date.now() }));
  db.close();
}
export async function loadLastCapture() {
  const db = await open();
  const row = await wrap(db.transaction(MISC).objectStore(MISC).get('lastCapture'));
  db.close();
  return row || null;
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// Local-day key from a unix-SECONDS timestamp (band records are seconds). Buckets by the phone's local
// midnight so "last night" lands on a single calendar day the way the user thinks about it.
export function dayKeyOf(tsSec) {
  const d = new Date(tsSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Compute a day's summary + Day Strain from its merged columnar series. Strain needs only HR + the user's
// profile (no sleep-window detection), so it's always computable here. HRV is an RMSSD proxy over the stored
// representative RR series; resting HR is the 5th-percentile of non-zero HR (overnight floor). Recovery/Sleep
// %s need the sleep window + baselines and are layered on separately once a night is detectable.
export function computeDaySummary(rec, profile = {}) {
  const { ts, hr, skin, spo2, rr, ax, ay, az } = rec;
  const n = rec.n;
  const restingHr = profile.restingHr || 50;
  const maxHr = profile.maxHr > 0 ? profile.maxHr : maxHeartRate(profile.age || 30);
  const sex = profile.sex || 'm';
  const strainAcc = makeStrainAccumulator({ restingHr, maxHr, sex });

  const hrs = [], skins = [], spo2s = [], rrs = [], mags = [];
  for (let i = 0; i < n; i++) {
    const h = hr[i];
    if (h > 0) {
      hrs.push(h);
      const dt = i + 1 < n ? Math.min(60, Math.max(1, ts[i + 1] - ts[i])) : 1; // gap to next sample, clamped
      strainAcc.add(h, dt);
    }
    if (skin[i] > 0) skins.push(skin[i] / 100);
    if (spo2[i] > 0) spo2s.push(spo2[i]);
    if (rr[i] > 0) rrs.push(rr[i]);
    if (ax[i] || ay[i] || az[i]) mags.push(Math.hypot(ax[i], ay[i], az[i]) / 1000);
  }
  // HRV proxy: RMSSD over successive representative RR intervals across the night.
  let rmssd = null;
  if (rrs.length > 5) { let s = 0, c = 0; for (let i = 1; i < rrs.length; i++) { const d = rrs[i] - rrs[i - 1]; if (Math.abs(d) < 400) { s += d * d; c++; } } rmssd = c ? Math.round(Math.sqrt(s / c)) : null; }
  // Activity: mean |accel| deviation from 1 g, and a crude "active minutes" count.
  let activity = null, activeSec = 0;
  if (mags.length) { let s = 0; for (const m of mags) { s += Math.abs(m - 1); if (m > 1.2 || m < 0.8) activeSec++; } activity = +(s / mags.length).toFixed(3); }

  // Standalone sleep: build 30-s epochs (mean HR · RMSSD over the epoch's RR · accel actigraphy = mean
  // |Δ g-vector|), auto-detect the night, classify stages and score performance — no WHOOP cloud needed.
  const sleep = stageNight(rec, { restingHr, maxHr, sex, strain: strainAcc.strain });

  return {
    n,
    minTs: rec.minTs, maxTs: rec.maxTs,
    spanH: rec.maxTs > rec.minTs ? +((rec.maxTs - rec.minTs) / 3600).toFixed(1) : 0,
    avgHr: hrs.length ? Math.round(hrs.reduce((a, c) => a + c, 0) / hrs.length) : null,
    minHr: hrs.length ? Math.min(...hrs) : null,
    maxHr: hrs.length ? Math.max(...hrs) : null,
    restHr: hrs.length ? Math.round(percentile(hrs, 0.05)) : null, // 5th-pct overnight floor ≈ resting HR
    hrvMs: rmssd,
    skinTempC: skins.length ? +med(skins).toFixed(1) : null,
    spo2: spo2s.length ? med(spo2s) : null,
    activity, activeMin: activity != null ? Math.round(activeSec / 60) : null,
    strain: strainAcc.strain,
    zoneSeconds: strainAcc.zoneSeconds,
    sleep,
  };
}

// Build 30-s epochs from a day's columnar series: mean HR · RMSSD over the epoch's RR · accel actigraphy
// (mean |Δ g-vector|) · median skin temp · max SpO2. Shared by on-device staging AND the calibration export
// (these epochs are exactly what classifySleepStages consumes, so a 30-s export is sufficient to re-fit
// sleep staging off-device without shipping the full 1 Hz stream).
export function buildDayEpochs(rec) {
  const { ts, hr, rr, ax, ay, az, skin, spo2, n } = rec;
  const ES = 30;
  const eps = [];
  let i = 0;                                             // forward-only pointer; each sample consumed once
  for (let st = ts[0]; st <= ts[n - 1]; st += ES) {
    const en = st + ES;
    let hrSum = 0, hrCnt = 0; const rrSeq = []; let mvSum = 0, mvCnt = 0, px = null, py = null, pz = null;
    let skinSum = 0, skinCnt = 0, spo2Max = 0;
    while (i < n && ts[i] < en) {
      if (hr[i] > 0) { hrSum += hr[i]; hrCnt++; }
      if (rr[i] > 0) rrSeq.push(rr[i]);
      if (skin[i] > 0) { skinSum += skin[i]; skinCnt++; }
      if (spo2[i] > spo2Max) spo2Max = spo2[i];
      if (ax[i] || ay[i] || az[i]) {
        if (px != null) { mvSum += Math.hypot(ax[i] - px, ay[i] - py, az[i] - pz) / 1000; mvCnt++; }
        px = ax[i]; py = ay[i]; pz = az[i];
      }
      i++;
    }
    if (!hrCnt) continue;
    let rmssd = null;
    if (rrSeq.length > 2) { let s = 0, c = 0; for (let k = 1; k < rrSeq.length; k++) { const d = rrSeq[k] - rrSeq[k - 1]; s += d * d; c++; } rmssd = Math.sqrt(s / c); }
    eps.push({ t: st * 1000, hr: hrSum / hrCnt, rmssd, move: mvCnt ? mvSum / mvCnt : 0,
      skinTempC: skinCnt ? +(skinSum / skinCnt / 100).toFixed(2) : null, spo2: spo2Max || null });
  }
  return eps;
}

// Build 30-s sleep epochs from a day's columnar series, detect the overnight window, classify stages and
// score sleep performance. Movement = mean |Δ g-vector| per epoch (the calibrated actigraphy metric; uses
// the stored accel VECTOR, which is why the store keeps ax/ay/az not just magnitude). Returns null if no
// plausible night is present (e.g. a daytime-only capture). NOTE: buckets by local day, so a sleep that
// starts before local midnight has its pre-midnight portion in the previous day's record — detection here
// sees the post-midnight part. Fine for post-midnight onsets; cross-midnight refinement is a follow-up.
function stageNight(rec, ctx) {
  if (rec.n < 120) return null;                          // < 1 h of data → not a night
  const eps = buildDayEpochs(rec);
  if (eps.length < 40) return null;
  const win = detectSleepWindow(eps);
  if (!win || win.durMin < 90) return null;              // need a real consolidated block
  const inBed = eps.slice(win.startIdx, win.endIdx + 1);
  const stages = classifySleepStages(inBed);
  const m = summarizeStages(stages);
  const asleepMin = Math.round(m.rem + m.sws + m.light);
  const needMin = Math.round(sleepNeedMinutes({ dayStrain: ctx.strain || 0 }));
  const perf = sleepPerformance(asleepMin, needMin);
  // Run-length-encode the per-epoch hypnogram into compact segments [{s, m}] so the Sleep screen can draw a
  // real hypnogram without re-loading the heavy arrays (each night is only a few dozen segments).
  const segs = [];
  for (const st of stages) {
    const last = segs[segs.length - 1];
    if (last && last.s === st) last.m += 0.5; else segs.push({ s: st, m: 0.5 });
  }
  return {
    start: win.start, end: win.end, inBedMin: win.durMin,
    remMin: Math.round(m.rem), swsMin: Math.round(m.sws), lightMin: Math.round(m.light), awakeMin: Math.round(m.awake),
    asleepMin, needMin, performance: perf != null ? Math.round(perf * 100) : null,
    needBaselineMin: 480, disturbances: segs.filter((g) => g.s === 'awake').length, segs,
  };
}

// Merge a list of decoded records {ts, hr, skinTempC, spo2, rr, acc:{x,y,z}} into the columnar arrays of ONE
// day, dedup/overlaying by timestamp (a later pull of the same second fills in or replaces). Returns a fresh
// rec. Accel is stored as the signed vector (g×1000) so the store can recompute |Δ| actigraphy for staging.
export function mergeDay(day, existing, incoming) {
  const map = new Map(); // ts -> {hr, skin, spo2, rr, ax, ay, az}
  if (existing) {
    for (let i = 0; i < existing.n; i++) {
      map.set(existing.ts[i], { hr: existing.hr[i], skin: existing.skin[i], spo2: existing.spo2[i], rr: existing.rr[i],
        ax: existing.ax ? existing.ax[i] : 0, ay: existing.ay ? existing.ay[i] : 0, az: existing.az ? existing.az[i] : 0 });
    }
  }
  for (const r of incoming) {
    const prev = map.get(r.ts) || { hr: 0, skin: 0, spo2: 0, rr: 0, ax: 0, ay: 0, az: 0 };
    map.set(r.ts, {
      hr:   r.hr > 0 ? r.hr : prev.hr,
      skin: r.skinTempC != null ? Math.round(r.skinTempC * 100) : prev.skin,
      spo2: r.spo2 != null ? r.spo2 : prev.spo2,
      rr:   r.rr != null ? r.rr : prev.rr,
      ax:   r.acc ? Math.round(r.acc.x * 1000) : prev.ax,
      ay:   r.acc ? Math.round(r.acc.y * 1000) : prev.ay,
      az:   r.acc ? Math.round(r.acc.z * 1000) : prev.az,
    });
  }
  const keys = [...map.keys()].sort((a, b) => a - b);
  const n = keys.length;
  const clamp16 = (v) => Math.max(-32768, Math.min(32767, v | 0));
  const out = { day, n, minTs: keys[0] || 0, maxTs: keys[n - 1] || 0,
    ts: new Int32Array(n), hr: new Uint8Array(n), skin: new Int16Array(n), spo2: new Uint8Array(n), rr: new Int16Array(n),
    ax: new Int16Array(n), ay: new Int16Array(n), az: new Int16Array(n) };
  for (let i = 0; i < n; i++) { const v = map.get(keys[i]); out.ts[i] = keys[i]; out.hr[i] = v.hr; out.skin[i] = v.skin; out.spo2[i] = v.spo2; out.rr[i] = v.rr; out.ax[i] = clamp16(v.ax); out.ay[i] = clamp16(v.ay); out.az[i] = clamp16(v.az); }
  return out;
}

// Ingest a pull's decoded records into the store, bucketed + merged by local day. `records` are app.js
// pullRecords entries: {idx, ts, hr, src, skinTempC, spo2, accMag, rr, respRate}. Only dense (47) physiology
// records carry the series we store; EVENT(48) frames are skipped. Returns the affected day summaries.
export async function ingest(records, profile = {}) {
  const byDay = new Map();
  for (const r of records) {
    if (r.src !== 47 || !(r.ts > 1500000000)) continue;
    const k = dayKeyOf(r.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }
  if (!byDay.size) return [];
  const db = await open();
  const summaries = [];
  for (const [day, recs] of byDay) {
    const existing = await wrap(db.transaction(DAYS).objectStore(DAYS).get(day));
    const merged = mergeDay(day, existing, recs);
    const summary = computeDaySummary(merged, profile);
    const metaRow = { day, ...summary, updatedAt: Date.now() };
    const t = db.transaction([DAYS, META], 'readwrite');
    await Promise.all([ wrap(t.objectStore(DAYS).put(merged)), wrap(t.objectStore(META).put(metaRow)) ]);
    summaries.push(metaRow);
  }
  db.close();
  return summaries.sort((a, b) => a.day < b.day ? 1 : -1);
}

// Calibration export: every stored day as { summary, epochs[] } (30-s epochs — HR/RMSSD/movement/skin/SpO2).
// This is what off-device calibration (sleep staging, recovery, strain, WHOOP-Age inputs) needs, and it's
// ~1-2 MB for a week vs tens of MB of raw hex — small enough to share in chat. Pass {raw:true} to also embed
// the full 1 Hz columnar series (for steps / fine actigraphy work) at the cost of size.
export async function exportAll(opts = {}) {
  const db = await open();
  const days = await wrap(db.transaction(DAYS).objectStore(DAYS).getAll());
  const meta = await wrap(db.transaction(META).objectStore(META).getAll());
  db.close();
  const metaBy = Object.fromEntries(meta.map((m) => [m.day, m]));
  const out = { schema: 'wios-store-export/1', days: [] };
  for (const rec of days.sort((a, b) => a.day < b.day ? -1 : 1)) {
    const { sleep, zoneSeconds, ...summary } = metaBy[rec.day] || {};
    const day = { day: rec.day, n: rec.n, minTs: rec.minTs, maxTs: rec.maxTs, summary: { ...summary, sleep, zoneSeconds },
      epochs: buildDayEpochs(rec).map((e) => ({ t: e.t, hr: Math.round(e.hr), rmssd: e.rmssd != null ? Math.round(e.rmssd) : null, move: +e.move.toFixed(4), skinTempC: e.skinTempC, spo2: e.spo2 })) };
    if (opts.raw) day.raw = { ts: Array.from(rec.ts), hr: Array.from(rec.hr), rr: Array.from(rec.rr), ax: Array.from(rec.ax), ay: Array.from(rec.ay), az: Array.from(rec.az), skin: Array.from(rec.skin), spo2: Array.from(rec.spo2) };
    out.days.push(day);
  }
  return out;
}

// Light list for the History screen — meta rows only (no heavy arrays loaded). Newest first.
export async function listDays() {
  const db = await open();
  const rows = await wrap(db.transaction(META).objectStore(META).getAll());
  db.close();
  return rows.sort((a, b) => a.day < b.day ? 1 : -1);
}

// Full columnar arrays for one day (for charts / re-scoring).
export async function getDay(day) {
  const db = await open();
  const rec = await wrap(db.transaction(DAYS).objectStore(DAYS).get(day));
  db.close();
  return rec || null;
}

// Recompute every stored day's summary (e.g. after the user edits their profile, which changes Strain).
export async function recomputeAll(profile = {}) {
  const db = await open();
  const days = await wrap(db.transaction(DAYS).objectStore(DAYS).getAll());
  for (const rec of days) {
    const summary = computeDaySummary(rec, profile);
    const t = db.transaction(META, 'readwrite');
    await wrap(t.objectStore(META).put({ day: rec.day, ...summary, updatedAt: Date.now() }));
  }
  db.close();
  return days.length;
}

export async function removeDay(day) {
  const db = await open();
  const t = db.transaction([DAYS, META], 'readwrite');
  t.objectStore(DAYS).delete(day);
  await wrap(t.objectStore(META).delete(day));
  db.close();
}

export async function clearAll() {
  const db = await open();
  const t = db.transaction([DAYS, META], 'readwrite');
  t.objectStore(DAYS).clear();
  await wrap(t.objectStore(META).clear());
  db.close();
}

// Rough storage footprint for the Stored-data screen (uses the StorageManager estimate when available).
export async function usage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usedBytes: e.usage || 0, quotaBytes: e.quota || 0 };
    }
  } catch (e) {}
  return { usedBytes: 0, quotaBytes: 0 };
}
