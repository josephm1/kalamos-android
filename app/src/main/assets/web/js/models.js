function uid() {
  return (Math.random().toString(36).substring(2,6) + '-' +
          Math.random().toString(36).substring(2,6) + '-' +
          Math.random().toString(36).substring(2,6))
}

function nowISO() {
  return new Date().toISOString()
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o))
}

const DEFAULT_TEMPLATE = { type: 'ruled', spacing: 32, margin: 72 }

function createPage(template) {
  return {
    pageId: 'p-' + uid(),
    template: template ? deepClone(template) : deepClone(DEFAULT_TEMPLATE),
    strokes: []
  }
}

function createNotebook(title, folderId, template) {
  const now = nowISO()
  return {
    notebookId: 'nb-' + uid(),
    title: title || 'Notebook',
    folderId: folderId || '',
    createdAt: now,
    updatedAt: now,
    defaultTemplate: template ? deepClone(template) : deepClone(DEFAULT_TEMPLATE),
    pages: [createPage(template)]
  }
}

function createFolder(name) {
  return {
    folderId: 'fld-' + uid(),
    name: name || 'New Folder',
    createdAt: nowISO()
  }
}

function createStroke(tool, color, width, points) {
  return {
    id: 's-' + uid(),
    tool: tool || 'pen',
    color: color || '#111111',
    width: width || 3,
    points: points || []
  }
}

function validateNotebook(data) {
  if (!data || !data.pages || !Array.isArray(data.pages) || data.pages.length === 0) return false
  if (!data.notebookId) data.notebookId = 'nb-' + uid()
  if (!data.title) data.title = 'Notebook'
  if (!data.createdAt) data.createdAt = nowISO()
  data.updatedAt = nowISO()
  if (!data.defaultTemplate) data.defaultTemplate = deepClone(DEFAULT_TEMPLATE)
  for (const p of data.pages) {
    if (!p.pageId) p.pageId = 'p-' + uid()
    if (!p.template) p.template = deepClone(DEFAULT_TEMPLATE)
    if (!p.strokes) p.strokes = []
  }
  return true
}
