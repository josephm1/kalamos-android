package com.kalamos.notebook

import android.app.Application
import android.os.Build
import android.util.Log
import com.inksdk.ink.PerfCounters
import com.inksdk.ink.PerfSink

class KalamosApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                org.lsposed.hiddenapibypass.HiddenApiBypass.addHiddenApiExemptions("L")
                Log.i(TAG, "HiddenApiBypass enabled")
            } catch (t: Throwable) {
                Log.w(TAG, "HiddenApiBypass failed: ${t.message}")
            }
        }
        PerfCounters.sink = PerfSink { _, _ -> }  // disable hot-path metrics in production

        // One-time: shrink old bloated notebook files (pressure/timestamp + pretty-print) to the
        // compact format so cold opens read less off disk. Background thread — never blocks launch.
        Thread {
            try {
                com.kalamos.notebook.storage.StorageManager(this).compactAllNotebooksOnce()
            } catch (t: Throwable) {
                Log.w(TAG, "notebook compaction failed: ${t.message}")
            }
        }.apply { priority = Thread.MIN_PRIORITY; start() }
    }

    companion object {
        private const val TAG = "KalamosApp"
    }
}