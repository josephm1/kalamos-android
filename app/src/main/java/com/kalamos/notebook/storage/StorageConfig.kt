package com.kalamos.notebook.storage

import android.content.Context
import android.os.Environment
import java.io.File

/**
 * Resolves WHERE notebooks/thumbnails/library.json live. Default is the app's private internal
 * storage (filesDir); the user can point it at a real folder on another volume (e.g. the SD card)
 * via Settings. We store an absolute path and use plain java.io.File everywhere (fast — unlike the
 * Storage Access Framework), which on a non-private path requires the MANAGE_EXTERNAL_STORAGE
 * ("all files access") permission.
 */
object StorageConfig {
    private const val PREFS = "kalamos_storage"
    private const val KEY_ROOT = "root_path"

    /** The active storage root. Falls back to internal if the stored path is unset or unusable
     *  (e.g. the SD card was removed) so the app always has somewhere to read/write. */
    fun getRoot(context: Context): File {
        val path = prefs(context).getString(KEY_ROOT, null)
        if (path != null) {
            val f = File(path)
            if ((f.exists() || f.mkdirs()) && f.canWrite()) return f
        }
        return context.filesDir
    }

    fun setRoot(context: Context, path: String?) {
        prefs(context).edit().putString(KEY_ROOT, path).apply()
    }

    fun isInternal(context: Context): Boolean =
        getRoot(context).absolutePath == context.filesDir.absolutePath

    /** Volume roots the app can target: the app's private internal dir (always, no permission) plus
     *  the root of every mounted external volume (primary shared + SD card), discovered via
     *  getExternalFilesDirs (each entry is .../<volumeRoot>/Android/data/<pkg>/files). */
    fun externalVolumeRoots(context: Context): List<File> {
        return context.getExternalFilesDirs(null)
            .filterNotNull()
            .mapNotNull { dir ->
                // strip the trailing /Android/data/<pkg>/files to get the volume root
                val marker = "/Android/data/"
                val idx = dir.absolutePath.indexOf(marker)
                if (idx > 0) File(dir.absolutePath.substring(0, idx)) else null
            }
    }

    fun hasAllFilesAccess(): Boolean =
        android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R ||
            Environment.isExternalStorageManager()

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
