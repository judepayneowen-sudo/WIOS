// Tests for src/store.js — the on-phone persistence layer. Covers the pure pieces (day bucketing, the
// dedup/merge into columnar arrays, and the per-day summary + Day Strain). IndexedDB itself is exercised in
// the app; here we test the data transforms that decide what gets stored and computed.
import { dayKeyOf, mergeDay, computeDaySummary } from '../src/store.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ~${b})`);

// --- day bucketing -----------------------------------------------------------
{
  const k = dayKeyOf(Math.floor(new Date(2026, 5, 22, 23, 30).getTime() / 1000)); // local 22 Jun 23:30
  ok(k === '2026-06-22', `dayKeyOf local date → ${k}`);
}

// --- merge: dedup by ts, fill nulls, sort ------------------------------------
{
  const base = Math.floor(new Date(2026, 5, 22, 2, 0).getTime() / 1000);
  const recs = [
    { ts: base + 2, hr: 60, skinTempC: 33.2, spo2: 96, rr: 1000, acc: { x: 0, y: 0, z: 1.0 } },
    { ts: base + 0, hr: 58, skinTempC: 33.0, spo2: null, rr: null, acc: { x: 0, y: 0, z: 0.99 } },
    { ts: base + 1, hr: 59, skinTempC: null, spo2: 95, rr: 1010, acc: { x: 0, y: 0, z: 1.01 } },
  ];
  const m1 = mergeDay('2026-06-22', null, recs);
  ok(m1.n === 3, `merge fresh → 3 rows (${m1.n})`);
  ok(m1.ts[0] === base && m1.ts[2] === base + 2, 'merge sorts by ts ascending');
  ok(m1.hr[1] === 59, 'merge keeps per-ts HR');
  ok(m1.az[2] === 1000, 'merge stores accel z-vector (g×1000)');

  // Re-pull the SAME night with one overlapping second (updated HR) + one new second → no duplication.
  const repull = [
    { ts: base + 1, hr: 61, skinTempC: 33.1, spo2: null, rr: null, acc: null }, // overlap: HR updates, skin fills
    { ts: base + 3, hr: 62, skinTempC: 33.3, spo2: 97, rr: 990, acc: { x: 0, y: 0, z: 1.02 } }, // new second
  ];
  const m2 = mergeDay('2026-06-22', m1, repull);
  ok(m2.n === 4, `re-pull dedups, adds only the new second → 4 rows (${m2.n})`);
  ok(m2.hr[1] === 61, 'overlapping second updates HR');
  near(m2.skin[1], 3310, 1, 'overlapping second fills skin temp from re-pull');
  ok(m2.spo2[1] === 95, 'overlapping second keeps prior SpO2 when re-pull has none');
  ok(m2.az[1] === 1010, 'overlapping second keeps prior accel when re-pull has none');
}

// --- summary + Day Strain ----------------------------------------------------
{
  // 10 minutes of elevated HR (~140 bpm) at 1 Hz → non-trivial strain; some accel movement.
  const base = Math.floor(new Date(2026, 5, 22, 18, 0).getTime() / 1000);
  const recs = [];
  for (let i = 0; i < 600; i++) recs.push({ ts: base + i, hr: 140, skinTempC: 33.5, spo2: null, rr: 700 + (i % 3), acc: { x: 0, y: 0, z: i % 30 === 0 ? 1.6 : 1.0 } });
  const merged = mergeDay('2026-06-22', null, recs);
  const s = computeDaySummary(merged, { age: 30, sex: 'm', restingHr: 50, maxHr: 190 });
  ok(s.n === 600, `summary record count (${s.n})`);
  ok(s.avgHr === 140, `avgHr (${s.avgHr})`);
  ok(s.strain > 0 && s.strain <= 21, `Day Strain in range (${s.strain})`);
  ok(s.hrvMs != null && s.hrvMs >= 0, `HRV proxy computed (${s.hrvMs})`);
  ok(s.skinTempC === 33.5, `skin temp median (${s.skinTempC})`);
  ok(s.activity != null, `movement index computed (${s.activity})`);
  ok(s.sleep === null, 'daytime-only capture → no sleep window');
  near(s.spanH, 0.2, 0.05, 'span hours');
}

// --- standalone sleep staging from stored data -------------------------------
{
  // Synthesize a night at 1 Hz: active evening, a 5 h low-HR/low-move sleep block, active morning. The store
  // should detect the window and produce stage minutes + a performance %.
  const base = Math.floor(new Date(2026, 5, 22, 0, 0).getTime() / 1000);
  const recs = []; let t = base;
  const block = (mins, hr, jitter) => { for (let s = 0; s < mins * 60; s++) { const z = 1 + (Math.sin(s) * jitter); recs.push({ ts: t++, hr, skinTempC: null, spo2: null, rr: Math.round(60000 / hr), acc: { x: 0, y: 0, z } }); } };
  block(60, 80, 0.10);   // active evening
  block(150, 52, 0.002); // deep-ish core
  block(90, 60, 0.002);  // rem-ish
  block(60, 55, 0.002);  // light
  block(80, 85, 0.12);   // active morning
  const merged = mergeDay('2026-06-22', null, recs);
  const s = computeDaySummary(merged, { age: 30, sex: 'm', restingHr: 50, maxHr: 190 });
  ok(s.sleep != null, 'sleep window detected from stored night');
  if (s.sleep) {
    ok(s.sleep.inBedMin >= 240 && s.sleep.inBedMin <= 320, `in-bed duration spans the sleep block (${s.sleep.inBedMin} min)`);
    ok(s.sleep.asleepMin > 0, `asleep minutes computed (${s.sleep.asleepMin})`);
    ok(s.sleep.performance != null && s.sleep.performance > 0, `sleep performance % computed (${s.sleep.performance})`);
  }
}

// --- empty / sparse safety ---------------------------------------------------
{
  const m = mergeDay('2026-06-22', null, [{ ts: 1781000000, hr: 0, skinTempC: null, spo2: null, rr: null, acc: null }]);
  const s = computeDaySummary(m, {});
  ok(s.avgHr === null && s.strain === 0, 'all-zero HR → no strain, null avg');
  ok(s.sleep === null, 'single record → no sleep');
}

console.log(`\nstore: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
