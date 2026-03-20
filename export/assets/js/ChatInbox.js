/**
 * ChatInbox — persistent directed-message inbox with unread badge.
 * Hooks into Kst.js via ChatInbox.record() and ChatInbox.markRead().
 */
var ChatInbox = (function () {
  'use strict';

  var MAX_PER_CONV = 50;
  var _baseKey     = null;   // set on login
  var _unread      = {};     // { callsign: count }
  var _convs       = {};     // { callsign: [msg, ...] }
  var _meta        = {};     // { callsign: { locator, name } } — stored separately (arrays don't survive JSON round-trip with extra props)
  var _panelOpen   = false;

  // ── Base callsign (strip /P, -2, etc.) ────────────────
  function baseCall(cs) {
    return (cs || '').toUpperCase().replace(/[\/\-].*$/, '');
  }

  // ── localStorage keys ─────────────────────────────────
  function msgKey()    { return 'kst2you_msgs_'   + _baseKey; }
  function unreadKey() { return 'kst2you_unread_' + _baseKey; }
  function metaKey()   { return 'kst2you_meta_'   + _baseKey; }

  // ── Persistence ───────────────────────────────────────
  function loadFromStorage() {
    try { var m = localStorage.getItem(msgKey());    if (m) _convs  = JSON.parse(m); } catch(e) { _convs  = {}; }
    try { var u = localStorage.getItem(unreadKey()); if (u) _unread = JSON.parse(u); } catch(e) { _unread = {}; }
    try { var t = localStorage.getItem(metaKey());   if (t) _meta   = JSON.parse(t); } catch(e) { _meta   = {}; }
  }

  function saveMsgs() {
    if (!_baseKey) return;
    try { localStorage.setItem(msgKey(), JSON.stringify(_convs)); } catch(e) {}
  }

  function saveUnread() {
    if (!_baseKey) return;
    try { localStorage.setItem(unreadKey(), JSON.stringify(_unread)); } catch(e) {}
  }

  function saveMeta() {
    if (!_baseKey) return;
    try { localStorage.setItem(metaKey(), JSON.stringify(_meta)); } catch(e) {}
  }

  // ── Badge ──────────────────────────────────────────────
  function totalUnread() {
    return Object.values(_unread).reduce(function(s, n) { return s + n; }, 0);
  }

  function updateBadge() {
    var n    = totalUnread();
    var badge = document.getElementById('ci-badge');
    var btn   = document.getElementById('ci-btn');
    if (!badge || !btn) return;
    badge.textContent = n;
    badge.style.display = n > 0 ? 'inline-block' : 'none';
    btn.classList.toggle('ci-has-unread', n > 0);
  }

  // ── Panel rendering ────────────────────────────────────
  function formatTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toUTCString().slice(17, 22) + 'z';
    }
    return d.toUTCString().slice(5, 11);
  }

  function renderPanel() {
    var list = document.getElementById('ci-list');
    if (!list) return;

    // Sort conversations by most recent message
    var sorted = Object.keys(_convs).sort(function(a, b) {
      var aLast = _convs[a][_convs[a].length - 1];
      var bLast = _convs[b][_convs[b].length - 1];
      return (bLast ? bLast.ts : 0) - (aLast ? aLast.ts : 0);
    });

    if (sorted.length === 0) {
      list.innerHTML = '<div class="ci-empty">No conversations yet</div>';
      return;
    }

    list.innerHTML = sorted.map(function(call) {
      var msgs  = _convs[call];
      var last  = msgs[msgs.length - 1];
      var unr   = _unread[call] || 0;
      var preview = last ? escHtml(last.text).slice(0, 45) + (last.text.length > 45 ? '…' : '') : '';
      var fromMe  = last && last.from === (window.userName || '');
      return '<div class="ci-row" data-call="' + escHtml(call) + '">' +
        '<div class="ci-row-main">' +
          '<span class="ci-call">' + escHtml(call) + '</span>' +
          (unr > 0 ? '<span class="ci-unread-badge">' + unr + '</span>' : '') +
          '<span class="ci-time">' + (last ? formatTime(last.ts) : '') + '</span>' +
        '</div>' +
        '<div class="ci-preview">' + (fromMe ? '<span class="ci-me">You: </span>' : '') + preview + '</div>' +
      '</div>';
    }).join('');

    // Click a conversation
    list.querySelectorAll('.ci-row').forEach(function(el) {
      el.addEventListener('click', function() {
        var call = el.dataset.call;
        closePanel();
        chatPopup(call);
      });
    });
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Panel open/close ───────────────────────────────────
  function openPanel() {
    renderPanel();
    var panel = document.getElementById('ci-panel');
    if (panel) panel.classList.add('ci-open');
    _panelOpen = true;
  }

  function closePanel() {
    var panel = document.getElementById('ci-panel');
    if (panel) panel.classList.remove('ci-open');
    _panelOpen = false;
  }

  function togglePanel() {
    if (_panelOpen) { closePanel(); } else { openPanel(); }
  }

  // ── Public API ─────────────────────────────────────────
  return {

    /**
     * Call after login with the user's own callsign.
     * Loads persisted history back into Kst.js messageLog.
     */
    init: function(myCallsign) {
      _baseKey = baseCall(myCallsign);
      loadFromStorage();

      // Replay persisted messages into Kst.js messageLog
      Object.keys(_convs).forEach(function(call) {
        if (typeof messageLog[call] === 'undefined') messageLog[call] = [];
        _convs[call].forEach(function(msg) {
          var alreadyIn = messageLog[call].some(function(m) { return m.ts === msg.ts && m.text === msg.text; });
          if (!alreadyIn) messageLog[call].push(msg);
        });
      });

      updateBadge();
    },

    /**
     * Record a directed message. Call from Kst.js message handler.
     * isIncoming: true if message.to === userName
     */
    record: function(msg, isIncoming) {
      if (!_baseKey) return;
      var peer = isIncoming ? msg.from : msg.to;
      if (!peer || peer === '0') return;

      if (!_convs[peer]) _convs[peer] = [];

      // Cache locator only — bearing/distance are position-dependent so we never store them
      if (window.stationList && window.stationList[peer] && window.stationList[peer].locator) {
        _meta[peer] = { locator: window.stationList[peer].locator, name: window.stationList[peer].name };
        saveMeta();
      }
      // Avoid duplicate replays
      var last = _convs[peer][_convs[peer].length - 1];
      if (last && last.ts === msg.ts && last.text === msg.text) return;

      _convs[peer].push({ from: msg.from, to: msg.to, text: msg.text, ts: msg.ts || Date.now() });
      // Trim to max
      if (_convs[peer].length > MAX_PER_CONV) _convs[peer].splice(0, _convs[peer].length - MAX_PER_CONV);

      // Increment unread if incoming and chat popup isn't open for this peer
      if (isIncoming && peer !== (window.chatPopupCallsign || '')) {
        _unread[peer] = (_unread[peer] || 0) + 1;
        saveUnread();
      }

      saveMsgs();
      updateBadge();
      if (_panelOpen) renderPanel();
    },

    /** Return last known station metadata for a callsign, or null. */
    getMeta: function(callsign) {
      return _meta[callsign] || null;
    },

    /**
     * Mark a conversation as read. Call from chatPopup().
     */
    markRead: function(callsign) {
      if (_unread[callsign]) {
        delete _unread[callsign];
        saveUnread();
        updateBadge();
        if (_panelOpen) renderPanel();
      }
    },

    /**
     * Clear all persisted history and unread counts.
     */
    clear: function() {
      _convs  = {};
      _unread = {};
      _meta   = {};
      saveMsgs();
      saveUnread();
      saveMeta();
      updateBadge();
      if (_panelOpen) renderPanel();
    },

    /** Inject fake conversations for UI testing. Call from console: ChatInbox.test() */
    test: function() {
      var now = Date.now();
      var fakeData = [
        { peer: 'G4BAO',  meta: { locator: 'IO91', name: 'Pete' }, msgs: [
            { from: 'G4BAO',  to: 'EI8KN', text: 'Hi, are you on 2m?', ts: now - 12*60000 },
            { from: 'EI8KN',  to: 'G4BAO', text: 'Yes, listening on JT65', ts: now - 11*60000 },
            { from: 'G4BAO',  to: 'EI8KN', text: 'Great, calling you now', ts: now - 10*60000 },
          ], unread: 1 },
        { peer: 'G4SFY',  meta: { locator: 'IO93', name: 'Dave' }, msgs: [
            { from: 'G4SFY',  to: 'EI8KN', text: 'Scatter path looks good from here!', ts: now - 45*60000 },
            { from: 'EI8KN',  to: 'G4SFY', text: 'Agreed, plane just entered corridor', ts: now - 44*60000 },
          ], unread: 0 },
        { peer: 'OZ1BEF', meta: { locator: 'JO65', name: 'Lars' }, msgs: [
            { from: 'OZ1BEF', to: 'EI8KN', text: 'Hej 73', ts: now - 2*3600000 },
          ], unread: 1 },
        { peer: 'PA3FYG', meta: { locator: 'JO22', name: 'Hans' }, msgs: [
            { from: 'EI8KN',  to: 'PA3FYG', text: 'Vy 73', ts: now - 5*3600000 },
            { from: 'PA3FYG', to: 'EI8KN',  text: '73! Good tropo today', ts: now - 4*3600000 },
            { from: 'PA3FYG', to: 'EI8KN',  text: 'Working G4BAO now too', ts: now - 3*3600000 },
          ], unread: 2 },
      ];

      // Use logged-in callsign, or a dummy if not yet logged in
      var me = _baseKey || (window.userName ? baseCall(window.userName) : 'G1YFG');
      if (!_baseKey) _baseKey = me;

      // Patch fake messages to use actual callsign
      fakeData.forEach(function(c) {
        c.msgs.forEach(function(m) {
          if (m.from !== c.peer) m.from = me;
          if (m.to   !== c.peer) m.to   = me;
        });
      });

      fakeData.forEach(function(c) {
        _convs[c.peer]  = c.msgs;
        _meta[c.peer]   = c.meta;
        if (c.unread > 0) _unread[c.peer] = c.unread;
      });

      updateBadge();
      if (_panelOpen) renderPanel();
      console.log('ChatInbox: test data loaded. Open panel to see conversations.');
    },

    /** Build the navbar button and slide-out panel. */
    buildUI: function() {
      // Navbar button
      var btn = document.createElement('button');
      btn.id        = 'ci-btn';
      btn.className = 'ci-btn';
      btn.title     = 'Message inbox';
      btn.innerHTML = '💬<span id="ci-badge" class="ci-badge" style="display:none">0</span>';
      btn.addEventListener('click', togglePanel);
      var cqBtn = document.getElementById('cqButton');
      cqBtn.parentNode.insertBefore(btn, cqBtn);

      // Slide-out panel
      var panel = document.createElement('div');
      panel.id        = 'ci-panel';
      panel.className = 'ci-panel';
      panel.innerHTML =
        '<div class="ci-header">' +
          '<span class="ci-title">Messages</span>' +
          '<button class="ci-close-btn" id="ci-close">✕</button>' +
        '</div>' +
        '<div class="ci-list" id="ci-list"><div class="ci-empty">No conversations yet</div></div>' +
        '<div class="ci-footer">' +
          '<button class="ci-clear-btn" id="ci-clear">Clear history</button>' +
        '</div>';
      document.body.appendChild(panel);

      document.getElementById('ci-close').addEventListener('click', closePanel);
      document.getElementById('ci-clear').addEventListener('click', function() {
        if (confirm('Clear all message history?')) ChatInbox.clear();
      });

      // Close panel on outside click
      document.addEventListener('click', function(e) {
        if (_panelOpen &&
            !panel.contains(e.target) &&
            e.target.id !== 'ci-btn' &&
            !btn.contains(e.target)) {
          closePanel();
        }
      });

      // Auto-load test data on localhost
      if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
        setTimeout(function() { ChatInbox.test(); }, 500);
      }
    },
  };
})();
