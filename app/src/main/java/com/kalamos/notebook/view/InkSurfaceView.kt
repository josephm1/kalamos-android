package com.kalamos.notebook.view

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PointF
import android.graphics.Rect
import android.util.AttributeSet
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.inksdk.ink.InkController
import com.inksdk.ink.InkDefaults
import com.inksdk.ink.StrokeCallback

/** One stroke to render (surface px). [pressures] non-null = FELT pen (per-point variable width via
 *  InkDefaults.pressureToWidth); null = constant-width ballpoint at [width]. [colorInt] = ink color.
 *  [dashed] = the "selection" pen (dashed line). */
class StrokeRender(val points: List<PointF>, val width: Float, val pressures: FloatArray?, val colorInt: Int, val dashed: Boolean)

/**
 * Single opaque ink surface, ported from inkit. The Bigme daemon draws the live in-progress
 * stroke onto this view's HANDWRITTEN overlay (low latency); finished strokes are baked into a
 * page bitmap that we present via lockCanvas on the SAME surface, then re-prime the daemon buffer
 * to match via syncOverlay(force=false) (no extra EPD refresh).
 *
 * One HWC layer is the whole point: when the lockCanvas commit and the daemon overlay were on two
 * separate surfaces they fought for the e-ink panel, causing per-stroke catch-up lag. On one
 * surface there's no fight, so we can commit every stroke immediately (no debounce).
 *
 * Opaque (white page) — it covers the WebView, which is kept only for the toolbar + vector model.
 */
class InkSurfaceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : SurfaceView(context, attrs, defStyleAttr), SurfaceHolder.Callback {

    private var inkController: InkController? = null
    private var pendingCallback: StrokeCallback? = null
    private var pendingRect: Rect? = null
    private var pendingOnReady: ((Boolean) -> Unit)? = null
    private var writingTopPx = 0
    private val exclRect = Rect()   // floating-menu pen-exclusion bounds, re-applied across attaches
    private var eraserMode = false
    private var surfaceReady = false
    private var attached = false

    private var pageBitmap: Bitmap? = null
    private var pageCanvas: Canvas? = null
    // Full-screen wake refresh happens only on the first present of a session (cold-open fix); later
    // renders refresh just the paper, so the toolbar never flashes on page-change / button taps.
    private var hasPresentedOnce = false
    // Snapshot of the web toolbar / floating menu, composited onto the page so the web UI is visible
    // while the ink surface stays the sole layer. [menuLeft/menuTop] = where it's drawn (0,0 for the
    // old top strip; the left-edge position for the collapsible floating menu).
    private var toolbarBitmap: Bitmap? = null
    private var menuLeft = 0
    private var menuTop = 0
    // Deferred stroke-painting pass for heavy pages (shell shows first, strokes fill in next frame).
    private var strokesRunnable: Runnable? = null
    // The strokes currently shown (surface px). renderPage resets it; drawStroke appends. A stroke
    // with pressures != null is a FELT stroke (per-point variable width); null = constant-width ballpoint.
    private val displayedStrokes = ArrayList<StrokeRender>()
    private var pressureMode = false   // felt pen active (re-applied to the controller on each attach)
    private var dashMode = false       // selection pen active (dashed) — re-applied on each attach
    private val dashEffect = android.graphics.DashPathEffect(InkDefaults.dashIntervals(), 0f)
    // Last template render params, so eraseAt can repaint the shell + remaining strokes natively.
    private var rTemplate = "blank"
    private var rSpacing = 0f
    private var rMargin = 0f
    private var rDpr = 1f
    private val rBounds = Rect()
    private val paint = Paint().apply {
        isAntiAlias = true
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.parseColor("#111111")
        strokeWidth = 3f
    }
    private val path = Path()

