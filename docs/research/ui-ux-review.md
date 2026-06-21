# UI/UX Critical Review — Kalamos

**Status:** research deliverable (ROADMAP.md → "UI/UX critical review")
**Scope:** the current interface and interaction design, what works, what doesn't, and
concrete recommendations. Grounded in the code as it stands today.
**Device context:** Bigme HiBreak — Kaleido 3 colour e-ink, USI 2.0 stylus, hardware
page-turn buttons. No multi-touch expectation; the stylus + a finger tap are the inputs.

---

## 1. How the UI is actually built (so recommendations are realistic)

Kalamos is a **hybrid app**. All UI is HTML/CSS/JS inside one reused WebView
(`app/src/main/assets/web/app.html`), split into two views — `#library-view` and
`#editor-view` — toggled by a JS router (`js/app.js`), never a page reload
(`AppFragment.kt:18`). The native side is a thin shell.

The editor has a hard constraint that shapes *every* UX decision: an **opaque native
`InkSurfaceView` sits on top of the WebView** and is the only thing actually visible while
writing (`view/InkSurfaceView.kt:24-35`). The web toolbar/menu is therefore **rendered
into a bitmap and "baked" onto that surface** (`InkManager.snapshotToolbar` /
`snapshotMenu` / `snapshotToolbarRegion`). Consequences that are easy to forget but
dominate the UX:

- The menu the user sees in the editor is a **screenshot**, not live DOM. It only updates
  when something explicitly re-snapshots it.
- Anything that animates or drags continuously (a slider thumb, a hover state) is invisible
  until a re-snapshot fires — by design, to avoid e-ink flashing.
- Every visual change costs an e-ink refresh, so the UI is deliberately *static between
  discrete actions*. "Snappy, animated" UI is the wrong target here; "instant, quiet,
  legible" is the right one.

This is a sound architecture for e-ink. The review below judges the UX *within* those
rules, not against them.

---

## 2. What's working well

- **Full-screen paper + collapsible floating menu** (`app.html:77-125`). Collapsed, the
  menu is just a `☰` handle and the page is essentially full-bleed. This already partly
  delivers the roadmap's "maximize canvas space" goal and is the right default for writing.
- **Targeted refreshes.** Button taps re-bake only their own element cluster
  (`snapshotToolbarEls(['btn-pen','btn-felt',...])`, `editor-controller.js:814`) and the
  page number updates its own rect on page turns (`:624`). The UI avoids full-screen flashes
  on routine actions — exactly right for e-ink.
- **Hardware page-turn buttons** are wired to real navigation in both views
  (`MainActivity.dispatchKeyEvent` → `AppFragment.onPageKey` → `App.onPageKey`):
  library pagination and notebook page nav (`library-controller.js:286`,
  `editor-controller.js:629`). Using the physical buttons is the most e-ink-native
  interaction the device offers and it's respected.
- **Thumbnails already exclude the menu chrome.** `InkSurfaceView.captureThumbnail`
  (`:498`) crops to the *paper region* (`rBounds`) at a fixed 3:4 aspect, so the roadmap
  item "thumbnail snapshot excludes the menu" is effectively already satisfied by the
  capture source (the bare page bitmap, before the menu is composited). Worth confirming on
  device, but the code path is correct.
- **Autosave is communicated.** `#autosave-status` cycles Saving…/Saved and surfaces a real
  toast on failure (`editor-controller.js:728-768`) instead of silently losing work on a
  pulled SD card — good trust behaviour.
- **Colour palette is tuned for the panel.** Swatches are explicitly chosen as saturated,
  medium-dark hues that read on the Kaleido 3 CFA, with a note that pastels wash out
  (`app.html:88-103`). This is real device-aware design, not a default colour picker.

---

## 3. What isn't working / friction points

### 3.1 The editor menu is a long vertical scroll-list of 14+ controls
`#menu-tools` stacks Back, Pen, Felt, Select, Erase, Colour, Undo, Redo, Prev, page#, Next,
Add, Del, template `<select>`, width slider, Anim, Export, autosave (`app.html:81-124`).
On a tall e-ink panel this is a lot of equally-weighted targets in one column. Problems:
- **No grouping/hierarchy.** Writing tools, history, page nav, and document actions
  (export) all look identical. The most-used controls (pen/erase/colour) aren't visually
  privileged over rare ones (export).
- **Expanded menu eats canvas.** When open it's a full-height column; the roadmap's
  "maximize canvas" and "moveable menu" items confirm this is felt. The menu is docked
  left and **not repositionable** (roadmap P1: "moveable, nicer hamburger menu").

**Recommendation:** split into a small always-relevant cluster (pen/erase/colour/undo) and
a secondary "more" group (template/width/export/anim). Make the menu draggable (store its
position per-device). Both are already roadmap P1 — this review endorses them as the highest
-leverage UI changes.

