let notebook = null
let currentPageIndex = 0
let activeTool = 'pen'
let activePenType = 'ballpoint'   // 'ballpoint' (constant width) | 'felt' (pressure-varied width)
let activeColor = '#000000'       // current ink colour (vivid palette tuned for the Kaleido 3 panel)
let strokeWidth = 3
let activeStroke = null
let isDrawing = false
let autosaveTimer = null
let autosavePending = false
let inkSdkActive = false      // true once BigmeInkController confirms attach
let daemonErrorTimer = null   // deferred "pen engine unavailable" toast (cancelled on a quick retry)
let flipEraserActive = false  // true when eraser mode was auto-triggered by USI stylus flip
let contentActive = false     // true while an interactive-format content layer is baked on the surface
let eraseBox = null           // accumulates the bbox (model px) of strokes erased since the last refresh
let lastErasePoint = null     // previous eraser sample, so a swipe erases along the path (not just at samples)
let eraseRefreshTimer = null  // throttle timer for the live erase refresh during a swipe
const ERASE_REFRESH_MS = 90   // min gap between live erase refreshes (keeps e-ink GU16 from piling up)
const STROKE_LOAD_DELAY_MS = 220  // delay after the template shows before loading+rendering strokes
const HEAVY_PAGE_BYTES = 18000    // raw page JSON above this defers strokes (template-first); below renders now
const PREFETCH_IDLE_MS = 600      // idle after a page settles before warming neighbouring pages
const PREFETCH_AHEAD = 4          // pages to prefetch ahead of the current page (forward flips dominate)
const PREFETCH_BEHIND = 2         // pages to prefetch behind; both only run while the main thread is idle
const EVICT_IDLE_MS = 3000        // settle time before eviction is even considered — far lazier than prefetch
const RESIDENT_AHEAD = PREFETCH_AHEAD + 2    // keep a buffer beyond the prefetch span so eviction never
const RESIDENT_BEHIND = PREFETCH_BEHIND + 2  // drops a page prefetch just loaded (avoids load/evict thrash)
const EVICT_MIN_IDLE_MS = 8       // only evict inside a real idle slice with at least this much time left

// CSS-pixel paper bounds cached when ink is attached (set by attachInk).
// Used by stroke callbacks to convert daemon physical-pixel coords → canvas coords.
let inkCssBounds = { left: 0, top: 0 }

const paper = document.getElementById('paper')
const eraserCursor = document.getElementById('eraser-cursor')
const pageNumEl = document.getElementById('page-num')
const widthSlider = document.getElementById('width-slider')
const widthValue = document.getElementById('width-value')
const templateSelect = document.getElementById('template-select')
const autosaveStatus = document.getElementById('autosave-status')

function currentPage() { return notebook ? notebook.pages[currentPageIndex] : null }
function totalPages() { return notebook ? notebook.pages.length : 0 }

// ============== INIT ==============

function initEditor() {
  sizePaper()
  initToolbar()

  // On #paper (visible, receives stylus pointer events through the surface). Writing is owned by
  // the daemon; these handlers only act on the stylus/button ERASER.
  paper.addEventListener('pointerdown', onPointerDown)
  paper.addEventListener('pointermove', onPointerMove)
  paper.addEventListener('pointerup', onPointerUp)
  paper.addEventListener('pointerleave', onPointerLeave)
  paper.addEventListener('pointercancel', function() {
    // Pen pointercancel fires spuriously while the daemon owns input — do NOT abort an in-progress
    // eraser swipe here (it finalizes its refresh on pointerup/leave). Just hide the cursor.
    hideEraserCursor()
  })

  const ro = new ResizeObserver(function() {
    const prevW = paper.style.width
    const prevH = paper.style.height
    sizePaper()
    if (paper.style.width !== prevW || paper.style.height !== prevH) {
      // The reused WebView pre-warms offscreen (size 0) and gets its real size when shown, so the
      // paper rect changes after the first attach. Re-sync native ink coords + template to it.
      if (inkSdkActive) {
        attachInk()
        syncNativePage()
      }
    }
  })
  ro.observe(document.getElementById('canvas-area'))

  History.updateButtons()
  updateUI()
}

// Called from native after webView.loadUrl completes. Lazy open: use the library-preloaded meta if
// present, else load it now (migrates a legacy notebook on demand). Only the CURRENT page's strokes
// are read here; other pages stream in when navigated to.
window.loadNotebookById = function(notebookId) {
  window._needFullToolbar = true   // open → bake the whole toolbar once (onInkControllerReady)
  const nb = Storage.takeCachedMeta(notebookId) || Storage.loadMeta(notebookId)
  if (nb) {
    notebook = nb
    // Normally open at page 0; a sketch session (App.openSketch) opens directly at its page.
    currentPageIndex = (window._openAtPage != null) ? Math.min(window._openAtPage, nb.pages.length - 1) : 0
    window._openAtPage = null
    // Sticky-note sketch: point the daemon at this note's own strokes (in block.hl[hi].note.strokes).
    window._sketchNoteStrokes = null
    if (window._sketchNote) {
      const p = notebook.pages[currentPageIndex]
      const blk = p && p.blocks && p.blocks[window._sketchNote.bi]
      const hl = blk && Array.isArray(blk.hl) && blk.hl[window._sketchNote.hi]
      if (hl) {
        if (!hl.note) hl.note = {}
        // Reset if missing OR in the old web-canvas format (point arrays without a .points field).
        if (!Array.isArray(hl.note.strokes) || (hl.note.strokes.length && !hl.note.strokes[0].points)) {
          hl.note.strokes = []
        }
        window._sketchNoteStrokes = hl.note.strokes
      }
    }
    History.clear()
    activeStroke = null
    isDrawing = false
    updateUI()
    updateAutosaveStatus('idle')
    attachInkWhenReady()           // onInkControllerReady → syncNativePage renders the page natively
    return
  }
  // Fallback: create new notebook
  notebook = createNotebook('Notebook', '')
  notebook.notebookId = notebookId
  Storage.saveNotebook(notebook)
  History.clear()
  updateUI()
  attachInkWhenReady()
}

// Read a page's strokes from disk the first time it's shown (lazy load). Pages start strokes=null.
function ensurePageLoaded(index) {
  const p = notebook && notebook.pages[index]
  if (p && p.strokes === null) {
    p.strokes = Storage.loadPageStrokes(notebook.notebookId, p.pageId)
  }
}

// ============== PAPER SIZING ==============

function sizePaper() {
  // Full-screen paper (minus a small margin); the floating menu sits on top of it.
  const area = document.getElementById('canvas-area')
  paper.style.width = (area.clientWidth - 12) + 'px'
  paper.style.height = (area.clientHeight - 12) + 'px'
}

// ============== INK INTEGRATION ==============

