# Sample-book authoring prompt (feature test fixture)

A copy-paste **prompt** for an AI that turns a downloaded Wikipedia article into a small, complete
**book folder** in the Kalamos interactive format (`book-to-interactive-format.md`). The result
exercises **every element type** — formatted prose, an image, single- and multi-answer MCQs, an
inline pen-input box, plus a seeded sticky note + highlight — so the new format can be tested
end-to-end. It also doubles as a manual stand-in for the importer (§6 of the format doc) until that's
built.

> **Note:** there is no on-device book reader yet (it's the build target). Validate the output by
> opening `sections/*.html` in a desktop browser and checking the JSON; when the reader lands, this
> same folder is the runnable book (it's a plain folder — nothing to package).

---

## How to use
1. Download a Wikipedia article as **complete HTML** (the page + its `images/` folder), e.g. the
   browser's "Save Page As → Web Page, Complete", or single-file HTML.
2. Paste the **prompt below** into a capable AI, then attach/paste the article HTML and list the image
   files you saved.
3. The AI returns a **folder tree** (`book/…`). Review it against the acceptance checklist — that
   folder *is* the book; there's nothing to package.

---

## THE PROMPT (copy from here)

````
You are converting a single Wikipedia article into a small interactive "book" in the Kalamos
book-folder format. Output a complete folder tree as fenced code blocks (one per file), nothing else
besides a short final checklist. Do not invent facts — use only the supplied article; you may
summarise and shorten.

INPUT: I will paste the article's HTML and list the image files I downloaded (filenames + rough
subject of each). Use those images; do not hotlink the web.

PRODUCE this folder (a plain Kalamos book — no archive):

  book/
    manifest.json
    styles/book.css
    sections/s1.html, sections/s2.html, sections/s3.html   (3–4 sections)
    assets/<name>.<ext>                                     (the images, referenced by the sections)
    sidecar/meta.json
    sidecar/highlights/<sectionId>.json
    sidecar/notes/<sectionId>/index.json
    sidecar/notes/<sectionId>/<noteId>.json

REQUIREMENTS — the book MUST collectively include, across its sections:
  - Formatted prose: headings, paragraphs, at least one list and one blockquote.
  - At least one <figure> image referencing assets/… with alt text + caption.
  - At least TWO <kal-mcq>: one single-answer (multi="false") and one multi-answer (multi="true"),
    each with 3–4 <kal-choice>, a correct `answer`, and a <kal-explain>.
  - At least one <kal-ink> inline pen-input box with a `label` and a `height`.
  - One <kal-anim kind="breath"> placeholder (only if topically reasonable; else omit).
  - Stable, unique `id`s on every heading/paragraph and every interactive element (e.g. s2-p3, q1).
  - A seeded example highlight (a real character range into one of your <p> texts) in
    sidecar/highlights, and a seeded sticky note in sidecar/notes (anchor into the same kind of range;
    strokes may be a short placeholder array).

FORMAT RULES:
  - Sections are sanitised reflowable HTML fragments (NO <html>/<head>/<body>, no <script>, no inline
    styles, no fixed/absolute positioning). Allowed tags: h1–h4, p, ul/ol/li, blockquote, figure,
    img, figcaption, em, strong, code, sup, sub, a, table/thead/tbody/tr/th/td, and the custom tags
    <kal-mcq>/<kal-prompt>/<kal-choice>/<kal-explain>, <kal-ink>, <kal-anim>.
  - <kal-mcq id answer multi> … <kal-prompt>…</kal-prompt> <kal-choice id="a">…</kal-choice>…
    <kal-explain>…</kal-explain> </kal-mcq>. `answer` = a choice id (or space-separated ids if
    multi="true").
  - <kal-ink id height label></kal-ink> — empty element; height in px (200–360).
  - Images: reference as src="assets/<name>". Keep the original files; PREFER converting photos to
    .webp and diagrams to .svg if you can, otherwise keep .png/.jpg. Assume each is downscaled to
    ≤ 1264 px wide.
  - manifest.json: { "bookId","title","author","lang","dir","cover":"assets/…"?,
    "spine":[{"sectionId":"s1","title":"…"}, …], "toc":[{"label":"…","href":"s1"}, …] }
  - styles/book.css: a small reflow-friendly stylesheet (readable serif/sans body, sensible
    line-height, figure/img max-width:100%, table basics). No fixed sizes that block reflow.
  - sidecar/meta.json: { "bookRef":"books/<bookId>","position":{"sectionId":"s1","page":0},
    "flags":{} }
  - highlights file: [ { "sectionId":"s2","start":<int>,"end":<int>,"color":"yellow" } ]
  - notes index: [ { "noteId":"n1","anchor":{"sectionId":"s2","start":<int>,"end":<int>},
    "hasPreview":false } ]
  - note file: { "anchor":{"sectionId":"s2","start":<int>,"end":<int>},
    "strokes":[ [[x,y],[x,y],…] ] }   (a short placeholder stroke is fine)

Keep each section short enough to read on a 1264×1680 screen across a few paginated columns. End with
a one-line checklist confirming every REQUIREMENT above is present.
````

(End of prompt.)

---

## What each piece maps to (for the reviewer)
- **Sections / prose / image** → the reflowable HTML + `assets/` of the book folder (format doc §2–§3).
- **`<kal-mcq>` / `<kal-ink>` / `<kal-anim>`** → the inline interactive elements (§3); their *state*
  and *strokes* live in the **sidecar**, not the book.
- **Seeded highlight + sticky note** → the mutable user layer (§4), anchored by character range so it
  survives reflow.
- **manifest spine/TOC** → what the reader streams on open (§5).

## Acceptance checklist
- [ ] 3–4 sections; each heading/paragraph and every interactive element has a unique `id`.
- [ ] ≥1 `<figure>` image with alt + caption, `src="assets/…"`, and the file exists in `assets/`.
- [ ] ≥2 `<kal-mcq>` — one `multi="false"`, one `multi="true"` — each with `answer` + `<kal-explain>`.
- [ ] ≥1 `<kal-ink>` with `label` + `height`.
- [ ] No `<script>`, no inline styles, no `<html>/<head>/<body>` in sections.
- [ ] `manifest.json` spine lists every section file; `toc` resolves; JSON parses.
- [ ] Seeded `highlights/*.json` range points into real text; seeded note file + index entry present.
- [ ] (optional) `<kal-anim kind="breath">` present where topical.

## Eyeball before a reader exists
- Open each `sections/sN.html` in a desktop browser (wrap in a throwaway `<html><body>…` if needed) —
  prose/images render; the `<kal-*>` tags appear as inert inline elements (expected — the reader
  upgrades them).
- `python3 -m json.tool` each JSON file to confirm it parses.
- Check every `src="assets/…"` and manifest `sectionId`/`href` resolves to a real file.

## On-disk form (a plain folder)
The `book/` folder **is** the deliverable — a plain directory, no archive, no extension, served
directly by `WebViewAssetLoader` (format doc §2.1). Don't zip it; just keep the files as-is. (Zipping
is only ever an export/transfer convenience, then expanded back to a folder — never the on-device
form.) The `sidecar/` folder is **not** part of the book — it's the mutable user layer that lives
beside the book on device (format doc §4). Keep it alongside for testing.
