// Interactive reading mode for on-disk interactive-format notebooks (a notebook "variant" whose
// pages carry blocks[]). In reading mode the native ink surface is HIDDEN and the WebView is the live
// layer, so content is interactive: text is selectable (EPUB-style highlights — Stage 2), MCQs are
// finger-tapped, animations have play/pause. The daemon low-latency ink is reserved for sticky-note
// drawing areas (Stage 3). No scrolling: page-turn buttons move pages; blocks are authored to fit.
// See memory project_kalamos_interactive_format. Reuses el/escapeHtml/miniMarkdown from content-blocks.js.
const Reader = {
  nb: null,            // lazy notebook (pages carry blocks; strokes unused in reading mode)
  page: 0,

  // True if this notebook is interactive (any page has blocks). [meta] = a loaded lazy notebook.
  isInteractive(meta) {
    return !!(meta && meta.pages && meta.pages.some(function(p) {
      return Array.isArray(p.blocks) && p.blocks.length
    }))
  },

  open(meta) {
    this.nb = meta
    this.page = 0
    document.getElementById('library-view').style.display = 'none'
    document.getElementById('editor-view').style.display = 'none'
    document.getElementById('reader-view').style.display = 'flex'
    Bridge.enterLibrary()        // hide the ink surface → the WebView is the visible interactive layer
    App.current = 'reader'
    this.render()
  },

  close() {
    if (this._noteWrap) this.closeNote()   // detach the note's ink surface first (else it obscures the library)
    document.getElementById('reader-view').style.display = 'none'
    document.getElementById('library-view').style.display = 'flex'
    App.current = 'library'
    if (typeof renderLibrary === 'function') renderLibrary()
  },

  next() { if (this.page < this.nb.pages.length - 1) { this.page++; this.render() } },
  prev() { if (this.page > 0) { this.page--; this.render() } },

  render() {
    const view = document.getElementById('reader-view')
    view.innerHTML = ''

    // top bar: back + title + page indicator
    const bar = el('div', 'rd-bar')
    const back = el('button', 'rd-btn', '← Library')
    back.addEventListener('click', () => this.close())
    bar.appendChild(back)
    bar.appendChild(el('div', 'rd-title', this.nb.title || 'Notebook'))
    bar.appendChild(el('div', 'rd-pageind', (this.page + 1) + ' / ' + this.nb.pages.length))
    view.appendChild(bar)

    // the page: a fixed (non-scrolling) column of interactive blocks
    const pageEl = el('div', 'rd-page')
    this.pageEl = pageEl
    const blocks = (this.nb.pages[this.page] || {}).blocks || []
    blocks.forEach((b, i) => pageEl.appendChild(this.block(b, i)))
    view.appendChild(pageEl)
    this.wireSelection(pageEl)

    // bottom nav
    const nav = el('div', 'rd-nav')
    const prev = el('button', 'rd-btn', '▲ Prev'); prev.disabled = this.page === 0
    prev.addEventListener('click', () => this.prev())
    const nx = el('button', 'rd-btn', 'Next ▼'); nx.disabled = this.page === this.nb.pages.length - 1
    nx.addEventListener('click', () => this.next())
    nav.appendChild(prev); nav.appendChild(nx)
    view.appendChild(nav)

    // overlay layers (fixed, above the page): persistent highlights + the live selection
    this.hlLayer = el('div', 'rd-overlay'); view.appendChild(this.hlLayer)
    this.selLayer = el('div', 'rd-overlay'); view.appendChild(this.selLayer)
    this.renderHighlights()

    // a drawing page auto-enters the daemon sketch (confined to its box) the moment you reach it
    if (blocks.some(function(b) { return b.type === 'drawing' }) && !this._suppressAutoSketch) {
      const self = this
      setTimeout(function() { if (App.current === 'reader') self.openSketch() }, 350)
    }
    this._suppressAutoSketch = false
  },

  block(b, i) {
    switch (b.type) {
      case 'text':      return this.text(b, i)
      case 'image':     return this.image(b)
      case 'mcq':       return this.mcq(b)
      case 'drawing':   return this.drawing(b, i)
      case 'animation': return this.anim(b)
      default:          return el('div', 'rd-unknown', '[' + b.type + ']')
    }
  },

  text(b, i) {
    const d = el('div', 'rd-text')
    d.dataset.bi = i
    d.innerHTML = miniMarkdown(b.format === 'plain' ? escapeHtml(b.md) : (b.md || ''))
    return d   // highlights are drawn as an overlay (renderHighlights), not by mutating the text
  },

  image(b) {
    const fig = el('figure', 'rd-figure cb-fit-' + (b.fit || 'contain'))
    const img = document.createElement('img')
    img.className = 'rd-img'
    img.alt = b.alt || ''
    img.addEventListener('error', function() { fig.classList.add('rd-img-missing') })
    let url = ''
    try { url = Bridge.getNotebookAsset(this.nb.notebookId, b.src) } catch (e) {}
    if (url) img.src = url
    fig.appendChild(img)
    if (b.caption) fig.appendChild(el('figcaption', 'rd-caption', b.caption))
    return fig
  },

  // Finger-tappable MCQ: select a choice, Check grades it (correct/incorrect + explanation).
  mcq(b) {
    if (!b.state) b.state = { selected: [], revealed: false }
    const box = el('div', 'rd-mcq')
    const q = el('div', 'rd-mcq-q'); q.innerHTML = miniMarkdown(b.prompt).replace(/^<p>|<\/p>$/g, '')
    box.appendChild(q)
    const list = el('div', 'rd-choices')
    const sync = () => Array.from(list.children).forEach((ch) => ch._sync && ch._sync())
    b.choices.forEach((c) => {
      const btn = el('button', 'rd-choice')
      btn.innerHTML = miniMarkdown(c.md).replace(/^<p>|<\/p>$/g, '')
      btn._sync = () => {
        btn.classList.toggle('sel', b.state.selected.indexOf(c.id) !== -1)
        if (b.state.revealed) {
          const correct = b.answer.indexOf(c.id) !== -1
          btn.classList.toggle('correct', correct)
          btn.classList.toggle('wrong', !correct && b.state.selected.indexOf(c.id) !== -1)
        }
      }
      btn.addEventListener('click', () => {
        if (b.state.revealed) return
        if (b.multi) {
          const i = b.state.selected.indexOf(c.id)
          if (i === -1) b.state.selected.push(c.id); else b.state.selected.splice(i, 1)
        } else b.state.selected = [c.id]
        sync()
      })
      btn._sync(); list.appendChild(btn)
    })
    box.appendChild(list)
    const check = el('button', 'rd-btn rd-check', 'Check answer')
    const expl = el('div', 'rd-explain')
    check.addEventListener('click', () => {
      if (!b.state.selected.length) { Bridge.showToast('Pick an answer first'); return }
      b.state.revealed = true; sync()
      const ok = b.answer.length === b.state.selected.length &&
                 b.answer.every((a) => b.state.selected.indexOf(a) !== -1)
      expl.innerHTML = '<b>' + (ok ? '✓ Correct.' : '✗ Not quite.') + '</b> ' +
                       (b.explain ? miniMarkdown(b.explain).replace(/^<p>|<\/p>$/g, '') : '')
      expl.classList.add('show'); check.disabled = true
    })
    const foot = el('div', 'rd-mcq-foot'); foot.appendChild(check)
    box.appendChild(foot)
    box.appendChild(expl)
    return box
  },

  // Drawing area on a page (e.g. the lungs): the daemon sketch auto-opens when you reach the page, so
  // this is just a brief high-contrast placeholder (no Draw button).
  drawing(b, i) {
    const wrap = el('div', 'rd-draw')
    if (b.label) wrap.appendChild(el('div', 'rd-draw-label', b.label))
    const box = el('div', 'rd-draw-box'); box.style.height = (b.height || 300) + 'px'
    box.appendChild(el('span', 'hint', 'Opening sketch…'))
    wrap.appendChild(box)
    return wrap
  },

  // Open the clean daemon sketch on this page's inline box (auto-triggered for a drawing page).
  openSketch() {
    App.openSketch(this.nb.notebookId, this.page, { modal: false })
  },

  // Animation with play/pause. In reading mode the WebView is visible, so the CSS animation shows
  // directly (no native sampler needed — that's for baked/occluded content).
  anim(b) {
    const wrap = el('div', 'rd-anim')
    const stage = el('div', 'rd-anim-stage'); stage.innerHTML = (b.kind === 'breath') ? LUNGS_SVG : ''
    wrap.appendChild(stage)
    if (b.caption) wrap.appendChild(el('div', 'rd-caption', b.caption))
    const play = el('button', 'rd-btn', '▶ Play'); let on = false
    play.addEventListener('click', () => {
      on = !on; stage.classList.toggle('playing', on); play.textContent = on ? '❚❚ Pause' : '▶ Play'
    })
    const ctrl = el('div', 'rd-anim-ctrl'); ctrl.appendChild(play)
    wrap.appendChild(ctrl)
    return wrap
  },

  // ---- Stage 2: EPUB-style text highlighting with the INVERTED stylus ----
  // The flipped USI pen reports pointerType 'pen' with the eraser button bit (same detection the
  // editor's web-layer eraser uses). We do our OWN selection (no window.getSelection → no native
  // copy/select/share menu) and render it as a yellow highlight + a black outline box. Highlights are
  // stored as character offsets in the text block (block.hl) and ride in meta.json (persist on reopen).
  // Pen OR finger over text: DRAG = highlight (word-snapped); a stationary HOLD over an existing
  // highlight = its menu (delete / edit note). A plain tap does nothing (so "pressing around" never
  // creates or destroys anything). Highlighting is web-layer, no daemon.
  wireSelection(pageEl) {
    const self = this
    let startCaret = null, moved = false, sx = 0, sy = 0, lpTimer = null
    const update = function(x, y) {
      const end = caretRange(x, y)
      if (!startCaret || !end) return
      const ord = orderedRange(startCaret, end) || collapsedRange(startCaret)
      const r = snapRangeToWords(ord)
      if (r) { self._selRange = r; self.drawSelOverlay(r) }
    }
    pageEl.addEventListener('pointerdown', function(e) {
      if (!isHighlightPointer(e)) return
      if (!e.target || !e.target.closest || !e.target.closest('.rd-text')) return
      self.hidePopup(); self.clearSelOverlay()
      startCaret = caretRange(e.clientX, e.clientY)
      moved = false; sx = e.clientX; sy = e.clientY; self._selRange = null
      update(e.clientX, e.clientY)
      clearTimeout(lpTimer)
      lpTimer = setTimeout(function() {                 // stationary hold → highlight menu (if on one)
        const loc = self.findHighlightAt(sx, sy)
        if (loc) { startCaret = null; self.clearSelOverlay(); self.showHlMenu(loc, sx, sy) }
      }, 500)
      e.preventDefault()
    })
    pageEl.addEventListener('pointermove', function(e) {
      if (!startCaret) return
      if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) { moved = true; clearTimeout(lpTimer) }
      update(e.clientX, e.clientY)
      e.preventDefault()
    })
    const finish = function() {
      clearTimeout(lpTimer)
      if (!startCaret) return
      startCaret = null
      // Only a real DRAG creates a highlight — a tap clears (no accidental highlight).
      if (moved && self._selRange && self._selRange.toString().trim()) self.showPopup(self._selRange)
      else self.clearSelOverlay()
    }
    pageEl.addEventListener('pointerup', finish)
    pageEl.addEventListener('pointercancel', finish)
    pageEl.addEventListener('pointerleave', finish)
  },

  drawSelOverlay(range) { this.clearSelOverlay(); drawRangeInto(this.selLayer, range, 'rd-sel') },
  clearSelOverlay() { if (this.selLayer) this.selLayer.innerHTML = '' },

  findHighlightAt(x, y) {
    const r = caretRange(x, y)
    if (!r) return null
    let node = r.startContainer
    let blockEl = node.nodeType === 1 ? node : node.parentElement
    while (blockEl && !blockEl.dataset.bi) blockEl = blockEl.parentElement
    if (!blockEl) return null
    const bi = parseInt(blockEl.dataset.bi, 10)
    const off = offsetWithin(blockEl, r.startContainer, r.startOffset)
    const block = this.nb.pages[this.page].blocks[bi]
    if (!block || !Array.isArray(block.hl)) return null
    for (let hi = 0; hi < block.hl.length; hi++) {
      if (off >= block.hl[hi].s && off <= block.hl[hi].e) return { bi: bi, hi: hi }
    }
    return null
  },

  showHlMenu(loc, x, y) {
    this.hidePopup()
    const self = this
    const hl = this.nb.pages[this.page].blocks[loc.bi].hl[loc.hi]
    const pop = el('div', 'rd-pop')
    if (hl.note) {
      const ed = el('button', 'rd-pop-btn', '✎ Edit note')
      ed.addEventListener('click', function() { self.hidePopup(); self.openStickyNote(loc.bi, loc.hi) })
      pop.appendChild(ed)
    } else {
      const add = el('button', 'rd-pop-btn', '🗒 Add sticky note')
      add.addEventListener('click', function() {
        hl.note = { strokes: [] }; self.save(); self.hidePopup(); self.renderHighlights()
        self.openStickyNote(loc.bi, loc.hi)
      })
      pop.appendChild(add)
    }
    const del = el('button', 'rd-pop-btn', '🗑 Delete')
    del.addEventListener('click', function() { self.deleteHighlight(loc); self.hidePopup() })
    const cx = el('button', 'rd-pop-btn', '✕')
    cx.addEventListener('click', function() { self.hidePopup() })
    pop.appendChild(del); pop.appendChild(cx)
    document.getElementById('reader-view').appendChild(pop)
    pop.style.top = Math.max(8, y - 52) + 'px'
    pop.style.left = Math.min(Math.max(8, x - 40), window.innerWidth - 320) + 'px'
    this._pop = pop
  },

  deleteHighlight(loc) {
    const block = this.nb.pages[this.page].blocks[loc.bi]
    if (block && Array.isArray(block.hl)) { block.hl.splice(loc.hi, 1); this.save(); this.renderHighlights() }
  },

  // Re-draw all persisted highlights (yellow + black outline) for the current page, plus a tappable
  // note icon for any highlight that has a sticky note attached.
  renderHighlights() {
    if (!this.hlLayer) return
    this.hlLayer.innerHTML = ''
    const self = this
    const blocks = (this.nb.pages[this.page] || {}).blocks || []
    blocks.forEach(function(b, bi) {
      if (b.type !== 'text' || !Array.isArray(b.hl)) return
      const blockEl = self.pageEl.querySelector('[data-bi="' + bi + '"]')
      if (!blockEl) return
      b.hl.forEach(function(h, hi) {
        const range = rangeForOffsets(blockEl, h.s, h.e)
        if (!range) return
        const bb = drawRangeInto(self.hlLayer, range, 'rd-hl')
        if (h.note && bb) {
          // SVG pencil (predictable bounds, unlike a font glyph) anchored to the highlight's
          // bottom-right corner: a 10px box whose bottom-right sits at (bb.r, bb.b).
          const icon = el('span', 'rd-note-icon')
          icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#000"/></svg>'
          icon.style.left = (bb.r - 10) + 'px'; icon.style.top = (bb.b - 10) + 'px'
          icon.addEventListener('click', function() { self.openStickyNote(bi, hi) })
          self.hlLayer.appendChild(icon)
        }
      })
    })
  },

  showPopup(range) {
    this.hidePopup()
    const loc = locateRange(range)
    const rects = range.getClientRects()
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
    const pop = el('div', 'rd-pop')
    const hi = el('button', 'rd-pop-btn', '✎ Highlight')
    const st = el('button', 'rd-pop-btn', '🗒 Sticky note')
    const cx = el('button', 'rd-pop-btn', '✕')
    const self = this
    hi.addEventListener('click', function() { self.addHighlight(loc, false) })
    st.addEventListener('click', function() { self.addHighlight(loc, true) })
    cx.addEventListener('click', function() { self.hidePopup() })
    pop.appendChild(hi); pop.appendChild(st); pop.appendChild(cx)
    document.getElementById('reader-view').appendChild(pop)
    pop.style.top = Math.max(8, rect.top - 50) + 'px'
    pop.style.left = Math.min(Math.max(8, rect.left), window.innerWidth - 300) + 'px'
    this._pop = pop
  },

  hidePopup() { if (this._pop) { this._pop.remove(); this._pop = null } this.clearSelOverlay() },

  addHighlight(loc, withNote) {
    if (!loc) { this.hidePopup(); return }
    const block = this.nb.pages[this.page].blocks[loc.bi]
    if (!block.hl) block.hl = []
    // Max one highlight per word: reject a new highlight that overlaps any existing one.
    for (let i = 0; i < block.hl.length; i++) {
      if (loc.start < block.hl[i].e && block.hl[i].s < loc.end) {
        this.hidePopup(); this.clearSelOverlay(); Bridge.showToast('Already highlighted'); return
      }
    }
    const h = { s: loc.start, e: loc.end }
    if (withNote) h.note = { strokes: [] }
    block.hl.push(h)
    this.save()
    this.hidePopup()
    this.renderHighlights()
    if (withNote) this.openStickyNote(loc.bi, block.hl.length - 1)
  },

  save() {
    try { Storage.saveNotebookDirty(this.nb) } catch (e) { console.warn('Reader.save', e) }
  },

  // Open a sticky note WITHOUT switching to the editor: the reader stays visible, and the daemon ink
  // surface is resized to JUST the note box (Bridge.attachInkBox). So only that small region composites
  // / refreshes — no full-screen flash — while the page + highlight stay visible around it. Low-latency
  // daemon ink; strokes stored per-note (normalized) in block.hl[hi].note.strokes.
  openStickyNote(bi, hi) {
    this.closeNote()
    const self = this
    const hl = this.nb.pages[this.page].blocks[bi].hl[hi]
    if (!hl.note) hl.note = {}
    if (!Array.isArray(hl.note.strokes) || (hl.note.strokes.length && hl.note.strokes[0].points)) hl.note.strokes = []
    this._note = { bi: bi, hi: hi, full: false }

    const wrap = el('div', 'rd-note-wrap')
    const card = el('div', 'rd-note-card')
    const box = el('div', 'rd-note-box')   // reserves the drawing area; the ink surface covers it
    card.appendChild(box)
    const ctl = el('div', 'rd-note-ctl')
    const done = el('button', 'rd-btn', '✓ Done')
    const full = el('button', 'rd-btn', '⛶ Full page')
    ctl.appendChild(done); ctl.appendChild(full)
    card.appendChild(ctl)
    wrap.appendChild(card)
    document.getElementById('reader-view').appendChild(wrap)
    this._noteWrap = wrap; this._noteBox = box

    done.addEventListener('click', function() { self.closeNote() })
    full.addEventListener('click', function() {
      self._note.full = !self._note.full
      card.classList.toggle('full', self._note.full)
      full.textContent = self._note.full ? '⊟ Window' : '⛶ Full page'
      self.reattachNoteBox()
    })
    requestAnimationFrame(function() { self.attachNoteBox() })
  },

  attachNoteBox() {
    const box = this._noteBox; if (!box) return
    const r = box.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const pad = 3   // CSS px inset so the box's own border stays visible around the ink surface
    const L = Math.round((r.left + pad) * dpr), T = Math.round((r.top + pad) * dpr)
    const R = Math.round((r.right - pad) * dpr), B = Math.round((r.bottom - pad) * dpr)
    window._noteSketch = { w: R - L, h: B - T }
    Bridge.attachInkBox(L, T, R, B)
    Bridge.setInkStyle(3 * dpr, '#000000')
  },

  // Full-page / window toggle: detach + re-attach at the new box size. The async flush re-attaches
  // (it must NOT finalize — that's only for closing) so the strokes survive the toggle.
  reattachNoteBox() {
    this._reattaching = true
    Bridge.detachInkBox()   // flushes current strokes (→ onNoteStrokes), then onNoteFlushed re-attaches
  },

  // Close: hide the overlay + detach. The daemon flush is ASYNC, so we keep the note context alive
  // until window.onNoteFlushed fires (after the strokes have landed), then finalize/save.
  closeNote() {
    if (!this._noteWrap) return
    this._noteWrap.remove(); this._noteWrap = null; this._noteBox = null
    Bridge.detachInkBox()
  },

  finalizeNote() {
    this._note = null
    window._noteSketch = null
    this.save(); this.renderHighlights()
  },

  // Daemon strokes (box-local surface px) → point arrays stored per-note, normalized by WIDTH for both
  // axes so the drawing scales 1:1 (uniform) and never stretches to the box's aspect. The surface
  // already shows them live; we just persist them.
  onNoteStrokes(strokes) {
    if (!this._note || !window._noteSketch) return
    const hl = this.nb.pages[this.page].blocks[this._note.bi].hl[this._note.hi]
    if (!Array.isArray(hl.note.strokes)) hl.note.strokes = []
    const w = window._noteSketch.w || 1
    for (let s = 0; s < strokes.length; s++) {
      const pts = strokes[s]; if (!pts || !pts.length) continue
      const arr = []
      for (let i = 0; i < pts.length; i++) arr.push({ x: pts[i][0] / w, y: pts[i][1] / w })
      hl.note.strokes.push(arr)
    }
    this.save()
  },

  // Render the note's stored strokes onto the (fresh) box surface — uniform scaling (×width).
  renderNoteStrokes() {
    const ns = window._noteSketch; if (!ns || !this._note) return
    const hl = this.nb.pages[this.page].blocks[this._note.bi].hl[this._note.hi]
    const strokes = Array.isArray(hl.note.strokes) ? hl.note.strokes : []
    const dpr = window.devicePixelRatio || 1
    const out = { t: 'blank', sp: 0, mg: 0, dpr: dpr, b: [0, 0, ns.w, ns.h], s: [] }
    for (let s = 0; s < strokes.length; s++) {
      const st = strokes[s]; if (!st || !st.length || st.points) continue
      const p = []
      for (let i = 0; i < st.length; i++) p.push([Math.round(st[i].x * ns.w), Math.round(st[i].y * ns.w)])
      out.s.push({ w: 3 * dpr, c: '#000000', p: p })
    }
    Bridge.renderInk(JSON.stringify(out))
  }
}

