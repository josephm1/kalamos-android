# Kalamos — Roadmap / Backlog

Captured feature + research backlog. Priority tags: **[P1]** soon · **[P2]** normal ·
**[P3]** later / nice-to-have · **[research]** produce an analysis doc before building.

---

## Reviews & analysis deliverables (write-ups, not features)

- **[research] UI/UX critical review.** A critical review of the current user interface and
  interaction design — what's working, what isn't, concrete improvement recommendations.
- **[research] Battery-life optimization review.** Critical review/analysis of every way to
  reduce the device's battery drain (ties into Smart Wi-Fi and refresh-mode choices below).
  See existing `../BATTERY-OPTIMIZATION.md`.
- **[research] Book → interactive format conversion.** Analysis doc on the best way to convert
  books into highly *editable and interactive* formats supporting: animations, MCQs, writing,
  drawing, and AI integration (local-computer + cloud APIs). Investigate **MDX / "Markdown X"**
  as the authoring/content layer. This is a cornerstone feature — research first.

## Pen & input

- **[P1] Inverted-pen highlighter.** Use the USI 2.0 stylus's end knob (the button normally
  mapped to *erase*) as a **highlighter** when the pen is flipped/inverted. Detect the inverted
  tool and switch to highlight mode rather than erase.
- **[P1] Selection that actually selects.** The current "selection" pen only draws a dashed
  lasso. Make it a real selection: capture enclosed strokes → move / delete / copy / transform.
- **[P2] Auto line-wrap on ruled guides.** When handwriting runs to the right edge along a
  ruled guideline, automatically shift the writing **down to the next line, back to the left**.
  Research the existing app that does this and how they implemented it.
- **[P2] Whole-pixel mode (data-compaction toggle).** Per-notebook option (via long-press, see
  below) to **disable sub-pixel data compaction** and round strokes to whole pixels. Costs
  latency + storage but looks crisper/more precise — for detailed/precision drawings.
- **[P3] Scribble-to-erase.** Scratch-out gesture deletes strokes. Can wait.

## UI / layout

- **[P1] Maximize canvas space.** Remove/auto-hide toolbars to give the page maximum area.
- **[P1] Moveable, nicer hamburger menu.** Make the menu draggable/repositionable and visually
  nicer (replaces fixed toolbars).
- **[P1] Thumbnail snapshot excludes the menu.** When capturing the notebook thumbnail, exclude
  the toolbar/menu chrome so the thumbnail shows only the page.
- **[P2] Page indicator while scrolling.** A very small, unobtrusive corner indicator showing
  current page / total pages while navigating a notebook.
- **[P2] Nested folder view.** Folders display as a true nested structure that mirrors how
  they're laid out in internal storage / SD card.

## Notebooks & templates

- **[P1] Long-press notebook → context options.** Long-pressing a notebook opens extra options,
  including:
  - **Custom default layouts** — instead of ruled, choose music-note staves, imported PDFs, or
    other customizable templates. Templates live in a dedicated folder in internal storage.
  - **Whole-pixel mode toggle** (see Pen & input above).
- **[P3] Calendar function.** Possibly a calendar view/module. To be decided later.
- **[P3] Applied-maths function.** A maths-focused mode (graphing / computation / notation).
- **[P2] To-do list.** A to-do list feature.

## Knowledge & AI

- **[P2] Wiktionary support.** Look up words (definitions) inline.
- **[P3] On-device local AI.** Greater integration with local AI running on the device. Not a
  priority.
- **[P3] Cloud AI + local-computer AI.** Also support cloud AI APIs and accessing AI services
  running on the user's own computer (LAN).

## System & platform

- **[P2] Smart Wi-Fi.** Keep Wi-Fi off unless actually needed, but avoid rapid on/off cycling
  (which itself wastes battery). Demand-driven, debounced toggling.

## Developer experience

- **[P2] Decouple the web layer.** Once the native side is finished, make the website side easy
  to work on in isolation — so other AIs can iterate on templates, page/website structure, and
  web elements (views) without touching native. Clear web/native boundary + a way to preview the
  web layer standalone.

---

_Notes: items reference device = Bigme HiBreak (Kaleido 3 colour e-ink, USI 2.0 stylus).
Storage roots: `/storage/emulated/0/Kalamos` (internal) + SD card. The web/native split keeps
live writing on the Bigme handwriting daemon for latency._
