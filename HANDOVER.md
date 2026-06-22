# Kalamos — Session Handover

## Build / device
- Device: **Bigme HiBreak** (Kaleido 3, USI 2.0 stylus, density 300 / dpr 1.875, 1264×1680).
  Daemon: `com.xrz.HandwrittenClient`. Pkg `com.kalamos.notebook`.
- Build: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:assembleDebug -q`
- Install: `adb -t <id> install -r app/build/outputs/apk/debug/app-debug.apk` (transport id changes on WiFi — re-detect with `adb devices -l`).
- Storage root: `/storage/emulated/0/Kalamos` (`library.json` + `notebooks/<id>/` + `thumbnails/`).
- Repos (account `josephm1`): `josephm1/kalamos-android` (origin), `josephm1/inksdk` (remote `josephm1`). Both pushed.

## Interactive-format feature (the recent work)
Design is in `docs/research/book-to-interactive-format.md` and memory `project_kalamos_interactive_format`.
Demo notebook **"History of Tuberculosis (interactive)"** = `nb-demo-tb`, pushed on-disk (10 pages, Wikipedia text + `assets/` images), registered in `library.json`. It's a real **notebook variant** (pages carry `blocks[]` in `meta.json`), not bundled in the APK.

**Reading mode** (`reader-controller.js`, `content-blocks.js`, `content.css`): interactive notebooks open in the **WebView-live reader** (ink surface hidden) — formatted text, images (via `Bridge.getNotebookAsset` data URLs), **finger-tap MCQs**, **animation play/pause**. No scroll; hardware page buttons paginate.

**Highlighting** (EPUB-style, web layer, no daemon): pen tip OR finger **drag** over text → word-snapped selection (own overlay, native menu disabled) → popup (Highlight / Sticky note). Stored as char ranges in `block.hl[]` (in meta). One highlight per word (overlap rejected). **Long-hold** a highlight → menu: Delete (1 tap), Add/Edit sticky note. Tiny SVG pencil marker at the highlight's bottom-right corner when it has a note.

**Sticky notes** (daemon): opening a note → `App.openSketch(nbId, page, {modal:true, note:{bi,hi}})` → daemon low-latency sketch in a centred Post-it box, content baked behind, **pen confined to the box** (`setWritingBounds` in inksdk). Each note's strokes are independent in `block.hl[hi].note.strokes`. Daemon on only while the note is open. Full-page toggle / shrink button.

Key native: `InkSurfaceView.contentBitmap` + `setContentSnapshot(bmp, refreshRect)`; `InkManager.snapshotContent[Partial]`, `skipNextWake`; bridge `snapshotContent(Partial)`, `setWritingBounds`, `getNotebookAsset`. inksdk: `setWritingBounds`, multi-zone `isExcluded`.

## ✅ Working
- Reading mode, MCQ tap, animation play/pause, images.
- Highlights (pen + finger), word-snap, one-per-word, delete (1 tap), add/edit-note menu.
- Sticky notes: daemon drawing, **independent per note**, persist (after the meta-cache-invalidation fix in `storage-web.js` — saves now invalidate `_metaCache`).
- Glyph marker positioning.

## ⛔ OUTSTANDING — partial refresh on note-open
Opening a note **still full-screen flashes**, though the note + content-behind render correctly. Done so far: skip the wake GU16 (`InkSurfaceView.skipNextWake`) + refresh only the Post-it card (`snapshotContentPartial` → `setContentSnapshot(bmp, refreshRect)`).
**The remaining cause:** when the ink surface goes GONE→VISIBLE (reader→note), `surfaceCreated` → `commitPage()` presents the (blanked) `pageBitmap`, and that present triggers a full-screen panel update.
**Next steps to try:** (a) don't `eraseColor(WHITE)` the pageBitmap on the reader→note detach so the present isn't a white full-screen change; or (b) suppress the `surfaceCreated` present until the content is baked; or (c) **resize the `InkSurfaceView` to just the note-box region** while a note is open (so only that region is a surface → only it refreshes, reader shows through elsewhere) — likely the cleanest.

## Other backlog
See `ROADMAP.md` + `docs/research/` (ui-ux, battery, book→interactive). Highlight-not-baked-behind during a note sketch is a minor follow-up.
