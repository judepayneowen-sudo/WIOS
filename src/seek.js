/*
 * WHOOP Core — exact FORCE_TRIM seek (pure, testable).
 *
 * The band's historical dump streams forward from a flash cursor called the "trim" — a monotonic RECORD INDEX,
 * not a clock. Every record carries a timestamp and records are written in order, so `trim ↑ ⇒ time ↑`. But the
 * band only writes records while worn (≈1/sec on-wrist, 0 off-wrist/charging), so time is NOT evenly spaced in
 * trim: an off-wrist gap stretches a few trims across hours. There is therefore no formula from time → trim — but
 * because time is MONOTONIC in trim, we can binary-search it EXACTLY.
 *
 * bisectSeek runs a bounded false-position (interpolating) search: it keeps a bracket [lo, hi] in trim whose
 * timestamps straddle the target, picks an estimate strictly INSIDE the bracket, probes it, and shrinks the
 * bracket — converging to the record at/just-before `target` within `tol` seconds. Because every probe is strictly
 * inside [loTrim, hiTrim], it can never probe the erased zone (which crashes the band) or overshoot the
 * write-pointer, and it can never extrapolate out of range (the old failure that shot to trim 257431).
 *
 * `probe(trim)` returns { ts } for the record at that trim, or null/{ts:null} for erased/empty flash (which, in a
 * bracket bounded above by the cursor, can only be the low/erased side — so we move the floor up).
 */
export async function bisectSeek({ loTrim, loTs, hiTrim, hiTs, target, probe, tol = 120, maxIter = 12 }) {
  // Illinois false-position on f(trim) = ts(trim) − target (root where ts = target). a holds the at/before-target
  // side (f ≤ 0), b the after-target side (f ≥ 0). The Illinois weighting halves a stale endpoint's f so the
  // search can't stagnate on a flat-then-steep curve (an off-wrist gap), giving fast, guaranteed convergence.
  let a = { trim: loTrim, f: loTs - target };
  let b = { trim: hiTrim, f: hiTs - target };
  let best = loTs != null && loTs <= target ? { trim: loTrim, ts: loTs } : null;
  let last = 0;                                   // which side moved last: -1 = a, +1 = b
  const probes = [];
  for (let i = 0; i < maxIter && b.trim - a.trim > 2; i++) {
    // False-position estimate, clamped STRICTLY inside the bracket (so it can never leave [a.trim, b.trim]).
    let mt = b.f !== a.f ? Math.round(a.trim - a.f * (b.trim - a.trim) / (b.f - a.f)) : Math.round((a.trim + b.trim) / 2);
    mt = Math.min(b.trim - 1, Math.max(a.trim + 1, mt));
    const m = await probe(mt);
    probes.push(mt);
    if (!m || m.ts == null) { a = { trim: mt, f: a.f }; continue; }   // erased/empty → below the data; raise floor
    const fm = m.ts - target;
    // Return only when we've landed at/just-BEFORE target within tol — never after (the drain reads forward, so
    // landing early is safe but landing late would skip the gap between target and the landing).
    if (fm <= 0 && -fm <= tol) return { trim: mt, ts: m.ts, probes, hit: true };
    if (fm <= 0) {                                 // m is at/before target → it's the new lower bound
      if (last === -1) b.f *= 0.5;                 // Illinois: a moved twice running → down-weight stale b
      a = { trim: mt, f: fm }; last = -1;
      if (!best || m.ts > best.ts) best = { trim: mt, ts: m.ts };
    } else {                                       // m is after target → new upper bound
      if (last === +1) a.f *= 0.5;                 // Illinois: b moved twice running → down-weight stale a
      b = { trim: mt, f: fm }; last = +1;
    }
  }
  // Bracket converged without hitting tol (e.g. the target sits inside an off-wrist gap with no record there) —
  // return the newest record still at/before target. The drain reads forward through target, so landing a touch
  // early never misses data.
  const r = best || { trim: a.trim, ts: target + a.f };
  return { trim: r.trim, ts: r.ts, probes, hit: false };
}
