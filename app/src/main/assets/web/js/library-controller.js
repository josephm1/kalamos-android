let libraryData = null
let activeFolderId = ''
let contextMenuEl = null
let libraryPage = 0

function initLibrary() {
  const settingsBtn = document.getElementById('btn-settings')
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings)
  loadLibrary()
}

// ============== SETTINGS / STORAGE ==============

function fmtBytes(b) {
  b = b || 0
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB'
  return b + ' B'
}

let settingsBody = null   // the open Settings panel body, so a folder pick can refresh it

function openSettings() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const modal = document.createElement('div')
  modal.className = 'modal'

  const h3 = document.createElement('h3')
  h3.textContent = 'Storage'
  modal.appendChild(h3)

  const body = document.createElement('div')
  body.className = 'storage-body'
  modal.appendChild(body)
  settingsBody = body

  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'btn'
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', function() { overlay.remove(); settingsBody = null })
  actions.appendChild(closeBtn)
  modal.appendChild(actions)

  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  renderStorageSettings(body)
}

function renderStorageSettings(body) {
  body.innerHTML = ''
  let info
  try { info = JSON.parse(Bridge.getStorageInfo()) } catch (e) { info = {} }

  const usage = document.createElement('div')
  usage.className = 'storage-usage'
  usage.textContent = 'Your notes use ' + fmtBytes(info.dataSize)
  body.appendChild(usage)

  const curLbl = document.createElement('div')
  curLbl.className = 'storage-current-label'
  curLbl.textContent = 'Current location'
  body.appendChild(curLbl)
  const curPath = document.createElement('div')
  curPath.className = 'storage-current-path'
  curPath.textContent = info.currentPath || ''
  body.appendChild(curPath)

  // Pick any folder (internal or SD) via the system picker.
  const chooseBtn = document.createElement('button')
  chooseBtn.className = 'btn storage-action'
  chooseBtn.textContent = 'Choose folder…'
  chooseBtn.addEventListener('click', function() {
    if (!info.hasAllFilesAccess) {
      showConfirm('Permission needed',
        'Choosing a folder (e.g. on the SD card) needs "All files access". Grant it in settings, then come back and choose again.',
        function() { Bridge.requestAllFilesAccess() })
      return
    }
    Bridge.pickStorageFolder()
  })
  body.appendChild(chooseBtn)

  // Reset to internal storage (only shown when not already internal).
  const internal = (info.locations || []).find(function(l) { return l.label === 'Internal storage' })
  if (internal && !internal.current) {
    const resetBtn = document.createElement('button')
    resetBtn.className = 'btn storage-action'
    resetBtn.textContent = 'Use internal storage'
    resetBtn.addEventListener('click', function() {
      body.innerHTML = '<div class="storage-usage">Moving notes… please wait.</div>'
      setTimeout(function() {
        const res = Bridge.setStorageLocation(internal.path)
        Bridge.showToast(res === 'ok' ? 'Notes moved to internal storage' : 'Move failed (' + res + ')')
        if (res === 'ok') loadLibrary()
        renderStorageSettings(body)
      }, 60)
    })
    body.appendChild(resetBtn)
  }
}

// Called from native after the system folder picker returns + migration completes.
window.onStorageFolderPicked = function(status, path) {
  if (status === 'ok') {
    loadLibrary()
    if (settingsBody) renderStorageSettings(settingsBody)
    Bridge.showToast('Notes moved to ' + (path || 'new folder'))
  } else if (status === 'need_permission') {
    Bridge.requestAllFilesAccess()
    Bridge.showToast('Grant "All files access", then choose again')
  } else if (status === 'cancelled') {
    // user backed out — do nothing
  } else {
    Bridge.showToast('Could not use that folder (' + status + ')')
  }
}

function loadLibrary() {
  const _t0 = Date.now()  // DIAG to remove
  libraryData = Storage.loadLibrary()
  const _t1 = Date.now()  // DIAG to remove
  if (!libraryData.folders) libraryData.folders = []
  renderLibrary()
  console.log('DIAG library load: loadIndex=' + (_t1-_t0) + 'ms render=' + (Date.now()-_t1) + 'ms notebooks=' + (libraryData.notebooks ? libraryData.notebooks.length : 0))  // DIAG to remove
}