    init {
        // Base-layer surface (NOT ZOrderOnTop). On e-ink a z-ordered overlay surface gets a slow,
        // flashing refresh mode; the base surface gets the fast one — matching inkit. The WebView
        // above it is made transparent (page area) so this surface shows through.
        holder.setFormat(PixelFormat.OPAQUE)
        holder.addCallback(this)
    }

    fun attach(callback: StrokeCallback, rect: Rect, controller: InkController, onReady: (Boolean) -> Unit) {
        if (attached) detach()
        inkController = controller
        pendingCallback = callback
        pendingRect = rect
        pendingOnReady = onReady
        if (surfaceReady && width > 0 && height > 0) {
            val success = doAttach()
            onReady(success)
            pendingOnReady = null
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        surfaceReady = true
        ensureBitmap()
        commitPage()
        if (inkController != null && pendingCallback != null) {
            val success = doAttach()
            pendingOnReady?.invoke(success)
            pendingOnReady = null
        }
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
        ensureBitmap()
        commitPage()
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        surfaceReady = false
        inkController?.detach()
        attached = false
        hasPresentedOnce = false   // a fresh open should full-refresh again (incl. the toolbar)
    }

    private fun doAttach(): Boolean {
        val controller = inkController ?: return false
        val callback = pendingCallback ?: return false
        val limit = pendingRect ?: Rect(0, 0, width, height)
        val success = controller.attach(this, limit, callback)
        attached = success
        if (success) {
            controller.setWritingTop(writingTopPx)   // re-apply across (re)attaches
            controller.setWritingExclusion(exclRect.left, exclRect.top, exclRect.right, exclRect.bottom)
            controller.setEraserMode(eraserMode)
            controller.setPressureMode(pressureMode)
            controller.setDashMode(dashMode)
            // Full-screen GU16 wake refresh ONLY on the first present of a session (cold open /
            // surface recreate) — that's the blank-until-touch fix, and it's the one time the whole
            // panel (incl. the toolbar snapshot) should refresh. On a re-attach (page change) the
            // page render refreshes just the paper, so a full refresh here would flash the toolbar.
            if (!hasPresentedOnce) {
                pageBitmap?.let { controller.syncOverlay(it, null, true) }
                hasPresentedOnce = true
            }
        }
        return success
    }

    fun detach() {
        inkController?.detach()
        inkController = null
        pendingCallback = null
        pendingRect = null
        pendingOnReady = null
        attached = false
        // Blank the retained page so the NEXT notebook opens to white, not this one's strokes. The
        // surface keeps pageBitmap across hide/show, so without this, doAttach's first-present GU16
        // re-shows the previous notebook's page for a beat before the new one's render lands.
        pageBitmap?.eraseColor(Color.WHITE)
        toolbarBitmap = null       // also drop the baked menu/toolbar snapshot (re-baked on next open)
        hasPresentedOnce = false   // next open does its full wake-refresh, now of the blanked page
    }

    private fun ensureBitmap() {
        val w = width
        val h = height
        if (w <= 0 || h <= 0) return
        val b = pageBitmap
        if (b == null || b.width != w || b.height != h) {
            val fresh = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            pageCanvas = Canvas(fresh)
            pageCanvas?.drawColor(Color.WHITE)
            if (b != null) pageCanvas?.drawBitmap(b, 0f, 0f, null)
            pageBitmap = fresh
            b?.recycle()
        }
    }

    fun setStrokeStyle(widthPx: Float, colorInt: Int) {
        paint.strokeWidth = widthPx
        paint.color = colorInt
        inkController?.setStrokeStyle(widthPx, colorInt)
    }

    /** Surface-px y below which writing is allowed; pen above it (the toolbar) is ignored. */
    fun setWritingTop(topPx: Int) {
        writingTopPx = topPx
        inkController?.setWritingTop(topPx)
    }

    fun setWritingExclusion(left: Int, top: Int, right: Int, bottom: Int) {
        exclRect.set(left, top, right, bottom)
        inkController?.setWritingExclusion(left, top, right, bottom)
    }

    /** Eraser mode: while active the daemon paints no ink (the pen tip erases via the web layer). */
    fun setEraserMode(active: Boolean) {
        eraserMode = active
        inkController?.setEraserMode(active)
    }

    /** Felt pen: vary live stroke width by pen pressure. Stored so it survives re-attach. */
    fun setPressureMode(active: Boolean) {
        pressureMode = active
        inkController?.setPressureMode(active)
    }

    /** Selection pen: dashed live stroke. Stored so it survives re-attach. */
    fun setDashMode(active: Boolean) {
        dashMode = active
        inkController?.setDashMode(active)
    }

    /** Bake one captured animation frame ([bmp], the web region's pixels) onto the surface at
     *  [left],[top] and refresh just that region — FAST (HANDWRITE) for speed, or a clean GU16 every
     *  so often to clear the ghosting the fast mode accumulates. Generic: [bmp] is whatever the web
     *  layer rendered (SVG/CSS/canvas), so any animation works. */
    fun animFrame(bmp: Bitmap, left: Int, top: Int, clean: Boolean) {
        val c = pageCanvas ?: return
        c.drawBitmap(bmp, left.toFloat(), top.toFloat(), null)
        val r = Rect(left, top, left + bmp.width, top + bmp.height)
        if (clean) pageBitmap?.let { inkController?.syncOverlay(it, r, true) }
        else pageBitmap?.let { inkController?.refreshRegionFast(it, r) }
    }

    /** Stop an animation: re-render the page over [region] (clearing the last animation frame). */
    fun animClear(region: Rect) {
        renderFromState(shellFirst = false, refreshRect = region)
    }

    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        inkController?.setEnabled(enabled)
    }