// Attach the daemon only once #paper has a real, laid-out size. The reused WebView pre-warms
// OFFSCREEN (size 0) and re-lays-out to full-screen when shown; attaching before that settles
// captured a stale paper rect → wrong inkCssBounds → blank/offset page and mislocated strokes.
function attachInkWhenReady(attempts) {
  attempts = attempts || 0
  const r = paper.getBoundingClientRect()
  if ((r.width < 50 || r.height < 50) && attempts < 40) {
    requestAnimationFrame(function() { attachInkWhenReady(attempts + 1) })
    return
  }
  console.log('DIAG attachReady attempts=' + attempts + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height))
  attachInk()
}

function attachInk() {
  const rect = paper.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  inkCssBounds = { left: rect.left, top: rect.top }
  console.log('[Ink] attachInk dpr=' + dpr +
    ' cssBounds=(' + rect.left + ',' + rect.top + ',' + rect.right + ',' + rect.bottom + ')' +
    ' physBounds=(' + Math.round(rect.left * dpr) + ',' + Math.round(rect.top * dpr) +
    ',' + Math.round(rect.right * dpr) + ',' + Math.round(rect.bottom * dpr) + ')')
  // Pass physical-pixel bounds to native so clearRegion math stays consistent
  Bridge.attachInk(
    Math.round(rect.left * dpr),
    Math.round(rect.top * dpr),
    Math.round(rect.right * dpr),
    Math.round(rect.bottom * dpr)
  )
  Bridge.setInkStyle(strokeWidth * dpr, activeColor)
}

function detachInk() {
  inkSdkActive = false
  if (notebook) Storage.saveThumbnail(notebook.notebookId)
  Bridge.detachInk()
}

// ============== INK CALLBACKS (called from native) ==============

// Strokes are rendered natively on the ink surface during writing; native batches the vector
// data and calls this ONCE after the pen pauses (no JS runs mid-writing). [strokes] is an array
// of point-arrays in surface (physical) px: [[{x,y},...], ...]. We convert to page/CSS coords,
// append to the notebook model, and save.
window.onStrokesBatch = function(strokes) {
  if (!notebook || !strokes || strokes.length === 0) return
  const noteBuf = window._sketchNoteStrokes   // sticky-note sketch → strokes go to the note, not the page
  if (!noteBuf) ensurePageLoaded(currentPageIndex)   // lazy: the page being written to needs its array
  const page = currentPage()
  const target = noteBuf || (page && page.strokes)
  if (!target) return
  const dpr = window.devicePixelRatio || 1
  const felt = activePenType === 'felt'
  const tool = felt ? 'felt' : (activePenType === 'selection' ? 'selection' : 'pen')
  for (let s = 0; s < strokes.length; s++) {
    const pts = strokes[s]   // each point is [surfaceX, surfaceY, pressure]
    if (!pts || pts.length === 0) continue
    const stroke = {
      id: 's-' + uid(),
      tool: tool,
      color: activeColor,
      width: strokeWidth,
      points: pts.map(function(p) {
        const pt = { x: p[0] / dpr - inkCssBounds.left, y: p[1] / dpr - inkCssBounds.top }
        if (felt) pt.p = p[2]   // keep per-point pressure ONLY for felt strokes (ballpoint = constant)
        return pt
      })
    }
    const idx = target.length
    target.push(stroke)
    if (noteBuf) { triggerAutosave(); continue }   // note strokes persist in meta (block.hl.note)
    page._dirty = true
    ;(function(st, i) {
      History.push(
        function() { page.strokes.splice(i, 1); page._dirty = true; triggerAutosave(); History.updateButtons() },
        function() { page.strokes.splice(i, 0, deepClone(st)); page._dirty = true; triggerAutosave(); History.updateButtons() }
      )
    })(stroke, idx)
  }
  // No save here — native schedules window.saveNotebook() only after a long true-idle so the
  // heavy JSON.stringify + disk write never competes with active writing.
}

window.onInkControllerReady = function(available) {
  inkSdkActive = available
  if (available && isDrawing && activeStroke) {
    // Daemon came online mid-pointer-stroke — discard the mixed stroke
    activeStroke = null
    isDrawing = false
  }
  if (!available) {
    // The first attach on open frequently reports false transiently before a retry succeeds, so
    // DON'T toast immediately — schedule it and cancel below if the daemon comes up shortly after.
    // Only a genuine, persistent failure reaches the user.
    console.warn('Ink SDK not available (attach returned false)')
    if (daemonErrorTimer) clearTimeout(daemonErrorTimer)
    daemonErrorTimer = setTimeout(function() {
      if (!inkSdkActive) Bridge.showToast('Pen engine unavailable — writing is disabled')
    }, 2500)
  } else {
    if (daemonErrorTimer) { clearTimeout(daemonErrorTimer); daemonErrorTimer = null }
    // Surface is ready — paint the current page's existing strokes onto the native surface.
    syncNativePage()
    renderPageContent()   // bake any interactive-format content under the ink
    // Bake the FULL toolbar only on open (set by loadNotebookById); page-change re-attach handles
    // its own targeted page-number update, so it doesn't re-bake the whole strip.
    if (window._needFullToolbar) {
      window._needFullToolbar = false
      snapshotToolbar()
    }
  }
}

