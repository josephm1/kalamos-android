# Book → Interactive Format — Kalamos

**Status:** design spec (condensed). Supersedes the earlier long-form analysis; this is the settled
design plus a build plan. Companion: `sample-book-authoring-prompt.md` (a prompt that generates a
feature-complete test book in this format).

**Goal:** turn books into highly *editable & interactive* content — formatted text, images, MCQs,
diagrams/animations, pen input, AI — that **reflows** and loads with **EPUB-class** strain on the
device.

**Device context:** Bigme HiBreak — dpr 1.875, **1264×1680 px**, Kaleido 3 (limited-colour, mostly
read as greyscale), modest CPU/RAM, storage on internal flash or SD. Vanilla-JS WebView UI over a
native low-latency ink surface (the Bigme daemon). Design point: a **900+ page** illustrated book.

---

## 1. Settled design at a glance

A book is split by **mutability** into two parts:

- **Immutable authored book = a plain `books/<bookId>/` folder** (manifest spine/TOC + reflowable
  HTML sections + shared CSS + content-addressed assets). No container/extension (§2.1). Read-only;
  streamed section-by-section.
- **Mutable user layer = loose sidecar files** under the notebook dir — highlights, sticky notes,
  inline pen-input strokes, MCQ/reading state. Cheap atomic per-file writes.

Three principles make it light on the device:
1. **Reflow via the EPUB model** — store logical reflowable HTML, paginate at runtime with the
   browser's native engine (no fixed page geometry baked at author time).
2. **No on-page freehand ink** — all handwriting is **sticky notes** or **inline ink boxes** whose
   strokes are *box-local*; only the box's text anchor moves on reflow, so nothing pixel-bound has to
   be re-mapped.
3. **Stream, never load whole** — open reads only the spine; each section streams one file/entry;
   memory/CPU track the *current section*, not book length.

---

## 2. On-disk layout & file formats

### 2.1 A book is a plain folder
The on-disk unit is a **plain directory keyed by bookId — no extension, no container**:
```
books/<bookId>/              # a notebook's bookRef points here
  manifest.json              # { bookId, title, author, lang, dir, cover, spine:[{sectionId,title?,fixed?}], toc:[…] }
  sections/<sectionId>.html  # reflowable sanitised HTML (prose + inline interactive elements)
  styles/book.css            # shared typography/layout
  assets/<hash>.webp|svg|png # images & diagrams, content-addressed (hash dedups repeats)
```
A folder is simplest to read, serve, author and inspect: trivial random access (just open the file),
no central-directory parsing, no extra library. We do **not** wrap it in a `.kbk`/ZIP — a folder name
carries no filesystem or performance meaning, and a container's only real upside (fewer files for
SD/FAT or shipping many books) doesn't apply here. If single-file *distribution* is ever needed, a
book can be zipped for transfer and expanded back to a folder on install — an export detail, not the
on-device format.

### 2.2 Formats by role (no single format)
| Role | Format | Why |
|---|---|---|
| Manifest / spine / TOC / interactive-element data | **JSON** | small, fast parse, diff-able |
| Prose / "web elements" | **sanitised HTML** | renders via the WebView's native engine; reflows for free |
| Diagrams / charts / line art | **SVG** | crisp on e-ink, ~no bitmap RAM |
| Photographs | **WebP** (fallback PNG/JPEG), downscaled ≤ ~1264 px | smallest at quality |
| Handwriting (notes, ink boxes) | **compact JSON** point arrays, box-local coords | small; reflow-safe |

### 2.3 No compression needed
Store the files **plain** (uncompressed). A book's bytes are dominated by **images**, which are already
compressed; the text (HTML/CSS/JSON) is a small fraction, so compressing it would save little while
adding a decompress step on every read. Keep it simple — plain files, no per-file gzip, no archive.
(If a large text-heavy book ever warrants it, individual files can be gzipped later; it's not the
default.)

### 2.4 Streaming via one virtual origin
Serve the book folder through a single virtual origin (`https://book.local/<bookId>/…`) on the existing
`WebViewClient` (`AppFragment.makeWebViewClient`; `androidx.webkit:webkit:1.9.0` is already a
dependency) using `WebViewAssetLoader`'s directory path-handler — almost no code. The web layer uses
ordinary `fetch()` for a section's HTML and `<img src>` for assets; native maps URL → file, and the
browser decodes/evicts image bitmaps itself — no base64, no full-res decode. One
handler covers "load section", "load image", and "stream asset".

---

## 3. Element types & encoding

Sections are sanitised HTML. **Interactive elements are inline custom tags** the reader upgrades to
widgets; their *mutable* state lives in the sidecar (keyed by `sectionId` + element `id`), never in
the book.

