# Battery-Life Optimization Review — Kalamos

**Status:** research deliverable (ROADMAP.md → "Battery-life optimization review").
This document also satisfies the roadmap's reference to a missing `../BATTERY-OPTIMIZATION.md`
— that file does not exist anywhere in the repo or its parent; this is it.
**Scope:** every realistic way to reduce battery drain on the target device, grounded in the
current code. Ties into the planned **Smart Wi-Fi** and refresh-mode roadmap items.
**Device context:** Bigme HiBreak — Kaleido 3 colour e-ink, USI 2.0 stylus.

---

## 1. Baseline audit — what the app does today (verified from code)

The good news first: **the current power baseline is very clean.** A grep across the whole
codebase for the usual battery offenders returns **nothing**:

- **No wake locks** (`PowerManager`/`WakeLock`) and **no `FLAG_KEEP_SCREEN_ON` /
  `keepScreenOn`** — the app never forces the screen/CPU awake. (e-ink with no backlight
  makes "screen on" cheap anyway, but holding a CPU wake lock would not be.)
- **No networking of any kind** — no `WifiManager`, `ConnectivityManager`,
  `HttpURLConnection`, OkHttp, `fetch()`, or `XMLHttpRequest`. The app is fully offline
  today. (The only grep hit for `fetch(` was a false positive inside `schedulePrefetch`.)
- **No background work** — no `Service`, `JobScheduler`, `WorkManager`, or `AlarmManager`.
- **No sensors** — no `SensorManager`, location, camera, or USB polling
  (`AndroidManifest.xml` declares only `MANAGE_EXTERNAL_STORAGE` and a non-required USB-host
  *feature*, not a runtime drain).
- **No foreground process when backgrounded** — `MainActivity` starts a single
  `AppFragment`; `onPause` just tells the web layer to pause (`AppFragment.kt:101`).

So Kalamos is essentially a foreground-only, offline, single-activity app. There is no
"hidden drain." That reframes this review: the question is **not** "what is wasting battery"
but **"what will waste battery as the roadmap features land, and how do we pre-empt it."**

### Recurring loops/timers that *do* run (all foreground, all bounded)
| Source | Cadence | When active | Notes |
|--------|---------|-------------|-------|
| Stroke flush to JS | `FLUSH_IDLE_MS = 900ms` after pen-up (`InkManager.kt:442`) | only after writing | one-shot, cancelled on pen-down |
| Disk save | `SAVE_IDLE_MS = 2500ms` true-idle (`InkManager.kt:444`) | only after writing | one-shot; heavy `JSON.stringify`+fsync, deferred so it never competes with writing |
| Autosave (web) | 300ms debounce (`editor-controller.js:733`) | on model change | writes only dirty pages |
| Neighbour prefetch | `PREFETCH_IDLE_MS = 600ms` (`editor-controller.js:303`) | after a page settles | parses ±1 pages into RAM; CPU only, no I/O loop |
| **Animation sampler** | **`ANIM_FRAME_MS = 60ms` (~16fps) (`InkManager.kt:452`)** | **only while an animation is toggled on** | the single most expensive loop in the app |

None of these are persistent background drains; they are short, idle-triggered, and
cancelled by the next interaction.

---

## 2. The real battery levers on an e-ink device

On a backlight-free e-ink tablet, the dominant power consumers (in rough order) are:

1. **CPU/GPU wakeups** — anything that keeps the SoC out of deep idle: animation loops,
   polling, frequent timers, busy JS.
2. **Panel refreshes (EPD waveforms)** — drawing to e-ink draws current. A full **GU16**
   greyscale refresh is far more expensive (and flashes) than a small partial/A2/fast
   waveform. Frequent or full-screen refreshes add up.
3. **Radios** — Wi-Fi/BT. Currently unused, but the roadmap adds AI/sync features that will
   turn the radio into the #1 drain the moment they ship.
4. **Disk I/O** — fsync'd writes wake the SoC and flash storage; cheap individually, costly
   if done per-stroke (the app already avoids this).

The app already gets a lot of #1, #2, and #4 right. The biggest *future* risk is #3.

---

## 3. e-ink refresh discipline (current behaviour + cost)

Refresh mode is centralised in `com.inksdk.ink.EinkCenter`:

- App-wide default is set once to the faster "COMIC" mode at editor entry
  (`AppFragment.kt:43-44`, `EinkCenter.setDefaultMode()`).
- Animations bump the panel to a fast/animation waveform and **revert on stop/page-change/
  leave** (`InkManager.startWebAnim` → `EinkCenter.enterAnimationMode()`,
  `stopWebAnim` → `exitAnimationMode()`, `:100-117`). This scoping is important: the
  expensive mode is never left on.