// Daemon flush finished after a detach. A full-page/window toggle re-attaches at the new size; a real
// close finalizes/saves.
window.onNoteFlushed = function() {
  if (!window.Reader) return
  if (Reader._reattaching) {
    Reader._reattaching = false
    requestAnimationFrame(function() { requestAnimationFrame(function() { Reader.attachNoteBox() }) })
    return
  }
  Reader.finalizeNote()
}

// ---- selection / highlight helpers ----

// Highlighter trigger: pen (tip or inverted) OR finger. Web-layer (no daemon) — highlighting doesn't
// need real-time latency, unlike the sticky-note sketch.
function isHighlightPointer(e) {
  return e.pointerType === 'pen' || e.pointerType === 'touch'
}

function caretRange(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y)
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y)
    if (p) { const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r }
  }
  return null
}

// A range from caret a to caret b in document order (swapped if b precedes a).
function orderedRange(a, b) {
  try {
    const r = document.createRange()
    r.setStart(a.startContainer, a.startOffset)
    r.setEnd(b.startContainer, b.startOffset)
    if (r.collapsed) { r.setStart(b.startContainer, b.startOffset); r.setEnd(a.startContainer, a.startOffset) }
    return r.collapsed ? null : r
  } catch (e) { return null }
}

function collapsedRange(caret) {
  const r = document.createRange()
  r.setStart(caret.startContainer, caret.startOffset)
  r.setEnd(caret.startContainer, caret.startOffset)
  return r
}