```html
<!-- prose: ordinary semantic HTML -->
<h2 id="s2-h1">Photosynthesis</h2>
<p id="s2-p1">Plants convert <em>light</em> into chemical energy…</p>

<!-- image / diagram -->
<figure><img src="assets/chloroplast.webp" alt="Chloroplast cross-section">
  <figcaption>Fig 1. A chloroplast.</figcaption></figure>

<!-- multiple-choice (single or multi) -->
<kal-mcq id="q1" answer="b" multi="false">
  <kal-prompt>Which organelle performs photosynthesis?</kal-prompt>
  <kal-choice id="a">Mitochondrion</kal-choice>
  <kal-choice id="b">Chloroplast</kal-choice>
  <kal-choice id="c">Ribosome</kal-choice>
  <kal-explain>Chloroplasts contain the chlorophyll that captures light.</kal-explain>
</kal-mcq>

<!-- inline pen-input exercise (box-local strokes → reflow-safe) -->
<kal-ink id="sketch1" height="320" label="Sketch and label a chloroplast"></kal-ink>

<!-- animation (declarative; built-in kind, or an animated SVG asset) -->
<kal-anim id="a1" kind="breath" caption="Breathing cycle"></kal-anim>
```

- **MCQ** — `answer` is one id (or space-separated for `multi="true"`); state `{selected[],revealed}`
  in the sidecar.
- **Ink box** — an in-flow fixed-height canvas; strokes are box-local JSON, saved in the sidecar,
  optional baked PNG preview. Drawn with the daemon while focused.
- **Sticky note & highlight** — *not authored in the book*; they're user data (§4) created over the
  prose, anchored to a text range.
- **AI block** (future) — `<kal-ai prompt=… inputs=…>`; routed through one gate (explicit action,
  foreground, debounced); result cached in the sidecar. Never auto-triggers.

---

## 4. Reflow, pagination & annotations

- **Reflowable sections, runtime pagination.** Lay each section into screen-width columns with **CSS
  multicolumn** (`column-width:100vw; height:100vh; overflow-x`); a page turn = jump one column. The
  native C++ layout engine does the work (the source of EPUB performance) — no per-page JS layout.
- **Cache the pagination map** per `(sectionId, fontSize, fontFace, viewport)` in the sidecar:
  re-open is instant; a font change recomputes only the current section. **Paged, not scrolling**
  (discrete column jumps = one clean e-ink refresh per turn).
- **Fixed-layout option.** A section may be `fixed:true` (worksheet/full-page diagram) — falls back to
  a fixed canvas, EPUB-FXL-style. Default is reflow.
- **Annotations anchor to text, not pixels** (EPUB-CFI-style), so they survive reflow:
  - **Highlight** = `{ sectionId, start, end, color }` → re-projected onto whatever column it now
    occupies.
  - **Sticky note** = a range anchor **plus** its own small note-local stroke canvas; only the marker
    anchor moves on reflow, the handwriting never needs re-mapping. Tap a marker → load just that one
    note file.
- **No on-page freehand ink** over flowing prose (the one pixel-bound thing that couldn't reflow is
  simply absent). Handwriting is sticky notes + inline ink boxes only.

### Mutable sidecar layout
```
notebooks/<id>/
  meta.json                          # bookRef (which book folder), reading position, per-section flags, pagination cache
  highlights/<sectionId>.json        # [ { sectionId, start, end, color } ]
  notes/<sectionId>/index.json       # [ { noteId, anchor:{sectionId,start,end}, hasPreview } ]
  notes/<sectionId>/<noteId>.json    # ONE note/ink-box: { anchor, strokes:[…] }   ← loaded only when opened
  notes/<sectionId>/<noteId>.png     # optional baked preview
```
Editing a note/highlight/MCQ writes only the one tiny file — never the book, never a whole-notebook blob.

---

## 5. Loading & memory model

The handwriting app already loads page-at-a-time and never the whole notebook; books inherit that:
- **Open:** read only `manifest.json` (spine) + the tiny sidecar `meta.json`.
- **Read a section:** within a resident window, read one section file + that section's small sidecar
  files; images stream and the browser evicts their bitmaps; jump to the cached column offset.
- **Window + idle-gated eviction (already implemented for strokes):** `prefetchNeighbours` warms
  `PREFETCH_AHEAD`/`PREFETCH_BEHIND` neighbours inside `requestIdleCallback`, skipping while
  `appBusy()`; `evictDistantPages` nulls out-of-window content in a true idle slice, never evicting a
  dirty item (`editor-controller.js`). For books the unit becomes the **section**.