// Re-render the current page (template + strokes) onto the native ink surface from the model.
// Call after model changes (load / undo / redo / erase / page / template change). All coords in
// SURFACE px. MUST NOT run mid-writing (the model lags the native batch by the idle flush).
// [refreshRect] (optional) = {x,y,w,h} in MODEL/CSS px to refresh ONLY that region on e-ink
// (used by the eraser so it's a partial refresh, not full-screen). Omit for a full refresh.
function syncNativePage(refreshRect) {
  const page = currentPage()
  if (!page) return
  const dpr = window.devicePixelRatio || 1
  const tmpl = page.template || { type: 'blank', spacing: 32, margin: 72 }
  const rect = paper.getBoundingClientRect()
  const out = {
    t: tmpl.type || 'blank',
    sp: (tmpl.spacing || 32) * dpr,
    mg: (tmpl.margin || 72) * dpr,
    dpr: dpr,
    b: [Math.round(rect.left * dpr), Math.round(rect.top * dpr), Math.round(rect.right * dpr), Math.round(rect.bottom * dpr)],
    s: []
  }
  if (refreshRect) {
    const pad = 6
    out.rr = [
      Math.round((refreshRect.x + inkCssBounds.left) * dpr) - pad,
      Math.round((refreshRect.y + inkCssBounds.top) * dpr) - pad,
      Math.round((refreshRect.x + refreshRect.w + inkCssBounds.left) * dpr) + pad,
      Math.round((refreshRect.y + refreshRect.h + inkCssBounds.top) * dpr) + pad
    ]
  }
  // ADAPTIVE template-first: decide per page from its raw byte size (a cheap read, NO parse). Only a
  // HEAVY page shows the template/lines now and defers its strokes a beat later; a LIGHT page parses +
  // renders immediately (no penalty). Applies on open AND page-switch — heavy pages are delayed, light
  // ones are instant.
  // Sticky-note daemon sketch: render the NOTE's own strokes (the content page is baked behind by
  // renderPageContent). Otherwise the page's strokes (with the adaptive template-first lazy load).
  let strokesSrc = window._sketchNoteStrokes
  if (!strokesSrc && window._sketchNote) strokesSrc = []   // note mode w/o buffer → empty, NEVER the page's
  if (!strokesSrc) {
    if (page.strokes === null) {
      const raw = Storage.loadPageRaw(notebook.notebookId, page.pageId)
      if (raw.length > HEAVY_PAGE_BYTES) {
        Bridge.renderInk(JSON.stringify(out))   // out.s empty → template/lines only; strokes deferred
        const idx = currentPageIndex
        if (_strokeLoadTimer) clearTimeout(_strokeLoadTimer)
        _strokeLoadTimer = setTimeout(function() {
          _strokeLoadTimer = null
          page.strokes = Storage.parseStrokes(raw)
          if (notebook && currentPageIndex === idx) syncNativePage()   // render strokes over the template
        }, STROKE_LOAD_DELAY_MS)
        return
      }
      page.strokes = Storage.parseStrokes(raw)  // light page → parse now, render full below
    }
    strokesSrc = page.strokes
  }
  for (let s = 0; s < strokesSrc.length; s++) {
    const st = strokesSrc[s]
    if (!st || !st.points) continue   // skip malformed / legacy-format strokes
    const felt = st.tool === 'felt'
    const dashed = st.tool === 'selection'
    const pts = []
    for (let i = 0; i < st.points.length; i++) {
      const p = st.points[i]
      const arr = [Math.round((p.x + inkCssBounds.left) * dpr), Math.round((p.y + inkCssBounds.top) * dpr)]
      if (felt) arr.push(p.p !== undefined ? p.p : 0.5)   // per-point pressure for variable width
      pts.push(arr)
    }
    const so = { w: (st.width || 3) * dpr, c: st.color || '#111111', p: pts }
    if (felt) so.vw = 1   // tell native to render variable width from the per-point pressure
    if (dashed) so.d = 1  // tell native to render this stroke as a dashed line (selection pen)
    out.s.push(so)
  }
  Bridge.renderInk(JSON.stringify(out))
  schedulePrefetch()   // page is up — warm the neighbouring pages once we settle (instant flips)
  scheduleEvict()      // …and, much more lazily, drop pages that have fallen outside the window
}

// Interactive-format pages: render this page's content blocks into #content-layer, then bake them
// onto the ink surface (under the ink) so the daemon pen writes over the article. Called on page
// change only — the baked bitmap persists across stroke/erase/undo re-renders (drawn natively each
// time), so syncNativePage never re-bakes. Plain pages clear any prior content. No scrolling: the
// content layer is clipped to the page; the page-turn buttons move between pages.
function renderPageContent() {
  if (!notebook) return
  const page = currentPage()
  const layer = document.getElementById('content-layer')
  const sketch = !!window._sketchActive
  layer.classList.toggle('sketch-full', sketch && !!window._sketchFull)
  layer.classList.toggle('sketch-modal', sketch && !!window._sketchModal)

  if (page && Array.isArray(page.blocks) && page.blocks.length) {
    ContentBlocks.render(layer, page, notebook.notebookId, function() {
      if (sketch && window._sketchModal) layer.appendChild(buildSketchBox())  // Post-it OVER the content
      if (sketch) addSketchControls(layer)
      bakeContentAndBound(layer)
    })
    contentActive = true
  } else if (sketch && window._sketchModal) {
    layer.classList.add('has-content'); layer.innerHTML = ''   // sticky note on a content-less page
    layer.appendChild(buildSketchBox()); addSketchControls(layer)
    bakeContentAndBound(layer)
    contentActive = true
  } else {
    layer.classList.remove('has-content')
    layer.innerHTML = ''
    Bridge.setWritingBounds(0, 0, 0, 0)   // plain page → pen writes anywhere
    if (contentActive) { Bridge.clearContent(); contentActive = false }
  }
}

// Bake #content-layer onto the ink surface; confine the daemon pen to the sketch box; and (in full
// screen) exclude the shrink button that sits inside the box so the pen doesn't draw on it.
function bakeContentAndBound(layer) {
  const dpr = window.devicePixelRatio || 1
  const rect = paper.getBoundingClientRect()
  const SL = Math.round(rect.left * dpr), ST = Math.round(rect.top * dpr)
  const SR = Math.round(rect.right * dpr), SB = Math.round(rect.bottom * dpr)
  // Confine the daemon pen to the inner draw box.
  const box = layer.querySelector('.sk-box, .cb-draw-box')
  if (box && window._sketchActive) {
    const r = box.getBoundingClientRect()
    Bridge.setWritingBounds(Math.round(r.left * dpr), Math.round(r.top * dpr),
                            Math.round(r.right * dpr), Math.round(r.bottom * dpr))
  } else {
    Bridge.setWritingBounds(0, 0, 0, 0)
  }
  // Sticky note → bake but refresh ONLY the Post-it card (partial); everything else → full refresh.
  const card = (window._sketchModal && window._sketchNote) ? layer.querySelector('.sk-note') : null
  if (card) {
    const c = card.getBoundingClientRect()
    Bridge.snapshotContentPartial(SL, ST, SR, SB,
      Math.round(c.left * dpr) - 8, Math.round(c.top * dpr) - 8,
      Math.round(c.right * dpr) + 8, Math.round(c.bottom * dpr) + 8)
  } else {
    Bridge.snapshotContent(SL, ST, SR, SB)
  }
  // Full-screen shrink button sits inside the box → exclude it so the pen doesn't draw on it.
  const sh = layer.querySelector('.sk-shrink')
  if (sh) {
    const r = sh.getBoundingClientRect()
    Bridge.setWritingExclusion(Math.round(r.left * dpr), Math.round(r.top * dpr),
                               Math.round(r.right * dpr), Math.round(r.bottom * dpr))
  } else {
    Bridge.setWritingExclusion(0, 0, 0, 0)
  }
}

// A centred, header-less, high-contrast Post-it box for a sticky-note sketch (overlays the page).
function buildSketchBox() {
  const wrap = document.createElement('div'); wrap.className = 'sk-wrap'
  const note = document.createElement('div'); note.className = 'sk-note'
  note.appendChild(Object.assign(document.createElement('div'), { className: 'sk-box' }))
  wrap.appendChild(note)
  return wrap
}