    /** A finished stroke (surface px): bake into the page, then present + re-prime the daemon
     *  buffer for ONLY the stroke's bounding box, so the EPD partial-refresh is small. */
    fun drawStroke(points: List<PointF>, pressures: List<Float>? = null, dashed: Boolean = false) {
        ensureBitmap()
        val c = pageCanvas ?: return
        paint.pathEffect = if (dashed) dashEffect else null   // selection pen: dashed; restored to null otherwise
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
        for (p in points) {
            if (p.x < minX) minX = p.x
            if (p.y < minY) minY = p.y
            if (p.x > maxX) maxX = p.x
            if (p.y > maxY) maxY = p.y
        }
        var maxW = paint.strokeWidth
        if (pressures != null) {
            val p = Paint(paint)
            maxW = drawStrokeVariable(c, points, paint.strokeWidth, pressures.toFloatArray(), p)
        } else {
            drawStrokeInto(c, points, paint)
        }
        val pad = (maxW + 4f).toInt()
        val dirty = Rect(
            (minX.toInt() - pad).coerceAtLeast(0),
            (minY.toInt() - pad).coerceAtLeast(0),
            (maxX.toInt() + pad).coerceAtMost(width),
            (maxY.toInt() + pad).coerceAtMost(height)
        )
        commitPage(dirty)
        // Full daemon-buffer reset to the clean page (inkit's way) so A2 ghosting can't build up.
        // force=false → no extra EPD refresh, just a buffer blit; the visible refresh is the small
        // partial commitPage above.
        pageBitmap?.let { inkController?.syncOverlay(it, null, false) }
    }

    /** Re-render the whole page from the model (load / undo / erase / template / page change):
     *  white + template + all strokes. All coords in surface px. */
    fun renderPage(
        templateType: String, spacing: Float, margin: Float, dpr: Float, bounds: Rect,
        strokes: List<StrokeRender>, refreshRect: Rect? = null
    ) {
        rTemplate = templateType; rSpacing = spacing; rMargin = margin; rDpr = dpr; rBounds.set(bounds)
        displayedStrokes.clear()
        displayedStrokes.addAll(strokes)
        // A refresh rect (erase) → immediate, partial GU16 refresh of just that region (no shell-first).
        renderFromState(shellFirst = refreshRect == null && strokes.size > SHELL_FIRST_THRESHOLD, refreshRect)
    }

