package com.kalamos.notebook.bridge

import android.graphics.PointF
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import com.inksdk.ink.StrokeCallback
import com.kalamos.notebook.view.InkSurfaceView

class InkManager(
    private val inkSurfaceView: InkSurfaceView,
    private val webView: WebView
) {

    private var attached = false
    private var currentBounds = Rect()
    private var strokeWidthPx = 3f
    private val mainHandler = Handler(Looper.getMainLooper())

    // Points of the in-progress stroke (surface px). Reused each stroke.
    private val pointBuffer = ArrayList<PointF>()
    // Per-point pen pressure (0..1), parallel to pointBuffer — used by the felt pen for width.
    private val pressureBuffer = ArrayList<Float>()
    // Felt pen active (vary width by pressure) vs ballpoint (constant width).
    @Volatile private var feltMode = false
    // Selection pen active (dashed line).
    @Volatile private var dashMode = false


    // Finished strokes accumulated NATIVELY as JSON, flushed to the JS model in ONE
    // evaluateJavascript only after the pen pauses. So the writing burst runs zero JS / no
    // WebView round-trips — only the native page render (drawStroke) happens per stroke.
    private val batchBuffer = StringBuilder()
    private var batchCount = 0
    private val flushRunnable = Runnable { flushToJs() }
    // The heavy disk save (JSON.stringify whole notebook + write) is separate from the cheap model
    // update, and only fires after a LONG true-idle window — both cancelled on pen-down — so a save
    // can never run while the user is still writing (that was the residual mid-page hiccup).
    private val saveRunnable = Runnable { postToWeb("window.saveNotebook()") }

    // True while the web layer is erasing (stylus eraser detected). The daemon's tool detection is
    // unreliable and can mis-paint an eraser swipe as a pen stroke, so we discard any daemon stroke
    // while erasing — the web layer's eraser detection is the authority.
    @Volatile private var erasing = false

    /** SPA routing: show the editor. The ink surface (base-layer, the visible writing layer) becomes
     *  visible and the WebView goes transparent so it shows through. The daemon attach itself is
     *  driven separately by the web layer's attachInk flow. */
    fun enterEditor() {
        mainHandler.post {
            inkSurfaceView.visibility = android.view.View.VISIBLE
            webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        }
    }

    /** SPA routing: show the library. Hide the ink surface and make the WebView opaque so the
     *  library view is the sole visible layer. (detach() is called separately by the web layer.) */
    fun enterLibrary() {
        mainHandler.post {
            inkSurfaceView.visibility = android.view.View.GONE
            webView.setBackgroundColor(android.graphics.Color.WHITE)
        }
    }

    /** Web layer tells us it's erasing (button mode or stylus eraser). The daemon paints no ink so
     *  the pen tip erases via the web layer; we also drop any daemon stroke as a backstop. */
    fun setErasing(active: Boolean) {
        erasing = active
        inkSurfaceView.setEraserMode(active)
    }

    // ---- Generic web-region animation ----
    // The animation is defined entirely in the WEB layer (SVG/CSS/canvas/JS). This whole loop ONLY
    // runs while an animation is active (animRunning) — it's started by the web layer (startWebAnim)
    // and stopped on toggle-off / page-change / leaving the editor. Plain pages/notebooks pay nothing.
    // Each frame native drives the web clock (window.__animTick) so the animation keeps advancing even
    // though a software-layered/occluded WebView throttles its own requestAnimationFrame.
    @Volatile private var animRunning = false
    private val animRect = Rect()
    private var animFrameIdx = 0
    private val animRunnable = object : Runnable {
        override fun run() {
            if (!animRunning) return
            captureAnimFrame()                     // the web (CSS) animation advances on its own clock
            animFrameIdx++
            mainHandler.postDelayed(this, ANIM_FRAME_MS)
        }
    }

    /** Start sampling + fast-refreshing the WebView region [l,t,r,b] (surface px). */
    fun startWebAnim(l: Int, t: Int, r: Int, b: Int) {
        mainHandler.post {
            animRect.set(l, t, r, b)
            animFrameIdx = 0
            animRunning = true
            // This page has an animation → switch the panel into its fast (non-flashing) mode. Reverted
            // to the writing-friendly default the moment the animation stops (toggle/page-change/leave).
            com.inksdk.ink.EinkCenter.init(webView.context)
            com.inksdk.ink.EinkCenter.enterAnimationMode()
            // Software layer so webView.draw() captures live content (the HW draw() is blank). Held
            // for the whole animation (no per-frame flip); writing is daemon-owned and unaffected.
            webView.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
            webView.postDelayed({ if (animRunning) animRunnable.run() }, 60)
        }
    }

    fun stopWebAnim() {
        mainHandler.post {
            if (!animRunning) return@post
            animRunning = false
            mainHandler.removeCallbacks(animRunnable)
            webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
            com.inksdk.ink.EinkCenter.exitAnimationMode()   // back to the writing/reading default
            inkSurfaceView.animClear(Rect(animRect))
        }
    }

    private fun captureAnimFrame() {
        val w = animRect.width(); val h = animRect.height()
        if (w <= 0 || h <= 0) return
        try {
            val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp)
            canvas.translate(-animRect.left.toFloat(), -animRect.top.toFloat())
            webView.draw(canvas)                 // sample the animation region from the web layer
            val t0 = System.nanoTime()
            // Every frame uses the (tunable) fast waveform — no periodic GU16 de-ghost during the
            // waveform experiment, so the chosen mode is what we actually see.
            inkSurfaceView.animFrame(bmp, animRect.left, animRect.top, false)
            bmp.recycle()
            if (animFrameIdx % 20 == 0)
                Log.i(TAG, "webAnim frame=$animFrameIdx refresh=${(System.nanoTime() - t0) / 1_000_000}ms region=${w}x$h")
        } catch (e: Exception) {
            Log.w(TAG, "captureAnimFrame failed: ${e.message}")
        }
    }

    /** Pen type: "ballpoint" = constant width; "felt" = width by pressure; "selection" = dashed line. */
    fun setPenType(type: String) {
        feltMode = type == "felt"
        dashMode = type == "selection"
        inkSurfaceView.setPressureMode(feltMode)
        inkSurfaceView.setDashMode(dashMode)
    }

    private val strokeCallback = object : StrokeCallback {
        override fun onStrokeBegin(x: Float, y: Float, pressure: Float, timestampMs: Long) {
            if (erasing) return                          // web layer owns this gesture as an eraser
            mainHandler.removeCallbacks(flushRunnable)   // still writing — hold the JS flush + save
            mainHandler.removeCallbacks(saveRunnable)
            pointBuffer.clear()
            pressureBuffer.clear()
            pointBuffer.add(PointF(x, y)); pressureBuffer.add(pressure)
        }

        override fun onStrokeMove(x: Float, y: Float, pressure: Float, timestampMs: Long) {
            if (erasing) return
            pointBuffer.add(PointF(x, y)); pressureBuffer.add(pressure)
        }

        override fun onStrokeEnd(x: Float, y: Float, pressure: Float, timestampMs: Long) {
            if (erasing) return                          // discard daemon-mis-detected eraser stroke
            pointBuffer.add(PointF(x, y)); pressureBuffer.add(pressure)
            // The ONLY per-stroke work during writing: bake into the native page surface.
            inkSurfaceView.drawStroke(pointBuffer, if (feltMode) pressureBuffer else null, dashMode)
            // Stash the vector data natively; model update + save deferred to idle.
            appendStrokeToBatch(pointBuffer, pressureBuffer)
            mainHandler.removeCallbacks(flushRunnable)
            mainHandler.removeCallbacks(saveRunnable)
            mainHandler.postDelayed(flushRunnable, FLUSH_IDLE_MS)
            mainHandler.postDelayed(saveRunnable, SAVE_IDLE_MS)
        }
    }

    // One stroke as JSON: [[x,y,pressure],...]. The web layer keeps the pressure only for felt strokes.
    private fun appendStrokeToBatch(points: List<PointF>, pressures: List<Float>) {
        if (batchCount > 0) batchBuffer.append(',')
        batchBuffer.append('[')
        for (i in points.indices) {
            if (i > 0) batchBuffer.append(',')
            batchBuffer.append('[').append(points[i].x.toInt()).append(',').append(points[i].y.toInt())
            batchBuffer.append(',').append(String.format(java.util.Locale.US, "%.3f", pressures.getOrElse(i) { 0.5f })).append(']')
        }
        batchBuffer.append(']')
        batchCount++
    }

    /** Hand all strokes written since the last flush to the JS model in one call (off the write
     *  hot path). JS converts surface px → page coords, appends to the notebook model, saves. */
    private fun flushToJs() {
        if (batchCount == 0) return
        postToWeb("window.onStrokesBatch([$batchBuffer])")
        batchBuffer.setLength(0)
        batchCount = 0
    }

    fun attach(rect: Rect) {
        currentBounds = rect
        // Must run on main thread — BigmeInkController.attach() calls bindView()
        // which requires a view with a valid window token on the UI thread.
        mainHandler.post {
            val controller = createInkController()
            if (controller != null) {
                inkSurfaceView.attach(strokeCallback, rect, controller) { success ->
                    attached = success
                    postToWeb("window.onInkControllerReady($success)")
                    Log.i(TAG, "InkController ready: $success (${controller.javaClass.simpleName})")
                }
            } else {
                postToWeb("window.onInkControllerReady(false)")
            }
        }
    }

    fun detach() {
        mainHandler.removeCallbacks(flushRunnable)
        mainHandler.removeCallbacks(saveRunnable)
        // Only flush + save on the FIRST detach (back press triggers onPause + onDestroyView, each
        // calling detach) so we don't fire the save 2-3x.
        if (attached) {
            flushToJs()                          // push recent strokes to the model first
            postToWeb("window.saveNotebook()")   // then save (queued after onStrokesBatch)
        }
        inkSurfaceView.detach()
        attached = false
    }

    fun setStyle(widthPx: Float, colorHex: String) {
        strokeWidthPx = widthPx
        val colorInt = try {
            android.graphics.Color.parseColor(colorHex)
        } catch (e: Exception) {
            0xFF111111.toInt()
        }
        inkSurfaceView.setStrokeStyle(widthPx, colorInt)
    }

    fun setEnabled(enabled: Boolean) {
        inkSurfaceView.setEnabled(enabled)
    }

    /** Constrain the daemon's writing area: pen above [topPx] (surface px) — the toolbar strip —
     *  is ignored. The value is JS-provided (the website owns the writing region). */
    fun setWritingTop(topPx: Int) {
        inkSurfaceView.setWritingTop(topPx)
    }

    fun setWritingExclusion(left: Int, top: Int, right: Int, bottom: Int) {
        inkSurfaceView.setWritingExclusion(left, top, right, bottom)
    }


    /** Re-render the whole page on the native surface from the JS model. [json] = page object in
     *  SURFACE px: {"t":templateType,"sp":spacing,"mg":margin,"dpr":dpr,"b":[l,t,r,b],
     *  "s":[{"w":widthPx,"p":[[x,y],...]}, ...]}. Called on load/undo/erase/page/template change —
     *  never during active writing. */
    fun renderInk(json: String) {
        mainHandler.post {
            try {
                val o = org.json.JSONObject(json)
                val type = o.optString("t", "blank")
                val sp = o.optDouble("sp", 0.0).toFloat()
                val mg = o.optDouble("mg", 0.0).toFloat()
                val dpr = o.optDouble("dpr", 1.0).toFloat()
                val bA = o.getJSONArray("b")
                val bounds = Rect(bA.getInt(0), bA.getInt(1), bA.getInt(2), bA.getInt(3))
                val sArr = o.getJSONArray("s")
                val strokes = ArrayList<com.kalamos.notebook.view.StrokeRender>(sArr.length())
                for (i in 0 until sArr.length()) {
                    val so = sArr.getJSONObject(i)
                    val w = so.getDouble("w").toFloat()
                    val felt = so.optInt("vw", 0) == 1   // variable-width (felt) stroke → per-point pressure
                    val dashed = so.optInt("d", 0) == 1  // selection stroke → dashed line
                    val colorInt = try { android.graphics.Color.parseColor(so.optString("c", "#111111")) }
                        catch (e: Exception) { 0xFF111111.toInt() }
                    val pArr = so.getJSONArray("p")
                    val pts = ArrayList<PointF>(pArr.length())
                    val pressures = if (felt) FloatArray(pArr.length()) else null
                    for (j in 0 until pArr.length()) {
                        val pt = pArr.getJSONArray(j)
                        pts.add(PointF(pt.getDouble(0).toFloat(), pt.getDouble(1).toFloat()))
                        if (pressures != null) pressures[j] = if (pt.length() > 2) pt.getDouble(2).toFloat() else 0.5f
                    }
                    strokes.add(com.kalamos.notebook.view.StrokeRender(pts, w, pressures, colorInt, dashed))
                }
                Log.i("PERF", "DIAG renderInk t=${android.os.SystemClock.uptimeMillis()} strokes=${strokes.size}")
                val refreshRect = if (o.has("rr")) {
                    val rr = o.getJSONArray("rr")
                    Rect(rr.getInt(0), rr.getInt(1), rr.getInt(2), rr.getInt(3))
                } else null
                inkSurfaceView.renderPage(type, sp, mg, dpr, bounds, strokes, refreshRect)
            } catch (e: Exception) {
                Log.w(TAG, "renderInk parse failed: ${e.message}")
            }
        }
    }

    /** Capture the top [heightPx] (surface px) of the WebView — the toolbar strip — into a bitmap
     *  and bake it onto the native page so the web toolbar is visible while the ink surface stays
     *  the sole full-screen layer. Requires the WebView to be software-layered (HW draw() is blank). */
    fun snapshotToolbar(heightPx: Int) {
        mainHandler.post {
            val w = webView.width
            val h = heightPx.coerceAtMost(webView.height)
            if (w <= 0 || h <= 0) return@post
            // Flip to a software layer JUST for the capture (HW draw() is blank), let it render a
            // few frames, grab it, then flip back to hardware so writing stays fast. The WebView is
            // occluded by the ink surface, so this momentary software state is never visible.
            webView.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
            webView.postDelayed({
                try {
                    val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                    webView.draw(android.graphics.Canvas(bmp))
                    inkSurfaceView.setToolbarSnapshot(bmp)
                } catch (e: Exception) {
                    Log.w(TAG, "snapshotToolbar failed: ${e.message}")
                } finally {
                    webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
                }
            }, 80)
        }
    }

    /** Re-capture just a sub-region of the web toolbar (button cluster / page number) and bake it
     *  over that part of the surface — no whole-strip re-bake or refresh, so a toolbar change is fast
     *  and doesn't flash. left/top/right/bottom are surface px (the element's bounds). */
    fun snapshotToolbarRegion(left: Int, top: Int, right: Int, bottom: Int) {
        mainHandler.post {
            val l = left.coerceAtLeast(0)
            val t = top.coerceAtLeast(0)
            val w = (right - l).coerceAtMost(webView.width - l)
            val h = (bottom - t).coerceAtMost(webView.height - t)
            if (w <= 0 || h <= 0) return@post
            webView.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
            webView.postDelayed({
                try {
                    val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                    val canvas = android.graphics.Canvas(bmp)
                    canvas.translate(-l.toFloat(), -t.toFloat())   // map the [l,t] region of the WebView to [0,0]
                    webView.draw(canvas)
                    inkSurfaceView.setToolbarSnapshotRegion(bmp, l, t)
                } catch (e: Exception) {
                    Log.w(TAG, "snapshotToolbarRegion failed: ${e.message}")
                } finally {
                    webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
                }
            }, TOOLBAR_REGION_DELAY_MS)
        }
    }

    /** Capture the floating menu (bounds left..bottom, surface px) and bake it onto the surface as
     *  the persistent overlay. [refresh*] = the union of the menu's old + new bounds, re-rendered +
     *  refreshed so a collapse clears the area the menu used to cover. */
    fun snapshotMenu(left: Int, top: Int, right: Int, bottom: Int,
                     refreshLeft: Int, refreshTop: Int, refreshRight: Int, refreshBottom: Int) {
        mainHandler.post {
            val l = left.coerceAtLeast(0)
            val t = top.coerceAtLeast(0)
            val w = (right - l).coerceAtMost(webView.width - l)
            val h = (bottom - t).coerceAtMost(webView.height - t)
            if (w <= 0 || h <= 0) return@post
            webView.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
            webView.postDelayed({
                try {
                    val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
                    val canvas = android.graphics.Canvas(bmp)
                    canvas.translate(-l.toFloat(), -t.toFloat())
                    webView.draw(canvas)
                    inkSurfaceView.setMenuSnapshot(bmp, l, t, refreshLeft, refreshTop, refreshRight, refreshBottom)
                } catch (e: Exception) {
                    Log.w(TAG, "snapshotMenu failed: ${e.message}")
                } finally {
                    webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
                }
            }, TOOLBAR_REGION_DELAY_MS)
        }
    }

    /** Capture the current page off the native ink surface (the accurate, fully-rendered display —
     *  the web canvas is stale because writing only goes to the surface) into a scaled PNG and save
     *  it as the notebook's library thumbnail. Capture is on the main thread (touches the view);
     *  encode + disk write run off it. */
    fun saveThumbnail(notebookId: String, storage: com.kalamos.notebook.storage.StorageManager) {
        mainHandler.post {
            val thumb = inkSurfaceView.captureThumbnail(THUMB_WIDTH) ?: return@post
            Thread {
                try {
                    val baos = java.io.ByteArrayOutputStream()
                    thumb.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, baos)
                    storage.saveThumbnailBytes(notebookId, baos.toByteArray())
                } catch (e: Exception) {
                    Log.w(TAG, "saveThumbnail failed: ${e.message}")
                } finally {
                    thumb.recycle()
                }
            }.start()
        }
    }

    /** Flush the native stroke batch into the JS model, then signal JS so a model op (undo/erase)
     *  can run against an up-to-date model. */
    fun flushAndSignal() {
        mainHandler.removeCallbacks(flushRunnable)
        flushToJs()
        postToWeb("window.onNativeFlushed()")
    }

    fun isAttached(): Boolean = attached

    fun getCurrentBounds(): Rect = currentBounds

    private fun postToWeb(script: String) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            webView.evaluateJavascript(script, null)
        } else {
            webView.post { webView.evaluateJavascript(script, null) }
        }
    }

    private fun createInkController(): com.inksdk.ink.InkController? {
        return try {
            com.inksdk.ink.InkControllerFactory.create()
        } catch (e: Exception) {
            Log.w(TAG, "Ink SDK not available: ${e.message}")
            null
        }
    }

    companion object {
        private const val TAG = "InkManager"

        // Library thumbnail width in px (height follows the page aspect).
        private const val THUMB_WIDTH = 320

        // Settle delay before capturing a targeted toolbar region (a CSS class toggle paints fast;
        // shorter than the 80ms full-strip snapshot so button feedback is snappy).
        private const val TOOLBAR_REGION_DELAY_MS = 48L

        // Pen-up idle before the batched strokes are pushed to the JS model (cheap; non-visual).
        private const val FLUSH_IDLE_MS = 900L
        // Longer true-idle before the heavy disk save runs, so it never competes with writing.
        private const val SAVE_IDLE_MS = 2500L

        private const val JSON_X = """{"x":"""
        private const val JSON_Y = ""","y":"""

        // Web-animation sampling: ms between frames + frames between a clean GU16 de-ghost. The fast
        // refresh is ~1-8ms; the GU16 de-ghost flashes (full-region greyscale waveform), so keep it
        // rare — continuous motion mostly self-clears under the fast mode.
        private const val ANIM_FRAME_MS = 60L
        private const val ANIM_CYCLE = 60
    }
}
