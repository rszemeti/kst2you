/**
 * ContestLog — lightweight worked/skip tracker for contest operation.
 * Storage keys (all per base callsign):
 *   kst2you_contest_log_{base}      { worked: [{callsign,locator,dist,bearing,ts},...], skip: [...] }
 *   kst2you_contest_settings_{base} { active, workedDisplay, skipDisplay, mapDisplay }
 */
var ContestLog = (function () {
  'use strict';

  var _baseKey = null;
  var _log      = { worked: [], skip: [] };  // arrays of entry objects
  var _index    = {};                        // { callsign: 'worked'|'skip' } for fast lookup
  var _settings = {
    active:        false,
    workedDisplay: 'grey',   // 'hide' | 'grey'
    skipDisplay:   'hide',   // 'hide' | 'grey'
    mapDisplay:    'dim',    // 'hide' | 'dim'
  };

  // ── Helpers ───────────────────────────────────────────
  function baseCall(cs) {
    return (cs || '').toUpperCase().replace(/[\/\-].*$/, '');
  }
  function logKey()      { return 'kst2you_contest_log_'      + _baseKey; }
  function settingsKey() { return 'kst2you_contest_settings_' + _baseKey; }

  // ── Persistence ───────────────────────────────────────
  function load() {
    try { var l = localStorage.getItem(logKey());      if (l) _log      = JSON.parse(l); } catch(e) { _log = { worked: [], skip: [] }; }
    try { var s = localStorage.getItem(settingsKey()); if (s) _settings = Object.assign(_settings, JSON.parse(s)); } catch(e) {}
    _rebuildIndex();
  }
  function saveLog() {
    if (!_baseKey) return;
    try { localStorage.setItem(logKey(), JSON.stringify(_log)); } catch(e) {}
  }
  function saveSettings() {
    if (!_baseKey) return;
    try { localStorage.setItem(settingsKey(), JSON.stringify(_settings)); } catch(e) {}
  }
  function _rebuildIndex() {
    _index = {};
    (_log.worked || []).forEach(function(e) { _index[e.callsign] = 'worked'; });
    (_log.skip   || []).forEach(function(e) { _index[e.callsign] = 'skip'; });
  }

  // ── Badge / scoreboard ────────────────────────────────
  function updateScoreboard() {
    var el = document.getElementById('contest-score');
    if (!el) return;
    if (!_settings.active) { el.style.display = 'none'; return; }
    var w = (_log.worked || []).length;
    var s = (_log.skip   || []).length;
    el.textContent = 'Worked: ' + w + ' · Skip: ' + s;
    el.style.display = '';
  }

  // ── Log tab rendering ─────────────────────────────────
  function renderLogTab() {
    var tab = document.getElementById('contest-log-tab-content');
    if (!tab) return;

    function makeRows(arr, type) {
      if (!arr.length) return '<tr><td colspan="6" class="text-center text-muted py-3">None yet</td></tr>';
      return arr.map(function(e) {
        var d = new Date(e.ts);
        var timeStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
        return '<tr>' +
          '<td><strong>' + escHtml(e.callsign) + '</strong></td>' +
          '<td>' + escHtml(e.locator || '—') + '</td>' +
          '<td>' + (e.dist ? Math.round(e.dist) + ' km' : '—') + '</td>' +
          '<td>' + (e.bearing != null ? Math.round(e.bearing) + '°' : '—') + '</td>' +
          '<td>' + timeStr + '</td>' +
          '<td><button class="btn btn-xs btn-outline-secondary clog-unmark" data-call="' + escHtml(e.callsign) + '">Unmark</button></td>' +
        '</tr>';
      }).join('');
    }

    tab.innerHTML =
      '<div class="d-flex justify-content-between align-items-center mb-2">' +
        '<h6 class="mb-0">Session Log</h6>' +
        '<div>' +
          '<button class="btn btn-sm btn-outline-secondary me-2" id="clog-export">Export CSV</button>' +
          '<button class="btn btn-sm btn-outline-danger" id="clog-reset">Reset</button>' +
        '</div>' +
      '</div>' +
      '<h6 class="clog-section-hdr worked">Worked <span class="badge bg-success">' + (_log.worked||[]).length + '</span></h6>' +
      '<table class="table table-sm table-hover clog-table"><thead><tr>' +
        '<th>Call</th><th>Locator</th><th>Dist</th><th>Brg</th><th>Time</th><th></th>' +
      '</tr></thead><tbody>' + makeRows(_log.worked || [], 'worked') + '</tbody></table>' +
      '<h6 class="clog-section-hdr skip mt-3">Skip <span class="badge bg-secondary">' + (_log.skip||[]).length + '</span></h6>' +
      '<table class="table table-sm table-hover clog-table"><thead><tr>' +
        '<th>Call</th><th>Locator</th><th>Dist</th><th>Brg</th><th>Time</th><th></th>' +
      '</tr></thead><tbody>' + makeRows(_log.skip || [], 'skip') + '</tbody></table>';

    // Unmark buttons
    tab.querySelectorAll('.clog-unmark').forEach(function(btn) {
      btn.addEventListener('click', function() {
        ContestLog.unmark(btn.dataset.call);
      });
    });

    // Export
    var expBtn = document.getElementById('clog-export');
    if (expBtn) expBtn.addEventListener('click', exportCSV);

    // Reset
    var resetBtn = document.getElementById('clog-reset');
    if (resetBtn) resetBtn.addEventListener('click', function() {
      if (confirm('Clear entire session log?')) ContestLog.clear();
    });
  }

  function exportCSV() {
    var rows = [['Type','Callsign','Locator','Distance km','Bearing','Time']];
    (_log.worked||[]).forEach(function(e) {
      rows.push(['worked', e.callsign, e.locator||'', e.dist ? Math.round(e.dist) : '', e.bearing != null ? Math.round(e.bearing) : '', new Date(e.ts).toISOString()]);
    });
    (_log.skip||[]).forEach(function(e) {
      rows.push(['skip', e.callsign, e.locator||'', e.dist ? Math.round(e.dist) : '', e.bearing != null ? Math.round(e.bearing) : '', new Date(e.ts).toISOString()]);
    });
    var csv = rows.map(function(r) { return r.join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'session_log_' + (_baseKey || 'export') + '.csv';
    a.click();
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Log tab visibility ────────────────────────────────
  function setLogTabVisible(visible) {
    var li = document.getElementById('contest-log-tab-li');
    if (li) li.style.display = visible ? '' : 'none';
  }

  // ── Apply display settings to station list + map ──────
  function applyToStation(callsign) {
    var state = _index[callsign];
    if (!state || !_settings.active) {
      _showStation(callsign);
      return;
    }
    var display = state === 'worked' ? _settings.workedDisplay : _settings.skipDisplay;
    if (display === 'hide') {
      _hideStation(callsign);
    } else {
      _greyStation(callsign);
    }
  }

  function _hideStation(callsign) {
    // User list row
    var row = document.querySelector('#userListTable tbody tr[data-callsign="' + callsign + '"]');
    if (row) row.style.display = 'none';
    // Map marker opacity handled externally via getMapOpacity()
  }
  function _greyStation(callsign) {
    var row = document.querySelector('#userListTable tbody tr[data-callsign="' + callsign + '"]');
    if (row) { row.style.display = ''; row.classList.add('clog-greyed'); }
  }
  function _showStation(callsign) {
    var row = document.querySelector('#userListTable tbody tr[data-callsign="' + callsign + '"]');
    if (row) { row.style.display = ''; row.classList.remove('clog-greyed'); }
  }

  // ── Public API ────────────────────────────────────────
  return {

    init: function(myCallsign) {
      _baseKey = baseCall(myCallsign);
      load();
      setLogTabVisible(_settings.active);
      updateScoreboard();
    },

    /** Mark a station as worked or skip. */
    mark: function(callsign, type, locator, dist, brg) {
      if (!_baseKey) return;
      callsign = (callsign || '').toUpperCase();
      // Remove from whichever list it's currently in
      ContestLog.unmark(callsign, true);
      var entry = { callsign: callsign, locator: locator || null, dist: dist || null, bearing: brg || null, ts: Date.now() };
      if (type === 'worked') {
        _log.worked.push(entry);
      } else {
        _log.skip.push(entry);
      }
      _index[callsign] = type;
      saveLog();
      updateScoreboard();
      renderLogTab();
      applyToStation(callsign);
      if (typeof window.contestRefreshMapMarkers === 'function') window.contestRefreshMapMarkers();
      // Update chat popup badge if open for this callsign
      _updateChatBadge(callsign);
    },

    /** Remove a station from worked/skip. */
    unmark: function(callsign, _silent) {
      callsign = (callsign || '').toUpperCase();
      _log.worked = (_log.worked || []).filter(function(e) { return e.callsign !== callsign; });
      _log.skip   = (_log.skip   || []).filter(function(e) { return e.callsign !== callsign; });
      delete _index[callsign];
      if (!_silent) {
        saveLog();
        updateScoreboard();
        renderLogTab();
        applyToStation(callsign);
        if (typeof window.contestRefreshMapMarkers === 'function') window.contestRefreshMapMarkers();
        _updateChatBadge(callsign);
      }
    },

    /** Return 'worked', 'skip', or null. */
    getState: function(callsign) {
      return _index[(callsign || '').toUpperCase()] || null;
    },

    /** For map marker rendering — returns opacity multiplier (1, 0.25, or 0). */
    getMapOpacity: function(callsign) {
      if (!_settings.active) return 1;
      var state = _index[(callsign || '').toUpperCase()];
      if (!state) return 1;
      var display = state === 'worked' ? _settings.workedDisplay : _settings.skipDisplay;
      if (display === 'hide' && _settings.mapDisplay === 'hide') return 0;
      if (_settings.mapDisplay === 'dim') return 0.25;
      return 1;
    },

    /** Re-apply contest display to all rows in the user list and map markers. */
    applyAll: function() {
      if (typeof window.contestRefreshMapMarkers === 'function') window.contestRefreshMapMarkers();
      if (!_settings.active) {
        // Clear all contest styling
        document.querySelectorAll('#userListTable tbody tr').forEach(function(row) {
          row.style.display = '';
          row.classList.remove('clog-greyed');
        });
        return;
      }
      document.querySelectorAll('#userListTable tbody tr').forEach(function(row) {
        var call = row.dataset.callsign;
        if (call) applyToStation(call);
      });
    },

    clear: function() {
      _log = { worked: [], skip: [] };
      _index = {};
      saveLog();
      updateScoreboard();
      renderLogTab();
      ContestLog.applyAll();
    },

    // ── Settings accessors ──────────────────────────────
    isActive: function() { return !!_settings.active; },

    setActive: function(val) {
      _settings.active = !!val;
      saveSettings();
      setLogTabVisible(_settings.active);
      updateScoreboard();
      ContestLog.applyAll();
      // Sync settings UI checkbox
      var cb = document.getElementById('contest-mode-active');
      if (cb) cb.checked = _settings.active;
    },

    getSetting: function(key) { return _settings[key]; },

    setSetting: function(key, val) {
      _settings[key] = val;
      saveSettings();
      if (_settings.active) ContestLog.applyAll();
    },

    renderLogTab: renderLogTab,
    updateScoreboard: updateScoreboard,
  };

  function _updateChatBadge(callsign) {
    // If the chat popup is open for this callsign, refresh its contest badge
    if (typeof window.chatPopupCallsign !== 'undefined' && window.chatPopupCallsign === callsign) {
      var badge = document.getElementById('chatContestBadge');
      var state = ContestLog.getState(callsign);
      if (badge) {
        badge.textContent = state === 'worked' ? '✓ Worked' : state === 'skip' ? '✗ Skip' : '';
        badge.className = 'chat-contest-badge' + (state ? ' clog-' + state : ' d-none');
      }
    }
  }

})();