- **Section sizing — see §6.4 for the importer policy.** One section = one chapter, bounded so a
  single Blink layout/pagination pass stays cheap and resident RAM is bounded.
- **Net:** working set ≈ one section + any open note, independent of a 900-page length.

---

## 6. Importer: ePub → book folder (provisional)

Off-device Node/CLI tool (CI/desktop) — keeps parsers off the device and emits a validated book folder.
Input: **EPUB 2 and EPUB 3**. (Markdown is the easy authoring path; PDF is best-effort — positional,
needs text extraction/OCR.)

**Pipeline**
1. **Unpack OCF** (`META-INF/container.xml` → OPF). Reject DRM (`encryption.xml`) clearly.
2. **Parse OPF** — metadata (title/author/lang/identifier/direction), manifest, spine; capture cover.
3. **TOC** — EPUB3 nav (`epub:type="toc"`) or EPUB2 `toc.ncx` → normalized TOC in `manifest.json`.
4. **Per spine item → section(s):**
   - **Sanitise XHTML** to the reflow-safe subset (semantic tags + `figure/img` + tables + `a` +
     all `id`s; strip `<script>`, event handlers, fixed/absolute positioning, multicol).
   - **Normalise CSS** onto `styles/book.css`; drop embedded fonts by default (e-ink legibility/size).
   - **Assign stable anchor ids** (deterministic per section) so highlight/note ranges survive
     re-import (CFI-style).
   - **Chunk into sections — the sizing policy (§6.4).** Applies to the EPUB/PDF/other importer.
   - **Rewrite refs** — image `src` → `assets/<hash>`; internal `href` → `sectionId#anchor`; external
     links flagged; broken refs reported.
5. **Transcode assets** — raster → WebP (PNG/JPEG fallback), downscaled ≤ ~1264 px, quantised; keep
   SVG (sanitised); content-address by hash.
6. **Emit the folder** — `manifest.json`, `sections/*.html`, `styles/book.css`, `assets/*` as plain
   files (no archive). Deterministic + idempotent.
7. **Validate** — every spine entry + ref resolves, ids unique per section, output parses; fail loudly.

**Edge cases to handle/flag:** EPUB2 vs 3 (NCX vs nav); fixed-layout EPUB → `fixed:true` or flag;
RTL/vertical writing modes (carry `dir`/lang); MathML (keep if the WebView renders it, else rasterise);
wide/complex tables (keep but flag — may not reflow into a column); footnotes/`noteref` → in-app
popups (a natural fit with the note UI); media overlays / A-V (out of scope v1).

**Interactivity** (MCQ/ink/anim) is an **authoring layer added on top** — not inferred from prose. The
companion prompt (`sample-book-authoring-prompt.md`) is the manual stand-in until the importer exists.

---

### 6.4 Section chunking policy (the importer's sizing rule)
**There is only ONE real knob: a maximum.** The literature has a *max* (Calibre 260 KB, EPUB
~300 KB — both from limited-memory/CPU e-readers, i.e. this device) but **no minimum** — "one chapter
per file" is an *organisational* convention, not a performance floor, and consolidating small files is
explicitly recognised as *better* for navigation and device performance. So we **don't** set a floor;
we **coalesce small chapters toward the max**, which removes tiny files without an arbitrary minimum.

Measured on **section HTML bytes** (markup + text); **images don't count** (separate asset files the
browser decodes/evicts).

- **MAX ≈ 250 KB per section** — the ceiling *and* the pack target. Comfortable here: a 250 KB Blink
  layout / re-pagination is well under the budget on this SoC, and it's just under the de-facto reader
  limit.
- **Build sections by greedy packing**, not by emitting one file per chapter:
  1. Take the source's chapters/blocks in reading order.
  2. Append whole chapters to the current section until the **next** chapter would push it over MAX;
     then start a new section with that chapter.
  3. If a **single chapter alone exceeds MAX**, split *it* at a safe top-level block boundary (never
     mid-paragraph/`figure`/`<kal-*>`) into ≤ MAX pieces; those pieces pack/stand as sections.
- **No minimum.** A tiny chapter simply joins its neighbours; **a whole small book (≤ MAX) is ONE
  section, one load.** This is the desired behaviour — fewer, fuller files; never a 3 KB file.
- **Stable ids across split/merge** — deterministic per source position, so highlight/note ranges
  (CFI-style anchors, §4) survive re-import. TOC/`href` resolve to `sectionId#anchor` *within* a packed
  section (the reader paginates to the anchor).
- **PDF caveat:** no semantic chapters — detect boundaries from outline/bookmarks/heading sizes, then
  pack the same way; where structure is ambiguous, prefer fewer larger sections within MAX.

