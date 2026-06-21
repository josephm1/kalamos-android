package com.kalamos.notebook.bridge

import android.content.Intent
import android.graphics.Rect
import android.os.Environment
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import com.kalamos.notebook.storage.Notebook
import com.kalamos.notebook.storage.StorageManager

class AndroidBridge(
    private val fragment: Fragment,
    private val storageManager: StorageManager,
    private val inkManager: InkManager? = null
) {

    @JavascriptInterface
    fun saveLibrary(json: String): String {
        return try {
            val index = com.kalamos.notebook.storage.LibraryIndex.fromJson(org.json.JSONObject(json))
            if (storageManager.saveLibrary(index)) "ok" else "error: save failed"
        } catch (e: Exception) {
            "error: ${e.message}"
        }
    }

    @JavascriptInterface
    fun loadLibrary(): String {
        return try {
            val index = storageManager.loadLibrary()
            index.toJson().toString()
        } catch (e: Exception) {
            "{}"
        }
    }

    /** Save one page's strokes ([json] = strokes array). Per-page storage: only the edited page is
     *  rewritten, not the whole notebook. */
    @JavascriptInterface
    fun savePage(notebookId: String, pageId: String, json: String): String {
        return try {
            if (storageManager.savePageRaw(notebookId, pageId, json)) "ok" else "error: save failed"
        } catch (e: Exception) {
            "error: ${e.message}"
        }
    }

    /** Notebook meta (metadata + page list, no strokes) for lazy open — migrates on demand. */
    @JavascriptInterface
    fun loadMeta(notebookId: String): String {
        return try { storageManager.loadMetaRaw(notebookId) ?: "null" } catch (e: Exception) { "null" }
    }

    /** Meta WITHOUT migrating (library preload of already-migrated notebooks). "null" if not migrated. */
    @JavascriptInterface
    fun peekMeta(notebookId: String): String {
        return try { storageManager.peekMetaRaw(notebookId) ?: "null" } catch (e: Exception) { "null" }
    }

    /** One page's strokes (raw JSON array) for lazy load. */
    @JavascriptInterface
    fun loadPage(notebookId: String, pageId: String): String {
        return try { storageManager.loadPageRaw(notebookId, pageId) ?: "[]" } catch (e: Exception) { "[]" }
    }

    /** Save the notebook meta ([json] = metadata + page list); also vacuums deleted pages' files. */
    @JavascriptInterface
    fun saveMeta(notebookId: String, json: String): String {
        return try {
            if (storageManager.saveMetaRaw(notebookId, json)) "ok" else "error: save failed"
        } catch (e: Exception) {
            "error: ${e.message}"
        }
    }

    /** Return the notebook's raw on-disk JSON, unparsed, so V8 in the WebView does the single parse.
     *  Android's org.json was ~3s of parse+reserialize on a cold open for what V8 parses in a few ms;
     *  the native side now just reads the file. */
    @JavascriptInterface
    fun loadNotebookRaw(notebookId: String): String {
        return try {
            val _t0 = android.os.SystemClock.uptimeMillis()  // DIAG to remove
            val raw = storageManager.loadNotebookRaw(notebookId) ?: return "null"
            android.util.Log.i("PERF", "DIAG loadRaw native: read=${android.os.SystemClock.uptimeMillis()-_t0}ms bytes=${raw.length}")  // DIAG to remove
            raw
        } catch (e: Exception) {
            "null"
        }
    }

    @JavascriptInterface
    fun deleteNotebook(notebookId: String): String {
        return try {
            if (storageManager.deleteNotebook(notebookId)) "ok" else "error: delete failed"
        } catch (e: Exception) {
            "error: ${e.message}"
        }
    }

    @JavascriptInterface
    fun attachInk(left: Int, top: Int, right: Int, bottom: Int): Boolean {
        return try {
            inkManager?.attach(Rect(left, top, right, bottom))
            true
        } catch (e: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun detachInk() {
        inkManager?.detach()
    }

    @JavascriptInterface
    fun setInkStyle(widthPx: Float, colorHex: String) {
        inkManager?.setStyle(widthPx, colorHex)
    }

    @JavascriptInterface
    fun setInkEnabled(enabled: Boolean) {
        inkManager?.setEnabled(enabled)
    }


    /** Render the whole page on the native ink surface from the JS model (load/undo/erase/etc.).
     *  [json] = array of strokes in surface px: [{"w":widthPx,"p":[[x,y],...]}, ...]. */
    @JavascriptInterface
    fun renderInk(json: String) {
        inkManager?.renderInk(json)
    }

    /** Flush the native stroke batch into the JS model, then fire window.onNativeFlushed() so a
     *  model op (undo/erase/save) runs against current data. */
    @JavascriptInterface
    fun flushInk() {
        inkManager?.flushAndSignal()
    }

    /** Snapshot the top [heightPx] (surface px) of the WebView (the toolbar strip) onto the native
     *  page so the web toolbar is visible. Called by JS after load and after toolbar changes. */
    @JavascriptInterface
    fun snapshotToolbar(heightPx: Int) {
        inkManager?.snapshotToolbar(heightPx)
    }

    /** Re-bake just one toolbar region (surface px) — button cluster / page number — without a
     *  whole-strip re-bake or flash. */
    @JavascriptInterface
    fun snapshotToolbarRegion(left: Int, top: Int, right: Int, bottom: Int) {
        inkManager?.snapshotToolbarRegion(left, top, right, bottom)
    }

    /** Bake the floating collapsible menu at its bounds (left..bottom). [refresh*] = union of old +
     *  new menu bounds so a collapse clears the area it used to cover. */
    @JavascriptInterface
    fun snapshotMenu(left: Int, top: Int, right: Int, bottom: Int,
                     refreshLeft: Int, refreshTop: Int, refreshRight: Int, refreshBottom: Int) {
        inkManager?.snapshotMenu(left, top, right, bottom, refreshLeft, refreshTop, refreshRight, refreshBottom)
    }

    /** Bake the WebView's interactive-format content layer (region [l,t,r,b] = paper, surface px)
     *  onto the ink surface, under the ink. The pen then writes over the baked article content. */
    @JavascriptInterface
    fun snapshotContent(left: Int, top: Int, right: Int, bottom: Int) {
        inkManager?.snapshotContent(left, top, right, bottom)
    }

    /** Bake the content region but limit the EPD refresh to rl,rt,rr,rb (sticky-note box) for a partial refresh. */
    @JavascriptInterface
    fun snapshotContentPartial(left: Int, top: Int, right: Int, bottom: Int, rl: Int, rt: Int, rr: Int, rb: Int) {
        inkManager?.snapshotContent(left, top, right, bottom, rl, rt, rr, rb)
    }

    /** Suppress the full-screen wake refresh on the next attach (partial sticky-note open). */
    @JavascriptInterface
    fun skipWakeRefresh() {
        inkManager?.skipNextWake()
    }

    /** Drop any baked content (plain notebook / page with no blocks). */
    @JavascriptInterface
    fun clearContent() {
        inkManager?.clearContent()
    }

    /** A notebook asset (e.g. an image under the notebook's assets/) as a base64 data URL, for the
     *  content layer to display. [relPath] is relative to the notebook dir. "" if missing. */
    @JavascriptInterface
    fun getNotebookAsset(notebookId: String, relPath: String): String {
        return storageManager.getNotebookAssetDataUrl(notebookId, relPath)
    }

    /** Restrict the daemon's writing area: pen above [topPx] (surface px) is ignored. JS owns the
     *  measurement (the toolbar strip), so the website controls the pen-input region. */
    @JavascriptInterface
    fun setWritingTop(topPx: Int) {
        inkManager?.setWritingTop(topPx)
    }

    /** The floating menu's bounds (surface px): pen inside is ignored. Empty rect clears it. */
    @JavascriptInterface
    fun setWritingExclusion(left: Int, top: Int, right: Int, bottom: Int) {
        inkManager?.setWritingExclusion(left, top, right, bottom)
    }

    /** Confine the daemon pen to a box (surface px) — for sticky-note/sketch drawing. Empty clears. */
    @JavascriptInterface
    fun setWritingBounds(left: Int, top: Int, right: Int, bottom: Int) {
        inkManager?.setWritingBounds(left, top, right, bottom)
    }

    /** Web layer toggles eraser mode: while active, native discards any daemon stroke (the daemon
     *  sometimes mis-paints a stylus-eraser swipe as a pen stroke). */
    @JavascriptInterface
    fun setErasing(active: Boolean) {
        inkManager?.setErasing(active)
    }

    /** Pen type: "ballpoint" (constant width), "felt" (width by pressure), "selection" (dashed line). */
    @JavascriptInterface
    fun setPenType(type: String) {
        inkManager?.setPenType(type)
    }

    /** Start sampling + fast-refreshing a WebView region (surface px) — the web layer's animation. */
    @JavascriptInterface
    fun startWebAnim(left: Int, top: Int, right: Int, bottom: Int) {
        inkManager?.startWebAnim(left, top, right, bottom)
    }

    @JavascriptInterface
    fun stopWebAnim() {
        inkManager?.stopWebAnim()
    }

    /** Capture the current page off the native ink surface and save it as the notebook's thumbnail
     *  (the web canvas is stale — writing only goes to the surface). */
    @JavascriptInterface
    fun captureThumbnail(notebookId: String) {
        inkManager?.saveThumbnail(notebookId, storageManager)
    }

    @JavascriptInterface
    fun getThumbnailDataUrl(notebookId: String): String {
        return storageManager.getThumbnailDataUrl(notebookId)
    }

    /** SPA routing (the web layer owns navigation now): switch the single WebView to editor mode
     *  (show the ink surface, transparent WebView). */
    @JavascriptInterface
    fun enterEditor() {
        inkManager?.enterEditor()
    }

    /** SPA routing: switch to library mode (hide the ink surface, opaque WebView). */
    @JavascriptInterface
    fun enterLibrary() {
        inkManager?.enterLibrary()
    }

    /** Back pressed while on the library — quit to the home screen. */
    @JavascriptInterface
    fun exitApp() {
        fragment.requireActivity().runOnUiThread {
            fragment.requireActivity().moveTaskToBack(true)
        }
    }

    @JavascriptInterface
    fun showToast(message: String) {
        Toast.makeText(fragment.requireContext(), message, Toast.LENGTH_SHORT).show()
    }

    @JavascriptInterface
    fun setAutosaveStatus(status: String) {
        // UI indicator in toolbar is handled via web layer; could pipe to native status bar
    }

    @JavascriptInterface
    fun exportNotebook(notebookId: String) {
        val notebook = storageManager.loadNotebook(notebookId) ?: return
        val json = notebook.toJson().toString(2)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/json"
            putExtra(Intent.EXTRA_TITLE, "${notebook.title}.json")
        }
        exportLauncher.launch(intent)
        pendingExportJson = json
    }

    @JavascriptInterface
    fun getAppDataDir(): String {
        return storageManager.getAppDataDir()
    }

    /** Current storage location + the available targets (internal + any SD card), with free space,
     *  for the Settings panel. JSON. */
    @JavascriptInterface
    fun getStorageInfo(): String {
        return try {
            val ctx = fragment.requireContext()
            val internal = ctx.filesDir
            val current = storageManager.currentRootPath()
            val locations = org.json.JSONArray()
            locations.put(org.json.JSONObject().apply {
                put("label", "Internal storage")
                put("path", internal.absolutePath)
                put("free", internal.freeSpace)
                put("needsPermission", false)
                put("current", current == internal.absolutePath)
            })
            com.kalamos.notebook.storage.StorageConfig.externalVolumeRoots(ctx).forEach { vol ->
                if (!vol.absolutePath.startsWith("/storage/emulated")) {
                    val target = java.io.File(vol, "Kalamos")
                    locations.put(org.json.JSONObject().apply {
                        put("label", "SD card")
                        put("path", target.absolutePath)
                        put("free", vol.freeSpace)
                        put("needsPermission", true)
                        put("current", current == target.absolutePath)
                    })
                }
            }
            org.json.JSONObject().apply {
                put("currentPath", current)
                put("dataSize", storageManager.dataSizeBytes())
                put("hasAllFilesAccess", com.kalamos.notebook.storage.StorageConfig.hasAllFilesAccess())
                put("locations", locations)
            }.toString()
        } catch (e: Exception) {
            "{\"locations\":[]}"
        }
    }

    /** Migrate the notebooks to [targetPath] and make it the active root. Returns "ok",
     *  "need_permission" (caller should call requestAllFilesAccess then retry), or "error: …".
     *  The old data is left in place (not deleted) as a safety net. */
    @JavascriptInterface
    fun setStorageLocation(targetPath: String): String {
        return try {
            val ctx = fragment.requireContext()
            val target = java.io.File(targetPath)
            val isInternal = targetPath == ctx.filesDir.absolutePath
            if (!isInternal && !com.kalamos.notebook.storage.StorageConfig.hasAllFilesAccess()) {
                return "need_permission"
            }
            if (!storageManager.migrateTo(target)) return "error: migration failed"
            com.kalamos.notebook.storage.StorageConfig.setRoot(ctx, if (isInternal) null else targetPath)
            "ok"
        } catch (e: Exception) {
            "error: ${e.message}"
        }
    }

    /** Launch the system folder picker (SAF). On pick, we resolve the tree URI to a real filesystem
     *  path and migrate there (keeping fast java.io.File access), then call
     *  window.onStorageFolderPicked(status, path). */
    @JavascriptInterface
    fun pickStorageFolder() {
        fragment.requireActivity().runOnUiThread {
            try {
                folderPickerLauncher.launch(null)
            } catch (e: Exception) {
                notifyStorageJs("error", "")
            }
        }
    }

    /** Resolve a SAF tree URI (externalstorage provider) to a filesystem path. Handles the primary
     *  shared volume ("primary:Sub") and removable volumes ("XXXX-XXXX:Sub"). Returns null for
     *  non-filesystem providers (cloud), which we can't use with direct file access. */
    private fun resolveTreeUriToPath(uri: android.net.Uri): String? {
        return try {
            val docId = android.provider.DocumentsContract.getTreeDocumentId(uri)
            val parts = docId.split(":", limit = 2)
            val volId = parts[0]
            val sub = if (parts.size > 1) parts[1] else ""
            val base = if (volId.equals("primary", ignoreCase = true))
                android.os.Environment.getExternalStorageDirectory().absolutePath
            else "/storage/$volId"
            if (sub.isEmpty()) base else "$base/$sub"
        } catch (e: Exception) {
            null
        }
    }

    private fun notifyStorageJs(status: String, path: String) {
        fragment.requireActivity().runOnUiThread {
            val wv = fragment.view?.findViewById<android.webkit.WebView>(com.kalamos.notebook.R.id.webView)
            wv?.evaluateJavascript(
                "window.onStorageFolderPicked && window.onStorageFolderPicked('$status', ${org.json.JSONObject.quote(path)})",
                null
            )
        }
    }

    private val folderPickerLauncher = fragment.registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri: android.net.Uri? ->
        if (uri == null) { notifyStorageJs("cancelled", ""); return@registerForActivityResult }
        val path = resolveTreeUriToPath(uri)
        if (path == null) { notifyStorageJs("unresolved", ""); return@registerForActivityResult }
        if (!com.kalamos.notebook.storage.StorageConfig.hasAllFilesAccess()) {
            notifyStorageJs("need_permission", path); return@registerForActivityResult
        }
        // Migrate off the main thread (could be large), then switch the active root + notify JS.
        Thread {
            val ok = storageManager.migrateTo(java.io.File(path))
            if (ok) com.kalamos.notebook.storage.StorageConfig.setRoot(fragment.requireContext(), path)
            notifyStorageJs(if (ok) "ok" else "error", path)
        }.start()
    }

    /** Open the system screen to grant "All files access" (needed for non-private folders like the
     *  SD card). */
    @JavascriptInterface
    fun requestAllFilesAccess() {
        if (com.kalamos.notebook.storage.StorageConfig.hasAllFilesAccess()) return
        try {
            val intent = Intent(
                android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                android.net.Uri.parse("package:" + fragment.requireContext().packageName)
            )
            fragment.startActivity(intent)
        } catch (e: Exception) {
            try {
                fragment.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            } catch (e2: Exception) { /* ignore */ }
        }
    }

    private var pendingExportJson: String? = null

    private val exportLauncher = fragment.registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == ComponentActivity.RESULT_OK) {
            result.data?.data?.let { uri ->
                try {
                    fragment.requireContext().contentResolver.openOutputStream(uri)?.use { out ->
                        out.write(pendingExportJson?.toByteArray() ?: return@use)
                    }
                    fragment.requireActivity().runOnUiThread {
                        fragment.requireActivity().supportFragmentManager.executePendingTransactions()
                        val webView = fragment.view?.findViewById<android.webkit.WebView>(com.kalamos.notebook.R.id.webView)
                        webView?.evaluateJavascript("window.onExportComplete(true)", null)
                    }
                } catch (e: Exception) {
                    fragment.requireActivity().runOnUiThread {
                        val webView = fragment.view?.findViewById<android.webkit.WebView>(com.kalamos.notebook.R.id.webView)
                        webView?.evaluateJavascript("window.onExportComplete(false)", null)
                    }
                }
            }
        } else {
            fragment.requireActivity().runOnUiThread {
                val webView = fragment.view?.findViewById<android.webkit.WebView>(com.kalamos.notebook.R.id.webView)
                webView?.evaluateJavascript("window.onExportComplete(false)", null)
            }
        }
        pendingExportJson = null
    }
}