// Expand a range to whole words: start snaps back to the first letter of its word, end snaps forward
// to the end of its word — so a highlight begins/ends on word boundaries, not mid-word.
function snapRangeToWords(range) {
  if (!range) return null
  const s = wordBoundary(range.startContainer, range.startOffset, -1)
  const e = wordBoundary(range.endContainer, range.endOffset, +1)
  try { const r = document.createRange(); r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset); return r } catch (x) { return range }
}

function wordBoundary(node, offset, dir) {
  if (!node || node.nodeType !== 3) return { node: node, offset: offset }
  const t = node.nodeValue || ''
  const isWord = function(c) { return c != null && /\S/.test(c) }   // word = run of non-whitespace
  let i = offset
  if (dir < 0) { while (i > 0 && isWord(t[i - 1])) i-- }
  else { while (i < t.length && isWord(t[i])) i++ }
  return { node: node, offset: i }
}

// Map a Range to a single text block + character offsets within it (clamped to the start block).
function locateRange(range) {
  let node = range.startContainer
  let blockEl = node.nodeType === 1 ? node : node.parentElement
  while (blockEl && !blockEl.dataset.bi) blockEl = blockEl.parentElement
  if (!blockEl) return null
  const start = offsetWithin(blockEl, range.startContainer, range.startOffset)
  const end = blockEl.contains(range.endContainer)
    ? offsetWithin(blockEl, range.endContainer, range.endOffset) : blockEl.textContent.length
  return { bi: parseInt(blockEl.dataset.bi, 10), start: Math.min(start, end), end: Math.max(start, end) }
}

