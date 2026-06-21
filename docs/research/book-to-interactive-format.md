# Book → Interactive Format Conversion — Kalamos

**Status:** research deliverable (ROADMAP.md → "Book → interactive format conversion").
Flagged in the roadmap as a **cornerstone feature — research first**.
**Goal:** find the best way to convert books into highly *editable and interactive* formats
supporting animations, multiple-choice questions (MCQs), writing, drawing, and AI
integration (on-device + cloud/LAN). The roadmap specifically asks to investigate
**MDX / "Markdown X"** as the authoring/content layer.
**Device context:** Bigme HiBreak — Kaleido 3 colour e-ink, USI 2.0 stylus, WebView UI.

---

## 1. The core architectural constraint (read this first)

Kalamos today renders content in **two stacked layers** in the editor:

1. A **native opaque `InkSurfaceView`** on top, where the Bigme daemon draws live ink with
   minimal latency. It is the *only* visible layer while writing and it **covers the
   WebView** (`view/InkSurfaceView.kt:24-35`, `bridge/InkManager.enterEditor` makes the
   WebView transparent so the surface shows through, `:51-56`).
2. The **WebView underneath**, which today holds only the toolbar/menu and the vector model;
   its toolbar is *screenshotted and baked* onto the ink surface
   (`InkManager.snapshotToolbar`). Page "content" today = **handwritten strokes only**
   (`models.js` page = `{pageId, template, strokes[]}`; native draws the paper template —
   blank/ruled/grid/dotted — in `InkSurfaceView.drawTemplate`, `:421-452`).

So there is currently **no rich text/content layer at all** — a page is a template + ink.
Introducing book content (formatted text, images, MCQs, embedded interactives) means
introducing a **third concept: rendered document content that must coexist with the
daemon-owned ink overlay.** This is the central design problem, and MDX is only the
*authoring* half of it. The harder half is **compositing rich web content with the opaque,
low-latency ink surface on e-ink.**

The existing **animation pipeline is the proof-of-concept for the answer**: a web-defined
SVG/CSS animation is rendered in the WebView, and native **samples that region and
fast-refreshes it onto the ink surface** every frame (`InkManager.startWebAnim` /
`captureAnimFrame`, `:92-138`; `animFrame` in `InkSurfaceView`, `:224-230`). That same
"render rich content in the WebView → composite a region onto the ink surface" mechanism is
exactly what interactive book content needs. **The feature is an extension of the animation
path, not a greenfield system.**

---

## 2. What is MDX, and does it fit?

**MDX** is Markdown with embedded JSX components: you write prose in Markdown and drop in
`<Mcq .../>`, `<Drawing .../>`, `<Animation .../>`, `<AskAI .../>` components inline. It's a
compile step (MDX → JS/React component) plus a runtime (React or a lighter renderer).

**Why it's attractive here:**
- Content authors write mostly prose; interactivity is just components. That maps perfectly
  to "animations, MCQs, writing, drawing, AI" — each is one component type.
- It's a clean **content layer** separable from native — directly serving the roadmap's
  "decouple the web layer" goal (authors/other AIs iterate on `.mdx` + components without
  touching Kotlin).
- Huge ecosystem; components are reusable and composable.

**Why it's not a clean fit as-is, on this device:**
- **MDX's natural runtime is React.** Pulling React into a WebView that is currently
  vanilla JS (`app.html` loads plain scripts, no framework, `:128-135`) is a big dependency
  and bundle-size jump for a device where simplicity = battery + reliability.
- **MDX assumes a build toolchain** (bundler). The app today ships static assets with no
  build step. Adopting MDX means adopting a web build pipeline (acceptable, and arguably
  desirable, but a real decision).
- **e-ink + React reconciliation** can cause extra DOM churn → extra refreshes. The app's
  whole UX philosophy is "discrete, static, partial refreshes" (see `ui-ux-review.md`).
  A React render-on-every-state-change model fights that unless carefully gated.
- **The ink overlay problem remains.** MDX renders into the WebView, but the WebView is
  *underneath the opaque ink surface* in the editor. Pure-MDX content would be invisible
  unless either (a) the editor lets the WebView show through (no ink overlay in "reading"
  mode) or (b) content regions are sampled+composited onto the surface like animations.

**Verdict on MDX:** the **authoring model is the right idea** (Markdown prose + typed
interactive components), but **full MDX-on-React in the WebView is likely too heavy** for
the e-ink/vanilla-JS reality. The recommended path keeps MDX's *authoring ergonomics* while
avoiding its *runtime weight* — see §4.

---

## 3. The interactive component types, mapped to the current app

