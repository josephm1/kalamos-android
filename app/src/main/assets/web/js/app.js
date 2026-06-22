// Single-page router. Library and editor are two views inside ONE WebView; switching just toggles
// which is visible (no page reload, no WebView swap, no fragment teardown). The editor view sits
// over a native base-layer ink surface (the visible writing layer); the library view is a plain
// opaque WebView. Bridge.enterEditor/enterLibrary tell native which mode to present.
const App = {
  current: null,        // 'library' | 'editor'
  editorInited: false,  // initEditor() measures layout, so run it lazily on first editor show

  start() {
    initLibrary()                                       // render the grid from the index
    document.getElementById('editor-view').style.display = 'none'
    document.getElementById('library-view').style.display = 'flex'
    this.current = 'library'
    Bridge.enterLibrary()                               // native: hide ink surface, opaque WebView
  },

  showEditor(notebookId) {
    // Interactive-format notebooks (pages carry blocks) open in interactive reading mode, not the
    // ink editor. Detect via the (preloaded) meta without disturbing the plain-notebook path.
    if (window.Reader) {
      const meta = Storage.takeCachedMeta(notebookId) || Storage.loadMeta(notebookId)
      if (Reader.isInteractive(meta)) { Reader.open(meta); return }
    }
    document.getElementById('library-view').style.display = 'none'
    document.getElementById('editor-view').style.display = 'flex'
    this.current = 'editor'
    Bridge.enterEditor()                                // native: show ink surface, transparent WebView
    if (!this.editorInited) { initEditor(); this.editorInited = true }
    loadNotebookById(notebookId)                        // load + render + attach ink
  },

  // Open a clean, focused daemon-ink sketch on an interactive notebook page — NO old editor chrome
  // (the floating menu is hidden). The pen is confined to the drawing box. [opts.modal] = a centred
  // Post-it box (for a sticky note) vs the page's inline box (the lungs). Back returns to the reader.
  openSketch(notebookId, pageIndex, opts) {
    opts = opts || {}
    this._sketchReturn = { nbId: notebookId, page: pageIndex }
    window._sketchActive = true
    window._sketchModal = !!opts.modal
    window._sketchNote = opts.note || null    // {bi,hi} → daemon strokes go to that note's buffer
    window._sketchFull = false
    window._openAtPage = pageIndex
    window._needFullToolbar = false              // sketch mode bakes no toolbar/menu
    document.getElementById('reader-view').style.display = 'none'
    document.getElementById('library-view').style.display = 'none'
    const ev = document.getElementById('editor-view')
    ev.style.display = 'flex'
    ev.classList.add('sketch')                   // CSS hides the floating menu in this mode
    this.current = 'editor'
    Bridge.enterEditor()
    if (opts.note) Bridge.skipWakeRefresh()   // sticky-note open → no full-screen wake; partial refresh
    if (!this.editorInited) { initEditor(); this.editorInited = true }
    loadNotebookById(notebookId)
  },

  _endSketch() {
    window._sketchActive = false; window._sketchModal = false; window._sketchFull = false
    window._sketchNote = null; window._sketchNoteStrokes = null
    const ev = document.getElementById('editor-view'); if (ev) ev.classList.remove('sketch')
    Bridge.setWritingBounds(0, 0, 0, 0)
    Bridge.setWritingExclusion(0, 0, 0, 0)   // drop the shrink-button exclusion
  },

  showLibrary() {
    if (window.stopAnim) window.stopAnim()              // stop any running animation + clean its region first
    detachInk()                                         // save thumbnail + flush/save + release daemon (inkSdkActive=false)
    Bridge.enterLibrary()                               // native: hide ink surface, opaque WebView
    document.getElementById('editor-view').style.display = 'none'
    // A sketch session returns to the interactive reader (not the library), at the same page.
    if (this._sketchReturn) {
      const ret = this._sketchReturn; this._sketchReturn = null
      this._endSketch()
      const meta = Storage.loadMeta(ret.nbId)
      if (meta) {
        Reader.open(meta); Reader.page = ret.page
        Reader._suppressAutoSketch = true   // just came back from the sketch — don't re-enter it
        Reader.render(); return
      }
    }
    renderLibrary()                                     // refresh list (titles/updatedAt may have changed)
    document.getElementById('library-view').style.display = 'flex'
    this.current = 'library'
  },

  // Android hardware/gesture back, routed from native.
  onAndroidBack() {
    if (this.current === 'reader') {
      if (window.Reader && Reader._noteWrap) { Reader.closeNote(); return }   // close an open note first
      Reader.close()
    } else if (this.current === 'editor') this.showLibrary()
    else Bridge.exitApp()
  },

  // Hardware page-turn buttons (dir = 'up' | 'down'), routed from native.
  onPageKey(dir) {
    if (this.current === 'reader') { if (dir === 'down') Reader.next(); else Reader.prev() }
    else if (this.current === 'editor') { if (typeof editorPageTurn === 'function') editorPageTurn(dir) }
    else { if (typeof libraryPageTurn === 'function') libraryPageTurn(dir) }
  },

  // App backgrounded/foregrounded — only the editor needs to save + detach / re-attach the daemon.
  onPauseApp() {
    if (this.current === 'editor') { if (window.stopAnim) window.stopAnim(); window.saveNotebook(); detachInk() }
  },
  onResumeApp() {
    if (this.current === 'editor') attachInkWhenReady()
  }
}

window.App = App
document.addEventListener('DOMContentLoaded', function() { App.start() })