    /** Repaint the page from the retained state. [refreshRect] (surface px) limits the e-ink
     *  force-refresh to that region (erase); null = full-screen refresh. */
    private fun renderFromState(shellFirst: Boolean, refreshRect: Rect? = null) {
        ensureBitmap()
        val c = pageCanvas ?: return
        strokesRunnable?.let { removeCallbacks(it); strokesRunnable = null }
        c.drawColor(Color.WHITE)
        drawTemplate(c, rTemplate, rSpacing, rMargin, rDpr, rBounds)

        if (!shellFirst) {
            drawDisplayedStrokes(c)
            toolbarBitmap?.let { c.drawBitmap(it, menuLeft.toFloat(), menuTop.toFloat(), null) }
            commitPage(refreshRect)
            // force=true (GU16) so a re-render that REMOVED strokes (erase/undo) actually clears the
            // old ink — a plain commit is ink-biased and leaves erased strokes ghosted on e-ink.
            // Limit the EPD refresh to the erase rect, else the PAPER (not the whole screen) — never
            // the toolbar strip, so page-change / undo never flash the toolbar.
            pageBitmap?.let { inkController?.syncOverlay(it, refreshRect ?: paperRegion(), true) }
            return
        }

        // Heavy page: show the SHELL (template + toolbar) immediately, strokes next frame.
        toolbarBitmap?.let { c.drawBitmap(it, menuLeft.toFloat(), menuTop.toFloat(), null) }
        commitPage()
        pageBitmap?.let { inkController?.syncOverlay(it, paperRegion(), false) }
        val r = Runnable {
            val cc = pageCanvas
            if (cc != null) {
                drawDisplayedStrokes(cc)
                commitPage()
                pageBitmap?.let { inkController?.syncOverlay(it, paperRegion(), true) }
            }
            strokesRunnable = null
        }
        strokesRunnable = r
        post(r)
    }

    private fun drawDisplayedStrokes(c: Canvas) {
        val p = Paint(paint)
        for (s in displayedStrokes) {
            p.color = s.colorInt                                  // per-stroke ink color (the palette)
            p.pathEffect = if (s.dashed) dashEffect else null     // selection pen → dashed
            if (s.pressures != null) {
                drawStrokeVariable(c, s.points, s.width, s.pressures, p)   // felt: variable width
            } else {
                p.strokeWidth = s.width
                drawStrokeInto(c, s.points, p)
            }
        }
    }

    /** Draw a felt stroke as per-segment lines whose width tracks pen pressure (round caps/joins blend
     *  the segments). Returns the max width used (for the dirty-rect pad). */
    private fun drawStrokeVariable(c: Canvas, points: List<PointF>, base: Float, pressures: FloatArray, p: Paint): Float {
        if (points.isEmpty()) return base
        var maxW = 0f
        if (points.size == 1) {
            val w = InkDefaults.pressureToWidth(base, pressures.getOrElse(0) { 0.5f })
            val dot = Paint(p).apply { style = Paint.Style.FILL }
            c.drawCircle(points[0].x, points[0].y, w / 2f, dot)
            return w
        }
        for (i in 1 until points.size) {
            // average the endpoints' pressure for the segment
            val pr = (pressures.getOrElse(i) { 0.5f } + pressures.getOrElse(i - 1) { 0.5f }) / 2f
            val w = InkDefaults.pressureToWidth(base, pr)
            if (w > maxW) maxW = w
            p.strokeWidth = w
            c.drawLine(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, p)
        }
        return maxW
    }

    private fun paperRegion(): Rect? =
        if (rBounds.width() > 0 && rBounds.height() > 0) Rect(rBounds) else null