function saveLibrary() {
  Storage.saveLibrary(libraryData)
}

function renderLibrary() {
  renderFolderBar()
  renderGrid()
  renderEmptyState()
}

function renderFolderBar() {
  const bar = document.getElementById('folder-bar')
  bar.innerHTML = ''

  const allBtn = document.createElement('button')
  allBtn.className = 'folder-btn' + (activeFolderId === '' ? ' active' : '')
  allBtn.textContent = 'All'
  allBtn.addEventListener('click', function() { activeFolderId = ''; libraryPage = 0; renderLibrary() })
  bar.appendChild(allBtn)

  for (const f of libraryData.folders) {
    const btn = document.createElement('button')
    btn.className = 'folder-btn' + (f.folderId === activeFolderId ? ' active' : '')
    btn.textContent = f.name

    const del = document.createElement('span')
    del.className = 'delete-fold'
    del.textContent = '×'
    del.addEventListener('click', function(e) {
      e.stopPropagation()
      showDeleteFolderConfirm(f)
    })
    btn.appendChild(del)

    btn.addEventListener('click', function() { activeFolderId = f.folderId; libraryPage = 0; renderLibrary() })
    btn.addEventListener('contextmenu', function(e) {
      e.preventDefault()
      showContextMenu(e.clientX, e.clientY, f)
    })
    bar.appendChild(btn)
  }

  const input = document.createElement('input')
  input.id = 'folder-input'
  input.type = 'text'
  input.placeholder = '+ folder'
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && this.value.trim()) {
      libraryData.folders.push(createFolder(this.value.trim()))
      saveLibrary()
      this.value = ''
      renderLibrary()
    }
  })
  bar.appendChild(input)
}

// 8 notebooks + the New Note card (top-left) = a 3x3 page. Paginating means only the visible
// page's ~8 thumbnails ever load, which keeps the grid light with many notebooks AND keeps each
// render a single synchronous pass (streaming across frames breaks the e-ink refresh).
const PER_PAGE = 8

function renderGrid() {
  const grid = document.getElementById('grid')
  grid.innerHTML = ''

  const filtered = libraryData.notebooks
    .filter(function(n) { return !activeFolderId || n.folderId === activeFolderId })
    .sort(function(a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt) })

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  if (libraryPage >= totalPages) libraryPage = totalPages - 1
  if (libraryPage < 0) libraryPage = 0

  // New Note is always the top-left cell.
  grid.appendChild(buildNewNoteCard())

  const start = libraryPage * PER_PAGE
  const visible = filtered.slice(start, start + PER_PAGE)
  visible.forEach(function(info) {
    grid.appendChild(buildNoteCard(info))
  })

  renderPagination(totalPages)

  // Preload ONLY the visible notebooks' metas (structure, no strokes), off the render path, so a tap
  // opens from cache and lazy-loads just the current page. Re-runs each render (and on pagination) so
  // it always tracks the current page's selection — never the whole library.
  setTimeout(function() {
    visible.forEach(function(info) { Storage.preloadMeta(info.notebookId) })
  }, 50)
}

function buildNoteCard(info) {
  const card = document.createElement('div')
  card.className = 'note-card'

  const thumb = document.createElement('div')
  thumb.className = 'thumb'
  const thumbUrl = Storage.getThumbnailUrl(info.notebookId)
  if (thumbUrl) {
    const img = document.createElement('img')
    img.src = thumbUrl
    img.alt = ''
    img.addEventListener('error', function() { this.style.display = 'none' })
    thumb.appendChild(img)
  } else {
    const icon = document.createElement('span')
    icon.className = 'empty-icon'
    icon.textContent = '📄'
    thumb.appendChild(icon)
  }
  card.appendChild(thumb)

  const infoDiv = document.createElement('div')
  infoDiv.className = 'info'

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = info.title
  infoDiv.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = timeAgo(info.updatedAt)
  infoDiv.appendChild(meta)

  if (info.folderId) {
    const folder = libraryData.folders.find(function(f) { return f.folderId === info.folderId })
    if (folder) {
      const badge = document.createElement('span')
      badge.className = 'folder-badge'
      badge.textContent = folder.name
      infoDiv.appendChild(badge)
    }
  }

  card.appendChild(infoDiv)
  card.addEventListener('click', function() { App.showEditor(info.notebookId) })
  card.addEventListener('contextmenu', function(e) {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, info)
  })
  return card
}

