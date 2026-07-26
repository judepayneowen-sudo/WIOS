// src/gaps.js — find coverage gaps in the stored band history (Phase-2 self-heal).
//
// WHY: the phone accumulates nights/days off the band, but a pull can miss stretches — a night that was never
// synced, a day the app wasn't run, a window lost to a mid-pull disconnect. Before calibration (and for the
// standalone end-goal) we want to notice those holes and re-pull what the band still holds. But not every hole
// is worth chasing: when the band was simply OFF THE WRIST there's no heartbeat to recover, so re-pulling would
// just re-fetch empty frames. This module separates the two.
//
// HOW: the store keeps two 24-slot hour histograms per local day:
//   hours[h]   = total (47) records bucketed into local hour h
//   hrHours[h] = of those, how many carried a real heartbeat (HR>0)
// From these we classify every hour of the last N days as:
//   covered  — band worn and recording          (records present AND heartbeats present)
//   offwrist — band logged frames but no HR      (taken off / on the charger — nothing to recover)
//   missing  — no records at all                 (never pulled, or the band was powered off)
// Consecutive same-state hours are run-length-encoded into segments. Only `missing` segments are worth a
// re-pull; `offwrist` segments are reported so the user understands the hole but are never retried.
//
// This is PURE (no band, no IndexedDB) so it is unit-tested directly against synthetic meta rows. app.js layers
// the band's flash range on top to decide which `missing` gaps are still recoverable vs rolled off flash.

const HOUR = 3600e3;

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// rows: store meta rows [{ day:'YYYY-MM-DD', hours:[24], hrHours:[24], minTs, maxTs }, …] (newest-first or any order).
// opts: { now=Date.now(), windowDays=30, minGapHours=2, offHrThreshold=1 }
// Returns { gaps, missing, offwrist, windowStart, windowEnd, totalMissingHours, totalOffWristHours } — ts in unix SECONDS.
export function findGaps(rows, opts = {}) {
  const now = opts.now || Date.now();
  const windowDays = opts.windowDays || 30;
  const minGapH = opts.minGapHours != null ? opts.minGapHours : 2;
  const offThr = opts.offHrThreshold != null ? opts.offHrThreshold : 1;   // hrHours ≤ this in an hour with records ⇒ off-wrist

  const byDay = new Map();
  let firstTs = Infinity;
  for (const r of rows || []) {
    byDay.set(r.day, r);
    if (r.minTs && r.minTs * 1000 < firstTs) firstTs = r.minTs * 1000;
  }

  // Window = last N days, but never earlier than the first stored record (don't report the pre-band void as a gap).
  let start = now - windowDays * 24 * HOUR;
  if (firstTs !== Infinity) start = Math.max(start, firstTs);
  start = Math.floor(start / HOUR) * HOUR;                  // align to the top of the hour
  const end = Math.floor(now / HOUR) * HOUR;               // stop at the current hour (ignore the in-progress hour)

  const stateAt = (ms) => {
    const d = new Date(ms);
    const row = byDay.get(dayKey(d));
    if (!row) return 'missing';
    const h = d.getHours();
    const total = (row.hours && row.hours[h]) || 0;
    if (total === 0) return 'missing';
    const hrH = row.hrHours || row.hours;                  // older rows lack hrHours → treat any records as worn
    const hr = (hrH && hrH[h]) || 0;
    return hr <= offThr ? 'offwrist' : 'covered';
  };

  // RLE the hour timeline into runs, keeping only the non-covered ones.
  const segs = [];
  let cur = null, runStart = start;
  const flush = (stateEndMs) => {
    if (cur && cur !== 'covered') {
      segs.push({ kind: cur, startTs: Math.round(runStart / 1000), endTs: Math.round(stateEndMs / 1000), hours: (stateEndMs - runStart) / HOUR });
    }
  };
  for (let t = start; t < end; t += HOUR) {
    const s = stateAt(t);
    if (s !== cur) { flush(t); cur = s; runStart = t; }
  }
  flush(end);

  const gaps = segs.filter((g) => g.hours >= minGapH);
  const missing = gaps.filter((g) => g.kind === 'missing');
  const offwrist = gaps.filter((g) => g.kind === 'offwrist');
  return {
    gaps, missing, offwrist,
    windowStart: Math.round(start / 1000), windowEnd: Math.round(end / 1000),
    totalMissingHours: missing.reduce((a, g) => a + g.hours, 0),
    totalOffWristHours: offwrist.reduce((a, g) => a + g.hours, 0),
  };
}
