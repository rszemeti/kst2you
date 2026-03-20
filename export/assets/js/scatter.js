(function () {
  'use strict';

  // ── State ──────────────────────────────────────────
  let scatterMap = null;
  let scatterMapReady = false;
  let scatterAutoScan = false;
  let scatterChatCallsign = null;
  const SCATTER_MAX_KM = 900;

  // ── Rotator server discovery ────────────────────────
  // Silently probes localhost ports; sets window._rotatorUrl if found.
  (async function probeRotator() {
    const ports = [5000, 5001, 8000, 8001, 3000];
    for (const port of ports) {
      try {
        const r = await fetch('http://localhost:' + port + '/status', { signal: AbortSignal.timeout(800) });
        if (r.ok) {
          window._rotatorUrl = 'http://localhost:' + port;
          const el = document.getElementById('scatter-rotator-status');
          if (el) { el.textContent = 'Rotator: localhost:' + port; el.style.opacity = '1'; el.style.color = '#28a745'; }
          // Table may already be drawn — inject buttons now
          if ($.fn.DataTable.isDataTable('#userListTable')) injectUserListButtons();
          return;
        }
      } catch (_) {}
    }
  })();

  window.rotatorPointTo = function (callsign, locator) {
    if (!window._rotatorUrl) return;
    fetch(window._rotatorUrl + '/station', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign, locator }),
    }).catch(function () {});
  };

  // ── Auto-fill Station A when KST login sets our locator ────
  // Wraps setMyLocator() from Kst.js after DOMContentLoaded.
  const _SELF_DOT = 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png';

  document.addEventListener('DOMContentLoaded', function () {
    const _origSetLoc = window.setMyLocator;
    window.setMyLocator = function (loc) {
      _origSetLoc(loc);
      const el = document.getElementById('scatter-loc-a');
      if (el) el.value = loc.toUpperCase();
    };

    // Also catch manual location changes (double-click map) which set myLoc
    // directly and call drawMap() without going through setMyLocator().
    const _origDrawMap = window.drawMap;
    window.drawMap = function () {
      _origDrawMap();
      const el = document.getElementById('scatter-loc-a');
      if (el && typeof myLoc !== 'undefined') el.value = myLoc.toUpperCase();
    };

    // BS5: .modal(options) only initialises — doLogoff() needs an explicit show.
    const _origLogoff = window.doLogoff;
    window.doLogoff = function () {
      _origLogoff();
      $('#loginModal').modal('show');
    };

    // Load saved OpenSky credentials once DOM is ready
    (function () {
      const id     = localStorage.getItem('opensky_client_id')     || '';
      const secret = localStorage.getItem('opensky_client_secret') || '';
      if (id && secret) showCredsOk(id);
    })();

    // Wrap addMapMarker so own station always gets a blue dot on the main map.
    const _origAddMapMarker = window.addMapMarker;
    window.addMapMarker = function (stn) {
      _origAddMapMarker(stn);
      if (typeof userName !== 'undefined' && stn.callsign === userName && stn.marker) {
        stn.marker.setIcon(_SELF_DOT);
        // Keep blue even when away/back status changes
        const _origAway = stn.setAway.bind(stn);
        const _origBack = stn.setBack.bind(stn);
        stn.setAway = function () { _origAway(); stn.marker.setIcon(_SELF_DOT); };
        stn.setBack = function () { _origBack(); stn.marker.setIcon(_SELF_DOT); };
      }
    };
  });

  // ── Scatter map — lazy init on first tab show ───────
  document.addEventListener('shown.bs.tab', function (e) {
    if (e.target.getAttribute('href') !== '#tab-scatter') return;

    // Pop credentials modal immediately if no creds saved
    const hasCreds = localStorage.getItem('opensky_client_id') &&
                     localStorage.getItem('opensky_client_secret');
    if (!hasCreds) {
      bootstrap.Modal.getOrCreateInstance(
        document.getElementById('scatterCredModal')
      ).show();
    }

    if (scatterMapReady) {
      if (scatterAutoScan) { scatterAutoScan = false; scatterScan(); }
      return;
    }

    // Google Maps is loaded dynamically by Kst.js; poll until ready.
    const tryInit = setInterval(function () {
      if (typeof google === 'undefined' || !google.maps) return;
      clearInterval(tryInit);

      // setTimeout lets the browser paint the flex layout before Maps measures the div
      setTimeout(function () {
        scatterMap = new google.maps.Map(document.getElementById('scatter-map'), {
          center: { lat: 52.5, lng: 0.5 },
          zoom: 6,
          mapTypeId: 'roadmap',
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        scatterMapReady = true;
        google.maps.event.trigger(scatterMap, 'resize');
        scatterLog('Map ready', 'ok');

        // Pre-fill Station A if already logged in
        const locA = document.getElementById('scatter-loc-a');
        if (locA && !locA.value && typeof myLoc !== 'undefined' && myLoc) {
          locA.value = myLoc.toUpperCase();
        }

        // ── Path info overlay (bottom-left of map) ──────
        const pathOverlay = document.createElement('div');
        pathOverlay.id = 'scatter-map-overlay';
        pathOverlay.style.cssText = [
          'background:rgba(0,0,0,0.62)',
          'color:#fff',
          'font-family:monospace',
          'font-size:15px',
          'line-height:1.4',
          'padding:6px 10px',
          'border-radius:4px',
          'margin:0 0 8px 8px',
          'pointer-events:none',
          'display:none',
          'white-space:nowrap',
        ].join(';');
        scatterMap.controls[google.maps.ControlPosition.BOTTOM_LEFT].push(pathOverlay);

        refreshStationMarkers();
        if (scatterAutoScan) { scatterAutoScan = false; scatterScan(); }
      }, 300);
    }, 200);
  });

  // ── Inject ✈ scatter and ⟳ rotator buttons into user list rows ────
  function injectUserListButtons() {
    const dt = $('#userListTable').DataTable();
    dt.rows().every(function () {
      const row  = this.data();
      const node = $(this.node());
      if (!node.find('.scatter-btn').length && row.distance >= 5 && row.distance <= 900) {
        node.find('td:nth-child(3)').append(
          ' <button class="btn btn-outline-primary btn-sm py-0 px-1 scatter-btn"' +
          ' data-loc="' + row.locator + '" data-call="' + row.callsign + '"' +
          ' title="Check scatter path to ' + row.locator + '">✈</button>'
        );
      }
    });
  }

  $(document).on('draw.dt', '#userListTable', injectUserListButtons);

  $(document).on('click', '.scatter-btn', function (e) {
    e.stopPropagation();
    e.preventDefault();
    setScatterTarget($(this).data('loc'), $(this).data('call'));
  });


  // ── KST station markers on scatter map ─────────────
  let _stationMarkers = {}; // call → google.maps.Marker

  const _DOT_BASE = 'https://maps.google.com/mapfiles/ms/icons/';
  function stationDotUrl (isTarget, isAway) {
    if (isTarget) return _DOT_BASE + 'yellow-dot.png';
    return isAway  ? _DOT_BASE + 'red-dot.png' : _DOT_BASE + 'green-dot.png';
  }

  // Own station uses the same blue dot as the main map
  function selfIcon () { return _SELF_DOT; }

  function refreshStationMarkers () {
    if (!scatterMapReady || !scatterMap) return;

    const current = {}; // call → { loc, lat, lon, isAway }
    $('#userListTable tbody tr').each(function () {
      const loc       = $(this).find('td:nth-child(3)').text().trim().substring(0, 6);
      const rawCall   = $(this).find('td:nth-child(1)').text().trim().split(/\s/)[0];
      const call      = rawCall.replace(/^[\[(]|[\])]$/g, ''); // strip (CALL) decoration
      if (loc.length >= 4 && call) {
        const pos = ScatterTrack.geo.maidenheadToLatLon(loc);
        if (pos) {
          // Mirror away-status from the main map's stationList if available
          const stnObj = (typeof stationList !== 'undefined') ? stationList[call] : null;
          const isAway = stnObj ? stnObj.isAway() : false;
          current[call] = { loc, lat: pos.lat, lon: pos.lon, isAway };
        }
      }
    });

    // Remove markers for stations no longer online
    Object.keys(_stationMarkers).forEach(call => {
      if (!current[call]) { _stationMarkers[call].setMap(null); delete _stationMarkers[call]; }
    });

    // Add/update markers
    Object.entries(current).forEach(([call, info]) => {
      const isSelf   = (typeof userName !== 'undefined') && call === userName;
      const isTarget = call === scatterChatCallsign;
      const icon     = isSelf ? selfIcon() : stationDotUrl(isTarget, info.isAway);
      const zIdx     = isSelf ? 25 : isTarget ? 20 : 2;
      if (_stationMarkers[call]) {
        _stationMarkers[call].setIcon(icon);
        _stationMarkers[call].setZIndex(zIdx);
      } else {
        const m = new google.maps.Marker({
          position: { lat: info.lat, lng: info.lon },
          map:      scatterMap,
          title:    call + ' · ' + info.loc,
          icon:     icon,
          zIndex:   zIdx,
        });
        m.addListener('click', () => window.setScatterTarget(info.loc, call));
        _stationMarkers[call] = m;
      }
    });
  }

  // Rebuild station markers on every user-list redraw
  $(document).on('draw.dt', '#userListTable', function () {
    refreshStationMarkers();
  });

  // ── Public: set Station B and switch to Scatter tab ─
  window.setScatterTarget = function (locator, callsign) {
    document.getElementById('scatter-loc-b').value = locator.toUpperCase();
    if (callsign) window.scatterChatSetTarget(callsign);
    // Show/wire rotate button if rotator is available
    var rotWrap = document.getElementById('scatter-rotate-wrap');
    var rotBtn  = document.getElementById('scatter-rotate-btn');
    if (rotWrap && rotBtn) {
      if (window._rotatorUrl && locator) {
        rotBtn.onclick = function () { window.rotatorPointTo(callsign || '', locator); };
        rotWrap.style.display = 'block';
      } else {
        rotWrap.style.display = 'none';
      }
    }
    // Always switch to scatter tab first
    bootstrap.Tab.getOrCreateInstance(
      document.querySelector('#scatterTab [data-bs-toggle="tab"]')
    ).show();
    if (scatterMapReady) {
      scatterScan();
    } else {
      scatterAutoScan = true;
    }
  };

  // ── Range slider listeners ──────────────────────────
  document.getElementById('scatter-corridor').addEventListener('input', function () {
    document.getElementById('scatter-corr-val').textContent = this.value + '°';
    if (scatterMapReady) ScatterTrack.setCorridorDeg(parseInt(this.value));
  });
  document.getElementById('scatter-lookahead').addEventListener('input', function () {
    document.getElementById('scatter-look-val').textContent = this.value + ' min';
  });
  document.getElementById('scatter-refresh').addEventListener('input', function () {
    document.getElementById('scatter-refresh-val').textContent = this.value + 's';
  });
  document.getElementById('scatter-band').addEventListener('change', function () {
    document.getElementById('scatter-custom-wrap').style.display =
      this.value === 'custom' ? 'block' : 'none';
  });

  function getFreqMHz () {
    const v = document.getElementById('scatter-band').value;
    return v === 'custom'
      ? parseFloat(document.getElementById('scatter-custom-freq').value) || 144
      : parseFloat(v);
  }

  // ── OpenSky credentials ────────────────────────────

  function showCredsOk (id) {
    document.getElementById('scatter-cred-name').textContent       = id;
    document.getElementById('scatter-cred-name-modal').textContent = id;
    document.getElementById('scatter-cred-ok').style.display       = 'block';
    document.getElementById('scatter-cred-drop').style.display     = 'none';
    document.getElementById('scatter-cred-mini-ok').style.display  = 'flex';
    document.getElementById('scatter-cred-mini-none').style.display = 'none';
    const modal = bootstrap.Modal.getInstance(document.getElementById('scatterCredModal'));
    if (modal) modal.hide();
  }

  function showCredsDrop () {
    document.getElementById('scatter-cred-ok').style.display        = 'none';
    document.getElementById('scatter-cred-drop').style.display      = 'block';
    document.getElementById('scatter-cred-spinner').style.display   = 'none';
    document.getElementById('scatter-cred-mini-ok').style.display   = 'none';
    document.getElementById('scatter-cred-mini-none').style.display = 'flex';
    const zone = document.getElementById('scatter-drop-zone');
    zone.style.display     = 'block';
    zone.style.borderColor = '#dee2e6';
    zone.style.background  = '';
  }

  window.scatterClearCreds = function () {
    localStorage.removeItem('opensky_client_id');
    localStorage.removeItem('opensky_client_secret');
    showCredsDrop();
    scatterLog('Credentials cleared', 'info');
  };

  window.scatterCredDrop = function (event) {
    event.preventDefault();
    document.getElementById('scatter-drop-zone').style.borderColor = '#dee2e6';
    document.getElementById('scatter-drop-zone').style.background  = '';
    scatterCredFile(event.dataTransfer.files[0]);
  };

  window.scatterCredFile = function (file) {
    if (!file || !file.name.endsWith('.json')) {
      scatterLog('Please drop a .json file', 'err'); return;
    }
    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        const json   = JSON.parse(e.target.result);
        const id     = json.clientId     || json.client_id     || json.id     || '';
        const secret = json.clientSecret || json.client_secret || json.secret || '';
        if (!id || !secret) {
          scatterLog('Could not find clientId / clientSecret in JSON', 'err'); return;
        }
        document.getElementById('scatter-drop-zone').style.display    = 'none';
        document.getElementById('scatter-cred-spinner').style.display = 'block';
        scatterLog('Validating credentials for: ' + id, 'info');
        try {
          await validateOpenSkyToken(id, secret);
          localStorage.setItem('opensky_client_id',     id);
          localStorage.setItem('opensky_client_secret', secret);
          showCredsOk(id);
          scatterLog('Credentials validated and saved: ' + id, 'ok');
        } catch (err) {
          document.getElementById('scatter-drop-zone').style.display    = 'block';
          document.getElementById('scatter-cred-spinner').style.display = 'none';
          const zone = document.getElementById('scatter-drop-zone');
          zone.style.borderColor = '#dc3545';
          zone.style.background  = '#fff5f5';
          scatterLog('Validation failed: ' + err.message, 'err');
          setTimeout(function () {
            zone.style.borderColor = '#dee2e6';
            zone.style.background  = '';
          }, 3000);
        }
      } catch (err) {
        scatterLog('Invalid JSON: ' + err.message, 'err');
      }
    };
    reader.readAsText(file);
  };

  async function validateOpenSkyToken (id, secret) {
    const r = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
      }
    );
    const d = await r.json();
    if (d.access_token) return true;
    throw new Error(d.error_description || d.error || 'Invalid credentials');
  }

  // ── Scan / Clear ───────────────────────────────────
  window.scatterScan = function () {
    if (!scatterMapReady) {
      scatterLog('Map not ready — open the Scatter tab first', 'err'); return;
    }
    const locA   = document.getElementById('scatter-loc-a').value.trim().toUpperCase();
    const locB   = document.getElementById('scatter-loc-b').value.trim().toUpperCase();
    if (locA.length < 4 || locB.length < 4) {
      scatterLog('Please enter valid Maidenhead locators for both stations', 'err'); return;
    }
    const id     = localStorage.getItem('opensky_client_id')     || '';
    const secret = localStorage.getItem('opensky_client_secret') || '';

    document.getElementById('scatter-scan-btn').disabled = true;
    scatterSetStatus('Scanning…', 'info');
    scatterLog('Scanning ' + locA + ' → ' + locB + ' on ' + getFreqMHz() + ' MHz', 'info');

    ScatterTrack.init(scatterMap, {
      myLocator:     locA,
      theirLocator:  locB,
      band:          getFreqMHz(),
      corridorDeg:   parseInt(document.getElementById('scatter-corridor').value),
      lookaheadMins: parseInt(document.getElementById('scatter-lookahead').value),
      refreshSecs:   parseInt(document.getElementById('scatter-refresh').value),
      clientId:      id     || undefined,
      clientSecret:  secret || undefined,
      onUpdate: function (_ref) {
        const inPath     = _ref.inPath, approaching = _ref.approaching,
              all        = _ref.all,   pathInfo    = _ref.pathInfo,
              error      = _ref.error, predicted   = _ref.predicted;
        if (!predicted) document.getElementById('scatter-scan-btn').disabled = false;
        if (error) {
          if (_ref.rateLimited) {
            const msg = 'Rate limited — retrying in ' + _ref.retryAfter + 's';
            scatterSetStatus(msg, 'warn');
            scatterLog(msg, 'warn');
          } else {
            scatterSetStatus('Error: ' + error, 'err');
            scatterLog(error, 'err');
          }
          return;
        }
        if (!predicted) {
          document.getElementById('scatter-last-scan').textContent =
            new Date().toUTCString().slice(17, 25) + ' UTC';
          scatterLog(all.length + ' AC — ' + inPath.length + ' in corridor, ' +
                     approaching.length + ' approaching', 'ok');
        }
        document.getElementById('scatter-count').textContent = all.length;
        scatterSetStatus(
          all.length + ' AC · ' + inPath.length + ' in path · ' + approaching.length + ' approaching',
          'ok'
        );
        if (pathInfo) {
          const oslClient   = document.getElementById('osl-client');
          const oslRequests = document.getElementById('osl-requests');
          if (oslClient)   oslClient.textContent   = pathInfo.clientId || 'anonymous';
          if (oslRequests) oslRequests.textContent = pathInfo.requestCount || 0;
        }
        renderScatterResults(inPath, approaching);
        updateScatterPathBar(pathInfo);
      }
    });
    ScatterTrack.scan();
  };

  window.scatterClear = function () {
    ScatterTrack.clear();
    document.getElementById('scatter-list').innerHTML =
      '<div class="s-empty"><i class="bi bi-x-circle me-1"></i>Cleared.</div>';
    document.getElementById('scatter-path-bar').style.display = 'none';
    document.getElementById('scatter-count').textContent = '0';
    scatterSetStatus('Cleared', 'info');
    scatterLog('Cleared', 'info');
  };

  // ── Directed chat strip ────────────────────────────
  function scHtml (s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function scatterChatAppend (msg) {
    const feed = document.getElementById('scatter-chat-feed');
    if (!feed) return;
    const isMe = (msg.from === (window.userName || ''));
    const div  = document.createElement('div');
    div.className = 'scs-msg';
    div.innerHTML =
      '<span class="scs-from' + (isMe ? ' scs-me' : '') + '">' + scHtml(msg.from) + '</span>' +
      '<span class="scs-text">' + scHtml(msg.text) + '</span>';
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
    while (feed.children.length > 150) feed.removeChild(feed.firstChild);
  }

  // Set the target callsign for the scatter chat and seed from message history
  window.scatterChatSetTarget = function (callsign) {
    if (!callsign || callsign === '0') return;
    scatterChatCallsign = callsign.toUpperCase();
    const feed = document.getElementById('scatter-chat-feed');
    const toEl = document.getElementById('scatter-chat-to');
    if (feed) feed.innerHTML = '';
    if (toEl) toEl.textContent = scatterChatCallsign;

    // Big callsign banner in right panel
    const banner   = document.getElementById('scatter-target-banner');
    const callDisp = document.getElementById('scatter-target-call');
    if (banner)   { callDisp.textContent = scatterChatCallsign; banner.style.display = 'flex'; }

    // Refresh marker highlights to show new target in red
    refreshStationMarkers();

    // Seed with existing message history
    if (window.messageLog && window.messageLog[scatterChatCallsign]) {
      window.messageLog[scatterChatCallsign].forEach(scatterChatAppend);
    }
    if (feed) feed.scrollTop = feed.scrollHeight;
  };

  // Wrap appendToCurrentChat (global in Kst.js) to mirror directed messages here
  (function () {
    const _orig = window.appendToCurrentChat;
    window.appendToCurrentChat = function (msg) {
      if (_orig) _orig(msg);
      if (scatterChatCallsign &&
          (msg.from === scatterChatCallsign || msg.to === scatterChatCallsign)) {
        scatterChatAppend(msg);
      }
    };
  })();

  window.scatterChatSend = function () {
    const input = document.getElementById('scatter-chat-input');
    const text  = input.value.trim();
    if (!text) return;
    if (!scatterChatCallsign) {
      scatterLog('No target — click ✈ on a station first', 'err'); return;
    }
    if (typeof sendMsg === 'undefined' || typeof chatId === 'undefined') {
      scatterLog('Not connected', 'err'); return;
    }
    sendMsg('MSG|' + chatId + '|0|/CQ ' + scatterChatCallsign + ' ' + text + '|0|');
    input.value = '';
  };

  document.getElementById('scatter-chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') window.scatterChatSend();
  });

  // ── Results rendering ──────────────────────────────
  function renderScatterResults (inPath, approaching) {
    const list = document.getElementById('scatter-list');
    list.innerHTML = '';
    if (!inPath.length && !approaching.length) {
      list.innerHTML = '<div class="s-empty"><i class="bi bi-search me-1"></i>No aircraft in corridor or approaching.</div>';
      return;
    }
    if (inPath.length) {
      const h = document.createElement('div');
      h.className = 's-section-label in-path';
      h.innerHTML = '<span><i class="bi bi-airplane-fill me-1"></i>In Path Now</span>' +
                    '<span class="badge bg-primary">' + inPath.length + '</span>';
      list.appendChild(h);
      inPath.forEach(function (p) { list.appendChild(makePlaneItem(p, false)); });
    }
    if (approaching.length) {
      const h = document.createElement('div');
      h.className = 's-section-label approaching';
      h.innerHTML = '<span><i class="bi bi-arrow-right-circle me-1"></i>Approaching</span>' +
                    '<span class="badge bg-warning text-dark">' + approaching.length + '</span>';
      list.appendChild(h);
      approaching.forEach(function (p) { list.appendChild(makePlaneItem(p, true)); });
    }
  }

  function makePlaneItem (p, isApproaching) {
    const div = document.createElement('div');
    div.className = 'plane-item';
    const dPos = p.doppler != null && p.doppler >= 0;
    const dopplerHtml = p.dopplerKHz
      ? '<span class="pi-doppler ' + (dPos ? 'pos' : 'neg') + '">' + p.dopplerKHz + ' kHz</span>'
      : '';
    const timeHtml = isApproaching
      ? '<div class="pi-time"><i class="bi bi-clock me-1"></i>Entry in ~' + Math.round(p.minsToEntry) + ' min</div>'
      : p.minsInPath != null
        ? '<div class="pi-time rem"><i class="bi bi-hourglass-split me-1"></i>~' + Math.round(p.minsInPath) + ' min remaining</div>'
        : '';
    const callClass = p.callsign ? (isApproaching ? 'app' : '') : 'anon';
    const gradeStars = p.grade === 'heavy' ? '★★★' : p.grade === 'medium' ? '★★' : '★';
    const gradeCls   = 'grade-' + (p.grade || 'light');
    div.innerHTML =
      '<div class="d-flex justify-content-between align-items-baseline mb-1">' +
        '<span class="pi-call ' + callClass + '">' + (p.callsign || p.icao.toUpperCase()) + '</span>' +
        '<span class="pi-grade ' + gradeCls + '">' + gradeStars + '</span>' +
        dopplerHtml +
      '</div>' +
      '<div class="pi-meta">' +
        (p.altFt    != null ? Math.round(p.altFt / 100) * 100 + ' ft' : '—') + ' · ' +
        (p.velocity != null ? p.velocity + ' kt' : '—') + ' · ' +
        (p.heading  != null ? p.heading  + '°'   : '—') + ' · ' +
        Math.round(p.distFromMid) + ' km' +
      '</div>' +
      '<div class="pi-meta">' +
        'El: ' + (p.elevA != null ? p.elevA.toFixed(1) + '°' : '—') + ' / ' +
                 (p.elevB != null ? p.elevB.toFixed(1) + '°' : '—') +
      '</div>' + timeHtml;
    return div;
  }

  function updateScatterPathBar (pi) {
    if (!pi) return;
    document.getElementById('scatter-path-bar').style.display = 'grid';
    document.getElementById('s-pb-dist').textContent = pi.distance + ' km';
    document.getElementById('s-pb-bear').textContent = pi.bearing  + '°';
    document.getElementById('s-pb-in').textContent   = pi.inPathCount;
    document.getElementById('s-pb-app').textContent  = pi.approachingCount;

    // Update the map overlay
    const ov = document.getElementById('scatter-map-overlay');
    if (ov) {
      const locA = (document.getElementById('scatter-loc-a').value || '?').toUpperCase();
      const locB = (document.getElementById('scatter-loc-b').value || '?').toUpperCase();
      const callLine = scatterChatCallsign
        ? '<span style="font-size:22px;font-weight:700;letter-spacing:2px;color:#7df">' + scatterChatCallsign + '</span><br>'
        : '';
      ov.innerHTML =
        callLine +
        '<span style="font-size:15px;font-weight:bold">' + locA + ' &#8594; ' + locB + '</span><br>' +
        '<span style="font-size:13px">' + pi.distance + ' km &nbsp;·&nbsp; ' + pi.bearing + '°</span>';
      ov.style.display = 'block';
    }
  }

  // ── Status / log helpers ───────────────────────────
  function scatterSetStatus (msg, type) {
    const el = document.getElementById('scatter-status');
    el.className  = 's-' + (type || 'info');
    el.textContent = msg;
  }

  function scatterLog (msg, type) {
    const c = document.getElementById('osl-log');
    if (!c) return;
    const colours = { ok: '#28a745', err: '#dc3545', warn: '#fd7e14', info: '#ffc107' };
    const d = document.createElement('div');
    d.style.color     = colours[type] || colours.info;
    d.style.lineHeight = '1.5';
    d.textContent = '[' + new Date().toUTCString().slice(17, 25) + '] ' + msg;
    c.appendChild(d);
    c.scrollTop = c.scrollHeight;
    while (c.children.length > 200) c.removeChild(c.firstChild);
  }

  const _oslClearBtn = document.getElementById('osl-clear-btn');
  if (_oslClearBtn) _oslClearBtn.addEventListener('click', function () {
    const c = document.getElementById('osl-log');
    if (c) c.innerHTML = '';
  });

})();