function buildNewNoteCard() {
  const newCard = document.createElement('div')
  newCard.className = 'new-note-card'
  newCard.innerHTML = '<div><div class="plus">+</div><div class="label">New Note</div></div>'
  newCard.addEventListener('click', createNewNotebook)
  return newCard
}

// Hardware page-turn buttons in the library = pagination prev/next.
function libraryPageTurn(dir) {
  if (!libraryData) return
  const filtered = libraryData.notebooks.filter(function(n) { return !activeFolderId || n.folderId === activeFolderId })
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  if (dir === 'down' && libraryPage < totalPages - 1) { libraryPage++; renderLibrary() }
  else if (dir === 'up' && libraryPage > 0) { libraryPage--; renderLibrary() }
}

function renderPagination(totalPages) {
  const el = document.getElementById('pagination')
  el.innerHTML = ''
  if (totalPages <= 1) return

  const prev = document.createElement('button')
  prev.className = 'page-btn'
  prev.innerHTML = '&#9664;'
  prev.disabled = libraryPage <= 0
  prev.addEventListener('click', function() { if (libraryPage > 0) { libraryPage--; renderGrid() } })
  el.appendChild(prev)

  const label = document.createElement('span')
  label.className = 'page-label'
  label.textContent = (libraryPage + 1) + ' / ' + totalPages
  el.appendChild(label)

  const next = document.createElement('button')
  next.className = 'page-btn'
  next.innerHTML = '&#9654;'
  next.disabled = libraryPage >= totalPages - 1
  next.addEventListener('click', function() { if (libraryPage < totalPages - 1) { libraryPage++; renderGrid() } })
  el.appendChild(next)
}

function renderEmptyState() {
  const empty = document.getElementById('empty-state')
  if (libraryData.notebooks.length === 0) {
    empty.style.display = 'flex'
  } else {
    empty.style.display = 'none'
  }
}

function createNewNotebook() {
  const nb = createNotebook('Notebook', activeFolderId !== '' ? activeFolderId : '')
  libraryData.notebooks.push({
    notebookId: nb.notebookId,
    title: nb.title,
    folderId: nb.folderId,
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
    defaultTemplate: nb.defaultTemplate
  })
  saveLibrary()
  Storage.saveNotebook(nb)
  // Thumbnail is captured from the native surface when leaving the editor (no page rendered yet).
  App.showEditor(nb.notebookId)
}

function showContextMenu(x, y, target) {
  removeContextMenu()
  contextMenuEl = document.createElement('div')
  contextMenuEl.className = 'context-menu'
  contextMenuEl.style.left = x + 'px'
  contextMenuEl.style.top = y + 'px'

  if (target.folderId !== undefined && target.notebookId === undefined) {
    // Folder context
    const rename = document.createElement('div')
    rename.className = 'item'
    rename.textContent = 'Rename folder'
    rename.addEventListener('click', function() { renameFolder(target); removeContextMenu() })
    contextMenuEl.appendChild(rename)

    const del = document.createElement('div')
    del.className = 'item danger'
    del.textContent = 'Delete folder'
    del.addEventListener('click', function() { removeContextMenu(); showDeleteFolderConfirm(target) })
    contextMenuEl.appendChild(del)
  } else if (target.notebookId) {
    // Notebook context
    const rename = document.createElement('div')
    rename.className = 'item'
    rename.textContent = 'Rename'
    rename.addEventListener('click', function() { renameNote(target); removeContextMenu() })
    contextMenuEl.appendChild(rename)

    const del = document.createElement('div')
    del.className = 'item danger'
    del.textContent = 'Delete'
    del.addEventListener('click', function() { removeContextMenu(); showDeleteNoteConfirm(target) })
    contextMenuEl.appendChild(del)

    const moveLabel = document.createElement('div')
    moveLabel.className = 'item'
    moveLabel.textContent = 'Move to folder'
    contextMenuEl.appendChild(moveLabel)

    for (const f of libraryData.folders) {
      if (f.folderId === target.folderId) continue
      const opt = document.createElement('div')
      opt.className = 'item'
      opt.textContent = '  ' + f.name
      opt.addEventListener('click', function() { moveNote(target, f.folderId); removeContextMenu() })
      contextMenuEl.appendChild(opt)
    }

    if (target.folderId) {
      const opt = document.createElement('div')
      opt.className = 'item'
      opt.textContent = '  (No folder)'
      opt.addEventListener('click', function() { moveNote(target, ''); removeContextMenu() })
      contextMenuEl.appendChild(opt)
    }
  }

  document.body.appendChild(contextMenuEl)
  document.addEventListener('click', removeContextMenu, { once: true })
}