    /** Bake the FULL web toolbar strip onto the top of the page + GU16-refresh that strip. Called
     *  once per open (the toolbar is otherwise static; targeted region updates handle changes). */
    fun setToolbarSnapshot(bmp: Bitmap) {
        ensureBitmap()
        val c = pageCanvas ?: return
        val old = toolbarBitmap
        toolbarBitmap = bmp
        c.drawBitmap(bmp, 0f, 0f, null)
        val dirty = Rect(0, 0, minOf(bmp.width, width), minOf(bmp.height, height))
        commitPage(dirty)
        pageBitmap?.let { inkController?.syncOverlay(it, dirty, true) }
        if (old != null && old != bmp) old.recycle()
    }

    /** Update just a sub-region of the baked toolbar (a button cluster / the page number) and
     *  EPD-refresh ONLY that rect — no whole-strip re-bake, no flash. Keeps the cached toolbarBitmap
     *  in step so a later full page render doesn't revert the change. */
    fun setToolbarSnapshotRegion(bmp: Bitmap, x: Int, y: Int) {
        ensureBitmap()
        val c = pageCanvas ?: return
        // The cached menu bitmap's origin is (menuLeft,menuTop) on the surface, so write the region
        // into it at the menu-relative offset; the page canvas + refresh use absolute surface coords.
        toolbarBitmap?.let { tb ->
            try { Canvas(tb).drawBitmap(bmp, (x - menuLeft).toFloat(), (y - menuTop).toFloat(), null) } catch (e: Exception) {}
        }
        c.drawBitmap(bmp, x.toFloat(), y.toFloat(), null)
        val rect = Rect(x, y, x + bmp.width, y + bmp.height)
        commitPage(rect)
        pageBitmap?.let { inkController?.syncOverlay(it, rect, true) }
        bmp.recycle()
    }

    /** The floating collapsible menu: [bmp] is its current snapshot, drawn at ([left],[top]); it
     *  becomes the persistent overlay (redrawn over the page on every render). [refreshRect] (surface
     *  px) is the area to re-render + EPD-refresh — the UNION of the menu's old and new bounds so that
     *  collapsing a wide/tall menu clears the area it used to cover back to the page. */
    fun setMenuSnapshot(bmp: Bitmap, left: Int, top: Int, refreshLeft: Int, refreshTop: Int, refreshRight: Int, refreshBottom: Int) {
        ensureBitmap()
        val c = pageCanvas ?: return
        val old = toolbarBitmap
        toolbarBitmap = bmp
        menuLeft = left
        menuTop = top
        // Re-render the page (clears the old menu footprint to paper) then draw the new menu on top.
        c.drawColor(Color.WHITE)
        drawTemplate(c, rTemplate, rSpacing, rMargin, rDpr, rBounds)
        drawDisplayedStrokes(c)
        c.drawBitmap(bmp, left.toFloat(), top.toFloat(), null)
        val refresh = Rect(refreshLeft, refreshTop, refreshRight, refreshBottom)
        commitPage(refresh)
        pageBitmap?.let { inkController?.syncOverlay(it, refresh, true) }
        if (old != null && old != bmp) old.recycle()
    }

    private fun drawTemplate(c: Canvas, type: String, spacing: Float, margin: Float, dpr: Float, bounds: Rect) {
        if (spacing <= 0f) return
        val w = bounds.width().toFloat()
        val h = bounds.height().toFloat()
        val left = bounds.left.toFloat()
        val top = bounds.top.toFloat()
        val marginX = minOf(margin, w * 0.15f)
        // Mid-grey, ~1px+ — e-ink can't show the near-white #d4d4d4 the web canvas used.
        val line = Paint().apply {
            color = Color.parseColor("#909090"); style = Paint.Style.STROKE; strokeWidth = 1.0f * dpr; isAntiAlias = true
        }
        val dot = Paint().apply { color = Color.parseColor("#808080"); style = Paint.Style.FILL; isAntiAlias = true }
        when (type) {
            "ruled" -> {
                var y = spacing; while (y < h) { c.drawLine(left, top + y, left + w, top + y, line); y += spacing }
                val mp = Paint(line).apply { color = Color.parseColor("#b07070") }
                c.drawLine(left + marginX, top, left + marginX, top + h, mp)
            }
            "grid" -> {
                var x = marginX; while (x < w) { c.drawLine(left + x, top, left + x, top + h, line); x += spacing }
                var y = spacing; while (y < h) { c.drawLine(left, top + y, left + w, top + y, line); y += spacing }
            }
            "dotted" -> {
                var x = marginX
                while (x < w) {
                    var y = spacing
                    while (y < h) { c.drawCircle(left + x, top + y, 1.5f * dpr, dot); y += spacing }
                    x += spacing
                }
            }
        }
    }

