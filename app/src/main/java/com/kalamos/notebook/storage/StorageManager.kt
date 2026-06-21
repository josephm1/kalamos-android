package com.kalamos.notebook.storage

import android.content.Context
import android.graphics.Bitmap
import java.io.File

class StorageManager(private val context: Context) {

    private val rootDir: File get() = StorageConfig.getRoot(context)

    fun currentRootPath(): String = rootDir.absolutePath

    /** Total bytes used by notebooks + thumbnails + library under the current root. */
    fun dataSizeBytes(): Long =
        dirSize(notebooksDir) + dirSize(thumbnailsDir) + libraryFile.length()

    private fun dirSize(dir: File): Long =
        dir.listFiles()?.sumOf { if (it.isFile) it.length() else 0L } ?: 0L

    /** Copy all data (notebooks, thumbnails, library.json) from the current root into [target].
     *  The source is NOT deleted — switching the active root is a separate step — so a failed or
     *  interrupted migration never loses data. Returns true on success. */
    fun migrateTo(target: File): Boolean {
        return try {
            val source = rootDir
            if (source.absolutePath == target.absolutePath) return true
            if (!target.exists() && !target.mkdirs()) return false
            copyDir(File(source, "notebooks"), File(target, "notebooks"))
            copyDir(File(source, "thumbnails"), File(target, "thumbnails"))
            val lib = File(source, "library.json")
            if (lib.exists()) lib.copyTo(File(target, "library.json"), overwrite = true)
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun copyDir(src: File, dst: File) {
        if (!src.exists()) return
        dst.mkdirs()
        src.listFiles()?.forEach { f ->
            if (f.isFile) f.copyTo(File(dst, f.name), overwrite = true)
        }
    }

    private val notebooksDir: File get() = File(rootDir, "notebooks").also { it.mkdirs() }

    private val thumbnailsDir: File get() = File(rootDir, "thumbnails").also { it.mkdirs() }

    private val libraryFile: File get() = File(rootDir, "library.json")

    fun loadLibrary(): LibraryIndex {
        return try {
            if (libraryFile.exists()) {
                val json = libraryFile.readText()
                LibraryIndex.fromJson(org.json.JSONObject(json))
            } else {
                LibraryIndex.EMPTY
            }
        } catch (e: Exception) {
            LibraryIndex.EMPTY
        }
    }

    fun saveLibrary(index: LibraryIndex): Boolean {
        return atomicWrite(libraryFile, index.toJson().toString(2).toByteArray())
    }

    // ---- Per-page storage: notebooks/<id>/meta.json + notebooks/<id>/pages/<pageId>.json ----
    // A save rewrites only the edited page's small file + the tiny meta, never the whole notebook.
    // Legacy single-file notebooks (notebooks/<id>.json) are migrated lazily on first load and KEPT
    // as a backup (no deletion → a migration bug can't lose data).

    private fun notebookDir(id: String): File = File(notebooksDir, id)
    private fun metaFile(id: String): File = File(notebookDir(id), "meta.json")
    private fun pagesDir(id: String): File = File(notebookDir(id), "pages")
    private fun pageFile(id: String, pageId: String): File = File(pagesDir(id), "$pageId.json")
    private fun legacyFile(id: String): File = File(notebooksDir, "$id.json")

    fun loadNotebook(notebookId: String): Notebook? {
        return try {
            val raw = loadNotebookRaw(notebookId) ?: return null
            Notebook.fromJson(org.json.JSONObject(raw))
        } catch (e: Exception) {
            null
        }
    }

    /** Build the per-page directory from a legacy single-file notebook. Page files are written first,
     *  then meta.json LAST — its presence is the "migration complete" marker, so a crash mid-migration
     *  simply re-runs next load. The legacy file is left in place as a backup. */
    private fun migrateLegacyToPerPage(notebookId: String) {
        val nb = Notebook.fromJson(org.json.JSONObject(legacyFile(notebookId).readText()))
        pagesDir(notebookId).mkdirs()
        for (page in nb.pages) {
            atomicWrite(pageFile(notebookId, page.pageId),
                org.json.JSONArray(page.strokes.map { it.toJson() }).toString().toByteArray())
        }
        atomicWrite(metaFile(notebookId), metaJson(nb).toString().toByteArray())
    }

    private fun metaJson(nb: Notebook): org.json.JSONObject = org.json.JSONObject().apply {
        put("notebookId", nb.notebookId)
        put("title", nb.title)
        put("folderId", nb.folderId)
        put("createdAt", nb.createdAt)
        put("updatedAt", nb.updatedAt)
        put("defaultTemplate", nb.defaultTemplate.toJson())
        put("pages", org.json.JSONArray(nb.pages.map {
            org.json.JSONObject().apply { put("pageId", it.pageId); put("template", it.template.toJson()) }
        }))
    }

    /** Write [bytes] to [target] crash-safely: write a temp file, fsync it to disk, then atomically
     *  rename over the target. A crash / power-loss / SD-pull mid-write leaves the old file intact
     *  (the rename is atomic) — never a truncated, corrupted notebook. */
    private fun atomicWrite(target: File, bytes: ByteArray): Boolean {
        return try {
            val tmp = File(target.parentFile, target.name + ".tmp")
            java.io.FileOutputStream(tmp).use { fos ->
                fos.write(bytes)
                fos.flush()
                fos.fd.sync()
            }
            if (tmp.renameTo(target)) return true
            // Some filesystems won't rename onto an existing file — replace it.
            target.delete()
            tmp.renameTo(target)
        } catch (e: Exception) {
            false
        }
    }

    /** Ensure the per-page directory exists, migrating a legacy single-file on demand. Returns true
     *  iff meta.json is present afterwards. */
    private fun ensureMigrated(notebookId: String): Boolean {
        if (!metaFile(notebookId).exists()) {
            if (legacyFile(notebookId).exists()) migrateLegacyToPerPage(notebookId) else return false
        }
        return metaFile(notebookId).exists()
    }

    /** The notebook meta (metadata + page list, NO strokes) for lazy open. Migrates on demand. */
    fun loadMetaRaw(notebookId: String): String? {
        return try { if (ensureMigrated(notebookId)) metaFile(notebookId).readText() else null }
        catch (e: Exception) { null }
    }

    /** Like loadMetaRaw but NEVER migrates — for cheap library preload of already-migrated notebooks
     *  (a legacy one returns null and is simply migrated later, on its first real open). */
    fun peekMetaRaw(notebookId: String): String? {
        return try { if (metaFile(notebookId).exists()) metaFile(notebookId).readText() else null }
        catch (e: Exception) { null }
    }

    /** One page's strokes (raw JSON array), or "[]" if it has none yet. */
    fun loadPageRaw(notebookId: String, pageId: String): String? {
        return try {
            val pf = pageFile(notebookId, pageId)
            if (pf.exists()) pf.readText() else "[]"
        } catch (e: Exception) { null }
    }

    /** Reconstruct the full notebook JSON from meta + per-page files for the WebView (V8 does the one
     *  parse). The heavy stroke arrays are spliced in RAW (no native parse) — only the small meta is
     *  parsed — so the cold-open speed of raw-ship is preserved. Migrates a legacy file on demand. */
    fun loadNotebookRaw(notebookId: String): String? {
        return try {
            if (!ensureMigrated(notebookId)) return null
            reconstructRaw(notebookId)
        } catch (e: Exception) {
            null
        }
    }

    private fun reconstructRaw(notebookId: String): String {
        val meta = org.json.JSONObject(metaFile(notebookId).readText())
        val pagesMeta = meta.getJSONArray("pages")
        fun q(s: String): String = org.json.JSONObject.quote(s)
        val sb = StringBuilder(4096)
        sb.append("{\"notebookId\":").append(q(meta.optString("notebookId", notebookId)))
        sb.append(",\"title\":").append(q(meta.optString("title", "Notebook")))
        sb.append(",\"folderId\":").append(q(meta.optString("folderId", "")))
        sb.append(",\"createdAt\":").append(q(meta.optString("createdAt", "")))
        sb.append(",\"updatedAt\":").append(q(meta.optString("updatedAt", "")))
        sb.append(",\"defaultTemplate\":").append((meta.optJSONObject("defaultTemplate") ?: Template.DEFAULT.toJson()).toString())
        sb.append(",\"pages\":[")
        for (i in 0 until pagesMeta.length()) {
            if (i > 0) sb.append(",")
            val pm = pagesMeta.getJSONObject(i)
            val pageId = pm.getString("pageId")
            sb.append("{\"pageId\":").append(q(pageId))
            sb.append(",\"template\":").append(pm.getJSONObject("template").toString())
            sb.append(",\"strokes\":")
            val pf = pageFile(notebookId, pageId)
            val raw = if (pf.exists()) pf.readText().trim() else ""
            sb.append(if (raw.startsWith("[")) raw else "[]")   // missing/blank page file → empty strokes
            sb.append("}")
        }
        sb.append("]}")
        return sb.toString()
    }

    /** Write one page's strokes. [json] is a trusted strokes array from JSON.stringify(page.strokes). */
    fun savePageRaw(notebookId: String, pageId: String, json: String): Boolean {
        if (json.isBlank() || json[0] != '[') return false
        pagesDir(notebookId).mkdirs()
        return atomicWrite(pageFile(notebookId, pageId), json.toByteArray())
    }

    /** Write the notebook meta ([json] = metadata + page list from JSON.stringify), then vacuum any
     *  page files no longer referenced (deleted pages). Meta is written FIRST, so the sweep is always
     *  safe — and an interrupted sweep just leaves orphans that reconstructRaw ignores anyway. */
    fun saveMetaRaw(notebookId: String, json: String): Boolean {
        if (json.isBlank() || json[0] != '{') return false
        notebookDir(notebookId).mkdirs()
        if (!atomicWrite(metaFile(notebookId), json.toByteArray())) return false
        try {
            val keep = HashSet<String>()
            org.json.JSONObject(json).optJSONArray("pages")?.let { arr ->
                for (i in 0 until arr.length()) keep.add(arr.getJSONObject(i).getString("pageId") + ".json")
            }
            pagesDir(notebookId).listFiles()?.forEach {
                if (it.isFile && it.name.endsWith(".json") && it.name !in keep) it.delete()
            }
        } catch (e: Exception) {
            // Vacuum is best-effort; orphaned page files are harmless (reconstructRaw is meta-driven).
        }
        return true
    }

    /** Full save of an in-memory Notebook (all pages + meta) — used for create/duplicate where the
     *  whole model is rewritten. The editor's hot autosave path saves only dirty pages via savePageRaw. */
    fun saveNotebook(notebook: Notebook): Boolean {
        return try {
            pagesDir(notebook.notebookId).mkdirs()
            for (page in notebook.pages) {
                atomicWrite(pageFile(notebook.notebookId, page.pageId),
                    org.json.JSONArray(page.strokes.map { it.toJson() }).toString().toByteArray())
            }
            saveMetaRaw(notebook.notebookId, metaJson(notebook).toString())
        } catch (e: Exception) {
            false
        }
    }

    /** One-time migration: rewrite every notebook in the compact format — no pressure/timestamp,
     *  integer coords, no pretty-print — so old bloated files shrink ~3x and cold reads get faster.
     *  Idempotent (re-saving an already-compact notebook is a no-op) and guarded by a marker file so
     *  it only runs once. Safe to interrupt: partial progress leaves every file still readable. */
    fun compactAllNotebooksOnce() {
        val marker = File(rootDir, ".compacted_v1")
        if (marker.exists()) return
        try {
            val files = notebooksDir.listFiles { f -> f.extension == "json" } ?: emptyArray()
            var done = 0
            var beforeBytes = 0L
            var afterBytes = 0L
            for (f in files) {
                try {
                    beforeBytes += f.length()
                    val nb = Notebook.fromJson(org.json.JSONObject(f.readText()))
                    atomicWrite(f, nb.toJson().toString().toByteArray())
                    afterBytes += f.length()
                    done++
                } catch (e: Exception) {
                    // Leave an unreadable/odd file as-is; raw-ship + JS validation still handle it.
                }
            }
            marker.writeText("v1")
            android.util.Log.i("StorageManager", "compacted $done notebooks: ${beforeBytes/1024}KB -> ${afterBytes/1024}KB")
        } catch (e: Exception) {
            // Top-level failure: don't write the marker, so it retries next launch.
        }
    }

    fun deleteNotebook(notebookId: String): Boolean {
        return try {
            notebookDir(notebookId).deleteRecursively()  // per-page directory
            legacyFile(notebookId).delete()              // legacy single-file backup, if any
            File(thumbnailsDir, "$notebookId.png").delete()
            true
        } catch (e: Exception) {
            false
        }
    }

    fun saveThumbnailBytes(notebookId: String, bytes: ByteArray): Boolean {
        return try {
            File(thumbnailsDir, "$notebookId.png").writeBytes(bytes)
            true
        } catch (e: Exception) {
            false
        }
    }

    fun getThumbnailPath(notebookId: String): String {
        val file = File(thumbnailsDir, "$notebookId.png")
        return if (file.exists()) file.absolutePath else ""
    }

    /** The thumbnail as a base64 data: URL — embedded in the library DOM so it's always fresh (no
     *  file:// path caching → no stale previews after an edit) and renders in one synchronous pass
     *  (no async image decode → no partial e-ink refreshes). "" if there's no thumbnail yet. */
    fun getThumbnailDataUrl(notebookId: String): String {
        return try {
            val file = File(thumbnailsDir, "$notebookId.png")
            if (!file.exists()) return ""
            "data:image/png;base64," + android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }

    fun getNotebookPath(notebookId: String): String {
        return notebookDir(notebookId).absolutePath
    }

    /** A notebook asset (image) as a base64 data: URL for the WebView content layer. [relPath] is
     *  relative to the notebook dir (e.g. "assets/koch.jpg"); kept inside the notebook dir (no ..
     *  traversal). "" if missing/unreadable. */
    fun getNotebookAssetDataUrl(notebookId: String, relPath: String): String {
        return try {
            val dir = notebookDir(notebookId).canonicalFile
            val f = File(dir, relPath).canonicalFile
            if (!f.path.startsWith(dir.path) || !f.exists()) return ""
            val mime = when (f.extension.lowercase()) {
                "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"
                "webp" -> "image/webp"; "svg" -> "image/svg+xml"; else -> "application/octet-stream"
            }
            "data:$mime;base64," + android.util.Base64.encodeToString(f.readBytes(), android.util.Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }

    fun getAppDataDir(): String {
        return rootDir.absolutePath
    }
}