// Sketch controls. Small: Done + Full-page OUTSIDE the box (tappable, outside the pen bounds). Full
// screen: a single shrink-to-window button INSIDE the box's bottom-right (excluded from the pen).
function addSketchControls(layer) {
  if (window._sketchFull) {
    const sh = document.createElement('button'); sh.className = 'sk-shrink'; sh.textContent = '⊟'
    sh.title = 'Window'
    sh.addEventListener('click', function() { window._sketchFull = false; renderPageContent() })
    layer.appendChild(sh)
    return
  }
  const bar = document.createElement('div'); bar.className = 'sk-controls'
  const done = document.createElement('button'); done.className = 'sk-ctl'; done.textContent = '✓ Done'
  done.addEventListener('click', function() { App.showLibrary() })
  const full = document.createElement('button'); full.className = 'sk-ctl'; full.textContent = '⛶ Full page'
  full.addEventListener('click', function() { window._sketchFull = true; renderPageContent() })
  bar.appendChild(done); bar.appendChild(full)
  layer.appendChild(bar)
}

// Deferred-stroke timer for the adaptive template-first path (heavy pages only).
let _strokeLoadTimer = null

// Predictive prefetch (McMaster-Carr's hover-prefetch idea): once you settle on a page and aren't
// navigating, quietly parse the PREFETCH_AHEAD pages ahead + PREFETCH_BEHIND behind into memory so
// a sequential flip is INSTANT (already parsed, no template-first defer). Forward-weighted because
// you almost always flip forward. Each page is parsed only while the main thread is IDLE
// (requestIdleCallback) and prefetch yields entirely whenever the app is doing real work — writing,
// animating, saving, or a pending heavy-page load — so it never competes with foreground jobs.
let _prefetchTimer = null
function schedulePrefetch() {
  if (_prefetchTimer) clearTimeout(_prefetchTimer)
  _prefetchTimer = setTimeout(prefetchNeighbours, PREFETCH_IDLE_MS)
}

// True while the app is doing foreground work that prefetch must yield to (so a background parse
// never steals cycles from the pen, an animation, or a save).
function appBusy() {
  return isDrawing || animOn || autosavePending || _strokeLoadTimer !== null
}

// Run fn when the main thread is idle; fall back to a short timer where requestIdleCallback is absent.
function whenIdle(fn) {
  if (window.requestIdleCallback) { window.requestIdleCallback(fn, { timeout: 2000 }); return }
  setTimeout(fn, 16)
}

function prefetchNeighbours() {
  if (!notebook) return
  // Forward-weighted, nearest-first: all the AHEAD pages (most likely next), then the BEHIND ones.
  const targets = []
  for (let d = 1; d <= PREFETCH_AHEAD; d++) targets.push(currentPageIndex + d)
  for (let d = 1; d <= PREFETCH_BEHIND; d++) targets.push(currentPageIndex - d)
  const base = currentPageIndex
  let i = 0
  ;(function step() {
    if (!notebook || currentPageIndex !== base) return   // navigated away → the new page schedules its own
    if (i >= targets.length) return
    // Only touch the disk/parser when the processor is free; if a job is running, wait and retry
    // WITHOUT consuming a target.
    if (appBusy()) { _prefetchTimer = setTimeout(step, PREFETCH_IDLE_MS); return }
    const idx = targets[i++]
    if (idx >= 0 && idx < notebook.pages.length && notebook.pages[idx].strokes === null) {
      ensurePageLoaded(idx)   // read + parse → ready in memory for an instant flip
    }
    whenIdle(step)            // next page only once the main thread is idle again
  })()
}

// Memory eviction: a page's strokes stay resident once parsed, so flipping through a long notebook
// (and, later, a converted book of hundreds of pages) grows memory until the OS kills the app. Drop
// the strokes of pages OUTSIDE a resident window around the current page back to null — they reload
// instantly via the lazy path (ensurePageLoaded). This is gated EVEN HARDER than prefetch: it waits a
// long settle (EVICT_IDLE_MS), then runs only inside a TRUE idle slice (requestIdleCallback with NO
// timeout, so it's never forced) that actually has time left, and yields whenever the app is busy. It
// NEVER evicts a dirty page — autosave clears _dirty first, then a later pass drops it — so eviction
// can't lose unsaved ink and never has to perform a save itself.
let _evictTimer = null
function scheduleEvict() {
  if (_evictTimer) clearTimeout(_evictTimer)
  _evictTimer = setTimeout(function() {
    if (window.requestIdleCallback) window.requestIdleCallback(evictDistantPages)   // no timeout: pure idle only
    else evictDistantPages(null)
  }, EVICT_IDLE_MS)
}

function evictDistantPages(deadline) {
  if (!notebook) return
  // Defer if the app is working, or the idle slice is too short to be safe — retry later, never force it.
  if (appBusy() || (deadline && deadline.timeRemaining() < EVICT_MIN_IDLE_MS)) { scheduleEvict(); return }
  const lo = currentPageIndex - RESIDENT_BEHIND
  const hi = currentPageIndex + RESIDENT_AHEAD
  const pages = notebook.pages
  for (let idx = 0; idx < pages.length; idx++) {
    if (idx >= lo && idx <= hi) continue            // inside the resident window → keep
    const p = pages[idx]
    if (p && p.strokes !== null && !p._dirty) {
      p.strokes = null                              // drop parsed strokes; reload is the lazy path
      // (When block/image content lands: also null p.blocks and release its cached bitmaps here.)
    }
  }
}

// The floating menu's bounds at its last snapshot (surface px), so a collapse/expand can refresh
// the union of old + new bounds (clearing the footprint the menu used to cover).
let lastMenuBounds = null

// Re-snapshot the floating menu onto the surface (so it's visible) and tell the daemon to ignore
// pen inside it. [prevBounds] (optional) = the menu's previous footprint, for the clear-on-collapse
// refresh. Called whenever the menu opens/closes or its contents change (tool, page number, …).
function updateMenu(prevBounds) {
  const menu = document.getElementById('menu')
  if (!menu) return
  const dpr = window.devicePixelRatio || 1
  requestAnimationFrame(function() {
    const r = menu.getBoundingClientRect()
    const cl = Math.floor(r.left * dpr), ct = Math.floor(r.top * dpr)
    const cr = Math.ceil(r.right * dpr), cb = Math.ceil(r.bottom * dpr)
    if (cr <= cl || cb <= ct) return
    Bridge.setWritingTop(0)                       // no top strip any more
    // Exclude only the menu's own footprint from writing — pen-down on the (small) handle opens it
    // rather than writing under it; everything NOT covered by the menu stays writable.
    Bridge.setWritingExclusion(cl, ct, cr, cb)
    const p = prevBounds || { l: cl, t: ct, r: cr, b: cb }
    Bridge.snapshotMenu(cl, ct, cr, cb,
      Math.min(cl, p.l), Math.min(ct, p.t), Math.max(cr, p.r), Math.max(cb, p.b))
    lastMenuBounds = { l: cl, t: ct, r: cr, b: cb }
  })
}