// Character offset of (node,offset) within [root]'s text content.
function offsetWithin(root, node, offset) {
  const r = document.createRange()
  r.selectNodeContents(root)
  try { r.setEnd(node, offset) } catch (e) { return root.textContent.length }
  return r.toString().length
}

// Build a Range over [root]'s text for the [start,end) character span (no DOM mutation).
function rangeForOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  let pos = 0, node, sNode = null, sOff = 0, eNode = null, eOff = 0
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length, ns = pos, ne = pos + len
    if (sNode === null && start <= ne) { sNode = node; sOff = Math.max(0, start - ns) }
    if (end <= ne) { eNode = node; eOff = Math.max(0, end - ns); break }
    pos = ne
  }
  if (!sNode) return null
  if (!eNode) { eNode = sNode; eOff = sNode.nodeValue.length }
  try { const r = document.createRange(); r.setStart(sNode, sOff); r.setEnd(eNode, eOff); return r } catch (e) { return null }
}

// Draw a range as per-line highlight rects + one black bounding-outline box into [layer] (fixed,
// viewport coords). Returns the union box {l,t,r,b} or null.
function drawRangeInto(layer, range, cls) {
  const rects = range.getClientRects()
  let minL = 1e9, minT = 1e9, maxR = -1e9, maxB = -1e9, any = false
  for (let i = 0; i < rects.length; i++) {
    const rc = rects[i]
    if (rc.width < 1 || rc.height < 1) continue
    any = true
    const d = document.createElement('div')
    d.className = cls + '-rect'
    d.style.left = rc.left + 'px'; d.style.top = rc.top + 'px'
    d.style.width = rc.width + 'px'; d.style.height = rc.height + 'px'
    layer.appendChild(d)
    minL = Math.min(minL, rc.left); minT = Math.min(minT, rc.top)
    maxR = Math.max(maxR, rc.right); maxB = Math.max(maxB, rc.bottom)
  }
  if (!any) return null
  const box = document.createElement('div')
  box.className = cls + '-box'
  box.style.left = minL + 'px'; box.style.top = minT + 'px'
  box.style.width = (maxR - minL) + 'px'; box.style.height = (maxB - minT) + 'px'
  layer.appendChild(box)
  return { l: minL, t: minT, r: maxR, b: maxB }
}

