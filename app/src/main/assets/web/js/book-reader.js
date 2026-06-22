// Book reader for the interactive book-folder format (docs/research/book-to-interactive-format.md):
// an immutable book (manifest.json + sections/<sid>.html + styles/ + assets/) under the notebook dir,
// plus a mutable sidecar/ subfolder (highlights/, notes/). Sections are reflowable HTML, paginated at
// runtime with CSS multicolumn; <kal-mcq>/<kal-ink>/<kal-anim> upgrade to widgets; highlights + notes
// anchor to character ranges and live in the sidecar. Reuses the global helpers + daemon ink box from
// reader-controller.js. Prototype.
const BookReader = {
  nbId: null, manifest: null, sec: 0, page: 0, pages: 1,
  hl: {},        // sectionId → [{start,end,color}]
  noteIdx: {},   // sectionId → [{noteId,anchor,hasPreview}]

  isBook(meta) { return !!(meta && meta.bookRef) },

  open(meta) {
    this.nbId = meta.notebookId
    const raw = Bridge.getBookFile(this.nbId, 'manifest.json')
    try { this.manifest = JSON.parse(raw) } catch (e) { this.manifest = null }
    if (!this.manifest) { Bridge.showToast('Could not open book'); return }
    this.sec = 0; this.page = 0
    const pos = meta.position
    if (pos && pos.sectionId) {
      const i = this.manifest.spine.findIndex(function(s) { return s.sectionId === pos.sectionId })
      if (i >= 0) { this.sec = i; this.page = pos.page || 0 }
    }
    document.getElementById('library-view').style.display = 'none'
    document.getElementById('editor-view').style.display = 'none'
    this.view().style.display = 'flex'
    Bridge.enterLibrary()   // hide the ink surface — the WebView is the live reading layer
    App.current = 'book'
    this.renderSection()
  },

  view() {
    let v = document.getElementById('book-view')
    if (!v) { v = el('div', null); v.id = 'book-view'; document.body.appendChild(v) }
    return v
  },

  close() {
    if (this._ink) this.closeInkBox()
    this.view().style.display = 'none'
    document.getElementById('library-view').style.display = 'flex'
    App.current = 'library'
    if (typeof renderLibrary === 'function') renderLibrary()
  },

  sectionId() { return this.manifest.spine[this.sec].sectionId },

  renderSection() {
    const self = this
    const sid = this.sectionId()
    const v = this.view(); v.innerHTML = ''

    // inject the book's stylesheet, scoped to the section flow so it can't leak into the app
    if (this._css == null) this._css = scopeBookCss(Bridge.getBookFile(this.nbId, 'styles/book.css') || '', '#bk-flow')
    const style = document.createElement('style'); style.textContent = this._css; v.appendChild(style)

    // top bar
    const bar = el('div', 'bk-bar')
    const back = el('button', 'rd-btn', '← Library'); back.addEventListener('click', function() { self.close() })
    bar.appendChild(back)
    bar.appendChild(el('div', 'bk-title', this.manifest.title || 'Book'))
    this._ind = el('div', 'bk-ind', ''); bar.appendChild(this._ind)
    v.appendChild(bar)

    // content (reflowed into columns)
    const content = el('div', 'bk-content'); content.id = 'bk-content'
    const flow = el('div', 'bk-flow'); flow.id = 'bk-flow'
    flow.innerHTML = Bridge.getBookFile(this.nbId, 'sections/' + sid + '.html') || '<p>(missing section)</p>'
    content.appendChild(flow)
    v.appendChild(content)
    this._content = content; this._flow = flow

    // overlays for highlights / selection
    this.hlLayer = el('div', 'rd-overlay'); v.appendChild(this.hlLayer)
    this.selLayer = el('div', 'rd-overlay'); v.appendChild(this.selLayer)

    // nav
    const nav = el('div', 'bk-nav')
    const prev = el('button', 'rd-btn', '◀'); prev.addEventListener('click', function() { self.prevPage() })
    const nx = el('button', 'rd-btn', '▶'); nx.addEventListener('click', function() { self.nextPage() })
    nav.appendChild(prev); nav.appendChild(this._navlbl = el('div', 'bk-navlbl', '')); nav.appendChild(nx)
    v.appendChild(nav)

    this.resolveImages(flow)
    this.upgrade(flow)
    this.loadSidecar(sid)

    // paginate after layout (images may shift it; re-measure once they load)
    requestAnimationFrame(function() { self.paginate(); self.applyHighlights() })
    setTimeout(function() { self.paginate(); self.applyHighlights() }, 350)
    this.wireSelection(flow)
    this.savePosition()
  },

  // --- pagination via CSS multicolumn: each column = one page-width; page = translateX by page*stride.
  // The flow's OWN width is the column width (not the padded content box), and the column height is
  // published as --bk-colh so figures/images can be capped to fit a column (else a tall image spills
  // down the page instead of paginating). ---
  paginate() {
    const c = this._content, f = this._flow; if (!c || !f) return
    const h = c.clientHeight
    f.style.height = h + 'px'
    f.style.setProperty('--bk-colh', h + 'px')
    const w = f.clientWidth                       // the actual flow/page width
    if (w < 2) return
    f.style.columnWidth = w + 'px'
    const gap = 40
    const stride = w + gap
    this.pages = Math.max(1, Math.round((f.scrollWidth + gap) / stride))
    if (this.page >= this.pages) this.page = this.pages - 1
    if (this.page < 0) this.page = 0
    f.style.transform = 'translateX(' + (-this.page * stride) + 'px)'
    this._ind.textContent = (this.sec + 1) + '/' + this.manifest.spine.length
    this._navlbl.textContent = (this.page + 1) + ' / ' + this.pages
    this.applyHighlights()
    this.updateInlineInk()   // attach/detach the daemon to an inline <kal-ink> on this page
  },

  nextPage() {
    if (this.page < this.pages - 1) { this.page++; this.paginate(); this.savePosition() }
    else if (this.sec < this.manifest.spine.length - 1) { this.sec++; this.page = 0; this.renderSection() }
  },
  prevPage() {
    if (this.page > 0) { this.page--; this.paginate(); this.savePosition() }
    else if (this.sec > 0) { this.sec--; this.page = 1e9; this.renderSection() }
  },

  resolveImages(root) {
    const self = this
    const imgs = root.querySelectorAll('img[src^="assets/"]')
    Array.prototype.forEach.call(imgs, function(img) {
      const url = Bridge.getNotebookAsset(self.nbId, img.getAttribute('src'))
      if (url) img.src = url; else img.alt = '(image)'
      img.style.cursor = 'pointer'
      img.addEventListener('load', function() { self.paginate() })
      img.addEventListener('click', function(e) { e.stopPropagation(); self.openImageViewer(img.src) })
    })
  },

  // Tap an image → full-screen viewer, as large as fits, with a rotate button (e.g. view a landscape
  // image rotated to fill the portrait screen). Tap/pen/eraser all fire 'click'.
  openImageViewer(src) {
    const ov = el('div', 'iv-overlay')
    const img = document.createElement('img'); img.className = 'iv-img'; img.src = src
    img.addEventListener('click', function(e) { e.stopPropagation() })
    ov.appendChild(img)
    let rot = 0
    const bar = el('div', 'iv-bar')
    const rotate = el('button', 'rd-btn', '⟳ Rotate')
    rotate.addEventListener('click', function(e) { e.stopPropagation(); rot = (rot + 90) % 360; img.className = 'iv-img r' + rot })
    const close = el('button', 'rd-btn', '✕ Close')
    close.addEventListener('click', function(e) { e.stopPropagation(); ov.remove() })
    bar.appendChild(rotate); bar.appendChild(close); ov.appendChild(bar)
    ov.addEventListener('click', function() { ov.remove() })   // tap the backdrop to close
    this.view().appendChild(ov)
  },

  // upgrade <kal-mcq>/<kal-anim>/<kal-ink> custom tags to widgets
  upgrade(root) {
    const self = this
    Array.prototype.forEach.call(root.querySelectorAll('kal-mcq'), function(elm) { self.upgradeMcq(elm) })
    Array.prototype.forEach.call(root.querySelectorAll('kal-anim'), function(elm) { self.upgradeAnim(elm) })
    Array.prototype.forEach.call(root.querySelectorAll('kal-ink'), function(elm) { self.upgradeInk(elm) })
  },

  upgradeMcq(elm) {
    const prompt = (elm.querySelector('kal-prompt') || {}).textContent || ''
    const multi = elm.getAttribute('multi') === 'true'
    const answer = (elm.getAttribute('answer') || '').split(/\s+/).filter(Boolean)
    const explain = (elm.querySelector('kal-explain') || {}).textContent || ''
    const choices = Array.prototype.map.call(elm.querySelectorAll('kal-choice'), function(c) {
      return { id: c.getAttribute('id'), text: c.textContent }
    })
    const box = el('div', 'rd-mcq')
    box.appendChild(el('div', 'rd-mcq-q', prompt))
    const list = el('div', 'rd-choices')
    const sel = []
    const sync = function() {
      Array.prototype.forEach.call(list.children, function(ch) { ch._sync && ch._sync() })
    }
    let revealed = false
    choices.forEach(function(c, i) {
      const b = el('button', 'rd-choice', 'ABCDEFGH'[i] + '. ' + c.text)
      b._sync = function() {
        b.classList.toggle('sel', sel.indexOf(c.id) !== -1)
        if (revealed) { const ok = answer.indexOf(c.id) !== -1; b.classList.toggle('correct', ok); b.classList.toggle('wrong', !ok && sel.indexOf(c.id) !== -1) }
      }
      b.addEventListener('click', function() {
        if (revealed) return
        if (multi) { const k = sel.indexOf(c.id); if (k === -1) sel.push(c.id); else sel.splice(k, 1) }
        else { sel.length = 0; sel.push(c.id) }
        sync()
      })
      b._sync(); list.appendChild(b)
    })
    box.appendChild(list)
    const check = el('button', 'rd-btn rd-check', 'Check')
    const exp = el('div', 'rd-explain')
    check.addEventListener('click', function() {
      if (!sel.length) { Bridge.showToast('Pick an answer'); return }
      revealed = true; sync()
      const ok = answer.length === sel.length && answer.every(function(a) { return sel.indexOf(a) !== -1 })
      exp.innerHTML = '<b>' + (ok ? '✓ Correct.' : '✗ Not quite.') + '</b> ' + explain
      exp.classList.add('show'); check.disabled = true
    })
    const foot = el('div', 'rd-mcq-foot'); foot.appendChild(check); box.appendChild(foot); box.appendChild(exp)
    elm.replaceWith(box)
  },

  upgradeAnim(elm) {
    const wrap = el('div', 'rd-anim')
    const stage = el('div', 'rd-anim-stage'); stage.innerHTML = (elm.getAttribute('kind') === 'breath') ? LUNGS_SVG : ''
    wrap.appendChild(stage)
    const cap = elm.getAttribute('caption'); if (cap) wrap.appendChild(el('div', 'rd-caption', cap))
    const play = el('button', 'rd-btn', '▶ Play'); let on = false
    play.addEventListener('click', function() { on = !on; stage.classList.toggle('playing', on); play.textContent = on ? '❚❚ Pause' : '▶ Play' })
    const ctrl = el('div', 'rd-anim-ctrl'); ctrl.appendChild(play); wrap.appendChild(ctrl)
    elm.replaceWith(wrap)
  },

  // inline pen-input box: an in-flow outlined area. When the reader reaches the column it's on, the
  // daemon attaches to it (draw directly in the outline); pen-away detaches. Strokes → a sidecar file.
  upgradeInk(elm) {
    const id = elm.getAttribute('id'); const h = parseInt(elm.getAttribute('height') || '300', 10)
    const wrap = el('div', 'rd-draw')
    if (elm.getAttribute('label')) wrap.appendChild(el('div', 'rd-draw-label', elm.getAttribute('label')))
    const box = el('div', 'bk-ink'); box.style.height = h + 'px'
    box.dataset.file = 'sidecar/ink/' + this.sectionId() + '-' + id + '.json'
    box.appendChild(el('span', 'bk-ink-hint', '✎ draw here'))
    wrap.appendChild(box)
    elm.replaceWith(wrap)
  },

  // Attach/detach the daemon to an inline <kal-ink> box as it scrolls into / out of the current page.
  updateInlineInk() {
    if (!this._flow || this._inkWrap) return   // (a sticky-note modal owns the surface — skip)
    const cr = this._content.getBoundingClientRect()
    let visible = null
    Array.prototype.forEach.call(this._flow.querySelectorAll('.bk-ink'), function(b) {
      const r = b.getBoundingClientRect()
      if (r.width > 10 && r.left < cr.right - 30 && r.right > cr.left + 30) visible = b
    })
    if (visible) { if (!this._ink || this._ink.el !== visible) this.openInlineInk(visible) }
    else if (this._ink && this._ink.inline) this.closeInkBox()
  },

  openInlineInk(box) {
    const self = this
    let strokes = []
    try { const j = JSON.parse(Bridge.getBookFile(this.nbId, box.dataset.file) || '{}'); if (Array.isArray(j.strokes) && (!j.strokes.length || Array.isArray(j.strokes[0]))) strokes = j.strokes } catch (e) {}
    this._ink = { el: box, file: box.dataset.file, anchor: null, strokes: strokes, inline: true, full: false }
    this._inkBox = box; this._inkWrap = null
    requestAnimationFrame(function() { self.attachNoteBox() })
  },

  savePosition() {
    try {
      const raw = Bridge.getBookFile(this.nbId, 'meta.json'); const m = JSON.parse(raw)
      m.position = { sectionId: this.sectionId(), page: this.page }
      Bridge.saveBookFile(this.nbId, 'meta.json', JSON.stringify(m))
    } catch (e) {}
  },

  // ---- sidecar highlights + note markers (anchored to section char ranges) ----
  loadSidecar(sid) {
    try { this.hl[sid] = JSON.parse(Bridge.getBookFile(this.nbId, 'sidecar/highlights/' + sid + '.json') || '[]') } catch (e) { this.hl[sid] = [] }
    try { this.noteIdx[sid] = JSON.parse(Bridge.getBookFile(this.nbId, 'sidecar/notes/' + sid + '/index.json') || '[]') } catch (e) { this.noteIdx[sid] = [] }
  },
  saveHighlights(sid) { Bridge.saveBookFile(this.nbId, 'sidecar/highlights/' + sid + '.json', JSON.stringify(this.hl[sid] || [])) },
  saveNoteIndex(sid) { Bridge.saveBookFile(this.nbId, 'sidecar/notes/' + sid + '/index.json', JSON.stringify(this.noteIdx[sid] || [])) },

  applyHighlights() {
    if (!this.hlLayer || !this._flow) return
    this.hlLayer.innerHTML = ''
    const self = this, sid = this.sectionId()
    ;(this.hl[sid] || []).forEach(function(h) {
      const range = rangeForOffsets(self._flow, h.start, h.end); if (!range) return
      const bb = drawRangeInto(self.hlLayer, range, 'rd-hl')
      const note = (self.noteIdx[sid] || []).find(function(n) { return n.anchor.start === h.start && n.anchor.end === h.end })
      if (note && bb) {
        const icon = el('span', 'rd-note-icon')
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#000"/></svg>'
        icon.style.left = (bb.r - 10) + 'px'; icon.style.top = (bb.b - 10) + 'px'
        icon.addEventListener('click', function() { self.openNote(note) })
        self.hlLayer.appendChild(icon)
      }
    })
  },

  locate(range) {
    const a = offsetWithin(this._flow, range.startContainer, range.startOffset)
    const b = this._flow.contains(range.endContainer) ? offsetWithin(this._flow, range.endContainer, range.endOffset) : this._flow.textContent.length
    return { start: Math.min(a, b), end: Math.max(a, b) }
  },

  // pen/finger drag = highlight; stationary hold over a highlight = its menu (delete / add note)
  wireSelection(flow) {
    const self = this; let startCaret = null, moved = false, sx = 0, sy = 0, lp = null
    const upd = function(x, y) { const end = caretRange(x, y); if (!startCaret || !end) return; const r = snapRangeToWords(orderedRange(startCaret, end) || collapsedRange(startCaret)); if (r) { self._sel = r; self.clearSelOverlay(); drawRangeInto(self.selLayer, r, 'rd-sel') } }
    flow.addEventListener('pointerdown', function(e) {
      if (!isHighlightPointer(e)) return
      if (e.target && e.target.tagName === 'IMG') return   // image taps open the viewer, not a selection
      self.hidePopup(); self.clearSelOverlay(); startCaret = caretRange(e.clientX, e.clientY); moved = false; sx = e.clientX; sy = e.clientY; self._sel = null
      upd(e.clientX, e.clientY); clearTimeout(lp)
      lp = setTimeout(function() { const h = self.hitHighlight(sx, sy); if (h) { startCaret = null; self.clearSelOverlay(); self.showHlMenu(h, sx, sy) } }, 500)
      e.preventDefault()
    })
    flow.addEventListener('pointermove', function(e) { if (!startCaret) return; if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) { moved = true; clearTimeout(lp) } upd(e.clientX, e.clientY); e.preventDefault() })
    const fin = function() { clearTimeout(lp); if (!startCaret) return; startCaret = null; if (moved && self._sel && self._sel.toString().trim()) self.showPopup(self._sel); else self.clearSelOverlay() }
    flow.addEventListener('pointerup', fin); flow.addEventListener('pointercancel', fin); flow.addEventListener('pointerleave', fin)
  },
  clearSelOverlay() { if (this.selLayer) this.selLayer.innerHTML = '' },

  hitHighlight(x, y) {
    const r = caretRange(x, y); if (!r) return null
    const off = offsetWithin(this._flow, r.startContainer, r.startOffset); const sid = this.sectionId()
    const arr = this.hl[sid] || []
    for (let i = 0; i < arr.length; i++) if (off >= arr[i].start && off <= arr[i].end) return i
    return null
  },

  showPopup(range) {
    this.hidePopup(); const self = this; const loc = this.locate(range)
    const rects = range.getClientRects(); const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
    const pop = el('div', 'rd-pop')
    const hi = el('button', 'rd-pop-btn', '✎ Highlight'); hi.addEventListener('click', function() { self.addHighlight(loc, false) })
    const st = el('button', 'rd-pop-btn', '🗒 Sticky note'); st.addEventListener('click', function() { self.addHighlight(loc, true) })
    const cx = el('button', 'rd-pop-btn', '✕'); cx.addEventListener('click', function() { self.hidePopup() })
    pop.appendChild(hi); pop.appendChild(st); pop.appendChild(cx); this.view().appendChild(pop)
    pop.style.top = Math.max(8, rect.top - 50) + 'px'; pop.style.left = Math.min(Math.max(8, rect.left), window.innerWidth - 300) + 'px'; this._pop = pop
  },
  hidePopup() { if (this._pop) { this._pop.remove(); this._pop = null } this.clearSelOverlay() },

  addHighlight(loc, withNote) {
    const sid = this.sectionId(); if (!this.hl[sid]) this.hl[sid] = []
    for (let i = 0; i < this.hl[sid].length; i++) if (loc.start < this.hl[sid][i].end && this.hl[sid][i].start < loc.end) { this.hidePopup(); Bridge.showToast('Already highlighted'); return }
    this.hl[sid].push({ sectionId: sid, start: loc.start, end: loc.end, color: 'yellow' })
    this.saveHighlights(sid); this.hidePopup(); this.applyHighlights()
    if (withNote) this.addNote(loc)
  },

  showHlMenu(idx, x, y) {
    this.hidePopup(); const self = this; const sid = this.sectionId(); const h = this.hl[sid][idx]
    const note = (this.noteIdx[sid] || []).find(function(n) { return n.anchor.start === h.start && n.anchor.end === h.end })
    const pop = el('div', 'rd-pop')
    if (note) { const ed = el('button', 'rd-pop-btn', '✎ Edit note'); ed.addEventListener('click', function() { self.hidePopup(); self.openNote(note) }); pop.appendChild(ed) }
    else { const ad = el('button', 'rd-pop-btn', '🗒 Add sticky note'); ad.addEventListener('click', function() { self.hidePopup(); self.addNote({ start: h.start, end: h.end }) }); pop.appendChild(ad) }
    const del = el('button', 'rd-pop-btn', '🗑 Delete'); del.addEventListener('click', function() { self.hl[sid].splice(idx, 1); self.saveHighlights(sid); self.hidePopup(); self.applyHighlights() })
    const cx = el('button', 'rd-pop-btn', '✕'); cx.addEventListener('click', function() { self.hidePopup() })
    pop.appendChild(del); pop.appendChild(cx); this.view().appendChild(pop)
    pop.style.top = Math.max(8, y - 52) + 'px'; pop.style.left = Math.min(Math.max(8, x - 40), window.innerWidth - 320) + 'px'; this._pop = pop
  },

  addNote(loc) {
    const sid = this.sectionId(); if (!this.noteIdx[sid]) this.noteIdx[sid] = []
    const noteId = 'n' + Date.now().toString(36)
    const anchor = { sectionId: sid, start: loc.start, end: loc.end }
    this.noteIdx[sid].push({ noteId: noteId, anchor: anchor, hasPreview: false }); this.saveNoteIndex(sid)
    Bridge.saveBookFile(this.nbId, 'sidecar/notes/' + sid + '/' + noteId + '.json', JSON.stringify({ anchor: anchor, strokes: [] }))
    this.applyHighlights()
    this.openInkBox({ file: 'sidecar/notes/' + sid + '/' + noteId + '.json', anchor: anchor })
  },
  openNote(note) {
    this.openInkBox({ file: 'sidecar/notes/' + this.sectionId() + '/' + note.noteId + '.json', anchor: note.anchor })
  },

  // ---- daemon ink box (sticky note / kal-ink), reusing the shared box machinery ----
  openInkBox(target) {
    this.closeInkBox(); const self = this
    let strokes = []
    try { const j = JSON.parse(Bridge.getBookFile(this.nbId, target.file) || '{}'); if (Array.isArray(j.strokes) && (!j.strokes.length || Array.isArray(j.strokes[0]))) strokes = j.strokes } catch (e) {}
    this._ink = { file: target.file, anchor: target.anchor || null, strokes: strokes, full: false }
    const wrap = el('div', 'rd-note-wrap'); const card = el('div', 'rd-note-card'); const box = el('div', 'rd-note-box'); card.appendChild(box)
    const ctl = el('div', 'rd-note-ctl'); const done = el('button', 'rd-btn', '✓ Done'); const full = el('button', 'rd-btn', '⛶ Full page')
    ctl.appendChild(done); ctl.appendChild(full); card.appendChild(ctl); wrap.appendChild(card); this.view().appendChild(wrap)
    this._inkWrap = wrap; this._inkBox = box
    done.addEventListener('click', function() { self.closeInkBox() })
    full.addEventListener('click', function() { self._ink.full = !self._ink.full; card.classList.toggle('full', self._ink.full); full.textContent = self._ink.full ? '⊟ Window' : '⛶ Full page'; self._reattaching = true; Bridge.detachInkBox() })
    requestAnimationFrame(function() { self.attachNoteBox() })
  },
  attachNoteBox() {
    const box = this._inkBox; if (!box) return
    const r = box.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; const pad = 3
    const L = Math.round((r.left + pad) * dpr), T = Math.round((r.top + pad) * dpr), R = Math.round((r.right - pad) * dpr), B = Math.round((r.bottom - pad) * dpr)
    window._noteSketch = { w: R - L, h: B - T }; window._inkHandler = this
    Bridge.attachInkBox(L, T, R, B); Bridge.setInkStyle(3 * dpr, '#000000')
  },
  onNoteStrokes(strokes) {
    if (!this._ink || !window._noteSketch) return
    const w = window._noteSketch.w || 1
    for (let s = 0; s < strokes.length; s++) { const pts = strokes[s]; if (!pts || !pts.length) continue; const arr = []; for (let i = 0; i < pts.length; i++) arr.push([pts[i][0] / w, pts[i][1] / w]); this._ink.strokes.push(arr) }
    this.saveInk()
  },
  renderNoteStrokes() {
    const ns = window._noteSketch; if (!ns || !this._ink) return
    const dpr = window.devicePixelRatio || 1
    const out = { t: 'blank', sp: 0, mg: 0, dpr: dpr, b: [0, 0, ns.w, ns.h], s: [] }
    this._ink.strokes.forEach(function(st) { if (!st || !st.length) return; const p = []; for (let i = 0; i < st.length; i++) p.push([Math.round(st[i][0] * ns.w), Math.round(st[i][1] * ns.w)]); out.s.push({ w: 3 * dpr, c: '#000000', p: p }) })
    Bridge.renderInk(JSON.stringify(out))
  },
  saveInk() { if (this._ink) Bridge.saveBookFile(this.nbId, this._ink.file, JSON.stringify({ anchor: this._ink.anchor, strokes: this._ink.strokes })) },
  closeInkBox() {
    const had = !!this._ink || !!this._inkWrap
    if (this._inkWrap) { this._inkWrap.remove(); this._inkWrap = null }
    this._inkBox = null
    if (had) Bridge.detachInkBox()   // flush → onNoteFlushed → finalizeNote (saves + clears _ink)
  },
  finalizeNote() {
    this.saveInk(); this._ink = null; window._noteSketch = null
    // a note may have just gained its first strokes → refresh markers
    this.applyHighlights()
  }
}

// Prefix every rule selector with [scope] (mapping bare `body` → the scope) so the book's stylesheet
// applies only inside the section flow, never to the surrounding app chrome.
function scopeBookCss(css, scope) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return css.replace(/([^{}]+)\{/g, function(m, sel) {
    return sel.split(',').map(function(s) {
      s = s.trim(); if (!s) return s
      return s === 'body' ? scope : scope + ' ' + s
    }).join(',') + '{'
  })
}

window.BookReader = BookReader