// Open/close the menu. Capture the footprint BEFORE toggling so we can clear it on collapse.
function toggleMenu() {
  const menu = document.getElementById('menu')
  const prev = lastMenuBounds
  menu.classList.toggle('collapsed')
  updateMenu(prev)
}

// Full menu re-bake (used on open). Targeted updates use snapshotToolbarEls below.
function snapshotToolbar() { updateMenu(lastMenuBounds) }

// Re-bake ONLY the region covering the given element ids (e.g. the two tool buttons, or the page
// number) and refresh just that rect — so a button tap doesn't re-bake/flash the whole menu. When
// the menu is collapsed the buttons are hidden (no layout box) so this safely no-ops.
function snapshotToolbarEls(ids) {
  const dpr = window.devicePixelRatio || 1
  requestAnimationFrame(function() {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i])
      if (!el || el.offsetParent === null) continue   // hidden (menu collapsed) → skip
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.left < l) l = rect.left
      if (rect.top < t) t = rect.top
      if (rect.right > r) r = rect.right
      if (rect.bottom > b) b = rect.bottom
    }
    if (r <= l || b <= t) return
    Bridge.snapshotToolbarRegion(
      Math.floor(l * dpr), Math.floor(t * dpr), Math.ceil(r * dpr), Math.ceil(b * dpr))
  })
}

// Flush the native stroke batch into the model, then run [fn] against the up-to-date model.
// Used before model ops (undo/redo/erase) so strokes written but not yet flushed aren't lost.
let pendingAfterFlush = null
function flushNativeThen(fn) {
  pendingAfterFlush = fn
  Bridge.flushInk()   // native flushes the batch (window.onStrokesBatch) then fires onNativeFlushed
}
window.onNativeFlushed = function() {
  const cb = pendingAfterFlush
  pendingAfterFlush = null
  if (cb) cb()
}

// ============== ERASER ==============

function distToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const projX = ax + t * dx
  const projY = ay + t * dy
  return (px - projX) * (px - projX) + (py - projY) * (py - projY)
}

function hitTestStroke(ex, ey, stroke) {
  const pts = stroke.points
  if (pts.length === 0) return false
  const eraserRadius = 8    // model/CSS px — narrow for precision (swipe-path sampling keeps it reliable)
  const hitThreshold = eraserRadius + stroke.width / 2
  const hitThresholdSq = hitThreshold * hitThreshold

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (ex < minX - hitThreshold || ex > maxX + hitThreshold ||
      ey < minY - hitThreshold || ey > maxY + hitThreshold) {
    return false
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const dSq = distToSegmentSq(ex, ey, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)
    if (dSq < hitThresholdSq) return true
  }
  if (pts.length === 1) {
    const dSq = (ex - pts[0].x) * (ex - pts[0].x) + (ey - pts[0].y) * (ey - pts[0].y)
    if (dSq < hitThresholdSq) return true
  }
  return false
}

function hitTestAll(ex, ey) {
  const page = currentPage()
  if (!page) return null
  for (let i = page.strokes.length - 1; i >= 0; i--) {
    if (hitTestStroke(ex, ey, page.strokes[i])) {
      return page.strokes[i]
    }
  }
  return null
}

// Called from native after a live eraser swipe. [indices] = stroke indices the native surface
// already rubbed out (it hit-tests live); drop them from the vector model so save/undo stay in sync.
// Indices match page.strokes order because native flushes pending strokes before erasing.
function updateEraserCursor(x, y) {
  const eraserRadius = 12
  eraserCursor.style.width = (eraserRadius * 2) + 'px'
  eraserCursor.style.height = (eraserRadius * 2) + 'px'
  eraserCursor.style.left = x + 'px'
  eraserCursor.style.top = y + 'px'
  eraserCursor.style.display = 'block'
}

function hideEraserCursor() {
  eraserCursor.style.display = 'none'
}

// ============== POINTER EVENTS (eraser and fallback pen) ==============

function getCanvasCoords(e) {
  // Use the SAME offset the model uses (inkCssBounds), NOT the live paper rect. The two can diverge
  // (reused WebView / offscreen-layout race leaves inkCssBounds stale), and then the eraser would
  // hit-test in a different space than the strokes and miss everything. surface_x/dpr == clientX
  // (full-screen surface), so model coord = clientX - inkCssBounds.left.
  return { x: e.clientX - inkCssBounds.left, y: e.clientY - inkCssBounds.top }
}

function isStylusEraser(e) {
  // W3C Pointer Events: the stylus eraser reports pointerType 'pen' with buttons bit 32 / button 5.
  return e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5)
}

function onPointerDown(e) {
  const eraserEnd = isStylusEraser(e)
  // Pen TIP while the daemon is active: the daemon owns writing — do nothing here (keep the write
  // path free of web work). Only the stylus eraser is handled in the web layer.
  if (!eraserEnd && inkSdkActive && activeTool !== 'eraser') return

  e.preventDefault()
  PenPriority.enterCapture()

  if (e.pointerType === 'pen') {
    if (eraserEnd && activeTool !== 'eraser') {
      activeTool = 'eraser'
      flipEraserActive = true
      activeStroke = null
      isDrawing = false
      Bridge.setErasing(true)   // native discards any daemon stroke (mis-detected eraser-as-pen)
      updateUI()
    } else if (!eraserEnd && flipEraserActive && activeTool === 'eraser') {
      activeTool = 'pen'
      flipEraserActive = false
      Bridge.setErasing(false)
      updateUI()
    }
  }

  const coords = getCanvasCoords(e)

  // Pen tip: the daemon owns writing — no web-canvas fallback (single-device build).
  if (activeTool === 'eraser') {
    paper.setPointerCapture(e.pointerId)
    isDrawing = true
    eraseBox = null            // start a fresh erased-region accumulation for this swipe
    eraseAt(coords.x, coords.y)
    lastErasePoint = coords
  }
}

// Erase EVERY stroke within the eraser radius of (x,y) — handles densely stacked strokes too.
function eraseAt(x, y) {
  let hit = hitTestAll(x, y)
  while (hit) { eraseStroke(hit); hit = hitTestAll(x, y) }
}

// Erase along the segment from→to, sampling intermediate points so a fast swipe (sparse pointermove
// events) doesn't skip over strokes between samples.
function eraseAlong(from, to) {
  if (!from) { eraseAt(to.x, to.y); return }
  const dx = to.x - from.x, dy = to.y - from.y
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 6))
  for (let i = 1; i <= steps; i++) eraseAt(from.x + dx * i / steps, from.y + dy * i / steps)
}

// Live erase feedback: re-render + partial-refresh the just-erased region, throttled so the e-ink
// GU16 refreshes don't pile up. Strokes vanish as the swipe crosses them instead of all at pen-up.
function scheduleEraseRefresh() {
  if (eraseRefreshTimer) return        // already one pending — throttle
  eraseRefreshTimer = setTimeout(flushEraseRefresh, ERASE_REFRESH_MS)
}

