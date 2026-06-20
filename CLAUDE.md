# CLAUDE.md — durable guidance for this repo

Standalone iOS app (**WHOOP Core**) that reads a **WHOOP 5.0** band directly over Bluetooth and
computes Recovery / Sleep / Strain itself, so it can eventually stand alone **without** a WHOOP
subscription. For the full running log + handoff, read **`PROGRESS.md`** (source of truth for state).

---

## ⭐ Strategy — settled, do not re-litigate (updated 2026-06-20)

End goal: the app computes Recovery / Sleep / Strain **itself, from the band**, so the user can
**cancel the WHOOP subscription**. ⚠️ **Cancelling kills WHOOP API/cloud access** (the developer API
requires an active membership) — so ongoing operation **cannot** depend on the cloud. Two phases, with
different data paths. Both are required; neither is "the" answer alone.

### Phase 1 — CALIBRATION (one-time, while still subscribed) → cloud
Calibrate `src/scores.js` so our computed scores match WHOOP's. WHOOP's scores live only in WHOOP's
cloud, reachable via the **WHOOP developer API** (`tools/whoop-api.mjs`) — the answer-key. All three
are calibratable from the cloud:

| Score | Inputs in API | Output in API |
|---|---|---|
| **Recovery %** | `hrv_rmssd`, `resting_heart_rate`, `spo2`, `skin_temp`, resp, sleep | `recovery_score` |
| **Sleep %** | `stage_summary` + `sleep_needed` | `sleep_performance_percentage` |
| **Day Strain** | `/activity/workout` `zone_durations` (z0–z5) + workout `strain` | `strain` (0–21) |

During Phase 1: **wear the band + let the official WHOOP app sync** (fills the cloud answer-key over
~2–3 weeks), then `node tools/whoop-api.mjs` → `npm run calibrate`. **Do NOT destructively sync the
band yourself in this phase** — it denies WHOOP the data = no answer-key (we wiped ~29 h learning
this). Cloud is the calibration source; the band stays untouched.

### Phase 2 — STANDALONE (ongoing, after cancelling WHOOP) → band-raw
No subscription = no API. The app reads the band directly and runs the calibrated `scores.js`:
band → decode HR/HRV/sleep → `scores.js` → Recovery/Sleep/Strain. **This is why band-raw extraction is
essential and is NOT retired.**

**The band's historical sync is destructive (acked = commit = wipe) — and that is FINE in Phase 2.**
Once WHOOP is cancelled there's no cloud to preserve data for, so WHOOP Core simply *becomes the
band's sync client* (exactly what WHOOP's app did): a **paced acked sync** pulls the full buffer, the
band trims as it commits, repeat before the ~24 h rolling buffer overflows. The earlier disaster
happened only because we ran a destructive ack **during Phase 1** (wanting WHOOP to ALSO get the data)
AND with a broken **one-ack-then-abort** that committed without delivering. A proper paced acked sync
(ack every window to completion — like WHOOP's app, which reliably pulls days of data) delivers
everything. The official WHOOP app also reliably re-syncs/recovers the band (verified 2026-06-20).

### Remaining band-RE work for Phase 2 (develop in parallel, on sacrificial days)
- Verify a full **paced acked sync** reliably delivers the whole buffer (the trim test only did one
  ack + abort). Test on a day we accept not having WHOOP score (extraction denies WHOOP that day).
- Finish the **`HISTORICAL_DATA(47)` decode** (HR confirmed: `[3..6]`=idx, `[7..10]`=ts, `[14]`=HR;
  RR/HRV + sleep staging next).
- Validate decoded inputs by sanity/consistency (sane HR, matches live HR, RR→HRV) — not against
  WHOOP's same-day score (can't have both, since extraction wipes what WHOOP would sync). `scores.js`
  calibration comes from OTHER days' cloud data.

### Misconceptions to correct if they resurface
- **"Don't sync to WHOOP cloud — it loses calibration data."** Backwards in Phase 1: the cloud sync
  *creates* the answer-key. Let WHOOP sync.
- **"We're cloud-only / band-raw is retired."** NO. Cloud is only for the one-time calibration.
  Standalone operation (the end goal) REQUIRES band-raw — cancelling WHOOP removes the API.
- **"The destructive ack is a dead end."** Only during Phase 1. In Phase 2 it's the *correct*
  mechanism — we're the sole sync client, so trimming is normal (it's what WHOOP's app does).

---

## Workflow rules
- Read **`PROGRESS.md`** first for current state. Update it when state changes.
- ⚠️ **Band historical sync is DESTRUCTIVE.** `send_historical_data(22)` runs the read pointer to the
  end; `historical_data_result(23)` with `[01 …]` commits to that pointer = **wipes the buffer** (data
  does NOT reach WHOOP's cloud — it's gone). This is the right mechanism for **Phase 2** (we're the
  sole consumer) but **must not be used during Phase 1** (it denies WHOOP the answer-key). Read-only
  (no ack) only yields the oldest ~30 records. The app's acked sync is **confirm-gated**; do not
  bypass it during calibration.
- `git fetch` before working — both the laptop and phone/web push to this repo.
- Ship a phone build: bump `version` in `package.json` → run `release.yml` (publishes to
  `wios-awe.pages.dev`; SideStore updates OTA).
- Calibration answer-key lives in a **local, gitignored** `.whoop.env` / `.whoop-tokens.json` —
  never commit credentials.