| Component | What it needs | How it maps today |
|-----------|---------------|-------------------|
| **Prose / formatted text** | Rich text render | New — needs a content render layer in the WebView |
| **Writing** (fill-in handwriting) | Capture ink in a sub-region of a page | The daemon already writes anywhere; needs region-scoped strokes tied to a content block (extend the page model) |
| **Drawing** | Free ink in a bounded box | Same ink pipeline, bounded by `setWritingExclusion`/region (`InkManager:250`) |
| **MCQ** | Tap targets + state + (AI/auto) grading | Web DOM + the existing bridge; tap handling already works in library |
| **Animation** | Web-defined motion sampled to the panel | **Already exists** (`startWebAnim`/`captureAnimFrame`) — generalise from the bike demo |
| **AI block** (local + cloud/LAN) | Network or on-device inference + a result region | New; route through one network/AI gate (see `battery-optimization.md` §4.2/4.5) |

The decisive observation: **two of the six (writing, drawing) are already the app's core
competency, and a third (animation) already has a working pipeline.** The new work is the
*content/text layer*, *MCQ state*, and *AI integration* — plus the **document format** that
ties them together.

---

## 4. Recommended direction

### 4.1 Authoring format: "MDX-style," not necessarily MDX-the-toolchain
Adopt MDX's **mental model** — Markdown prose with inline typed interactive components — but
implement it as a **declarative content document** the app can render without React:

- A page becomes `{ pageId, template, blocks[], strokes[] }`, where `blocks[]` are typed
  content blocks (`text`, `image`, `mcq`, `drawing`, `animation`, `ai`) layered *under* the
  ink, and `strokes[]` remain the user's handwriting *over* it. This is a backward-compatible
  superset of today's model (`models.js`): existing notebooks just have no `blocks`.
- Authors write `.mdx`/Markdown; a **build/import step converts it to that block JSON**
  (this is the "book → interactive format conversion" itself). The conversion can run
  off-device (a desktop/CI tool), keeping the device runtime lean — which also fits the
  "decouple the web layer" goal (the web/import tooling is a separate workstream).
- If a richer authoring loop is wanted later, *then* evaluate a real MDX→React build; but
  the **storage/runtime format should be the simple block JSON**, not JSX, so the device
  never parses/executes arbitrary components.

### 4.2 Rendering: extend the animation/compositing model, add a "reading" layer mode
- For **static rich content** (text/images/MCQ chrome): render it in the WebView and, in a
  **reading/interactive mode**, let the WebView be the visible layer (ink surface hidden or
  transparent) — like the library view already does (`InkManager.enterLibrary`,
  `enterEditor`, `:51-65`). Writing/drawing blocks switch the ink surface back on, scoped to
  the block's region via the existing writing-exclusion/bounds machinery.
- For **animated content**: reuse `startWebAnim`/`captureAnimFrame` verbatim — it's already
  generic ("swap the element + driver for any animation," `editor-controller.js:897-899`).
- Keep the **e-ink discipline**: content blocks should render once and refresh their own
  rect on interaction (the toolbar-region partial-refresh pattern,
  `setToolbarSnapshotRegion`, is the template), never full-screen on every state change.

### 4.3 Storage
Per-page JSON already isolates each page (`StorageManager` `pages/<pageId>.json` +
`meta.json`, `:69-100`), and the loader splices raw stroke arrays without parsing
(`reconstructRaw`, `:176-202`). Block content fits the same scheme: store `blocks` in the
page file (or a sibling `blocks/<pageId>.json` if they get large, to preserve the
"don't parse strokes natively" cold-open speed). Atomic writes already protect against
SD-card pulls (`atomicWrite`, `:117-132`) — reuse them.

### 4.4 AI integration
Route both on-device and cloud/LAN AI through **one gate** (see `battery-optimization.md`):
explicit user action, foreground, debounced/coalesced network, visible working state. An
`<ai>` block declares its prompt/inputs; the gate decides local vs cloud based on
availability and settings. Do **not** let content auto-trigger AI calls (battery + privacy).

### 4.5 The web/native boundary (decouple-the-web-layer tie-in)
This feature is the strongest reason to do the roadmap's "decouple the web layer" item
*first or alongside*: define a clean contract where the web layer owns content
rendering/blocks and the native layer owns ink + compositing + storage + device I/O, talking
only through the existing bridge (`bridge/AndroidBridge.kt`, `BridgeRouter.kt`,
`js/bridge.js`). Done well, book/interactive content becomes a **web-only workstream** other
contributors (or AIs) can iterate on without touching Kotlin.

---

## 5. Phased approach

1. **Format spec + model superset.** Define the block schema; extend `models.js` page model
   (`blocks[]`) backward-compatibly; no UI yet. (Foundational, low risk.)
2. **Reading mode + static blocks.** Render `text`/`image`/`mcq` blocks in the WebView with
   a mode that shows the WebView (ink hidden), reusing the library show/hide path. Wire MCQ
   tap + state.
3. **Ink-on-content.** Re-enable the ink surface scoped to `drawing`/`writing` block regions
   (writing-exclusion/bounds) so handwriting composites over content.
4. **Animation blocks.** Generalise the existing bike animation into an `animation` block
   type (the pipeline already exists).
