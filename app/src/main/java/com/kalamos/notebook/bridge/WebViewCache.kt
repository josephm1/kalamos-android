package com.kalamos.notebook.bridge

import android.content.Context
import android.content.MutableContextWrapper
import android.os.Build
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * A cached, pre-warmed WebView reused across fragment instances so its HTML/JS *shell* is loaded
 * once and kept warm; only the *content* is (re)loaded per use. A stable [router] is bound once and
 * its delegate is swapped per session — addJavascriptInterface only takes effect on a page reload,
 * so a reused WebView would otherwise keep its first session's bridge. A MutableContextWrapper holds
 * the Application context while cached (no Activity leak) / the Activity context while displayed.
 */
class CachedWebViewHolder(private val url: String, private val transparentBg: Boolean) {

    val router = BridgeRouter()
    private var webView: WebView? = null

    @Volatile
    var isLoaded = false
        private set

    /** Create + start loading the WebView (idempotent). */
    fun prewarm(context: Context) {
        if (webView != null) return
        val wv = WebView(MutableContextWrapper(context.applicationContext))
        configure(wv)
        wv.addJavascriptInterface(router, "AndroidBridge")
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, u: String) { isLoaded = true }
        }
        wv.loadUrl(url)
        webView = wv
    }

    /** Get the warmed WebView, re-based onto [activity] and detached from any previous parent. */
    fun acquire(activity: Context): WebView {
        prewarm(activity)
        val wv = webView!!
        (wv.context as? MutableContextWrapper)?.baseContext = activity
        (wv.parent as? ViewGroup)?.removeView(wv)
        return wv
    }

    /** Detach + re-base onto the app context so the cached WebView never leaks the Activity. */
    fun release(appContext: Context) {
        val wv = webView ?: return
        (wv.parent as? ViewGroup)?.removeView(wv)
        (wv.context as? MutableContextWrapper)?.baseContext = appContext.applicationContext
        router.delegate = null
    }

    /** Destroy the cached WebView (e.g. its renderer died) so the next acquire rebuilds it fresh. */
    fun reset(appContext: Context) {
        val wv = webView
        webView = null
        isLoaded = false
        router.delegate = null
        if (wv != null) {
            (wv.parent as? ViewGroup)?.removeView(wv)
            wv.destroy()
        }
    }

    fun markLoaded() { isLoaded = true }

    private fun configure(webView: WebView) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            builtInZoomControls = false
            displayZoomControls = false
        }
        // Editor's WebView is transparent so the base-layer ink surface shows through; the library's
        // is opaque (it's the only view on screen).
        if (transparentBg) webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                if (m.message().startsWith("DIAG")) android.util.Log.i("WebConsole", m.message())
                return true
            }
        }
        // Cached/occluded WebViews would have their renderer reaped — pin it so it stays warm.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
    }
}

/** Process-wide cache of the single app WebView (library + editor are views inside app.html,
 *  toggled by the JS router). Starts opaque (library is shown first); InkManager flips it
 *  transparent in editor mode so the base-layer ink surface shows through. */
object WebViewCache {
    val app = CachedWebViewHolder("file:///android_asset/web/app.html", transparentBg = false)
}