### 3.2 Native widgets that don't fit a baked, e-ink toolbar
- **The width control is an `<input type=range>` slider** (`app.html:117-119`). On a baked
  snapshot the thumb doesn't move while dragging — it only re-snapshots on `change`
  (`editor-controller.js:983`). A slider is a "continuous feedback" widget used in a
  "no continuous feedback" medium. **Recommendation:** replace with discrete stepped width
  presets (e.g. 1/3/5/8/12 px tap targets) — instant, legible, one refresh each.
- **The template control is a native `<select>`** (`app.html:111`). A dropdown overlay on
  a stylus e-ink device is awkward (tiny targets, overlay refresh). **Recommendation:**
  inline icon toggles (Blank/Ruled/Grid/Dotted), matching the tool-button pattern.

### 3.3 `prompt()` and `contextmenu` in the library
- **Rename uses `window.prompt()`** (`library-controller.js:410,435`). A browser prompt on
  a stylus e-ink tablet means the system keyboard + an un-styled modal; inconsistent with
  the app's own modal styling (`showConfirm`, `:468`). **Recommendation:** use the existing
  modal pattern with a text field (and ideally handwriting-to-text later, per the
  Wiktionary/AI roadmap direction).
- **Long-press/right-click via `contextmenu`** drives note/folder actions
  (`:270,166`). The roadmap explicitly wants "long-press notebook → context options"
  (P1) — so the *interaction* is planned, but today it relies on the web `contextmenu`
  event, which is unreliable from a stylus. **Recommendation:** implement an explicit
  long-press timer on `pointerdown`/`pointerup` rather than depending on `contextmenu`.

### 3.4 No page indicator while scrolling/turning (roadmap P2)
The page number lives only inside the menu (`#page-num`, `app.html:107`). When the menu is
collapsed (the normal writing state) there's **no visible page position**. The roadmap's
"small unobtrusive corner indicator" is well-justified. **Recommendation:** a tiny,
bottom-corner `n/N` that refreshes its own rect on page turn (reuse the existing
`setToolbarSnapshotRegion` partial-refresh path — cheap, no flash).

### 3.5 Folder view is flat
`renderFolderBar` is a single horizontal row of folder chips with inline `+ folder` and a
delete `×` (`library-controller.js:141-186`); notes carry one `folderId`. The roadmap wants
"nested folder view mirroring internal storage." Today there's no nesting and no
storage-structure mirroring (storage is flat: `notebooks/<id>/`, `thumbnails/`,
`library.json` — `StorageManager.kt:46-50`). **Recommendation:** treat this as a data-model
change (folder parentId + a tree render), not just a CSS change; call it out before building.

### 3.6 Discoverability of stylus gestures
The flip-to-erase behaviour (USI end-knob → eraser) is implemented
(`editor-controller.js:476-504`) and the roadmap wants to extend it (inverted-pen
highlighter). But there's **no in-UI hint** that flipping the pen erases, or that the eraser
end exists. **Recommendation:** a one-time hint/cheat-sheet (or a tiny persistent tool
indicator showing the current pen state), since these gestures are otherwise invisible.

### 3.7 Minor
- **Two erase entry points with different cursors.** The eraser-cursor radius is `12`
  (`editor-controller.js:455`) while hit-test radius is `8` (`:413`) — the visual cursor is
  larger than the actual erase area, which can feel imprecise. Align them.
- **Selection tool is currently only a dashed lasso** that doesn't select (confirmed by
  roadmap P1 "selection that actually selects"). As-is it's a UX dead-end (draws a dashed
  line that does nothing) — until the feature lands, consider hiding it to avoid confusion.

---

## 4. Prioritised recommendations

| # | Recommendation | Effort | Roadmap tie-in |
|---|----------------|--------|----------------|
| 1 | Group + slim the editor menu; make it draggable | M | P1 moveable/nicer menu, P1 maximize canvas |
| 2 | Replace width slider with discrete width presets | S | (new, supports e-ink) |
| 3 | Replace template `<select>` with inline toggles | S | (new) |
| 4 | Corner page indicator (partial-refresh) | S | P2 page indicator |
| 5 | Replace `prompt()` rename + `contextmenu` with app modal + real long-press | M | P1 long-press options |
| 6 | One-time stylus-gesture hint / persistent tool-state indicator | S | supports inverted-pen, flip-erase |
| 7 | Nested folders (model + tree render) | L | P2 nested folders |
| 8 | Align eraser cursor size to hit radius; hide non-functional Select until implemented | S | P1 real selection |

"S/M/L" = small/medium/large. Items 1–6 are high-leverage and cheap; 7 needs a data-model
decision first.

---

## 5. Guiding principle for future UI work

Because the editor UI is a **baked snapshot on an opaque ink surface**, the design language
should be: *large, static, high-contrast targets; discrete state changes; partial refreshes;
no continuous-feedback widgets.* Every new control should answer "what single rect refreshes
when this changes, and does it flash?" — the controls that already do this well (tool
buttons, page number) are the template to follow; the ones that don't (slider, select,
prompt) are the ones to replace.
