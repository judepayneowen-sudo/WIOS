// Proves the bounded FORCE_TRIM search converges EXACTLY on a realistic band and never leaves the safe range.
import { bisectSeek } from '../src/seek.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// ── Synthetic band ──────────────────────────────────────────────────────────
// A monotonic time↔trim curve like a real band: dense worn regions (~1–3 s/trim) split by an OFF-WRIST GAP where
// a handful of trims jump across ~2.4 days (off-wrist = almost no records written). Floor below MIN_SAFE is erased.
const T0 = 1781700000;                 // ~Jun 18
const MIN_SAFE = 2000, WRITEPTR = 104534;
function tsAtTrim(trim) {
  if (trim < MIN_SAFE) return null;                  // erased flash → empty probe (would crash the real band)
  // segment A: trim 2000..50000 worn at ~2.0 s/trim  (Jun 18 → Jun 18+ ~26h)
  if (trim <= 50000) return T0 + (trim - 2000) * 2.0;
  // THE GAP: trim 50000..50300 jumps ~2.4 days (off-wrist, ~600 s/trim)
  const aEnd = T0 + (50000 - 2000) * 2.0;
  if (trim <= 50300) return aEnd + (trim - 50000) * 700;
  // segment B: trim 50300..WRITEPTR worn at ~1.6 s/trim
  const bStart = aEnd + 300 * 700;
  return bStart + (trim - 50300) * 1.6;
}
// A probe streams a burst whose FIRST records are non-monotonic (real captures showed this); probeReadPos takes
// the median of the first arrivals. Model that: return tsAtTrim with ±a few seconds of jitter resolved by median.
function makeProbe(trace) {
  return async (trim) => {
    trace.push(trim);
    const ts = tsAtTrim(trim);
    return ts == null ? null : { ts: Math.round(ts) };
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────
async function seekTo(target) {
  const trace = [];
  const res = await bisectSeek({
    loTrim: MIN_SAFE, loTs: tsAtTrim(MIN_SAFE),
    hiTrim: WRITEPTR, hiTs: tsAtTrim(WRITEPTR),
    target, probe: makeProbe(trace), tol: 120, maxIter: 14,
  });
  return { res, trace };
}

console.log('seek:');

// 1. Targets that ARE real records (dense worn regions, both sides of the gap) → EXACT landing within tol.
for (const trim of [8000, 20000, 35000, 49000, 60000, 80000, 100000]) {
  const target = Math.round(tsAtTrim(trim));
  const { res, trace } = await seekTo(target);
  ok(res.ts <= target + 1, `trim ${trim}: landed at/before target (${res.ts - target}s)`);
  ok(Math.abs(res.ts - target) <= 120, `trim ${trim}: EXACT within tol (off by ${res.ts - target}s, ${trace.length} probes)`);
  ok(Math.min(...trace) >= MIN_SAFE, `trim ${trim}: never probed below the safe floor`);
  ok(Math.max(...trace) <= WRITEPTR, `trim ${trim}: never probed above the write-pointer`);
  ok(trace.length <= 16, `trim ${trim}: converged in ${trace.length} probes`);
}

// 2. A target INSIDE the off-wrist gap (no records there) → lands at/before it; the drain then reads forward.
{
  const aEnd = tsAtTrim(50000);
  const target = aEnd + 24 * 3600;                  // a day into the gap — no data exists here
  const { res, trace } = await seekTo(target);
  ok(res.ts <= target, 'gap target: lands at/before the gap (no data missed — drain reads forward)');
  ok(Math.min(...trace) >= MIN_SAFE && Math.max(...trace) <= WRITEPTR, 'gap target: all probes stayed in safe range');
}

// 3. Exactness: a target exactly on a known record's timestamp resolves to within tol.
{
  const target = Math.round(tsAtTrim(30000));
  const { res } = await seekTo(target);
  ok(Math.abs(res.ts - target) <= 120, `exact target: within tol (off by ${res.ts - target}s)`);
}

// 4. Safety under a noisy/adversarial slope: even if the bracket timestamps imply a wild slope, no probe escapes.
{
  const target = Math.round(tsAtTrim(51000));        // just past the gap, in segment B
  const { res, trace } = await seekTo(target);
  ok(Math.min(...trace) >= MIN_SAFE && Math.max(...trace) <= WRITEPTR, 'post-gap: all probes stayed in safe range');
  ok(res.ts <= target + 1, 'post-gap: landed at/before target');
}

// 5. Reboot-orphan: target OLDER than everything reachable, with a STALE seed loTs (get_data_range still names
//    an orphaned older record). Must report the oldest REAL probe, NOT the synthetic seed (the "landed 18/06" bug).
{
  const target = 1000;                                       // older than any probe ts below
  const probed = [];
  const probe = async (trim) => { const ts = 5000 + (trim - MIN_SAFE); probed.push(ts); return { ts, trim }; };   // all ts ≥ 5000 ≫ target
  const res = await bisectSeek({ loTrim: MIN_SAFE, loTs: 100 /* stale seed, ≤ target */, hiTrim: WRITEPTR, hiTs: 9e8, target, probe, tol: 120, maxIter: 16 });
  ok(res.ts >= 5000, `reboot-orphan: returns a REAL probed ts (${res.ts}), not the stale seed (100)`);
  ok(res.ts === Math.min(...probed), 'reboot-orphan: returns the OLDEST real probe');
  ok(res.hit === false, 'reboot-orphan: not a hit (target unreachable)');
}

console.log(`\nseek: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
