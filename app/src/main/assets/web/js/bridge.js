const Bridge = {

  saveLibrary(json) {
    try {
      return AndroidBridge.saveLibrary(json)
    } catch (e) {
      console.warn('Bridge.saveLibrary error:', e)
      return 'error: ' + e.message
    }
  },

  loadLibrary() {
    try {
      return AndroidBridge.loadLibrary()
    } catch (e) {
      console.warn('Bridge.loadLibrary error:', e)
      return '{}'
    }
  },

  savePage(notebookId, pageId, json) {
    try {
      return AndroidBridge.savePage(notebookId, pageId, json)
    } catch (e) {
      console.warn('Bridge.savePage error:', e)
      return 'error: ' + e.message
    }
  },

  saveMeta(notebookId, json) {
    try {
      return AndroidBridge.saveMeta(notebookId, json)
    } catch (e) {
      console.warn('Bridge.saveMeta error:', e)
      return 'error: ' + e.message
    }
  },

  loadNotebookRaw(notebookId) {
    try {
      return AndroidBridge.loadNotebookRaw(notebookId)
    } catch (e) {
      console.warn('Bridge.loadNotebookRaw error:', e)
      return 'null'
    }
  },

  loadMeta(notebookId) {
    try { return AndroidBridge.loadMeta(notebookId) } catch (e) { console.warn('Bridge.loadMeta error:', e); return 'null' }
  },

  peekMeta(notebookId) {
    try { return AndroidBridge.peekMeta(notebookId) } catch (e) { console.warn('Bridge.peekMeta error:', e); return 'null' }
  },

  loadPage(notebookId, pageId) {
    try { return AndroidBridge.loadPage(notebookId, pageId) } catch (e) { console.warn('Bridge.loadPage error:', e); return '[]' }
  },

  deleteNotebook(notebookId) {
    try {
      return AndroidBridge.deleteNotebook(notebookId)
    } catch (e) {
      console.warn('Bridge.deleteNotebook error:', e)
      return 'error: ' + e.message
    }
  },

  attachInk(left, top, right, bottom) {
    try {
      return AndroidBridge.attachInk(left, top, right, bottom)
    } catch (e) {
      console.warn('Bridge.attachInk error:', e)
      return false
    }
  },

  detachInk() {
    try {
      AndroidBridge.detachInk()
    } catch (e) {
      console.warn('Bridge.detachInk error:', e)
    }
  },

  attachInkBox(left, top, right, bottom) {
    try { AndroidBridge.attachInkBox(left, top, right, bottom) } catch (e) { console.warn('Bridge.attachInkBox error:', e) }
  },

  detachInkBox() {
    try { AndroidBridge.detachInkBox() } catch (e) { console.warn('Bridge.detachInkBox error:', e) }
  },

  setInkStyle(widthPx, colorHex) {
    try {
      AndroidBridge.setInkStyle(widthPx, colorHex)
    } catch (e) {
      console.warn('Bridge.setInkStyle error:', e)
    }
  },

  setInkEnabled(enabled) {
    try {
      AndroidBridge.setInkEnabled(enabled)
    } catch (e) {
      console.warn('Bridge.setInkEnabled error:', e)
    }
  },


  renderInk(json) {
    try {
      AndroidBridge.renderInk(json)
    } catch (e) {
      console.warn('Bridge.renderInk error:', e)
    }
  },

  flushInk() {
    try {
      AndroidBridge.flushInk()
    } catch (e) {
      console.warn('Bridge.flushInk error:', e)
    }
  },

  snapshotToolbar(heightPx) {
    try {
      AndroidBridge.snapshotToolbar(heightPx)
    } catch (e) {
      console.warn('Bridge.snapshotToolbar error:', e)
    }
  },

  snapshotToolbarRegion(left, top, right, bottom) {
    try {
      AndroidBridge.snapshotToolbarRegion(left, top, right, bottom)
    } catch (e) {
      console.warn('Bridge.snapshotToolbarRegion error:', e)
    }
  },

  snapshotMenu(left, top, right, bottom, rl, rt, rr, rb) {
    try {
      AndroidBridge.snapshotMenu(left, top, right, bottom, rl, rt, rr, rb)
    } catch (e) {
      console.warn('Bridge.snapshotMenu error:', e)
    }
  },

  snapshotContent(left, top, right, bottom) {
    try { AndroidBridge.snapshotContent(left, top, right, bottom) } catch (e) { console.warn('Bridge.snapshotContent error:', e) }
  },

  snapshotContentPartial(left, top, right, bottom, rl, rt, rr, rb) {
    try { AndroidBridge.snapshotContentPartial(left, top, right, bottom, rl, rt, rr, rb) } catch (e) { console.warn('Bridge.snapshotContentPartial error:', e) }
  },

  skipWakeRefresh() {
    try { AndroidBridge.skipWakeRefresh() } catch (e) { console.warn('Bridge.skipWakeRefresh error:', e) }
  },

  clearContent() {
    try { AndroidBridge.clearContent() } catch (e) { console.warn('Bridge.clearContent error:', e) }
  },

  getNotebookAsset(notebookId, relPath) {
    try { return AndroidBridge.getNotebookAsset(notebookId, relPath) } catch (e) { console.warn('Bridge.getNotebookAsset error:', e); return '' }
  },

  getBookFile(notebookId, relPath) {
    try { return AndroidBridge.getBookFile(notebookId, relPath) } catch (e) { console.warn('Bridge.getBookFile error:', e); return '' }
  },

  saveBookFile(notebookId, relPath, content) {
    try { return AndroidBridge.saveBookFile(notebookId, relPath, content) } catch (e) { console.warn('Bridge.saveBookFile error:', e); return 'error' }
  },

  setWritingTop(topPx) {
    try {
      AndroidBridge.setWritingTop(topPx)
    } catch (e) {
      console.warn('Bridge.setWritingTop error:', e)
    }
  },

  setWritingExclusion(left, top, right, bottom) {
    try {
      AndroidBridge.setWritingExclusion(left, top, right, bottom)
    } catch (e) {
      console.warn('Bridge.setWritingExclusion error:', e)
    }
  },

  setWritingBounds(left, top, right, bottom) {
    try { AndroidBridge.setWritingBounds(left, top, right, bottom) } catch (e) { console.warn('Bridge.setWritingBounds error:', e) }
  },

  setErasing(active) {
    try {
      AndroidBridge.setErasing(active)
    } catch (e) {
      console.warn('Bridge.setErasing error:', e)
    }
  },

  setPenType(type) {
    try {
      AndroidBridge.setPenType(type)
    } catch (e) {
      console.warn('Bridge.setPenType error:', e)
    }
  },

  startWebAnim(left, top, right, bottom) {
    try { AndroidBridge.startWebAnim(left, top, right, bottom) } catch (e) { console.warn('Bridge.startWebAnim error:', e) }
  },

  stopWebAnim() {
    try { AndroidBridge.stopWebAnim() } catch (e) { console.warn('Bridge.stopWebAnim error:', e) }
  },


  captureThumbnail(notebookId) {
    try {
      AndroidBridge.captureThumbnail(notebookId)
    } catch (e) {
      console.warn('Bridge.captureThumbnail error:', e)
    }
  },

  getThumbnailDataUrl(notebookId) {
    try {
      return AndroidBridge.getThumbnailDataUrl(notebookId)
    } catch (e) {
      console.warn('Bridge.getThumbnailDataUrl error:', e)
      return ''
    }
  },

  enterEditor() {
    try {
      AndroidBridge.enterEditor()
    } catch (e) {
      console.warn('Bridge.enterEditor error:', e)
    }
  },

  enterLibrary() {
    try {
      AndroidBridge.enterLibrary()
    } catch (e) {
      console.warn('Bridge.enterLibrary error:', e)
    }
  },

  exitApp() {
    try {
      AndroidBridge.exitApp()
    } catch (e) {
      console.warn('Bridge.exitApp error:', e)
    }
  },

  showToast(message) {
    try {
      AndroidBridge.showToast(message)
    } catch (e) {
      console.warn('Bridge.showToast error:', e)
    }
  },

  setAutosaveStatus(status) {
    try {
      AndroidBridge.setAutosaveStatus(status)
    } catch (e) {
      // silently ignore — non-critical
    }
  },

  exportNotebook(notebookId) {
    try {
      AndroidBridge.exportNotebook(notebookId)
    } catch (e) {
      console.warn('Bridge.exportNotebook error:', e)
    }
  },

  getAppDataDir() {
    try {
      return AndroidBridge.getAppDataDir()
    } catch (e) {
      console.warn('Bridge.getAppDataDir error:', e)
      return ''
    }
  },

  getStorageInfo() {
    try {
      return AndroidBridge.getStorageInfo()
    } catch (e) {
      console.warn('Bridge.getStorageInfo error:', e)
      return '{"locations":[]}'
    }
  },

  setStorageLocation(targetPath) {
    try {
      return AndroidBridge.setStorageLocation(targetPath)
    } catch (e) {
      console.warn('Bridge.setStorageLocation error:', e)
      return 'error: ' + e.message
    }
  },

  requestAllFilesAccess() {
    try {
      AndroidBridge.requestAllFilesAccess()
    } catch (e) {
      console.warn('Bridge.requestAllFilesAccess error:', e)
    }
  },

  pickStorageFolder() {
    try {
      AndroidBridge.pickStorageFolder()
    } catch (e) {
      console.warn('Bridge.pickStorageFolder error:', e)
    }
  }
}