5. **AI blocks.** Add the AI gate (local + cloud/LAN); `<ai>` block type.
6. **Import/conversion tool (off-device).** The actual "book → interactive format" converter:
   Markdown/MDX-ish source → block JSON, runnable in CI/desktop.

Each phase is independently shippable and backward-compatible with plain handwritten
notebooks.

---

## 6. Summary

- **Adopt MDX's authoring *model* (prose + typed interactive components); do not adopt
  full MDX-on-React as the device runtime.** Compile to a simple, declarative **block JSON**
  format the lean WebView can render without a framework.
- **The hard part is compositing rich content with the opaque, daemon-owned ink surface on
  e-ink — and the existing animation pipeline already shows how (render in WebView → sample
  region → composite onto the surface), plus a reading mode that shows the WebView directly.**
- Writing/drawing/animation already exist or are 80% there; the genuinely new work is the
  **content/text layer, MCQ state, AI gating, and an off-device conversion tool.**
- This feature should be built **on top of a cleaned web/native boundary** ("decouple the
  web layer"), turning interactive book content into a web-only workstream.
- **Execution-ready detail** for the three load-bearing pieces is in the appendices:
  §7 the concrete block-JSON schema (with a worked example page), §8 a prototype-level wiring
  of Phase 2 (reading mode + static blocks) into the existing layer toggling, §9 an
  evaluation of the off-device conversion tool, §10 the reflow problem (adjustable text
  size / font) and its consequences for the fixed-rect layout, and §11 the lazy/windowed
  loading & memory model (eviction + image downsampling) for low-powered hardware.

---

## 7. The block-JSON schema (concrete)

This is the on-device **runtime/storage** format — the compile *target* of any MDX-style
authoring (§9), deliberately not JSX. The device only ever parses this declarative JSON; it
never executes authored components.

### 7.1 Page = a backward-compatible superset of today's model
Today a page is `{ pageId, template, strokes[] }` (`models.js:17-23`). Add one optional field:

```
page = { pageId, template, blocks[], strokes[] }
```

- `blocks[]` is the authored content layer, rendered **under** the user's ink.
- `strokes[]` stays exactly as-is — the user's handwriting **over** everything.
- **Backward-compatible both ways:** an existing notebook simply has no `blocks` (and
  `validateNotebook`, `models.js:56-68`, already tolerates missing fields — add
  `if (!p.blocks) p.blocks = []` there). Drop `blocks` from any example below and you have a
  byte-for-byte current page.

### 7.2 Coordinate space (the one rule everything obeys)
Every block `rect` is in **CSS px relative to the paper top-left** — the *same* space strokes
are stored in. Strokes are saved as `x = surfaceX/dpr - inkCssBounds.left`
(`editor-controller.js:180`), and re-projected to the native surface as
`(x + inkCssBounds.left) * dpr` (`syncNativePage:282`). Because blocks share that origin, a
block rect converts to the surface-px rectangles that `startWebAnim` (`:931`),
`setWritingExclusion` (`:341`), and the snapshot calls all expect via the **one transform that
already exists** — no new coordinate system is introduced.

### 7.3 Common block envelope
```json
{ "id": "b-xxxx", "type": "text|image|mcq|drawing|animation|ai",
  "rect": { "x": 0, "y": 0, "w": 0, "h": 0 },
  "z": 0 }
```
- `id` — stable id (`b-` + uid, same generator as strokes/pages, `models.js:1`).
- `type` — discriminator selecting the payload below.
- `rect` — CSS px from paper top-left (§7.2). `w`/`h` let the renderer lay out without measuring.
- `z` — optional stacking order among blocks (all blocks are still beneath ink).

### 7.4 Per-type payload (field by field)

**`text`** — formatted prose.
```json
{ "type":"text", "format":"md", "md":"## Photosynthesis\nPlants convert *light* into sugar.",
  "style": { "align":"left", "size":"body" } }
```
- `format` — `"md"` (inline Markdown; `"plain"` allowed). `md` — the source string.
- `style` — optional presentational hints (`size: title|body|caption`, `align`). No arbitrary CSS.

**`image`** — a raster/vector asset.
```json
{ "type":"image", "src":"assets/leaf.png", "fit":"contain", "alt":"A leaf cross-section" }
```
- `src` — path **relative to the notebook dir** (`getNotebookPath`, `StorageManager.kt:315`), so
  the importer can drop assets beside `pages/`. `fit` — `contain|cover|fill`. `alt` — accessibility.

**`mcq`** — multiple-choice question (state is mutable + persisted).
```json
{ "type":"mcq", "prompt":"Which organelle performs photosynthesis?",
  "choices":[ {"id":"a","md":"Mitochondrion"}, {"id":"b","md":"Chloroplast"},
              {"id":"c","md":"Ribosome"} ],
  "answer":["b"], "multi":false, "explain":"Chloroplasts contain chlorophyll.",
  "state": { "selected":[], "revealed":false } }
```
- `prompt` / `choices[]` (each `{id, md}`) — the question + options.
- `answer` — array of correct choice ids (array form covers both single- and multi-select).
- `multi` — allow multiple selections. `explain` — shown after reveal (optional).
- `state` — the **only mutable part**: `selected[]` (chosen ids) + `revealed` (graded yet?).
  Saved in the page file alongside strokes, so progress survives close/reopen.

**`drawing`** — a bounded free-ink region.
```json
{ "type":"drawing", "rect":{"x":40,"y":520,"w":680,"h":300}, "label":"Sketch the reaction" }
```
- No payload beyond `rect` + optional `label`: the *content* is the user's strokes that fall
  inside `rect`. `rect` maps directly to `setWritingExclusion` (`InkManager.kt:250`) — invert the
  exclusion so the daemon writes **only** inside the box (drawing mode), or excludes it (so the
  box is protected) depending on the active tool. Strokes still live in the page's `strokes[]`;
  the region is the spatial association, so no stroke-model change is needed.

**`animation`** — a web-defined motion sampled onto the panel.
```json
{ "type":"animation", "rect":{"x":120,"y":160,"w":280,"h":220},
  "kind":"bike", "loop":true, "autostart":false }
```
- `kind` — a built-in animation id today (`"bike"` is the shipped one, `editor-controller.js`
  `Bike`); later a small declarative spec. `loop`/`autostart` — playback policy.
- Runtime = the **existing** `startWebAnim`/`captureAnimFrame` path verbatim — `rect`→surface px
  is the region argument; nothing new on the native side.

**`ai`** — an AI-backed block (local or cloud/LAN), gated.
```json
{ "type":"ai", "prompt":"Summarise the student's answer above in one sentence.",
  "inputs":["b-mcq1","strokes"], "route":"auto",
  "state": { "result":"", "ranAt":null } }
```
- `prompt` — the instruction. `inputs[]` — refs to other block ids and/or `"strokes"`
  (the page's handwriting, optionally OCR'd) that feed the prompt.
- `route` — `auto|local|cloud`; the **single AI gate** (`battery-optimization.md` §4.2/4.5)
  decides and enforces foreground + explicit-action + debounced network.
- `state.result` / `ranAt` — cached output so it isn't re-run (battery + privacy). Never
  auto-triggers.

### 7.5 Worked example — one page mixing all four content kinds + handwriting
```json
{
  "pageId": "p-7f3a-9c12-04bd",
  "template": { "type": "ruled", "spacing": 32, "margin": 72 },
  "blocks": [
    { "id": "b-title", "type": "text", "rect": { "x": 72, "y": 40, "w": 900, "h": 120 },
      "format": "md", "md": "# Chapter 3 — Photosynthesis\nHow plants make food from light." },

    { "id": "b-diagram", "type": "animation", "rect": { "x": 360, "y": 180, "w": 280, "h": 220 },
      "kind": "bike", "loop": true, "autostart": false },

    { "id": "b-q1", "type": "mcq", "rect": { "x": 72, "y": 430, "w": 860, "h": 240 },
      "prompt": "Where does photosynthesis occur?",
      "choices": [ { "id": "a", "md": "Chloroplast" }, { "id": "b", "md": "Nucleus" },
                   { "id": "c", "md": "Cell wall" } ],
      "answer": [ "a" ], "multi": false,
      "explain": "Chloroplasts hold the chlorophyll that captures light.",
      "state": { "selected": [], "revealed": false } },

    { "id": "b-sketch", "type": "drawing", "rect": { "x": 72, "y": 700, "w": 860, "h": 300 },
      "label": "Draw and label a chloroplast" }
  ],
  "strokes": [
    { "id": "s-2a1b-77c0", "tool": "pen", "color": "#111111", "width": 3,
      "points": [ { "x": 120, "y": 760 }, { "x": 142, "y": 775 }, { "x": 168, "y": 769 } ] }
  ]
}
```
The single `strokes[]` entry is a handwritten line the user drew inside the `b-sketch` region —
identical to today's stroke model (`models.js:46-54`), living over the authored blocks.

### 7.6 Storage mapping (reuse, don't reinvent)
- Blocks ride in the **page file** — `pages/<pageId>.json` — written by `savePageRaw`
  (`StorageManager.kt:205`). Today that file is a bare strokes array; for content pages it becomes
  `{ "blocks":[...], "strokes":[...] }`. `reconstructRaw` (`:176-202`) splices the page file in
  raw, so it needs a small tweak: detect array (legacy → strokes-only) vs object (blocks+strokes)
  and emit accordingly — still **no native parse of stroke data**, preserving cold-open speed.
- If blocks ever get large, split to a sibling `blocks/<pageId>.json` and keep `pages/` as pure
  strokes (zero change to the hot stroke path). Add a per-page `hasBlocks` hint in `meta.json`
  (`metaJson`, `:102-112`) so the loader knows whether to fetch blocks at all.
- All writes go through `atomicWrite` (`:117-132`) — crash/SD-pull safety for free.

---

## 8. Phase 2 prototype: reading mode + static blocks

**Goal of this phase:** render `text`/`image`/`mcq` blocks and let the user *read and answer* —
no writing-over-content yet (that's Phase 3). This is the smallest end-to-end slice and it leans
entirely on the existing layer-toggle machinery.

### 8.1 The new third layer mode
Today there are exactly two native modes (`InkManager.kt`):

```kotlin
fun enterEditor()  { inkSurfaceView.visibility = VISIBLE; webView.setBackgroundColor(TRANSPARENT) } // :51
fun enterLibrary() { inkSurfaceView.visibility = GONE;    webView.setBackgroundColor(WHITE) }       // :60
```

Add a third that is *mechanically* like `enterLibrary` (ink off, WebView is the live visible
layer) but **semantically a notebook page** — we stay in `editor-view`, not the grid:

```kotlin
fun enterReadingMode() {                                   // new in InkManager
    inkSurfaceView.visibility = View.GONE
    webView.setBackgroundColor(Color.WHITE)
}
```

Plumb it exactly like the existing pair: `AndroidBridge.enterReading()` →
`inkManager?.enterReadingMode()` (mirror `AndroidBridge.kt:217-224`), the `@JavascriptInterface`
shim in `BridgeRouter.kt` (mirror `:42-43`), and a `Bridge.enterReading()` wrapper in
`bridge.js` (mirror `:201-215`). Because the ink surface is GONE, the WebView receives touches
directly — so block DOM is fully interactive with no daemon contention.

### 8.2 DOM render of blocks
Add a `#content-layer` div inside `editor-view` (sibling of the existing `paper`/`#anim-layer`),
absolutely positioned over the paper. A small `renderBlocks(page)` walks `page.blocks` and emits
plain DOM — **no React**:
- `text` → a positioned div; `md` run through a tiny Markdown→HTML pass (a ~30-line subset:
  headings, bold/italic, lists — enough for prose). 
- `image` → an `<img>` with `src` resolved against the notebook dir.
- `mcq` → prompt + a `<button>` per choice + a reveal control.
- `drawing`/`animation` → just a positioned placeholder box in Phase 2 (filled in Phase 3/4).

Each block element is positioned from its `rect` (CSS px, same origin as `paper`, §7.2), so it
lines up with where ink will later land.

### 8.3 Mode-toggle wiring (exact transitions)
The router lives in `app.js`; today `showEditor` always does ink editor + attach:

```js
showEditor(notebookId) {            // app.js:17
  ...; Bridge.enterEditor();        // :21  ink surface ON
  loadNotebookById(notebookId)      // :23  → attachInkWhenReady()
}
```

Phase 2 branches on whether the opened page has blocks:

- **Open a content page** → call `Bridge.enterReading()` (instead of `enterEditor`) and **skip**
  `attachInk` (no daemon needed for reading); then `renderBlocks(currentPage())`. A plain
  handwritten page is unchanged — still `enterEditor` + `attachInkWhenReady`.
- **"Write" toggle** (new toolbar button) → switch to ink: this is precisely the existing
  resume path — `Bridge.enterEditor()` then `attachInkWhenReady()` (the two calls
  `onResumeApp` already makes, `app.js:53`). For *writing over* content, the block region is
  composited onto the now-opaque ink surface by generalising `snapshotToolbarRegion`/`snapshotMenu`
  (`InkManager.kt:329`,`:356`) into a `snapshotContent(rect)` that bakes the block's WebView pixels
  onto the surface — **but this live write-over-content is Phase 3**; Phase 2 ships read+interact
  only, so the "Write" toggle can simply be disabled on pure-content pages until Phase 3.
- **Back to reading** (or page-turn to another content page) → `detachInk()` (which already saves
  the thumbnail + flushes + saves, `editor-controller.js:151-155`), then `Bridge.enterReading()`
  and re-`renderBlocks`. `stopAnim()` is called first if anything is running (same guard
  `showLibrary` uses, `app.js:27`).

### 8.4 MCQ interaction + partial refresh
With the WebView live in reading mode, MCQ is ordinary web:
- A choice `<button>` click handler mutates `block.state.selected`, toggles a `selected` class,
  and calls `triggerAutosave()` (the same autosave the editor already uses; state persists via
  `savePageRaw`).
- On reveal, mark correct/incorrect and show `explain`.
- **e-ink discipline:** after a state change, refresh **only the MCQ block's rect**, not the
  screen — the exact partial-refresh pattern the toolbar already uses
  (`setToolbarSnapshotRegion`/`snapshotToolbarRegion`, `InkManager.kt:329`). This avoids the
  full-screen flash and the ghosting discussed in `ui-ux-review.md` / `battery-optimization.md`.

### 8.5 What Phase 2 deliberately defers
Writing/drawing over content (Phase 3, needs `snapshotContent` + scoped `setWritingExclusion`),
animation blocks (Phase 4, the `startWebAnim` generalisation), and AI blocks (Phase 5, the gate).
Phase 2 is shippable and reversible on its own: a content page reads and grades; a normal notebook
is completely untouched.

---

## 9. The conversion tool (off-device importer), evaluated

This is the literal "book → interactive format conversion." It is an **off-device** Node/CLI
workstream, not device code.

### 9.1 Why off-device
- Keeps the device runtime lean (no parsers/bundlers shipped to the Bigme) and directly serves the
  "decouple the web layer" goal — the importer is a standalone tool that emits the **exact on-disk
  format `StorageManager` already reads**: a notebook dir with `meta.json` +
  `pages/<pageId>.json` (+ optional `blocks/` and `assets/`). It can run in CI or on a desktop.
- The device never sees the source format — only validated block JSON (§7), so no untrusted MDX/JS
  ever executes on the device.

### 9.2 Pipeline
```
source → parse → normalise to ONE intermediate AST → map nodes → blocks → paginate → emit + validate
```
1. **Parse** the source into a format-specific tree.
2. **Normalise** to a single intermediate AST (headings, paragraphs, images, lists, plus the
   interactive node kinds: mcq/drawing/animation/ai).
3. **Map** AST nodes 1:1 to block types (§7.4).
4. **Paginate** — the genuinely hard step: flow the linear AST into fixed page rectangles. This is
   why a **device-independent page geometry** (paper CSS px size + margins, matching the runtime
   `template`/paper rect) must be a tool input; the tool measures/wraps text to fill each page,
   then assigns each block a `rect` in the §7.2 coordinate space.
5. **Emit** the notebook directory and **validate** every page against the §7 schema (reuse the
   `validateNotebook` invariants, `models.js:56`).

### 9.3 Per-source evaluation
- **Markdown / MDX-ish — recommended primary path.** Easiest and highest-fidelity for *authored*
  interactive content. Parse with `remark`/`unified`; use the **MDX compiler for parsing only**
  (its AST), **not** its React runtime — so authored components `<Mcq>`, `<Drawing>`,
  `<Animation>`, `<AskAI>` map straight onto block types. This is exactly the doc's verdict (§2,
  §4.1) realised: *MDX's authoring model without MDX's runtime weight.* Interactivity is explicit
  in the source, so mapping is deterministic.
- **ePub — good secondary path.** Already HTML + CSS + semantic chapter/spine structure; parse the
  spine, convert each chapter's HTML to the intermediate AST. Main work is pagination and
  reducing/whitelisting CSS to the `style` hints the `text` block allows. Interactive blocks aren't
  present in stock ePub, so an imported book is read-only prose+images until enriched.
- **PDF — hardest, lowest priority / best-effort.** PDFs are positional, not semantic: text comes
  out as placed glyph runs with no reliable reading order or paragraph structure. Needs text
  extraction (pdf.js / pdfminer) plus heuristics (or OCR for scanned PDFs) to reconstruct flow;
  embedded images extract as `image` blocks. Treat as a convenience importer with manual cleanup
  expected, not a clean source.

### 9.4 Authoring interactivity
MCQ/animation/AI blocks come from **explicit components in the Markdown/MDX source** — the tool
does not try to infer questions from prose. That keeps conversion deterministic, diff-friendly,
CI-runnable, and schema-validated, and makes the authoring loop a pure web/content workstream that
contributors (or AIs) can iterate on without touching Kotlin (§4.5).

---

## 10. Reflow: adjustable text size / font (the fixed-rect tension)

A reader will eventually want to change the **body text size** or **font** — a baseline
e-reader expectation. Those two settings are added to the roadmap as future features, but they
collide head-on with two decisions made above, so the schema and pipeline must anticipate them
now even though the feature ships later.

### 10.1 Why it's hard here (not just "re-wrap the text")
- **Blocks have fixed rects.** §7.2 pins every block to a `{x,y,w,h}` in page CSS px, and §9.4
  bakes pagination **off-device** into those fixed rects. Change the font size and a `text`
  block's content no longer fits its `rect` — it overflows or leaves a gap, page breaks shift,
  and every block below it is mispositioned. The baked layout is, by construction, size/font
  specific.
- **Strokes are anchored to page coordinates, not to content.** This is the deeper problem.
  Handwriting is stored as flat page-CSS-px point arrays (`onStrokesBatch`, `editor-controller.js:180`)
  with no link to the block it annotates. If the prose above a margin note reflows downward, the
  text moves but **the ink does not** — the annotation drifts off the word it belonged to. A
  `drawing` block's region (§7.4) has the same issue: its `rect` is fixed, so reflowed text
  collides with or separates from it.
- **e-ink cost.** A reflow is a full re-layout → a full-screen GU16 refresh (a flash), the exact
  thing the app's partial-refresh discipline avoids. It's acceptable as an explicit, occasional
  user action, but it can't be cheap or incremental.

### 10.2 The core decision: fixed-layout vs reflowable are different page kinds
Trying to make one page model both pixel-anchored *and* reflowable is the trap. Instead, make it
an explicit page property — add `layout: "fixed" | "reflow"` to the page (and default missing →
`"fixed"`, preserving §7's backward compatibility):

- **`fixed` pages** — worksheets, textbook pages with diagrams, MCQs, anchored `drawing`
  regions. The §7 schema **as-is**. Text size/font are *not* adjustable here (or only via a
  re-import, §10.3c), because the whole value is the precise spatial relationship between
  content and the user's ink. This is the right default for *interactive* content.
- **`reflow` pages** — continuous prose (the bulk of an imported ePub/PDF, §9.3). Here text
  size/font **are** adjustable, but the trade-off is that ink **cannot anchor to coordinates**.
  Annotations on a reflow page must attach to a **text range or block id + character offset**, so
  that when the text re-wraps the annotation re-projects to wherever that range now sits. That is
  a different (richer) annotation model than today's flat stroke arrays — and the reason it's a
  separate page kind, not a flag on the current one.

### 10.3 Where the reflow actually runs (three options)
- **(a) On-device reflow.** Needs a real text-layout/pagination engine living in the lean
  WebView — exactly the runtime weight §2 argued against. Most flexible, heaviest; only the
  browser's own CSS layout (let a `reflow` page be a normal scrolling/​paginated HTML document
  rendered by the WebView) makes this viable without shipping a custom engine.
- **(b) Re-run the off-device paginator.** Keep the device lean: regenerate the page set from the
  source with new size/font params (§9.2 step 4) and re-sync the notebook. Clean output, but
  requires the source + the tool, so it's a "re-import," not a live setting.
- **(c) Logical document + separate pagination layer.** Store the source as one continuous
  logical document and treat physical pages as a derived pagination artifact. Changing size/font
  regenerates only the pagination layer (on-device for `reflow` prose via the browser, or
  off-device for `fixed` interactive layouts) without mutating the authored content. This is the
  cleanest long-term model and is compatible with both (a) and (b).

### 10.4 Recommendation
- Ship **`fixed`-layout interactive pages first** (everything in §7–§9 is already this) — they
  need no reflow and keep ink perfectly anchored.
- Add `layout` to the page model now (cheap, backward-compatible) so `reflow` prose pages can be
  introduced later without a format break.
- When text-size/font adjustment is built, scope it to **`reflow` pages**, render them as
  ordinary WebView-laid-out HTML (option **a** via the browser's own engine, no custom layout
  code), and use **range/block-anchored annotations** so handwriting survives re-wrapping. Treat
  changing size/font as an explicit action with a full refresh — not a live drag.
- Keep adjustable size/font **off `fixed` interactive pages**, where the spatial
  content↔ink relationship is the whole point; offer re-import (option **b**) if a different size
  is needed there.

---

## 11. Loading & memory model (low-powered hardware)

The Bigme HiBreak is a modest device, and a converted book is far heavier than a handwritten
notebook — hundreds of pages, large images, dense strokes. **The whole notebook must never be
loaded at once.** The good news: the app's *handwriting* path already enforces this, so most of
the answer is "make the content layer obey the discipline that already exists," with two genuinely
new pieces (eviction and image memory).

### 11.1 What already bounds memory today (inherit this, don't regress it)
The notebook is **never** loaded whole. The existing pipeline:
- **Meta-only open.** `loadNotebookById` (`editor-controller.js:77`) loads just `meta.json`
  (page list + templates, no strokes) via `Storage.loadMeta`/`takeCachedMeta`; `metaToNotebook`
  (`storage-web.js:17`) builds every page with `strokes: null`.
- **Lazy per-page strokes.** `page.strokes === null` is the "not loaded" sentinel;
  `ensurePageLoaded` (`editor-controller.js:101`) reads one page from disk on first show
  (`loadPageStrokes`, `storage-web.js:97`).
- **Template-first for a heavy page.** `HEAVY_PAGE_BYTES = 18000` (`editor-controller.js:19`):
  a page whose raw JSON exceeds it shows the template immediately and defers stroke parse by
  `STROKE_LOAD_DELAY_MS = 220` (`syncNativePage:260-273`).
- **Bounded, idle-gated prefetch.** `prefetchNeighbours` warms only `PREFETCH_AHEAD = 4` pages
  ahead + `PREFETCH_BEHIND = 2` behind (forward-weighted), each parsed inside `requestIdleCallback`
  and skipped while the app is busy (`appBusy()` — writing/animating/saving/pending load) — never
  the whole book.
- **Per-page files + raw splice.** `pages/<pageId>.json` per page; `reconstructRaw`
  (`StorageManager.kt:176`) splices stroke arrays with **no native parse**.
- **Incremental dirty save.** `saveNotebookDirty` (`storage-web.js:65`) writes only `_dirty`,
  *loaded* pages + the tiny meta; unloaded pages are skipped so their files are never clobbered.

The content layer must plug into exactly this — anything that loads all blocks/images up front
defeats it.

### 11.2 Blocks load lazily, exactly like strokes
- Add a `blocks: null` sentinel mirroring `strokes: null`, and `ensureBlocksLoaded(index)`
  mirroring `ensurePageLoaded`. Blocks live in the sibling `blocks/<pageId>.json` (§7.6) so the
  stroke hot path and `reconstructRaw`'s raw-splice stay untouched.
- Use the `meta.json` `hasBlocks` hint (§7.6) so a plain handwritten page never even issues a
  blocks read.
- Apply the same byte-threshold defer idea as `HEAVY_PAGE_BYTES`: on a block-heavy page render the
  cheap text first and hydrate interactive/image blocks a beat later (§11.6).

### 11.3 The new core: a sliding window + eviction (LRU)
- **Gap today:** once a page's `strokes` are parsed they stay in memory for the whole session.
  Fine for a ~30-page notebook; **unbounded for a 300-page book** — open enough pages and memory
  climbs until the OS kills the app.
- **Fix:** keep only a window of pages resident around `currentPageIndex` (e.g. ±2, wider than the
  the prefetch span). On page change, **evict** pages outside the window by setting `strokes`/`blocks`
  back to `null` and releasing their image bitmaps (§11.4). Reload is already cheap — it's just the
  existing lazy path firing again.
- **Safety:** evict only *after* flushing. A `_dirty` page is saved via `saveNotebookDirty` before
  it is nulled, reusing the existing dirty-tracking so eviction can never drop unsaved ink.
- **Result:** resident memory is bounded by the window, **independent of book length.** Expose a
  `WINDOW_PAGES` constant beside the existing tunables (`editor-controller.js:17-20`).

### 11.4 Images — the heaviest item, its own discipline
Images don't exist today and are the dominant risk: a decoded bitmap costs `W × H × bytes-per-px`
regardless of the (small) compressed file. A 4000×3000 photo is ~48 MB **decoded**, while the
panel is only ~1872 px wide.
- **Never inline base64** in the page/block JSON — it bloats the V8 parse and pins the whole image
  in the model string. Store images as **separate asset files** (`assets/<hash>.<ext>` under the
  notebook dir, `getNotebookPath`, `StorageManager.kt:315`); the `image` block's `src` (§7.4)
  already references a relative path.
- **Decode at display resolution, not source resolution.** Add a native `decodeImage(path,
  targetW)` using `BitmapFactory` bounds-only decode (`inJustDecodeBounds`) + `inSampleSize` to
  downsample *on decode*, then composite the result onto the surface region with the existing
  snapshot/region pattern (`setToolbarSnapshotRegion`, `InkManager.kt:343`) — so a big image is
  never materialised as a JS data URL or a full-res bitmap.
- **LRU bitmap cache with a byte budget**, and `recycle()` evicted/offscreen bitmaps — the app
  already does explicit per-frame `recycle()` in `captureAnimFrame`/the snapshot paths
  (`InkManager.kt:132`,`:303-379`). Tie bitmap eviction to the §11.3 page window.
- **e-ink lever:** Kaleido 3 is greyscale / limited-colour, so decode to a reduced config
  (RGB565, or 8-bit + dither) for a further memory cut with no perceptible loss on this panel.

### 11.5 The importer pre-conditions the data (push work off-device — §9 tie-in)
- The off-device importer (§9) writes the **per-page files directly** (meta + `pages/` + `blocks/`
  + `assets/`), so the device opens meta then windows pages — it never receives or builds a
  monolithic file in memory.
- The importer **pre-downscales images** to a device max dimension and strips the originals, so the
  device never even stores oversized assets. Pagination (§9.4) keeps each page's content bounded,
  which keeps every page file small enough for the windowed loader.

### 11.6 Within-page progressiveness + budgets
- Even a single heavy page (large image + many strokes) renders **progressively**, never as one
  blocking load: template first → strokes deferred by `STROKE_LOAD_DELAY_MS` → image blocks
  hydrated after, each composited region-by-region.
- Keep the knobs in one place next to today's constants (`editor-controller.js:17-20`):
  `WINDOW_PAGES` (resident window), the image-cache byte budget, and a block heavy-threshold
  analogous to `HEAVY_PAGE_BYTES`. They are the dials to tune as real books are tested on-device.

### 11.7 Summary
Memory safety comes from three layers, two of which already exist: **(1)** never load the whole
notebook (meta-only open + lazy per-page — *already shipped*); **(2)** bound the resident set with
a sliding window + eviction (*new*, but built on the existing lazy/dirty machinery); **(3)** treat
images as downsampled, separately-stored, LRU-cached, recycled bitmaps (*new*, the single biggest
lever). The importer pre-conditions everything off-device so the Bigme only ever handles small,
bounded, page-sized pieces.
