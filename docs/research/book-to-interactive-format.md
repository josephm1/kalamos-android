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
