const History = {
  _stack: [],
  _redoStack: [],

  push(undoFn, redoFn) {
    this._stack.push({ undo: undoFn, redo: redoFn })
    this._redoStack = []
    this.updateButtons()
  },

  undo() {
    if (this._stack.length === 0) return
    const action = this._stack.pop()
    action.undo()
    this._redoStack.push(action)
    this.updateButtons()
  },

  redo() {
    if (this._redoStack.length === 0) return
    const action = this._redoStack.pop()
    action.redo()
    this._stack.push(action)
    this.updateButtons()
  },

  clear() {
    this._stack = []
    this._redoStack = []
    this.updateButtons()
  },

  updateButtons() {
    const undoBtn = document.getElementById('btn-undo')
    const redoBtn = document.getElementById('btn-redo')
    if (undoBtn) undoBtn.disabled = this._stack.length === 0
    if (redoBtn) redoBtn.disabled = this._redoStack.length === 0
  },

  get canUndo() { return this._stack.length > 0 },
  get canRedo() { return this._redoStack.length > 0 }
}
