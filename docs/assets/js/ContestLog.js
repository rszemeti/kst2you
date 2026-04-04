/**
 * ContestLog — lightweight worked/skip tracker for contest operation.
 * Storage keys (all per base callsign):
 *   kst2you_contest_log_{base}      { worked: [{callsign,locator,dist,bearing,ts},...], skip: [...] }
 *   kst2you_contest_settings_{base} { active, workedDisplay, skipDisplay, mapDisplay }
 *
 * Cloud sync: saves to Firestore via kst-actions cloud function.
 *   Each session is a Firestore document; reset archives (doesn't delete).
 */
var ContestLog = (function () {
  'use strict';

  var CLOUD_URL = 'https://europe-west2-kst-chat.cloudfunctions.net/contest-log';
  var USER_SETTINGS_URL = 'https://europe-west2-kst-chat.cloudfunctions.net/user-settings';

  var _baseKey   = null;
  var _cloudTimer = null;   // debounce handle for cloud saves
  var _syncing   = false;   // true while a cloud save is in flight
  var _showHistory = false; // true to include deleted entries in log display
  var _log      = { worked: [], skip: [] };  // arrays of entry objects
  var _index    = {};                        // { callsign: 'worked'|'skip' } for fast lookup
  var _settings = {
    active:        false,
    workedDisplay: 'grey',   // 'hide' | 'grey'
    skipDisplay:   'hide',   // 'hide' | 'grey'
    mapDisplay:    'dim',    // 'hide' | 'dim'
    exchangeMode:  'simple', // 'simple' | 'exchange'
    nextSerial:    1,        // auto-incrementing serial number
    sessionName:   '',       // user-chosen name for this session
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
    _debouncedCloudSave();
  }
  function saveSettings() {
    if (!_baseKey) return;
    try { localStorage.setItem(settingsKey(), JSON.stringify(_settings)); } catch(e) {}
    _debouncedCloudSave();
  }
  function _rebuildIndex() {
    _index = {};
    (_log.worked || []).forEach(function(e) { if (!e.deleted) _index[e.callsign] = 'worked'; });
    (_log.skip   || []).forEach(function(e) { if (!e.deleted) _index[e.callsign] = 'skip'; });
  }

  /** Return only active (non-deleted) entries from a list. */
  function _active(list) {
    return (list || []).filter(function(e) { return !e.deleted; });
  }

  // ── Cloud sync ────────────────────────────────────────
  function _debouncedCloudSave() {
    if (_cloudTimer) clearTimeout(_cloudTimer);
    _cloudTimer = setTimeout(_cloudSave, 2000);  // 2s debounce
  }

  /** Merge two logs by union on callsign (keeps the newest entry per callsign). */
  function _mergeLogs(a, b) {
    function mergeList(listA, listB) {
      var map = {};
      // Index active entries by callsign from both sides
      (listA || []).forEach(function(e) {
        if (!e.deleted) map[e.callsign] = e;
      });
      (listB || []).forEach(function(e) {
        if (!e.deleted && (!map[e.callsign] || (e.ts && e.ts > (map[e.callsign].ts || 0)))) {
          // If we're replacing, mark the old one as superseded
          if (map[e.callsign]) map[e.callsign] = null; // will be excluded from active
          map[e.callsign] = e;
        }
      });
      // Collect all entries: deleted history from both sides + active winners
      var seen = new Set();
      var result = [];
      // Add all deleted/historical entries from both sides
      (listA || []).concat(listB || []).forEach(function(e) {
        var key = e.callsign + '|' + (e.ts || 0) + '|' + (e.deleted ? 'd' : 'a');
        if (!seen.has(key)) { seen.add(key); if (e.deleted) result.push(e); }
      });
      // Add active winners
      Object.values(map).forEach(function(e) { if (e) result.push(e); });
      return result;
    }
    return {
      worked: mergeList(a.worked, b.worked),
      skip:   mergeList(a.skip,   b.skip)
    };
  }

  function _cloudSave() {
    if (!_baseKey || _syncing) return;
    _syncing = true;
    _setCloudIndicator('saving');
    fetch(CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'contestSave',
        data: {
          callsign: _baseKey,
          name: _settings.sessionName || '',
          log: _log,
          settings: { nextSerial: _settings.nextSerial, exchangeMode: _settings.exchangeMode }
        }
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(resp) {
      _syncing = false;
      if (resp.status === 'conflict') {
        // Server has more entries — merge server data into local, then retry
        console.warn('ContestLog: cloud conflict, merging server data');
        var serverLog = resp.serverLog || { worked: [], skip: [] };
        _log = _mergeLogs(_log, serverLog);
        _rebuildIndex();
        try { localStorage.setItem(logKey(), JSON.stringify(_log)); } catch(e) {}
        // Bump serial to max of local and server
        if (resp.serverSettings && resp.serverSettings.nextSerial > (_settings.nextSerial || 1)) {
          _settings.nextSerial = resp.serverSettings.nextSerial;
          try { localStorage.setItem(settingsKey(), JSON.stringify(_settings)); } catch(e) {}
        }
        updateScoreboard();
        renderLogTab();
        _setCloudIndicator('merged');
        // Retry save with merged data after a short delay
        setTimeout(_cloudSave, 500);
      } else {
        _setCloudIndicator(resp.status === 'ok' ? 'saved' : 'error');
      }
    })
    .catch(function() {
      _syncing = false;
      _setCloudIndicator('error');
    });
  }

  function _cloudLoad(callback) {
    if (!_baseKey) { if (callback) callback(); return; }
    _setCloudIndicator('loading');
    fetch(CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'contestLoad', data: { callsign: _baseKey } })
    })
    .then(function(r) { return r.json(); })
    .then(function(resp) {
      if (resp.status === 'ok' && resp.log) {
        // Union-merge: combine local + cloud, keeping newest per callsign
        _log = _mergeLogs(_log, resp.log);
        try { localStorage.setItem(logKey(), JSON.stringify(_log)); } catch(e) {}
        _rebuildIndex();
        // Take the higher serial number
        if (resp.settings) {
          if (resp.settings.nextSerial && resp.settings.nextSerial > (_settings.nextSerial || 1)) {
            _settings.nextSerial = resp.settings.nextSerial;
          }
          if (resp.settings.exchangeMode) _settings.exchangeMode = resp.settings.exchangeMode;
          try { localStorage.setItem(settingsKey(), JSON.stringify(_settings)); } catch(e) {}
        }
        if (resp.name && !_settings.sessionName) _settings.sessionName = resp.name;
        _setCloudIndicator('saved');
      } else {
        _setCloudIndicator('none');
      }
      if (callback) callback();
    })
    .catch(function() {
      _setCloudIndicator('error');
      if (callback) callback();
    });
  }

  function _cloudReset() {
    if (!_baseKey) return;
    fetch(CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'contestReset', data: { callsign: _baseKey } })
    })
    .then(function(r) { return r.json(); })
    .then(function() { _setCloudIndicator('none'); })
    .catch(function() { _setCloudIndicator('error'); });
  }

  function _cloudSaveUserSettings(settings) {
    if (!_baseKey) return;
    fetch(USER_SETTINGS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'userSettingsSave', data: { callsign: _baseKey, settings: settings } })
    }).catch(function() { /* silent */ });
  }

  function _cloudLoadUserSettings(callback) {
    if (!_baseKey) { if (callback) callback(null); return; }
    fetch(USER_SETTINGS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'userSettingsGet', data: { callsign: _baseKey } })
    }).then(function(r) { return r.json(); })
      .then(function(resp) {
        if (callback) callback(resp && resp.status === 'ok' ? resp.settings : null);
      })
      .catch(function() { if (callback) callback(null); });
  }

  function _cloudRestoreSession(sessionId, callback) {
    if (!_baseKey) { if (callback) callback(null); return; }
    _setCloudIndicator('loading');
    fetch(CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'contestRestore', data: { callsign: _baseKey, sessionId: sessionId } })
    })
    .then(function(r) { return r.json(); })
    .then(function(resp) {
      if (resp.status === 'ok') {
        _setCloudIndicator('saved');
      } else {
        _setCloudIndicator('error');
      }
      if (callback) callback(resp);
    })
    .catch(function() {
      _setCloudIndicator('error');
      if (callback) callback(null);
    });
  }

  function _cloudListSessions(callback) {
    if (!_baseKey) { if (callback) callback([]); return; }
    fetch(CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'contestList', data: { callsign: _baseKey } })
    })
    .then(function(r) { return r.json(); })
    .then(function(resp) {
      if (resp.status === 'ok') callback(resp.sessions || []);
      else callback([]);
    })
    .catch(function() { callback([]); });
  }

  function _cloudLoadSession(sessionId, callback) {
    fetch(CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'contestLoadSession', data: { sessionId: sessionId } })
    })
    .then(function(r) { return r.json(); })
    .then(function(resp) { callback(resp); })
    .catch(function() { callback({ status: 'error' }); });
  }

  function _setCloudIndicator(state) {
    var el = document.getElementById('contest-cloud-status');
    if (!el) return;
    var labels = { saving: '☁ Saving…', saved: '☁ Synced', merged: '☁ Merged', loading: '☁ Loading…', error: '☁ Sync error', none: '' };
    var classes = { saving: 'text-info', saved: 'text-success', merged: 'text-warning', loading: 'text-info', error: 'text-danger', none: '' };
    el.textContent = labels[state] || '';
    el.className = 'small ms-2 ' + (classes[state] || '');
  }

  // ── Badge / scoreboard ────────────────────────────────
  function updateScoreboard() {
    var el = document.getElementById('contest-score');
    if (!el) return;
    if (!_settings.active) { el.style.display = 'none'; return; }
    var w = _active(_log.worked).length;
    var s = _active(_log.skip).length;
    el.textContent = 'Worked: ' + w + ' · Skip: ' + s;
    el.style.display = '';
  }

  // ── Log tab rendering ─────────────────────────────────
  function renderLogTab() {
    var tab = document.getElementById('contest-log-tab-content');
    if (!tab) return;

    function makeRows(arr, type) {
      var hasExchange = type === 'worked';
      var cols = hasExchange ? 11 : 6;
      if (!arr.length) return '<tr><td colspan="' + cols + '" class="text-center text-muted py-3">None yet</td></tr>';
      return arr.map(function(e) {
        var d = new Date(e.ts);
        var timeStr = utcStr(d);
        var isDel = !!e.deleted;
        var rowClass = isDel ? ' class="text-decoration-line-through text-muted"' : '';
        var row = '<tr' + rowClass + '>' +
          '<td><strong>' + escHtml(e.callsign) + '</strong></td>' +
          '<td>' + escHtml(e.locator || '—') + '</td>' +
          '<td>' + (e.dist ? Math.round(e.dist) + ' km' : '—') + '</td>' +
          '<td>' + (e.bearing != null ? Math.round(e.bearing) + '°' : '—') + '</td>';
        if (hasExchange) {
          row += '<td>' + escHtml(e.rstSent || '') + '</td>' +
            '<td>' + escHtml(e.serialSent || '') + '</td>' +
            '<td>' + escHtml(e.rstRcvd || '') + '</td>' +
            '<td>' + escHtml(e.serialRcvd || '') + '</td>' +
            '<td class="small">' + escHtml(e.comments || '') + '</td>';
        }
        row += '<td>' + timeStr + '</td>' +
          '<td>' + (isDel
            ? '<span class="text-muted small">' + utcTime(e.deletedAt) + '</span>'
            : '<button class="btn btn-xs btn-outline-secondary clog-unmark" data-call="' + escHtml(e.callsign) + '">Unmark</button>') +
          '</td>' +
        '</tr>';
        return row;
      }).join('');
    }

    var workedList = _showHistory ? (_log.worked || []) : _active(_log.worked);
    var skipList   = _showHistory ? (_log.skip   || []) : _active(_log.skip);

    tab.innerHTML =
      '<div class="d-flex justify-content-between align-items-center mb-2">' +
        '<h6 class="mb-0">Session Log' +
          (_settings.sessionName ? ' — <small class="text-muted">' + escHtml(_settings.sessionName) + '</small>' : '') +
        '</h6>' +
        '<div class="d-flex align-items-center">' +
          '<label class="form-check-label small me-3"><input type="checkbox" class="form-check-input me-1" id="clog-show-history"' + (_showHistory ? ' checked' : '') + '>History</label>' +
          '<button class="btn btn-sm btn-outline-secondary me-1" id="clog-export">CSV</button>' +
          '<button class="btn btn-sm btn-outline-secondary me-2" id="clog-export-edi">EDI</button>' +
          '<button class="btn btn-sm btn-outline-danger" id="clog-reset">Reset</button>' +
        '</div>' +
      '</div>' +
      '<h6 class="clog-section-hdr worked">Worked <span class="badge bg-success">' + _active(_log.worked).length + '</span></h6>' +
      '<table class="table table-sm table-hover clog-table"><thead><tr>' +
        '<th>Call</th><th>Locator</th><th>Dist</th><th>Brg</th><th>RST Sent</th><th>Ser Sent</th><th>RST Rcvd</th><th>Ser Rcvd</th><th>Comments</th><th>Time</th><th></th>' +
      '</tr></thead><tbody>' + makeRows(workedList, 'worked') + '</tbody></table>' +
      '<h6 class="clog-section-hdr skip mt-3">Skip <span class="badge bg-secondary">' + _active(_log.skip).length + '</span></h6>' +
      '<table class="table table-sm table-hover clog-table"><thead><tr>' +
        '<th>Call</th><th>Locator</th><th>Dist</th><th>Brg</th><th>Time</th><th></th>' +
      '</tr></thead><tbody>' + makeRows(skipList, 'skip') + '</tbody></table>';

    // Unmark buttons
    tab.querySelectorAll('.clog-unmark').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var cs = btn.dataset.call;
        // Check if this is a worked entry with exchange data
        var entry = _active(_log.worked).find(function(e) { return e.callsign === cs && (e.rstSent || e.serialSent); });
        if (entry) {
          if (!confirm('Unmark ' + cs + '? This will remove the logged exchange data.')) return;
        }
        ContestLog.unmark(cs);
      });
    });

    // Show history checkbox
    var histCb = document.getElementById('clog-show-history');
    if (histCb) histCb.addEventListener('change', function() {
      _showHistory = this.checked;
      renderLogTab();
    });

    // Export
    var expBtn = document.getElementById('clog-export');
    if (expBtn) expBtn.addEventListener('click', exportCSV);
    var ediBtn = document.getElementById('clog-export-edi');
    if (ediBtn) ediBtn.addEventListener('click', exportEDI);

    // Reset
    var resetBtn = document.getElementById('clog-reset');
    if (resetBtn) resetBtn.addEventListener('click', function() {
      var newName = prompt('Start a new session?\nEnter a name for the new session (e.g. "May 13cm log"):');
      if (newName === null) return; // cancelled
      newName = newName.trim() || 'Untitled session';
      ContestLog.clear(newName);
    });

    // Previous sessions
    var prevHtml =
      '<hr class="my-3">' +
      '<div>' +
        '<a class="text-decoration-none" data-bs-toggle="collapse" href="#clog-prev-sessions" role="button" aria-expanded="false">' +
          '▸ Previous Sessions' +
        '</a>' +
        '<div class="collapse mt-2" id="clog-prev-sessions">' +
          '<div id="clog-prev-list" class="text-muted small">Loading…</div>' +
        '</div>' +
      '</div>';
    tab.insertAdjacentHTML('beforeend', prevHtml);

    // Load session list when expanded
    var collapseEl = document.getElementById('clog-prev-sessions');
    if (collapseEl) {
      collapseEl.addEventListener('show.bs.collapse', function() {
        _renderSessionList();
      }, { once: false });
    }
  }

  function _renderSessionList() {
    var listEl = document.getElementById('clog-prev-list');
    if (!listEl) return;
    listEl.innerHTML = '<span class="text-muted">Loading…</span>';
    _cloudListSessions(function(sessions) {
      if (!sessions.length) {
        listEl.innerHTML = '<span class="text-muted">No saved sessions</span>';
        return;
      }
      var html = '<table class="table table-sm table-hover mb-0"><thead><tr>' +
        '<th>Name</th><th>Created</th><th>Worked</th><th>Skip</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>';
      sessions.forEach(function(s) {
        var created = s.createdAt ? new Date(s.createdAt) : null;
        var dateStr = created ? utcStr(created) : '—';
        var status = s.active
          ? '<span class="badge bg-success">Active</span>'
          : '<span class="badge bg-secondary">Archived</span>';
        html += '<tr>' +
          '<td>' + escHtml(s.name || 'Untitled') + '</td>' +
          '<td>' + escHtml(dateStr) + '</td>' +
          '<td>' + s.workedCount + '</td>' +
          '<td>' + s.skipCount + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' +
            '<button class="btn btn-xs btn-outline-primary clog-view-session" data-sid="' + escHtml(s.sessionId) + '">View</button>' +
            (!s.active ? ' <button class="btn btn-xs btn-outline-success clog-restore-session" data-sid="' + escHtml(s.sessionId) + '">Restore</button>' : '') +
            (!s.active ? ' <button class="btn btn-xs btn-outline-secondary clog-export-session" data-sid="' + escHtml(s.sessionId) + '">CSV</button>' : '') +
            (!s.active ? ' <button class="btn btn-xs btn-outline-secondary clog-edi-session" data-sid="' + escHtml(s.sessionId) + '">EDI</button>' : '') +
          '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
      listEl.innerHTML = html;

      // Wire view buttons
      listEl.querySelectorAll('.clog-view-session').forEach(function(btn) {
        btn.addEventListener('click', function() {
          _viewSession(btn.dataset.sid);
        });
      });
      // Wire export buttons
      listEl.querySelectorAll('.clog-export-session').forEach(function(btn) {
        btn.addEventListener('click', function() {
          _exportSession(btn.dataset.sid);
        });
      });
      // Wire EDI export buttons
      listEl.querySelectorAll('.clog-edi-session').forEach(function(btn) {
        btn.addEventListener('click', function() {
          _exportSessionEDI(btn.dataset.sid);
        });
      });
      // Wire restore buttons
      listEl.querySelectorAll('.clog-restore-session').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (!confirm('Restore this session as the active session?\nThe current session will be archived.')) return;
          _cloudRestoreSession(btn.dataset.sid, function(resp) {
            if (!resp || resp.status !== 'ok') {
              alert('Failed to restore session: ' + (resp ? resp.message : 'network error'));
              return;
            }
            // Load restored session data into local state
            _log = resp.log || { worked: [], skip: [] };
            _rebuildIndex();
            _settings.sessionName = resp.name || '';
            if (resp.settings) {
              if (resp.settings.nextSerial) _settings.nextSerial = resp.settings.nextSerial;
              if (resp.settings.exchangeMode) _settings.exchangeMode = resp.settings.exchangeMode;
            }
            saveLog();
            saveSettings();
            updateScoreboard();
            renderLogTab();
            ContestLog.applyAll();
          });
        });
      });
    });
  }

  function _viewSession(sessionId) {
    _cloudLoadSession(sessionId, function(resp) {
      if (resp.status !== 'ok') { alert('Failed to load session'); return; }
      var log = resp.log || { worked: [], skip: [] };
      var created = resp.createdAt ? utcStr(new Date(resp.createdAt)) : '—';
      var sessionLabel = resp.name ? escHtml(resp.name) : (resp.active ? 'Active Session' : 'Archived — ' + created);
      var html = '<div class="alert alert-info py-1 px-2 small mb-2">' +
        '<strong>' + sessionLabel + '</strong>' +
        (resp.name ? ' <span class="text-muted">(' + created + ')</span>' : '') +
        ' — ' + +
        (log.worked || []).length + ' worked, ' + (log.skip || []).length + ' skip' +
        ' <button class="btn btn-xs btn-outline-secondary ms-2" id="clog-view-close">Close</button></div>';
      html += '<table class="table table-sm table-hover"><thead><tr>' +
        '<th>Call</th><th>Locator</th><th>Dist</th><th>Brg</th><th>RST Sent</th><th>Ser Sent</th><th>RST Rcvd</th><th>Ser Rcvd</th><th>Comments</th><th>Time</th>' +
        '</tr></thead><tbody>';
      (log.worked || []).forEach(function(e) {
        var d = new Date(e.ts);
        html += '<tr class="table-success">' +
          '<td><strong>' + escHtml(e.callsign) + '</strong></td>' +
          '<td>' + escHtml(e.locator || '—') + '</td>' +
          '<td>' + (e.dist ? Math.round(e.dist) + ' km' : '—') + '</td>' +
          '<td>' + (e.bearing != null ? Math.round(e.bearing) + '°' : '—') + '</td>' +
          '<td>' + escHtml(e.rstSent || '') + '</td>' +
          '<td>' + escHtml(e.serialSent || '') + '</td>' +
          '<td>' + escHtml(e.rstRcvd || '') + '</td>' +
          '<td>' + escHtml(e.serialRcvd || '') + '</td>' +
          '<td class="small">' + escHtml(e.comments || '') + '</td>' +
          '<td>' + utcStr(d) + '</td></tr>';
      });
      (log.skip || []).forEach(function(e) {
        var d = new Date(e.ts);
        html += '<tr class="table-secondary">' +
          '<td>' + escHtml(e.callsign) + '</td>' +
          '<td>' + escHtml(e.locator || '—') + '</td>' +
          '<td>' + (e.dist ? Math.round(e.dist) + ' km' : '—') + '</td>' +
          '<td>' + (e.bearing != null ? Math.round(e.bearing) + '°' : '—') + '</td>' +
          '<td colspan="5"></td>' +
          '<td>' + utcStr(d) + '</td></tr>';
      });
      html += '</tbody></table>';

      var viewer = document.getElementById('clog-prev-list');
      if (viewer) {
        viewer.innerHTML = html;
        document.getElementById('clog-view-close').addEventListener('click', function() {
          _renderSessionList();
        });
      }
    });
  }

  function _exportSession(sessionId) {
    _cloudLoadSession(sessionId, function(resp) {
      if (resp.status !== 'ok') { alert('Failed to load session'); return; }
      var log = resp.log || { worked: [], skip: [] };
      var rows = [['Type','Callsign','Locator','Distance km','Bearing','RST Sent','Serial Sent','RST Rcvd','Serial Rcvd','Time']];
      (log.worked||[]).forEach(function(e) {
        rows.push(['worked', e.callsign, e.locator||'', e.dist ? Math.round(e.dist) : '', e.bearing != null ? Math.round(e.bearing) : '',
          e.rstSent||'', e.serialSent||'', e.rstRcvd||'', e.serialRcvd||'', new Date(e.ts).toISOString()]);
      });
      (log.skip||[]).forEach(function(e) {
        rows.push(['skip', e.callsign, e.locator||'', e.dist ? Math.round(e.dist) : '', e.bearing != null ? Math.round(e.bearing) : '',
          '','','','', new Date(e.ts).toISOString()]);
      });
      var csv = rows.map(function(r) { return r.join(','); }).join('\n');
      var a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      a.download = 'session_' + sessionId + '.csv';
      a.click();
    });
  }

  function _exportSessionEDI(sessionId) {
    _cloudLoadSession(sessionId, function(resp) {
      if (resp.status !== 'ok') { alert('Failed to load session'); return; }
      var log = resp.log || { worked: [], skip: [] };
      var worked = (log.worked || []).filter(function(e) { return !e.deleted; });
      if (!worked.length) { alert('No worked QSOs to export.'); return; }
      var myLocator = (typeof myLoc !== 'undefined' ? myLoc : '') || '';
      var edi = _buildEDI(worked, _baseKey, myLocator, resp.name || '', '');
      if (edi) _downloadEDI(edi, 'session_' + sessionId + '.edi');
    });
  }

  function exportCSV() {
    var rows = [['Type','Callsign','Locator','Distance km','Bearing','RST Sent','Serial Sent','RST Rcvd','Serial Rcvd','Comments','Time']];
    _active(_log.worked).forEach(function(e) {
      rows.push(['worked', e.callsign, e.locator||'', e.dist ? Math.round(e.dist) : '', e.bearing != null ? Math.round(e.bearing) : '',
        e.rstSent||'', e.serialSent||'', e.rstRcvd||'', e.serialRcvd||'', e.comments||'', new Date(e.ts).toISOString()]);
    });
    _active(_log.skip).forEach(function(e) {
      rows.push(['skip', e.callsign, e.locator||'', e.dist ? Math.round(e.dist) : '', e.bearing != null ? Math.round(e.bearing) : '',
        '','','','', e.comments||'', new Date(e.ts).toISOString()]);
    });
    var csv = rows.map(function(r) { return r.join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'session_log_' + (_baseKey || 'export') + '.csv';
    a.click();
  }

  // ── REG1TEST / EDI export ─────────────────────────────
  function _pad(n, len) { var s = String(n); while (s.length < len) s = '0' + s; return s; }

  function _buildEDI(workedEntries, callsign, locator, sessionName, band) {
    var lines = [];
    // Sort by timestamp
    var qsos = workedEntries.slice().sort(function(a, b) { return a.ts - b.ts; });
    if (!qsos.length) return null;

    // Determine contest date range from QSOs
    var first = new Date(qsos[0].ts);
    var last  = new Date(qsos[qsos.length - 1].ts);
    var dateStart = first.getUTCFullYear() + _pad(first.getUTCMonth() + 1, 2) + _pad(first.getUTCDate(), 2);
    var dateEnd   = last.getUTCFullYear()  + _pad(last.getUTCMonth() + 1, 2)  + _pad(last.getUTCDate(), 2);

    // Compute claimed QSO points (sum of distances)
    var totalPts = 0;
    qsos.forEach(function(e) { totalPts += (e.dist ? Math.round(e.dist) : 0); });

    // Collect unique WWLs (4-char squares) and DXCCs
    var wwlSet = {};
    qsos.forEach(function(e) {
      if (e.locator && e.locator.length >= 4) wwlSet[e.locator.substring(0, 4).toUpperCase()] = true;
    });
    var wwlCount = Object.keys(wwlSet).length;

    // Find ODX
    var odx = qsos.reduce(function(best, e) {
      return (e.dist || 0) > (best.dist || 0) ? e : best;
    }, qsos[0]);

    // Header
    lines.push('[REG1TEST;1]');
    lines.push('TName=' + (sessionName || 'Contest'));
    lines.push('TDate=' + dateStart + ';' + dateEnd);
    lines.push('PCall=' + (callsign || ''));
    lines.push('PWWLo=' + (locator || ''));
    lines.push('PExch=');
    lines.push('PAdr1=');
    lines.push('PAdr2=');
    lines.push('PSect=');
    lines.push('PBand=' + (band || ''));
    lines.push('PClub=');
    lines.push('RName=');
    lines.push('RCall=' + (callsign || ''));
    lines.push('RAdr1=');
    lines.push('RAdr2=');
    lines.push('RPoCo=');
    lines.push('RCity=');
    lines.push('RCoun=');
    lines.push('RPhon=');
    lines.push('RHBBS=');
    lines.push('MOpe1=');
    lines.push('MOpe2=');
    lines.push('STXEq=');
    lines.push('SPowe=');
    lines.push('SRXEq=');
    lines.push('SAnte=');
    lines.push('SAntH=;');
    lines.push('CQSOs=' + qsos.length + ';1');
    lines.push('CQSOP=' + totalPts);
    lines.push('CWWLs=' + wwlCount + ';0;1');
    lines.push('CWWLB=0');
    lines.push('CExcs=0;0;1');
    lines.push('CExcB=0');
    lines.push('CDXCs=0;0;1');
    lines.push('CDXCB=0');
    lines.push('CToSc=' + totalPts);
    lines.push('CODXC=' + (odx.callsign || '') + ';' + (odx.locator || '') + ';' + Math.round(odx.dist || 0));

    lines.push('[Remarks]');
    lines.push('Generated by Kst2You contest logger');

    lines.push('[QSORecords;' + qsos.length + ']');

    qsos.forEach(function(e) {
      var d = new Date(e.ts);
      var date = _pad(d.getUTCFullYear() % 100, 2) + _pad(d.getUTCMonth() + 1, 2) + _pad(d.getUTCDate(), 2);
      var time = _pad(d.getUTCHours(), 2) + _pad(d.getUTCMinutes(), 2);
      var pts = e.dist ? Math.round(e.dist) : 0;
      var rcvdWWL = (e.locator || '').toUpperCase();
      var newWWL = '';  // leave for contest manager to determine
      // Date;Time;Call;Mode;RST-S;Ser-S;RST-R;Ser-R;Exch;WWL;Pts;NewExch;NewWWL;NewDXCC;Dup
      lines.push(
        date + ';' + time + ';' +
        (e.callsign || '') + ';1;' +
        (e.rstSent || '59') + ';' + _pad(e.serialSent || '0', 3) + ';' +
        (e.rstRcvd || '59') + ';' + _pad(e.serialRcvd || '0', 3) + ';' +
        ';' + rcvdWWL + ';' +
        pts + ';;;;'
      );
    });

    return lines.join('\r\n') + '\r\n';
  }

  function _downloadEDI(content, filename) {
    var a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
    a.download = filename;
    a.click();
  }

  function exportEDI() {
    var worked = _active(_log.worked);
    if (!worked.length) { alert('No worked QSOs to export.'); return; }
    var myLocator = (typeof myLoc !== 'undefined' ? myLoc : '') || '';
    var edi = _buildEDI(worked, _baseKey, myLocator, _settings.sessionName, '');
    if (edi) _downloadEDI(edi, (_baseKey || 'log') + '.edi');
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /** Format a Date or timestamp as a UTC string. */
  function utcStr(d) {
    if (!(d instanceof Date)) d = new Date(d);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }
  function utcTime(d) {
    if (!(d instanceof Date)) d = new Date(d);
    return d.toISOString().replace(/.*T/, '').replace(/\.\d+Z$/, 'Z');
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

    init: function(myCallsign, password) {
      _baseKey = baseCall(myCallsign);
      load();
      setLogTabVisible(_settings.active);
      updateScoreboard();
      // Save password hash to user settings (fire-and-forget)
      if (password) _cloudSaveUserSettings({ password: password });
      // Load user settings from cloud (for rotator config etc.)
      _cloudLoadUserSettings(function(cloudSettings) {
        if (cloudSettings) {
          if (cloudSettings.rotatorType && !localStorage.getItem('kst2you_rotator_type')) {
            localStorage.setItem('kst2you_rotator_type', cloudSettings.rotatorType);
            if (cloudSettings.rotatorPort) localStorage.setItem('kst2you_rotator_port', cloudSettings.rotatorPort);
            if (typeof window._applyRotatorSetting === 'function') window._applyRotatorSetting();
          }
        }
      });
      // Try to restore from cloud (async, updates UI when done)
      _cloudLoad(function() {
        updateScoreboard();
        renderLogTab();
        ContestLog.applyAll();
      });
    },

    /** Mark a station as worked or skip. exchange = {rstSent, serialSent, rstRcvd, serialRcvd, comments} */
    mark: function(callsign, type, locator, dist, brg, exchange) {
      if (!_baseKey) return;
      callsign = (callsign || '').toUpperCase();
      // Remove from whichever list it's currently in
      ContestLog.unmark(callsign, true);
      var entry = { callsign: callsign, locator: locator || null, dist: dist || null, bearing: brg || null, ts: Date.now() };
      if (exchange) {
        entry.rstSent    = exchange.rstSent    || '';
        entry.serialSent = exchange.serialSent || '';
        entry.rstRcvd    = exchange.rstRcvd    || '';
        entry.serialRcvd = exchange.serialRcvd || '';
        if (exchange.comments) entry.comments = exchange.comments;
      }
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

    /** Remove a station from worked/skip (soft-delete — marks as deleted, preserves history). */
    unmark: function(callsign, _silent) {
      callsign = (callsign || '').toUpperCase();
      var now = Date.now();
      (_log.worked || []).forEach(function(e) {
        if (e.callsign === callsign && !e.deleted) { e.deleted = true; e.deletedAt = now; }
      });
      (_log.skip || []).forEach(function(e) {
        if (e.callsign === callsign && !e.deleted) { e.deleted = true; e.deletedAt = now; }
      });
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

    clear: function(newSessionName) {
      _cloudReset();   // archive current session in Firestore
      _log = { worked: [], skip: [] };
      _index = {};
      _settings.nextSerial = 1;
      _settings.sessionName = newSessionName || '';
      saveLog();
      saveSettings();
      updateScoreboard();
      renderLogTab();
      ContestLog.applyAll();
    },

    // ── Settings accessors ──────────────────────────────
    isActive: function() { return !!_settings.active; },

    setActive: function(val) {
      _settings.active = !!val;
      // Prompt for a session name when entering contest mode with no name set
      if (_settings.active && !_settings.sessionName) {
        var name = prompt('Enter a name for this contest session (e.g. "May 13cm log"):');
        if (name !== null) {
          _settings.sessionName = name.trim() || 'Untitled session';
        } else {
          _settings.sessionName = 'Untitled session';
        }
      }
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

    /** Save arbitrary settings to the user_settings cloud doc (fire-and-forget). */
    saveUserSetting: function(obj) {
      _cloudSaveUserSettings(obj);
    },

    /** Get next serial number (zero-padded to 3 digits). */
    getNextSerial: function() {
      return String(_settings.nextSerial || 1).padStart(3, '0');
    },

    /** Consume and increment the serial counter, returns the used serial. */
    consumeSerial: function(overrideVal) {
      var used = overrideVal || String(_settings.nextSerial || 1).padStart(3, '0');
      // If not overridden, increment
      if (!overrideVal) {
        _settings.nextSerial = (_settings.nextSerial || 1) + 1;
        saveSettings();
      } else {
        // If user typed a higher number, bump counter past it
        var n = parseInt(overrideVal, 10);
        if (!isNaN(n) && n >= (_settings.nextSerial || 1)) {
          _settings.nextSerial = n + 1;
          saveSettings();
        }
      }
      return used;
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
