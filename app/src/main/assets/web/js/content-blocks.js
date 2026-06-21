// Renders a page's interactive-format blocks into #content-layer as STATIC DOM. The editor then
// bakes that layer onto the opaque ink surface (Bridge.snapshotContent), and the user writes over it
// with the daemon pen. Nothing here is interactive (the ink surface owns touch): MCQs are answered by
// circling a choice, the drawing box is filled with real ink. See book-to-interactive-format.md §7.
const ContentBlocks = {
  // Render page.blocks into [container]; call [onReady] once images have loaded (so the bake captures
  // them). [notebookId] resolves image asset paths to data URLs via the bridge.
  render(container, page, notebookId, onReady) {
    container.innerHTML = ''
    const blocks = (page && page.blocks) || []
    if (!blocks.length) { container.classList.remove('has-content'); onReady && onReady(); return }
    container.classList.add('has-content')

    let pendingImgs = 0
    let mcqNum = 0
    const done = () => { if (pendingImgs === 0 && onReady) { onReady(); onReady = null } }

    blocks.forEach((b) => {
      let node = null
      switch (b.type) {
        case 'text':  node = this.text(b); break
        case 'image': node = this.image(b, notebookId, () => { pendingImgs--; done() });
                      if (b.src) pendingImgs++; break
        case 'mcq':   node = this.mcq(b, ++mcqNum); break
        case 'drawing': node = this.drawing(b); break
        case 'animation': node = this.animation(b); break
        default: node = el('div', 'cb', '[' + b.type + ']')
      }
      if (node) container.appendChild(node)
    })
    done()   // in case there were no images
  },

  text(b) {
    const d = el('div', 'cb cb-text')
    d.innerHTML = miniMarkdown(b.format === 'plain' ? escapeHtml(b.md) : (b.md || ''))
    return d
  },

  image(b, notebookId, onSettle) {
    const fig = el('figure', 'cb cb-figure cb-fit-' + (b.fit || 'contain'))
    const img = document.createElement('img')
    img.className = 'cb-img'
    img.alt = b.alt || ''
    img.addEventListener('load', onSettle)
    img.addEventListener('error', function() { fig.classList.add('cb-img-missing'); onSettle() })
    // Resolve the notebook-relative asset to a data URL (native reads it off disk).
    let url = ''
    try { url = Bridge.getNotebookAsset(notebookId, b.src) } catch (e) {}
    if (url) img.src = url; else { img.alt = '(image)'; setTimeout(onSettle, 0) }
    fig.appendChild(img)
    if (b.caption) fig.appendChild(el('figcaption', 'cb-caption', b.caption))
    return fig
  },

  // Static MCQ: lettered choices, answered with the pen (circle the letter). No tap grading here.
  mcq(b, num) {
    const box = el('div', 'cb cb-mcq')
    const q = el('div', 'cb-mcq-q')
    q.innerHTML = '<span class="qnum">Q' + num + '.</span> ' + miniMarkdown(b.prompt).replace(/^<p>|<\/p>$/g, '')
    box.appendChild(q)
    const list = el('div', 'cb-choices')
    const letters = 'ABCDEFGH'
    b.choices.forEach((c, i) => {
      const row = el('div', 'cb-choice')
      row.innerHTML = '<span class="lett">' + letters[i] + '</span>' +
        miniMarkdown(c.md).replace(/^<p>|<\/p>$/g, '')
      list.appendChild(row)
    })
    box.appendChild(list)
    box.appendChild(el('div', 'cb-mcq-hint', '✎ Circle your answer with the pen.'))
    return box
  },

  drawing(b) {
    const wrap = el('div', 'cb')
    if (b.label) wrap.appendChild(el('div', 'cb-draw-label', b.label))
    const box = el('div', 'cb-draw-box')
    box.style.height = (b.height || 300) + 'px'
    box.appendChild(el('span', 'hint', '✎ sketch here'))
    wrap.appendChild(box)
    return wrap
  },

  // Static framed figure for now (the SVG is baked as a still). Live motion would reuse the native
  // animation sampler (startWebAnim) in a later pass — kept out for the bake-only content path.
  animation(b) {
    const wrap = el('div', 'cb cb-anim')
    const stage = el('div', 'cb-anim-stage')
    stage.innerHTML = (b.kind === 'breath') ? LUNGS_SVG : ''
    wrap.appendChild(stage)
    if (b.caption) wrap.appendChild(el('div', 'cb-caption', b.caption))
    return wrap
  }
}

// ---- helpers ----
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Tiny safe Markdown subset → HTML: headings, bold, italic, inline code, unordered lists, paragraphs.
function miniMarkdown(src) {
  const lines = String(src).split('\n')
  let html = '', inList = false
  const inline = (t) => escapeHtml(t)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  const closeList = () => { if (inList) { html += '</ul>'; inList = false } }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { closeList(); continue }
    let m
    if ((m = line.match(/^###\s+(.*)/))) { closeList(); html += '<h3>' + inline(m[1]) + '</h3>'; continue }
    if ((m = line.match(/^##\s+(.*)/)))  { closeList(); html += '<h2>' + inline(m[1]) + '</h2>'; continue }
    if ((m = line.match(/^#\s+(.*)/)))   { closeList(); html += '<h1>' + inline(m[1]) + '</h1>'; continue }
    if ((m = line.match(/^[-*]\s+(.*)/))) { if (!inList) { html += '<ul>'; inList = true } html += '<li>' + inline(m[1]) + '</li>'; continue }
    closeList()
    html += '<p>' + inline(line) + '</p>'
  }
  closeList()
  return html
}

const LUNGS_SVG =
  '<svg viewBox="0 0 240 200" preserveAspectRatio="xMidYMid meet">' +
  '<line x1="120" y1="26" x2="120" y2="96" stroke="#333" stroke-width="6" stroke-linecap="round"/>' +
  '<path d="M120,70 L96,86 M120,70 L144,86" stroke="#333" stroke-width="6" fill="none" stroke-linecap="round"/>' +
  '<path d="M112,80 C112,120 96,150 78,168 C58,188 44,168 44,140 C44,112 60,86 88,80 C100,77 112,76 112,80 Z" fill="#D88" stroke="#A33" stroke-width="3"/>' +
  '<path d="M128,80 C128,120 144,150 162,168 C182,188 196,168 196,140 C196,112 180,86 152,80 C140,77 128,76 128,80 Z" fill="#D88" stroke="#A33" stroke-width="3"/>' +
  '</svg>'

window.ContentBlocks = ContentBlocks
