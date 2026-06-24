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
    { ts: base + 2, hr: 60, skinTempC: 33.2, spo2: 96, rr: 1000, accMag: 1.0 },
    { ts: base + 0, hr: 58, skinTempC: 33.0, spo2: null, rr: null, accMag: 0.99 },
    { ts: base + 1, hr: 59, skinTempC: null, spo2: 95, rr: 1010, accMag: 1.01 },
  ];
  const m1 = mergeDay('2026-06-22', null, recs);
  ok(m1.n === 3, `merge fresh → 3 rows (${m1.n})`);
  ok(m1.ts[0] === base && m1.ts[2] === base + 2, 'merge sorts by ts ascending');
  ok(m1.hr[1] === 59, 'merge keeps per-ts HR');

  // Re-pull the SAME night with one overlapping second (updated HR) + one new second → no duplication.
  const repull = [
    { ts: base + 1, hr: 61, skinTempC: 33.1, spo2: null, rr: null, accMag: null }, // overlap: HR updates, skin fills
    { ts: base + 3, hr: 62, skinTempC: 33.3, spo2: 97, rr: 990, accMag: 1.02 },     // new second
  ];
  const m2 = mergeDay('2026-06-22', m1, repull);
  ok(m2.n === 4, `re-pull dedups, adds only the new second → 4 rows (${m2.n})`);
  ok(m2.hr[1] === 61, 'overlapping second updates HR');
  near(m2.skin[1], 3310, 1, 'overlapping second fills skin temp from re-pull');
  ok(m2.spo2[1] === 95, 'overlapping second keeps prior SpO2 when re-pull has none');
}

// --- summary + Day Strain ----------------------------------------------------
{
  // 10 minutes of elevated HR (~140 bpm) at 1 Hz → non-trivial strain; some accel movement.
  const base = Math.floor(new Date(2026, 5, 22, 18, 0).getTime() / 1000);
  const recs = [];
  for (let i = 0; i < 600; i++) recs.push({ ts: base + i, hr: 140, skinTempC: 33.5, spo2: null, rr: 700 + (i % 3), accMag: i % 30 === 0 ? 1.6 : 1.0 });
  const merged = mergeDay('2026-06-22', null, recs);
  const s = computeDaySummary(merged, { age: 30, sex: 'm', restingHr: 50, maxHr: 190 });
  ok(s.n === 600, `summary record count (${s.n})`);
  ok(s.avgHr === 140, `avgHr (${s.avgHr})`);
  ok(s.strain > 0 && s.strain <= 21, `Day Strain in range (${s.strain})`);
  ok(s.hrvMs != null && s.hrvMs >= 0, `HRV proxy computed (${s.hrvMs})`);
  ok(s.skinTempC === 33.5, `skin temp median (${s.skinTempC})`);
  ok(s.activity != null, `movement index computed (${s.activity})`);
  near(s.spanH, 0.2, 0.05, 'span hours');
}

// --- empty / sparse safety ---------------------------------------------------
{
  const m = mergeDay('2026-06-22', null, [{ ts: 1781000000, hr: 0, skinTempC: null, spo2: null, rr: null, accMag: null }]);
  const s = computeDaySummary(m, {});
  ok(s.avgHr === null && s.strain === 0, 'all-zero HR → no strain, null avg');
}

console.log(`\nstore: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
