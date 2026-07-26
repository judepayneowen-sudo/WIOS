// Proves findGaps classifies the last-N-days timeline into missing vs off-wrist gaps and honours the min-gap
// filter and the first-record clamp — all in pure local-time logic (no band, no IndexedDB).
import { findGaps } from '../src/gaps.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

const HOUR = 3600e3;
const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Build a store meta row for a local day, per-hour state from stateFn(h) → 'covered' | 'offwrist' | 'missing'.
function row(y, mo, day, stateFn) {
  const d = new Date(y, mo, day, 12, 0, 0, 0);
  const hours = new Array(24).fill(0), hrHours = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    const s = stateFn(h);
    if (s === 'covered') { hours[h] = 60; hrHours[h] = 60; }
    else if (s === 'offwrist') { hours[h] = 60; hrHours[h] = 0; }   // frames logged, no heartbeat
    // missing → leave 0/0
  }
  const startOfDay = new Date(y, mo, day, 0, 0, 0, 0).getTime();
  return { day: dk(d), hours, hrHours, minTs: Math.round(startOfDay / 1000), maxTs: Math.round((startOfDay + 23 * HOUR) / 1000) };
}

// ── Scenario: "today" = Jan 15 2026, 12:00 local. Five days of history. ──────────────────────────────
const now = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
const ALL = () => 'covered';
const rows = [
  row(2026, 0, 11, ALL),                                   // oldest stored — fully covered (sets the window floor)
  row(2026, 0, 12, ALL),                                   // fully covered
  // Jan 13 intentionally ABSENT → whole day missing (24 h)
  row(2026, 0, 14, (h) => {                                // covered, but 02–05 off-wrist (4 h) and 12 a 1-h hole
    if (h >= 2 && h <= 5) return 'offwrist';
    if (h === 12) return 'missing';
    return 'covered';
  }),
  row(2026, 0, 15, (h) => h < 12 ? 'covered' : 'missing'), // today up to noon
];

const res = findGaps(rows, { now, windowDays: 30, minGapHours: 2 });

ok(res.missing.length === 1, `one missing gap (got ${res.missing.length})`);
ok(res.missing[0] && res.missing[0].hours === 24, `missing gap is the full absent day = 24 h (got ${res.missing[0] && res.missing[0].hours})`);
ok(res.offwrist.length === 1, `one off-wrist gap (got ${res.offwrist.length})`);
ok(res.offwrist[0] && res.offwrist[0].hours === 4, `off-wrist gap is 4 h (got ${res.offwrist[0] && res.offwrist[0].hours})`);
ok(res.totalMissingHours === 24, `total missing hours = 24 (got ${res.totalMissingHours})`);
ok(res.totalOffWristHours === 4, `total off-wrist hours = 4 (got ${res.totalOffWristHours})`);

// The 1-h hole (Jan 14 12:00) is below minGapHours=2 → must NOT surface as its own gap.
ok(!res.gaps.some((g) => g.hours === 1), 'sub-2h holes filtered out');

// Window floor clamps to the first stored record (Jan 11 00:00), NOT now-30d — no pre-band void reported.
ok(res.windowStart === Math.round(new Date(2026, 0, 11, 0, 0, 0, 0).getTime() / 1000), 'window floored to first stored day');

// The missing gap must start at Jan 13 00:00 and end at Jan 14 00:00 (exactly the absent day).
const mg = res.missing[0];
ok(mg.startTs === Math.round(new Date(2026, 0, 13, 0, 0, 0, 0).getTime() / 1000), 'missing gap starts at absent-day midnight');
ok(mg.endTs === Math.round(new Date(2026, 0, 14, 0, 0, 0, 0).getTime() / 1000), 'missing gap ends at next midnight');

// Off-wrist gap spans Jan 14 02:00 → 06:00.
const og = res.offwrist[0];
ok(og.startTs === Math.round(new Date(2026, 0, 14, 2, 0, 0, 0).getTime() / 1000), 'off-wrist gap starts 02:00');
ok(og.endTs === Math.round(new Date(2026, 0, 14, 6, 0, 0, 0).getTime() / 1000), 'off-wrist gap ends 06:00');

// ── Guard: a fully-covered history has no gaps. ──────────────────────────────────────────────────────
const clean = findGaps([row(2026, 0, 14, ALL), row(2026, 0, 15, (h) => h < 12 ? 'covered' : 'missing')], { now, minGapHours: 2 });
ok(clean.missing.length === 0 && clean.offwrist.length === 0, 'clean history → no gaps');

// ── Guard: older rows without hrHours treat any records as worn (no false off-wrist). ────────────────
const legacy = [{ day: dk(new Date(2026, 0, 14)), hours: new Array(24).fill(60), minTs: Math.round(new Date(2026, 0, 14).getTime() / 1000), maxTs: Math.round(new Date(2026, 0, 14, 23).getTime() / 1000) },
  row(2026, 0, 15, (h) => h < 12 ? 'covered' : 'missing')];
const leg = findGaps(legacy, { now, minGapHours: 2 });
ok(leg.offwrist.length === 0, 'legacy rows (no hrHours) → not mislabelled off-wrist');

console.log(`gaps.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