**Why max-only (refs):** [Calibre 260 KB default](https://manual.calibre-ebook.com/conversion.html);
[EPUB ~300 KB = a limited-hardware guideline, now a best-practice not a hard limit](https://idpf.org/forum/topic-917)
([geekrant](https://www.geekrant.org/2012/10/26/epub-htmlxhtml-or-chapter-upper-file-size-limit-is-300kb/),
[MobileRead](https://www.mobileread.com/forums/showthread.php?t=277355)); consolidating small files is a
recognised optimisation ([concat→EPUB](https://tinyapps.org/blog/201502260700_concatenate_html.html)).
A too-large chunk forces laying out the whole chunk (deep links / page counting) → a substantial pause;
this device adds a reason for the ceiling — the reader **paginates the whole section up front**
(CSS-multicolumn column count), so layout cost tracks section size. Nothing in the literature rewards a
*minimum*, so we use the max as the pack target instead.

## 7. Build sequence

Implement on a **branch off `origin/main`** (it has the shipped reader; the research branch is behind).

1. **Virtual-origin streaming** (§2.4) — the backbone; replaces base64 image data URLs (RAM win now).
2. **Book reader** — resolve `manifest.json` + sections/assets from the `books/<bookId>/` folder
   through the directory handler.
3. **Reflow pagination** — CSS multicolumn; column-jump turns on the hardware page buttons; cached
   offset map; font-size setting recomputes the current section.
4. **Mutable sidecar** — `meta.json` (bookRef/position/pagination cache) + `highlights/` + `notes/`;
   bridge load/save mirrors of the existing `loadPage`/`savePage`.
5. **Annotations** — range/CFI anchoring over reflowed HTML; highlight overlay; note markers; tap →
   load one note; reuse the shipped sticky-note daemon box (`setWritingBounds`/`snapshotContent`).
6. **Inline interactive elements** — `<kal-mcq>` (state in sidecar), `<kal-ink>` (daemon box, box-local
   strokes), `<kal-anim>` via the existing `startWebAnim` sampler.
7. **Importer** (§6).
8. **Section windowing/eviction** — apply the idle-gated prefetch/evict (§5) at section granularity.

---

## 8. What shipped today vs the target (+ migration)

**Shipped (origin/main):** an interactive-notebook *variant* — reading mode (`reader-controller.js`),
finger-tap MCQs, images, EPUB-style highlights, and daemon sticky notes — but content (`blocks[]`,
highlights `block.hl[]`, note strokes `block.hl[hi].note.strokes`) is stored **inside `meta.json`**,
and any edit rewrites the whole notebook meta. That works for the 10-page demo but doesn't scale
(whole-notebook rewrites; defeats cheap open + library preload; can't be evicted; no
authored-vs-user separation).

**Path to the target:** build §7 on `main`; **regenerate** the demo through the importer / authoring
prompt into a book folder + sidecar rather than migrating the meta blob. Plain handwritten notebooks are
untouched (they keep the existing per-page strokes model and on-page ink).

---

## 9. Open questions / measure on-device

- Section read latency for a mid-book page vs the windowed-prefetch budget, on internal flash vs SD;
  plus per-book file count and on-disk size (sanity-check the folder holds up at 900 pages on SD).
- CSS-multicol pagination + e-ink refresh time on a column jump; re-pagination time on a font change.
- Asset-streaming RAM (virtual origin) vs the base64 path on an image-heavy chapter.
- Whether highlights stay batched per section or need per-note files (annotation density).
- Importer output on 3–4 real ePubs (one EPUB2, one image-heavy, one with footnotes/tables).

---

## 10. Decision log (terse)

- **Reflowable HTML sections + runtime CSS-multicol pagination** (EPUB model) — *not* pre-paginated
  fixed-rect pages. Importer doesn't bake pagination.
- **No on-page freehand ink.** Handwriting = sticky notes + inline ink boxes, strokes box-local,
  range-anchored → reflow-safe.
- **Two-part storage:** immutable `books/<bookId>/` **plain folder** (no container/extension) +
  mutable loose per-section/per-note sidecar.
- **No compression** on device — images dominate and are already compressed; text is a small share.
  Plain files; zip only as an export/transfer detail if ever needed.
- **One virtual-origin handler** (`WebViewAssetLoader` directory) streams sections + assets to the WebView.
- **Off-device importer** (ePub→book folder); interactivity is an authoring layer, not inferred.
- **Annotations anchor to text ranges** (CFI-style), state in the sidecar, never in the book.
- **Build on a branch off `main`**; regenerate the demo rather than migrate the meta blob.