- Writing uses small partial refreshes per stroke: `drawStroke` commits only the stroke's
  dirty rect and resets the daemon buffer with `force=false` (no extra EPD refresh)
  (`InkSurfaceView.kt:244-275`).
- Full **GU16** refreshes are deliberately rationed: only on first present of a session
  (cold-open wake, `:143-150`), and on erase/undo where stale ink must actually be cleared,
  limited to the affected rect or just the paper region — never the toolbar
  (`:299-308`).
- Erase live-refreshes are throttled so GU16s can't pile up during a swipe
  (`ERASE_REFRESH_MS = 90`, `editor-controller.js:17,537`).
- Heavy pages render "shell first" then strokes a frame later
  (`SHELL_FIRST_THRESHOLD = 40`, `:287,524`) — fewer redundant full repaints.

**Assessment:** refresh discipline is already strong and battery-aware. The one place to
watch is the **animation sampler**, below.

---

## 4. Findings & recommendations

### 4.1 Animation sampling is the most expensive foreground loop — keep it opt-in and bounded
`animRunnable` samples the WebView region and fast-refreshes the panel every 60ms, and to do
so it forces the WebView to a **software layer for the whole animation**
(`InkManager.kt:104,131`) and drives the web clock each frame. ~16fps of WebView capture +
EPD writes is, by far, the heaviest sustained work the app can do.

- **Good:** it runs *only* while an animation is toggled on; plain notebooks pay nothing
  (`:76-78`). It correctly reverts the panel mode and the layer type on stop.
- **Recommendations:**
  - Add an **auto-stop / idle timeout** for animations (e.g. stop after N seconds with no
    interaction, or after one loop) so a forgotten animation can't sample indefinitely.
  - Consider a **lower frame rate option** (e.g. 100–125ms) for animations that don't need
    16fps; the constant is already tunable (`ANIM_FRAME_MS`).
  - Ensure the loop is stopped on `onPause` (it is stopped on page-change/leave-editor;
    verify `App.onPauseApp()` path also calls `stopAnim()` — `editor-controller.js:912`
    exposes `window.stopAnim`, wire it into pause if not already).

### 4.2 Wi-Fi / Smart Wi-Fi (roadmap P2) — design it as *off by default, demand-driven*
There is no radio usage today, so the cleanest possible policy is achievable: **stay offline
unless a feature explicitly needs the network.** When AI/sync/Wiktionary features land:

- Make every network-using feature **request connectivity explicitly** through one
  chokepoint (a small `NetworkGate`), rather than assuming Wi-Fi is up.
- **Debounce toggling.** The roadmap's own warning is correct: rapid Wi-Fi on/off itself
  wastes battery (association/DHCP cost). Pattern: turn Wi-Fi on for a *batch* of work, keep
  it up for a short grace window (e.g. 30–60s) in case more requests follow, then drop it.
  Never toggle per-request.
- **Coalesce.** Batch outbound work (sync, AI calls) so the radio wakes once, not N times.
- Note: programmatic Wi-Fi enable/disable is restricted on modern Android; on a Bigme device
  this likely needs the vendor API or simply *respecting* the user's setting and only
  reaching out when already connected. Confirm the device capability before committing to
  active toggling vs passive "only when connected."

### 4.3 Disk save cadence is already good — don't regress it
Saves are deferred to a 2.5s true-idle and write only dirty pages
(`InkManager.kt:444`, `StorageManager.savePageRaw`/`saveMetaRaw`). Per-page atomic writes
with fsync are correct for durability; the cost is acceptable because they're rare and
idle-triggered. **Recommendation:** keep the "never write per-stroke" invariant; if a future
feature adds frequent state, route it through the same idle-debounced path.

### 4.4 No always-on indicators
Avoid adding any persistent ticking UI (clocks, live counters, blinking cursors) — each
visible change is an EPD refresh. The current UI is correctly static between actions; keep it
that way.

### 4.5 Local on-device AI (roadmap P3) — flag as a future battery hotspot
On-device inference is CPU/NPU-heavy and will dwarf everything else when running. When it
lands: run it foreground, on explicit user action, with a visible "working" state, and never
speculatively/in the background.

---

## 5. Summary

- **Today:** excellent baseline — offline, no wake locks, no background work, disciplined
  e-ink refreshes, idle-debounced saves. There is little to "fix" now.
- **The one current loop to harden:** the animation sampler (add auto-stop + optional lower
  fps; confirm it stops on pause).
- **The future drains to pre-empt by design:** Wi-Fi (Smart Wi-Fi: off by default,
  demand-driven, debounced, coalesced) and on-device AI (foreground, explicit, never
  speculative).
- **Invariant to protect:** never do work (refresh, save, network, sample) speculatively or
  on a timer that outlives a user interaction.