function flushEraseRefresh() {
  eraseRefreshTimer = null
  if (!eraseBox) return
  const rr = { x: eraseBox.minX, y: eraseBox.minY, w: eraseBox.maxX - eraseBox.minX, h: eraseBox.maxY - eraseBox.minY }
  eraseBox = null                      // reset so the next interval refreshes only the newly-erased area
  syncNativePage(rr)
}

// Pen is owned by the daemon — these handlers only act on the stylus/button ERASER.
function onPointerMove(e) {
  if (activeTool !== 'eraser' || !isDrawing) return
  e.preventDefault()
  const coords = getCanvasCoords(e)
  eraseAlong(lastErasePoint, coords)   // erases the model + schedules a live refresh per stroke
  lastErasePoint = coords
}

function eraserFinalize() {
  isDrawing = false
  lastErasePoint = null
  hideEraserCursor()
  if (eraseRefreshTimer) { clearTimeout(eraseRefreshTimer); eraseRefreshTimer = null }
  if (eraseBox) {                      // flush any region erased since the last live refresh
    const rr = { x: eraseBox.minX, y: eraseBox.minY, w: eraseBox.maxX - eraseBox.minX, h: eraseBox.maxY - eraseBox.minY }
    syncNativePage(rr)
    eraseBox = null
  }
  triggerAutosave()
}

function onPointerUp(e) {
  if (activeTool !== 'eraser' || !isDrawing) return
  e.preventDefault()
  eraserFinalize()
}

function onPointerLeave(e) {
  if (activeTool !== 'eraser' || !isDrawing) return
  eraserFinalize()
  try { paper.releasePointerCapture(e.pointerId) } catch(_) {}
}

// ============== ERASE STROKE ==============

// Remove a stroke from the model + push undo, and schedule a throttled live refresh so it visibly
// disappears mid-swipe (not all at once on pen-up).
function eraseStroke(stroke) {
  const page = currentPage()
  if (!page) return
  const idx = page.strokes.indexOf(stroke)
  if (idx === -1) return
  const copy = deepClone(stroke)
  page.strokes.splice(idx, 1)
  page._dirty = true
  for (let i = 0; i < stroke.points.length; i++) {
    const p = stroke.points[i]
    if (!eraseBox) eraseBox = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
    else {
      if (p.x < eraseBox.minX) eraseBox.minX = p.x
      if (p.y < eraseBox.minY) eraseBox.minY = p.y
      if (p.x > eraseBox.maxX) eraseBox.maxX = p.x
      if (p.y > eraseBox.maxY) eraseBox.maxY = p.y
    }
  }
  History.push(
    function() { page.strokes.splice(idx, 0, deepClone(copy)); page._dirty = true; syncNativePage(); triggerAutosave(); History.updateButtons() },
    function() { page.strokes.splice(idx, 1); page._dirty = true; syncNativePage(); triggerAutosave(); History.updateButtons() }
  )
  scheduleEraseRefresh()   // live feedback (throttled); finalize handles the remainder on pen-up
}

// ============== PAGE MANAGEMENT ==============

function goToPage(index) {
  if (index < 0 || index >= totalPages()) return
  stopAnim()                // animations are per-page — leaving this page stops it
  currentPageIndex = index  // syncNativePage loads this page's strokes adaptively (light = now, heavy = deferred)
  activeStroke = null
  isDrawing = false
  hideEraserCursor()
  updateUI()
  // The daemon stays attached across page changes (same full-screen surface) — re-attaching it was
  // ~160ms of reflection + re-bind per turn. Just re-render the new page onto the surface.
  syncNativePage()
  renderPageContent()   // re-bake the new page's interactive content (or clear it on a plain page)
  snapshotToolbarEls(['btn-prev', 'page-num', 'btn-next', 'btn-add', 'btn-delete'])
}

// Hardware page-turn buttons in a notebook: down = next page (creates one if on the last page),
// up = previous page. Flush pending strokes first so the current page's writing is saved.
function editorPageTurn(dir) {
  if (!notebook) return
  if (dir === 'down') {
    if (currentPageIndex < totalPages() - 1) flushNativeThen(goToNextPage)
    else flushNativeThen(addPage)
  } else if (dir === 'up') {
    if (currentPageIndex > 0) flushNativeThen(goToPrevPage)
  }
}

function goToPrevPage() {
  if (currentPageIndex > 0) goToPage(currentPageIndex - 1)
}

function goToNextPage() {
  if (currentPageIndex < totalPages() - 1) goToPage(currentPageIndex + 1)
}

function addPage() {
  stopAnim()
  const page = currentPage()
  const tmpl = page ? page.template : notebook.defaultTemplate
  const newPage = createPage(tmpl)
  const newIndex = currentPageIndex + 1
  notebook.pages.splice(newIndex, 0, newPage)
  const prevIndex = currentPageIndex
  currentPageIndex = newIndex
  History.push(
    function() {
      notebook.pages.splice(newIndex, 1)
      currentPageIndex = prevIndex < notebook.pages.length ? prevIndex : notebook.pages.length - 1
      updateUI(); triggerAutosave(); History.updateButtons()
    },
    function() {
      notebook.pages.splice(newIndex, 0, newPage)
      currentPageIndex = newIndex
      updateUI(); triggerAutosave(); History.updateButtons()
    }
  )
  activeStroke = null
  isDrawing = false
  updateUI()
  syncNativePage()   // daemon stays attached; just re-render the new page
  renderPageContent()   // new page has no blocks → clears any baked content
  snapshotToolbarEls(['btn-prev', 'page-num', 'btn-next', 'btn-add', 'btn-delete'])
  triggerAutosave()
}

function deletePage() {
  if (totalPages() <= 1) return
  stopAnim()
  const pageToDelete = notebook.pages[currentPageIndex]
  const deleteIndex = currentPageIndex
  const wasLastPage = currentPageIndex === totalPages() - 1
  notebook.pages.splice(currentPageIndex, 1)
  if (wasLastPage) currentPageIndex = Math.max(0, totalPages() - 1)
  History.push(
    function() {
      const restored = deepClone(pageToDelete)
      restored._dirty = true   // its page file was vacuumed on the delete's save — re-write its strokes
      notebook.pages.splice(deleteIndex, 0, restored)
      currentPageIndex = deleteIndex
      updateUI(); triggerAutosave(); History.updateButtons()
    },
    function() {
      notebook.pages.splice(deleteIndex, 1)
      if (currentPageIndex >= notebook.pages.length) currentPageIndex = notebook.pages.length - 1
      updateUI(); triggerAutosave(); History.updateButtons()
    }
  )
  activeStroke = null
  isDrawing = false
  updateUI()
  syncNativePage()   // daemon stays attached; just re-render the new page
  renderPageContent()   // re-bake the now-current page's content (or clear it)
  snapshotToolbarEls(['btn-prev', 'page-num', 'btn-next', 'btn-add', 'btn-delete'])
  triggerAutosave()
}

