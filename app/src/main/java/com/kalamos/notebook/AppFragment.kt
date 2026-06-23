package com.kalamos.notebook

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.fragment.app.Fragment
import com.kalamos.notebook.bridge.AndroidBridge
import com.kalamos.notebook.bridge.WebViewCache
import com.kalamos.notebook.bridge.InkManager
import com.kalamos.notebook.storage.StorageManager
import com.kalamos.notebook.view.InkSurfaceView

/**
 * The single screen. Library and editor are two views inside ONE WebView (app.html), switched by
 * the JS router (window.App) — no fragment navigation, no WebView swap. The base-layer
 * InkSurfaceView is the visible writing layer in editor mode and hidden (GONE) in library mode.
 */
class AppFragment : Fragment() {

    private lateinit var storageManager: StorageManager
    private lateinit var bridge: AndroidBridge
    private var inkManager: InkManager? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        storageManager = StorageManager(requireContext())
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_app, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        android.util.Log.i("PERF", "DIAG app onViewCreated t=${android.os.SystemClock.uptimeMillis()}")  // DIAG to remove
        // Put the whole app on the faster COMIC refresh mode (vs the device's slower default). Animation
        // pages bump to FAST and revert to this. No-op on non-Bigme devices.
        com.inksdk.ink.EinkCenter.init(requireContext())
        com.inksdk.ink.EinkCenter.setDefaultMode()
        // (rotation lock is applied in MainActivity.onCreate)
        val container = view as ViewGroup
        val webView = WebViewCache.app.acquire(requireContext())
        webView.id = R.id.webView
        // index 0 → below the ink surface (the ink surface is the inflated top child).
        container.addView(webView, 0, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        wireWebView(webView)
    }

    private fun wireWebView(webView: WebView) {
        val inkSurfaceView = (view ?: return).findViewById<InkSurfaceView>(R.id.inkSurfaceView)
        inkManager = InkManager(inkSurfaceView, webView)
        bridge = AndroidBridge(this, storageManager, inkManager)
        WebViewCache.app.router.delegate = bridge
        webView.webViewClient = makeWebViewClient()
        if (WebViewCache.app.isLoaded) {
            // Reused WebView (e.g. after config change): make sure we're showing the library.
            webView.evaluateJavascript("window.App && window.App.start()", null)
        }
        // else: first load — app.html's DOMContentLoaded runs App.start() itself.
    }

    private fun makeWebViewClient() = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            super.onPageFinished(view, url)
            WebViewCache.app.markLoaded()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            android.util.Log.w("AppFragment", "WebView renderer gone (didCrash=${detail.didCrash()}); rebuilding")
            recreateWebView()
            return true
        }
    }

    private fun recreateWebView() {
        val container = view as? ViewGroup ?: return
        inkManager?.detach()
        WebViewCache.app.reset(requireContext().applicationContext)
        val fresh = WebViewCache.app.acquire(requireContext())
        fresh.id = R.id.webView
        container.addView(fresh, 0, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        wireWebView(fresh)
    }

    /** Android back → let the JS router decide (editor → library, library → exit). */
    fun handleBack() {
        webView?.evaluateJavascript("window.App && window.App.onAndroidBack()", null)
    }

    /** Hardware page-turn button → the JS router (library pagination / notebook page nav). */
    fun onPageKey(dir: String) {
        webView?.evaluateJavascript("window.App && window.App.onPageKey('$dir')", null)
    }

    override fun onPause() {
        super.onPause()
        webView?.evaluateJavascript("window.App && window.App.onPauseApp()", null)
    }

    override fun onResume() {
        super.onResume()
        webView?.evaluateJavascript("window.App && window.App.onResumeApp()", null)
    }

    override fun onDestroyView() {
        inkManager?.detach()
        WebViewCache.app.release(requireContext().applicationContext)
        super.onDestroyView()
    }

    private val webView: WebView?
        get() = view?.findViewById(R.id.webView)

    companion object {
        fun newInstance() = AppFragment()
    }
}