    fun clearPage() {
        pageBitmap?.eraseColor(Color.WHITE)
        commitPage()
        pageBitmap?.let { inkController?.syncOverlay(it, null, false) }
    }

    private fun drawStrokeInto(c: Canvas, points: List<PointF>, p: Paint) {
        if (points.isEmpty()) return
        if (points.size == 1) {
            val pt = points[0]
            val dot = Paint(p).apply { style = Paint.Style.FILL }
            c.drawCircle(pt.x, pt.y, p.strokeWidth / 2f, dot)
            return
        }
        path.reset()
        path.moveTo(points[0].x, points[0].y)
        for (i in 1 until points.size) path.lineTo(points[i].x, points[i].y)
        c.drawPath(path, p)
    }

    private fun commitPage(dirty: Rect? = null) {
        if (!surfaceReady) return
        val bmp = pageBitmap ?: return
        val controller = inkController
        val needSuspend = controller != null && controller.ownsSurface && controller.isActive
        if (needSuspend) controller?.setEnabled(false)
        try {
            val canvas = (if (dirty != null) holder.lockCanvas(dirty) else holder.lockCanvas()) ?: return
            try {
                canvas.drawBitmap(bmp, 0f, 0f, null)
            } finally {
                holder.unlockCanvasAndPost(canvas)
            }
        } catch (t: Throwable) {
            // surface being torn down — ignore
        } finally {
            if (needSuspend) controller?.setEnabled(true)
        }
    }

    /** A library thumbnail of the current page: the paper region of [pageBitmap] (toolbar excluded)
     *  cropped to a fixed 3:4 aspect and scaled to a constant [targetWidth]x(4/3) so EVERY thumbnail
     *  is identical dimensions (uniform in the grid, no object-fit cropping). Null if nothing has
     *  rendered yet. Caller recycles the result. */
    fun captureThumbnail(targetWidth: Int): Bitmap? {
        val src = pageBitmap ?: return null
        val pw = rBounds.width()
        val ph = rBounds.height()
        if (pw <= 0 || ph <= 0) return null
        // Crop the paper region to 3:4 (w:h), centered, so scaling never distorts.
        val aspect = 3f / 4f
        var cw = pw
        var ch = ph
        if (pw.toFloat() / ph > aspect) cw = (ph * aspect).toInt() else ch = (pw / aspect).toInt()
        val left = (rBounds.left + (pw - cw) / 2).coerceIn(0, src.width)
        val top = (rBounds.top + (ph - ch) / 2).coerceIn(0, src.height)
        cw = cw.coerceAtMost(src.width - left)
        ch = ch.coerceAtMost(src.height - top)
        if (cw <= 0 || ch <= 0) return null
        val tw = targetWidth
        val th = targetWidth * 4 / 3
        val thumb = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888)
        Canvas(thumb).drawBitmap(src, Rect(left, top, left + cw, top + ch), Rect(0, 0, tw, th), null)
        return thumb
    }

    fun isAttached(): Boolean = attached

    companion object {
        // Above this many strokes a page renders shell-first (template now, strokes next frame).
        private const val SHELL_FIRST_THRESHOLD = 40
    }
}