// ============== TEMPLATE ==============

function setTemplate(type) {
  const page = currentPage()
  if (!page) return
  const oldTmpl = deepClone(page.template)
  const newTmpl = deepClone(page.template)
  newTmpl.type = type
  page.template = newTmpl
  // Also update notebook default template
  notebook.defaultTemplate = deepClone(newTmpl)
  History.push(
    function() { page.template = deepClone(oldTmpl); triggerAutosave(); History.updateButtons(); updateUI() },
    function() { page.template = deepClone(newTmpl); triggerAutosave(); History.updateButtons(); updateUI() }
  )
  updateUI()
  triggerAutosave()
  syncNativePage()   // re-render the native page with the new template
}

// ============== AUTOSAVE ==============

function triggerAutosave() {
  if (!notebook) return
  updateAutosaveStatus('saving')
  autosavePending = true
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(function() {
    if (!Storage.saveNotebookDirty(notebook)) {
      // Don't pretend it saved — a silent failure on a removed/full SD card would lose work.
      autosavePending = false
      updateAutosaveStatus('error')
      Bridge.showToast('Save failed — check storage')
      return
    }
    // Also update library index
    const lib = Storage.loadLibrary()
    const info = lib.notebooks.find(function(n) { return n.notebookId === notebook.notebookId })
    if (info) {
      info.title = notebook.title
      info.updatedAt = notebook.updatedAt
      info.folderId = notebook.folderId || ''
      info.defaultTemplate = notebook.defaultTemplate
      Storage.saveLibrary(lib)
    }
    autosavePending = false
    updateAutosaveStatus('saved')
    setTimeout(function() { if (!autosavePending) updateAutosaveStatus('idle') }, 2000)
  }, 300)
}

function updateAutosaveStatus(state) {
  if (!autosaveStatus) return
  if (state === 'saving') {
    autosaveStatus.textContent = 'Saving...'
  } else if (state === 'saved') {
    autosaveStatus.textContent = 'Saved'
  } else if (state === 'error') {
    autosaveStatus.textContent = '⚠ Save failed'
  } else {
    autosaveStatus.textContent = ''
  }
}

// ============== SAVE on navigation ==============

window.saveNotebook = function() {
  if (notebook && !Storage.saveNotebookDirty(notebook)) {
    updateAutosaveStatus('error')
    Bridge.showToast('Save failed — check storage')
  }
}

window.onExportComplete = function(success) {
  Bridge.showToast(success ? 'Exported successfully' : 'Export cancelled')
}

// ============== UI ==============

function updateUI() {
  const page = currentPage()
  const total = totalPages()
  pageNumEl.textContent = (currentPageIndex + 1) + '/' + total
  document.getElementById('btn-prev').disabled = currentPageIndex <= 0
  document.getElementById('btn-next').disabled = currentPageIndex >= total - 1
  document.getElementById('btn-delete').disabled = total <= 1
  if (page) {
    templateSelect.value = page.template.type
  }
  document.getElementById('btn-pen').classList.toggle('active', activeTool === 'pen' && activePenType === 'ballpoint')
  document.getElementById('btn-felt').classList.toggle('active', activeTool === 'pen' && activePenType === 'felt')
  document.getElementById('btn-selection').classList.toggle('active', activeTool === 'pen' && activePenType === 'selection')
  document.getElementById('btn-eraser').classList.toggle('active', activeTool === 'eraser')
}

// ============== TOOLBAR EVENTS ==============

// Switch to a writing pen. type = 'ballpoint' (constant width) | 'felt' (width follows pen pressure).
function selectPen(type) {
  activeTool = 'pen'
  activePenType = type
  flipEraserActive = false
  activeStroke = null
  isDrawing = false
  hideEraserCursor()
  Bridge.setErasing(false)               // daemon resumes inking; pen tip writes
  Bridge.setPenType(type)                // 'ballpoint' | 'felt' (pressure width) | 'selection' (dashed)
  updateUI()
  snapshotToolbarEls(['btn-pen', 'btn-felt', 'btn-selection', 'btn-eraser'])
}

// Expanding colour palette inside the menu (the menu grows; updateMenu re-snapshots + refreshes,
// exactly like a menu expand/collapse — so it reuses the proven menu-snapshot path).
function toggleColorPopup() {
  const grid = document.getElementById('color-grid')
  grid.style.display = (grid.style.display === 'none' || !grid.style.display) ? 'grid' : 'none'
  updateMenu(lastMenuBounds)
}

function closeColorPopup() {
  const grid = document.getElementById('color-grid')
  if (grid.style.display === 'none') return
  grid.style.display = 'none'
  updateMenu(lastMenuBounds)   // refresh union clears the palette's footprint as the menu shrinks
}

// Pick an ink colour. Applies to the daemon (live) + new strokes; each stroke stores its own colour.
function selectColor(hex) {
  activeColor = hex
  Bridge.setInkStyle(strokeWidth * (window.devicePixelRatio || 1), activeColor)
  updateColorUI()
  closeColorPopup()
}

function updateColorUI() {
  const dot = document.getElementById('color-dot')
  if (dot) dot.style.background = activeColor
  const sws = document.querySelectorAll('#color-grid .pop-swatch')
  for (let i = 0; i < sws.length; i++) {
    sws[i].classList.toggle('active', sws[i].getAttribute('data-color').toLowerCase() === activeColor.toLowerCase())
  }
}