function removeContextMenu() {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null }
}

function renameNote(info) {
  const newTitle = prompt('Rename note:', info.title)
  if (newTitle && newTitle.trim()) {
    info.title = newTitle.trim()
    // Also update the notebook file's title
    const nb = Storage.loadNotebook(info.notebookId)
    if (nb) {
      nb.title = newTitle.trim()
      Storage.saveNotebook(nb)
    }
    saveLibrary()
    renderLibrary()
  }
}

function showDeleteNoteConfirm(info) {
  showConfirm('Delete "' + info.title + '"?', 'This cannot be undone.', function() {
    Storage.deleteNotebook(info.notebookId)
    const idx = libraryData.notebooks.indexOf(info)
    if (idx !== -1) libraryData.notebooks.splice(idx, 1)
    saveLibrary()
    renderLibrary()
  })
}

function renameFolder(folder) {
  const newName = prompt('Rename folder:', folder.name)
  if (newName && newName.trim()) {
    folder.name = newName.trim()
    saveLibrary()
    renderLibrary()
  }
}

function showDeleteFolderConfirm(folder) {
  showConfirm('Delete "' + folder.name + '"?', 'Notes will be moved to "No folder".', function() {
    for (const n of libraryData.notebooks) {
      if (n.folderId === folder.folderId) {
        n.folderId = ''
        // Update notebook file
        const nb = Storage.loadNotebook(n.notebookId)
        if (nb) { nb.folderId = ''; Storage.saveNotebook(nb) }
      }
    }
    const idx = libraryData.folders.indexOf(folder)
    if (idx !== -1) libraryData.folders.splice(idx, 1)
    saveLibrary()
    renderLibrary()
  })
}

function moveNote(info, folderId) {
  info.folderId = folderId
  const nb = Storage.loadNotebook(info.notebookId)
  if (nb) { nb.folderId = folderId; Storage.saveNotebook(nb) }
  saveLibrary()
  renderLibrary()
}

function showConfirm(title, message, onConfirm) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'

  const modal = document.createElement('div')
  modal.className = 'modal'

  const h3 = document.createElement('h3')
  h3.textContent = title
  modal.appendChild(h3)

  const p = document.createElement('p')
  p.textContent = message
  modal.appendChild(p)

  const actions = document.createElement('div')
  actions.className = 'modal-actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'btn'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', function() { overlay.remove() })
  actions.appendChild(cancelBtn)

  const confirmBtn = document.createElement('button')
  confirmBtn.className = 'btn active'
  confirmBtn.textContent = 'Delete'
  confirmBtn.addEventListener('click', function() {
    overlay.remove()
    if (onConfirm) onConfirm()
  })
  actions.appendChild(confirmBtn)

  modal.appendChild(actions)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}

function timeAgo(isoString) {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const diff = now - then
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return 'Just now'
  if (minutes < 60) return minutes + 'm ago'
  if (hours < 24) return hours + 'h ago'
  if (days < 7) return days + 'd ago'
  const d = new Date(then)
  return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
}
