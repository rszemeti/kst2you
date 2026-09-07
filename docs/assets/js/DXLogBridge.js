/* Optional local DXLog/N1MM worked-station updater. */
var DXLogBridge = (function () {
  'use strict';

  var socket = null;
  var retryTimer = null;
  var recent = {};
  var duplicateWindow = 30000;
  var connectedOnce = false;

  function setStatus(state, text) {
    var badge = document.getElementById('dxlog-status');
    if (!badge || (!connectedOnce && state !== 'connected')) return;
    badge.textContent = text;
    badge.className = 'dxlog-status-badge ' + state;
    badge.style.display = '';
    badge.title = state === 'error' ? 'Click to reconnect to DXLog bridge' : 'DXLog bridge connected';
    badge.style.cursor = state === 'error' ? 'pointer' : 'default';
    badge.onclick = state === 'error' ? function () {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      connect();
    } : null;
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    socket = new WebSocket(localStorage.getItem('kst2you_dxlog_bridge_url') || 'ws://127.0.0.1:8765');
    socket.onopen = function () {
      connectedOnce = true;
      setStatus('connected', 'DXLog Connected');
      console.info('DXLog bridge connected');
    };
    socket.onmessage = function (message) {
      var qso;
      try { qso = JSON.parse(message.data); } catch (error) { return; }
      if (!qso || (qso.type !== 'qso' && qso.type !== 'qso_replace') || !qso.callsign || typeof ContestLog === 'undefined' || !ContestLog.isActive()) return;
      var callsign = qso.callsign.toUpperCase();
      if (qso.type !== 'qso_replace' && ContestLog.getState(callsign) === 'worked') return;
      var key = [qso.type, callsign, qso.timestamp || '', qso.band || '', qso.mode || ''].join('|');
      var now = Date.now();
      if (recent[key] && now - recent[key] < duplicateWindow) return;
      recent[key] = now;
      console.info('DXLog QSO received:', callsign);
      ContestLog.mark(callsign, 'worked', qso.locator || null, null, null, {
        rstSent: qso.rst_sent || '',
        serialSent: qso.serial_sent || '',
        rstRcvd: qso.rst_received || '',
        serialRcvd: qso.serial_received || ''
      });
    };
    socket.onclose = function () {
      socket = null;
      setStatus('error', 'DXLog Error');
      if (!retryTimer) retryTimer = setTimeout(function () { retryTimer = null; connect(); }, 5000);
    };
    socket.onerror = function () {
      setStatus('error', 'DXLog Error');
      socket.close();
    };
  }

  return { connect: connect };
})();

window.addEventListener('load', DXLogBridge.connect);