// Bird-on-a-bike animation, driven entirely in the web layer (rAF). Wheels + crank rotate by time;
// the legs are solved with 2-bone IK so the feet ride the pedals. Native is unaware of any of this —
// it just samples the #anim-layer region — so this is fully generic (swap Bike + the SVG for anything).
const Bike = {
  active: false, built: false,
  _wheel(id, cx, cy, r) {
    const g = document.getElementById(id), NS = 'http://www.w3.org/2000/svg'
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI / 3, dx = r * Math.cos(a), dy = r * Math.sin(a)
      const ln = document.createElementNS(NS, 'line')
      ln.setAttribute('x1', (cx - dx).toFixed(1)); ln.setAttribute('y1', (cy - dy).toFixed(1))
      ln.setAttribute('x2', (cx + dx).toFixed(1)); ln.setAttribute('y2', (cy + dy).toFixed(1))
      ln.setAttribute('stroke', '#141414'); ln.setAttribute('stroke-width', '2')
      g.insertBefore(ln, g.firstChild)
    }
  },
  _rot(id, deg, cx, cy) {
    document.getElementById(id).setAttribute('transform', 'rotate(' + deg.toFixed(1) + ' ' + cx + ' ' + cy + ')')
  },
  _leg(id, hip, foot, L1, L2) {
    const dx = foot.x - hip.x, dy = foot.y - hip.y
    let d = Math.hypot(dx, dy); d = Math.min(d, L1 + L2 - 0.5)
    const base = Math.atan2(dy, dx)
    let c = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d); c = Math.max(-1, Math.min(1, c))
    const ka = base - Math.acos(c)   // knee bends toward the front
    const kx = hip.x + L1 * Math.cos(ka), ky = hip.y + L1 * Math.sin(ka)
    document.getElementById(id).setAttribute('d', 'M' + hip.x + ' ' + hip.y + ' L' + kx.toFixed(1) + ' ' + ky.toFixed(1) + ' L' + foot.x.toFixed(1) + ' ' + foot.y.toFixed(1))
  },
  frame(ms) {
    const wheelDeg = (ms * 0.5) % 360
    this._rot('wheel-back', wheelDeg, 62, 148)
    this._rot('wheel-front', wheelDeg, 184, 148)
    const crankDeg = (ms * 0.27) % 360
    this._rot('crank', crankDeg, 123, 150)
    const a = crankDeg * Math.PI / 180, kc = { x: 123, y: 150 }, pr = 15, hip = { x: 116, y: 100 }
    this._leg('leg-near', hip, { x: kc.x + pr * Math.cos(a), y: kc.y + pr * Math.sin(a) }, 32, 34)
    this._leg('leg-far', hip, { x: kc.x - pr * Math.cos(a), y: kc.y - pr * Math.sin(a) }, 32, 34)
    document.getElementById('bird').setAttribute('transform', 'translate(0 ' + (Math.sin(a * 2) * 1.2).toFixed(2) + ')')
  },
  start() {
    // Build the wheel spokes once, then CSS drives all motion (compositor-based — keeps advancing
    // when occluded, unlike rAF which throttles). No JS animation loop needed.
    if (!this.built) { this._wheel('wheel-back', 62, 148, 34); this._wheel('wheel-front', 184, 148, 34); this.built = true }
    this.active = true
  },
  stop() { this.active = false }
}

// Toggle a web-defined animation placed on the page. The animation is pure web (SVG + the Bike rAF);
// native just samples that region of the WebView each frame and fast-refreshes it onto the e-ink
// surface — so this is generic (swap the element + driver for any other animation).
let animOn = false

// Stop any running animation + clean its region. Cheap no-op when nothing is running, so it's safe
// to call on every page-change / editor-exit (keeps the animation scoped to its own page only).
function stopAnim() {
  if (!animOn) return
  animOn = false
  Bike.stop()
  Bridge.stopWebAnim()
  document.getElementById('anim-layer').style.display = 'none'
  document.getElementById('btn-anim').classList.remove('active')
}
window.stopAnim = stopAnim

function toggleAnim() {
  const layer = document.getElementById('anim-layer')
  const btn = document.getElementById('btn-anim')
  if (animOn) { stopAnim(); return }
  // Place at the centre of the writing area (toolbar-driven placement comes next).
  const area = document.getElementById('canvas-area')
  layer.style.display = 'flex'
  const w = layer.offsetWidth, h = layer.offsetHeight
  layer.style.left = Math.round((area.clientWidth - w) / 2) + 'px'
  layer.style.top = Math.round((area.clientHeight - h) / 2) + 'px'
  animOn = true
  btn.classList.add('active')
  Bike.start()   // start the web-side animation loop (rAF); native samples it independently
  // Hand native the element's surface-px region after layout settles.
  requestAnimationFrame(function() {
    const r = layer.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    Bridge.startWebAnim(Math.floor(r.left * dpr), Math.floor(r.top * dpr), Math.ceil(r.right * dpr), Math.ceil(r.bottom * dpr))
  })
}

function initToolbar() {
  document.getElementById('btn-menu').addEventListener('click', toggleMenu)

  document.getElementById('btn-library').addEventListener('click', function() {
    detachInk()
    saveNotebook()
    App.showLibrary()
  })

  document.getElementById('btn-pen').addEventListener('click', function() {
    selectPen('ballpoint')
  })

  document.getElementById('btn-felt').addEventListener('click', function() {
    selectPen('felt')
  })

  document.getElementById('btn-selection').addEventListener('click', function() {
    selectPen('selection')
  })

  document.getElementById('btn-eraser').addEventListener('click', function() {
    activeTool = 'eraser'
    flipEraserActive = false
    activeStroke = null
    isDrawing = false
    // Eraser mode: daemon paints NO ink (keeps delivering events to the web), so the pen TIP erases
    // via the web layer's reliable pointer events instead of writing. tool=0 = rock-solid.
    Bridge.setErasing(true)
    updateUI()
    snapshotToolbarEls(['btn-pen', 'btn-felt', 'btn-eraser'])   // only the tool buttons changed
  })

  document.getElementById('btn-anim').addEventListener('click', toggleAnim)
  document.getElementById('btn-color').addEventListener('click', toggleColorPopup)
  const popSwatches = document.querySelectorAll('#color-grid .pop-swatch')
  for (let i = 0; i < popSwatches.length; i++) {
    popSwatches[i].addEventListener('click', function() { selectColor(this.getAttribute('data-color')) })
  }
  updateColorUI()   // sync the Color cell's swatch + active highlight to the default colour

  widthSlider.addEventListener('input', function() {
    strokeWidth = parseInt(this.value, 10)
    widthValue.textContent = strokeWidth
    Bridge.setInkStyle(strokeWidth * (window.devicePixelRatio || 1), activeColor)
  })
  // The toolbar is a baked snapshot, so the live slider/value moving isn't visible until we
  // re-snapshot. Do it when the slider is released ('change'), not on every 'input' tick.
  widthSlider.addEventListener('change', function() {
    snapshotToolbarEls(['width-slider', 'width-value'])
  })

  templateSelect.addEventListener('change', function() {
    const v = this.value
    flushNativeThen(function() { setTemplate(v); snapshotToolbarEls(['template-select']) })
  })

  document.getElementById('btn-undo').addEventListener('click', function() {
    flushNativeThen(function() { History.undo(); syncNativePage() })
  })
  document.getElementById('btn-redo').addEventListener('click', function() {
    flushNativeThen(function() { History.redo(); syncNativePage() })
  })
  // Page ops flush the native batch first so the strokes written on the current page land in
  // its model before we switch away.
  document.getElementById('btn-prev').addEventListener('click', function() { flushNativeThen(goToPrevPage) })
  document.getElementById('btn-next').addEventListener('click', function() { flushNativeThen(goToNextPage) })
  document.getElementById('btn-add').addEventListener('click', function() { flushNativeThen(addPage) })
  document.getElementById('btn-delete').addEventListener('click', function() { flushNativeThen(deletePage) })
  document.getElementById('btn-export').addEventListener('click', function() {
    if (notebook) Bridge.exportNotebook(notebook.notebookId)
  })

  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault()
      if (e.shiftKey) flushNativeThen(function() { History.redo(); syncNativePage() })
      else flushNativeThen(function() { History.undo(); syncNativePage() })
    }
  })
}
