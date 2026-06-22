package com.kalamos.notebook.bridge

import android.webkit.JavascriptInterface

/**
 * Stable @JavascriptInterface bound ONCE to the reused editor WebView. Changes to
 * addJavascriptInterface only take effect on a page (re)load, so a reused WebView would keep its
 * first session's bridge. Instead we bind this router permanently and swap [delegate] per editor
 * session — the JS always calls the same object, which forwards to the live AndroidBridge.
 */
class BridgeRouter {

    @Volatile
    var delegate: AndroidBridge? = null

    @JavascriptInterface fun saveLibrary(json: String): String = delegate?.saveLibrary(json) ?: "error: no delegate"
    @JavascriptInterface fun loadLibrary(): String = delegate?.loadLibrary() ?: "{}"
    @JavascriptInterface fun savePage(notebookId: String, pageId: String, json: String): String = delegate?.savePage(notebookId, pageId, json) ?: "error: no delegate"
    @JavascriptInterface fun saveMeta(notebookId: String, json: String): String = delegate?.saveMeta(notebookId, json) ?: "error: no delegate"
    @JavascriptInterface fun loadMeta(notebookId: String): String = delegate?.loadMeta(notebookId) ?: "null"
    @JavascriptInterface fun peekMeta(notebookId: String): String = delegate?.peekMeta(notebookId) ?: "null"
    @JavascriptInterface fun loadPage(notebookId: String, pageId: String): String = delegate?.loadPage(notebookId, pageId) ?: "[]"
    @JavascriptInterface fun loadNotebookRaw(notebookId: String): String = delegate?.loadNotebookRaw(notebookId) ?: "null"
    @JavascriptInterface fun deleteNotebook(notebookId: String): String = delegate?.deleteNotebook(notebookId) ?: "error: no delegate"
    @JavascriptInterface fun attachInk(left: Int, top: Int, right: Int, bottom: Int): Boolean = delegate?.attachInk(left, top, right, bottom) ?: false
    @JavascriptInterface fun detachInk() { delegate?.detachInk() }
    @JavascriptInterface fun attachInkBox(left: Int, top: Int, right: Int, bottom: Int) { delegate?.attachInkBox(left, top, right, bottom) }
    @JavascriptInterface fun detachInkBox() { delegate?.detachInkBox() }
    @JavascriptInterface fun setInkStyle(widthPx: Float, colorHex: String) { delegate?.setInkStyle(widthPx, colorHex) }
    @JavascriptInterface fun setInkEnabled(enabled: Boolean) { delegate?.setInkEnabled(enabled) }
    @JavascriptInterface fun renderInk(json: String) { delegate?.renderInk(json) }
    @JavascriptInterface fun flushInk() { delegate?.flushInk() }
    @JavascriptInterface fun snapshotToolbar(heightPx: Int) { delegate?.snapshotToolbar(heightPx) }
    @JavascriptInterface fun snapshotToolbarRegion(left: Int, top: Int, right: Int, bottom: Int) { delegate?.snapshotToolbarRegion(left, top, right, bottom) }
    @JavascriptInterface fun snapshotMenu(left: Int, top: Int, right: Int, bottom: Int, refreshLeft: Int, refreshTop: Int, refreshRight: Int, refreshBottom: Int) { delegate?.snapshotMenu(left, top, right, bottom, refreshLeft, refreshTop, refreshRight, refreshBottom) }
    @JavascriptInterface fun snapshotContent(left: Int, top: Int, right: Int, bottom: Int) { delegate?.snapshotContent(left, top, right, bottom) }
    @JavascriptInterface fun snapshotContentPartial(left: Int, top: Int, right: Int, bottom: Int, rl: Int, rt: Int, rr: Int, rb: Int) { delegate?.snapshotContentPartial(left, top, right, bottom, rl, rt, rr, rb) }
    @JavascriptInterface fun skipWakeRefresh() { delegate?.skipWakeRefresh() }
    @JavascriptInterface fun clearContent() { delegate?.clearContent() }
    @JavascriptInterface fun getNotebookAsset(notebookId: String, relPath: String): String = delegate?.getNotebookAsset(notebookId, relPath) ?: ""
    @JavascriptInterface fun setWritingTop(topPx: Int) { delegate?.setWritingTop(topPx) }
    @JavascriptInterface fun setWritingExclusion(left: Int, top: Int, right: Int, bottom: Int) { delegate?.setWritingExclusion(left, top, right, bottom) }
    @JavascriptInterface fun setWritingBounds(left: Int, top: Int, right: Int, bottom: Int) { delegate?.setWritingBounds(left, top, right, bottom) }
    @JavascriptInterface fun setErasing(active: Boolean) { delegate?.setErasing(active) }
    @JavascriptInterface fun setPenType(type: String) { delegate?.setPenType(type) }
    @JavascriptInterface fun startWebAnim(left: Int, top: Int, right: Int, bottom: Int) { delegate?.startWebAnim(left, top, right, bottom) }
    @JavascriptInterface fun stopWebAnim() { delegate?.stopWebAnim() }
    @JavascriptInterface fun captureThumbnail(notebookId: String) { delegate?.captureThumbnail(notebookId) }
    @JavascriptInterface fun getThumbnailDataUrl(notebookId: String): String = delegate?.getThumbnailDataUrl(notebookId) ?: ""
    @JavascriptInterface fun enterEditor() { delegate?.enterEditor() }
    @JavascriptInterface fun enterLibrary() { delegate?.enterLibrary() }
    @JavascriptInterface fun exitApp() { delegate?.exitApp() }
    @JavascriptInterface fun showToast(message: String) { delegate?.showToast(message) }
    @JavascriptInterface fun setAutosaveStatus(status: String) { delegate?.setAutosaveStatus(status) }
    @JavascriptInterface fun exportNotebook(notebookId: String) { delegate?.exportNotebook(notebookId) }
    @JavascriptInterface fun getAppDataDir(): String = delegate?.getAppDataDir() ?: ""
    @JavascriptInterface fun getStorageInfo(): String = delegate?.getStorageInfo() ?: "{\"locations\":[]}"
    @JavascriptInterface fun setStorageLocation(targetPath: String): String = delegate?.setStorageLocation(targetPath) ?: "error: no delegate"
    @JavascriptInterface fun requestAllFilesAccess() { delegate?.requestAllFilesAccess() }
    @JavascriptInterface fun pickStorageFolder() { delegate?.pickStorageFolder() }
}
