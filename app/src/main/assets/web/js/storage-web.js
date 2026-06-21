// The notebook meta written to meta.json: all metadata + the page list (pageId + template), but NO
// strokes (those live in per-page files). Strips transient flags like page._dirty.
function buildMeta(nb) {
  return {
    notebookId: nb.notebookId,
    title: nb.title,
    folderId: nb.folderId || '',
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
    defaultTemplate: nb.defaultTemplate,
    pages: nb.pages.map(function(p) { return { pageId: p.pageId, template: p.template } })
  }
}

// Parse a meta JSON string into a LAZY notebook: pages carry pageId + template but strokes=null
// (loaded on demand). Returns null if the meta is malformed.
function metaToNotebook(raw) {
  try {
    const m = JSON.parse(raw)
    if (m && m.notebookId && Array.isArray(m.pages)) {
      m.pages = m.pages.map(function(p) { return { pageId: p.pageId, template: p.template, strokes: null } })
      return m
    }
  } catch (e) {}
  return null
}

// Library preload cache: notebookId → raw meta JSON string for the currently-visible notebooks.
const _metaCache = {}

const Storage = {

  saveLibrary(libraryIndex) {
    const json = JSON.stringify(libraryIndex)
    return Bridge.saveLibrary(json) === 'ok'
  },

  loadLibrary() {
    const raw = Bridge.loadLibrary()
    try {
      const data = JSON.parse(raw)
      if (data && data.version && Array.isArray(data.notebooks)) {
        return data
      }
    } catch (e) {}
    return { version: 1, notebooks: [], folders: [] }
  },

  // Per-page storage: meta.json (metadata + page list) + pages/<pageId>.json (one page's strokes).
  // A save rewrites only the changed page(s) + the tiny meta, never the whole notebook.

  // Full save — writes every LOADED page + meta. For create/duplicate where the model is fresh.
  // Unloaded (lazy, strokes===null) pages are skipped so their on-disk files are never clobbered.
  saveNotebook(notebook) {
    notebook.updatedAt = nowISO()
    for (const page of notebook.pages) {
      if (page.strokes === null) continue
      if (Bridge.savePage(notebook.notebookId, page.pageId, JSON.stringify(page.strokes)) !== 'ok') return false
      page._dirty = false
    }
    return Bridge.saveMeta(notebook.notebookId, JSON.stringify(buildMeta(notebook))) === 'ok'
  },

  // Incremental save — writes only pages flagged page._dirty + the (tiny) meta. The hot autosave path.
  saveNotebookDirty(notebook) {
    notebook.updatedAt = nowISO()
    for (const page of notebook.pages) {
      if (page._dirty && page.strokes !== null) {
        if (Bridge.savePage(notebook.notebookId, page.pageId, JSON.stringify(page.strokes)) !== 'ok') return false
        page._dirty = false
      }
    }
    // meta always written (covers updatedAt, page add/delete/reorder, template, title) — it's tiny
    return Bridge.saveMeta(notebook.notebookId, JSON.stringify(buildMeta(notebook))) === 'ok'
  },

  // Lazy open: load the meta (migrates a legacy notebook on demand) → notebook with strokes=null pages.
  loadMeta(notebookId) {
    const raw = Bridge.loadMeta(notebookId)
    return raw === 'null' ? null : metaToNotebook(raw)
  },

  // Read ONE page's raw JSON (no parse) — cheap; used to size-check a page before deciding whether to
  // render its strokes immediately or defer (template-first) for a heavy page.
  loadPageRaw(notebookId, pageId) {
    const raw = Bridge.loadPage(notebookId, pageId)
    return (raw === null || raw === undefined) ? '[]' : raw
  },

  // Parse a raw strokes JSON string into an array.
  parseStrokes(raw) {
    try { const s = JSON.parse(raw); if (Array.isArray(s)) return s } catch (e) {}
    return []
  },

  // Load ONE page's strokes (read + parse).
  loadPageStrokes(notebookId, pageId) {
    return this.parseStrokes(this.loadPageRaw(notebookId, pageId))
  },

  // Library preload: cache an already-migrated notebook's tiny meta (no migration → cheap; a legacy
  // notebook returns null and just migrates later on its first real open).
  preloadMeta(notebookId) {
    const raw = Bridge.peekMeta(notebookId)
    if (raw !== 'null') _metaCache[notebookId] = raw; else delete _metaCache[notebookId]
  },

  // Take the preloaded meta as a fresh lazy notebook (parsed each call so the cache isn't mutated).
  takeCachedMeta(notebookId) {
    const raw = _metaCache[notebookId]
    return raw ? metaToNotebook(raw) : null
  },

  // Native ships the raw on-disk JSON; V8 here does the single parse (org.json on the native side
  // was the cold-open bottleneck).
  loadNotebook(notebookId) {
    const raw = Bridge.loadNotebookRaw(notebookId)
    if (raw === 'null') return null
    try {
      const data = JSON.parse(raw)
      if (validateNotebook(data)) return data
    } catch (e) {}
    return null
  },

  deleteNotebook(notebookId) {
    return Bridge.deleteNotebook(notebookId) === 'ok'
  },

  // Capture the thumbnail from the NATIVE ink surface (the true display); the web canvas is stale
  // because writing goes only to the surface. Native crops the paper region + scales + saves.
  saveThumbnail(notebookId) {
    Bridge.captureThumbnail(notebookId)
  },

  getThumbnailUrl(notebookId) {
    return Bridge.getThumbnailDataUrl(notebookId)   // base64 data URL: always fresh, no async decode
  }
}
