const PenPriority = (function() {

  const MODE_CAPTURE = 'capture'
  const MODE_SYNC = 'sync'

  let _mode = MODE_CAPTURE
  let _syncTimer = null
  let _idleThreshold = 800
  let _deferredWork = []
  let _onModeChange = null

  function enterCapture() {
    if (_mode === MODE_CAPTURE) return
    _mode = MODE_CAPTURE
    _cancelSync()
  }

  function scheduleSync(thresholdMs) {
    _cancelSync()
    _syncTimer = setTimeout(function() {
      _mode = MODE_SYNC
      if (_onModeChange) _onModeChange(MODE_SYNC)
      _drainDeferred()
    }, thresholdMs || _idleThreshold)
  }

  function _cancelSync() {
    if (_syncTimer) {
      clearTimeout(_syncTimer)
      _syncTimer = null
    }
    _mode = MODE_CAPTURE
    if (_onModeChange) _onModeChange(MODE_CAPTURE)
  }

  function defer(label, fn) {
    if (fn === undefined) return
    if (_mode === MODE_SYNC) {
      try { fn() } catch (e) { console.warn('PenPriority.defer[' + label + ']:', e) }
      return
    }
    _deferredWork.push({label: label, fn: fn})
  }

  function _drainDeferred() {
    var work = _deferredWork
    _deferredWork = []
    for (var i = 0; i < work.length; i++) {
      try { work[i].fn() }
      catch (e) { console.warn('PenPriority deferred [' + work[i].label + '] failed:', e) }
    }
  }

  function isCapture() { return _mode === MODE_CAPTURE }

  return {
    enterCapture: enterCapture,
    scheduleSync: scheduleSync,
    defer: defer,
    isCapture: isCapture,
    setOnModeChange: function(cb) { _onModeChange = cb },
    setThreshold: function(ms) { _idleThreshold = ms },
  }
})()