// A small drawing canvas bound to a normalized stroke array (points in 0..1 of the box, so the
// drawing scales when the note toggles full screen). High-contrast black ink; draws each segment
// incrementally (light for e-ink), full redraw only on resize.
function makeSketchPad(container, strokes, onChange) {
  const canvas = document.createElement('canvas'); canvas.className = 'rd-sketch-canvas'
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  let cur = null
  const dpr = function() { return window.devicePixelRatio || 1 }
  function seg(a, b) {
    ctx.strokeStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.5 * dpr()
    ctx.beginPath(); ctx.moveTo(a.x * canvas.width, a.y * canvas.height); ctx.lineTo(b.x * canvas.width, b.y * canvas.height); ctx.stroke()
  }
  function dot(p) { ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(p.x * canvas.width, p.y * canvas.height, 1.4 * dpr(), 0, 7); ctx.fill() }
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height)
    strokes.forEach(function(s) { if (s.length === 1) dot(s[0]); else for (let i = 1; i < s.length; i++) seg(s[i - 1], s[i]) })
  }
  function resize() {
    const r = container.getBoundingClientRect()
    if (r.width < 2) { requestAnimationFrame(resize); return }
    canvas.width = Math.round(r.width * dpr()); canvas.height = Math.round(r.height * dpr())
    canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px'
    redraw()
  }
  function pos(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } }
  canvas.addEventListener('pointerdown', function(e) { cur = [pos(e)]; strokes.push(cur); canvas.setPointerCapture(e.pointerId); dot(cur[0]); e.preventDefault() })
  canvas.addEventListener('pointermove', function(e) { if (!cur) return; const p = pos(e); seg(cur[cur.length - 1], p); cur.push(p); e.preventDefault() })
  const end = function() { if (cur) { cur = null; onChange && onChange() } }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)
  canvas.addEventListener('pointerleave', end)
  resize()
  return { resize: resize, redraw: redraw }
}

window.Reader = Reader
