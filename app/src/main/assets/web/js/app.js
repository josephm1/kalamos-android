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
    document.getElementById('library-view').style.display = 'none'
    document.getElementById('editor-view').style.display = 'flex'
    this.current = 'editor'
    Bridge.enterEditor()                                // native: show ink surface, transparent WebView
    if (!this.editorInited) { initEditor(); this.editorInited = true }
    loadNotebookById(notebookId)                        // load + render + attach ink
  },

  showLibrary() {
    if (window.stopAnim) window.stopAnim()              // stop any running animation + clean its region first
    detachInk()                                         // save thumbnail + flush/save + release daemon (inkSdkActive=false)
    Bridge.enterLibrary()                               // native: hide ink surface, opaque WebView
    renderLibrary()                                     // refresh list (titles/updatedAt may have changed)
    document.getElementById('editor-view').style.display = 'none'
    document.getElementById('library-view').style.display = 'flex'
    this.current = 'library'
  },

  // Android hardware/gesture back, routed from native.
  onAndroidBack() {
    if (this.current === 'editor') this.showLibrary()
    else Bridge.exitApp()
  },

  // Hardware page-turn buttons (dir = 'up' | 'down'), routed from native.
  onPageKey(dir) {
    if (this.current === 'editor') { if (typeof editorPageTurn === 'function') editorPageTurn(dir) }
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
