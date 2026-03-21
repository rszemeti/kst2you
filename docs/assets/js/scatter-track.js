/**
 * ScatterTrack.js
 * Aircraft scatter module for VHF/UHF path analysis.
 *
 * Usage:
 *   ScatterTrack.init(map, options);
 *   ScatterTrack.setPath('IO82UJ', 'JO22FB');
 *   ScatterTrack.scan();
 *   ScatterTrack.clear();
 *   ScatterTrack.setband(144);
 *   ScatterTrack.destroy();
 *
 * Options:
 *   myLocator      {string}   Maidenhead locator for station A
 *   theirLocator   {string}   Maidenhead locator for station B
 *   band           {number}   Frequency in MHz (default 144)
 *   corridorDeg    {number}   Half-angle of diamond corridor in degrees (default 15)
 *   lookaheadMins  {number}   Minutes ahead to predict approaching aircraft (default 10)
 *   refreshSecs    {number}   Auto-refresh interval in seconds (default 60)
 *   clientId       {string}   OpenSky client ID (optional, falls back to anonymous)
 *   clientSecret   {string}   OpenSky client secret (optional)
 *   onUpdate       {function} Callback fired after each scan:
 *                             onUpdate({ inPath, approaching, all, pathInfo })
 *                               inPath[]     - planes currently in corridor
 *                               approaching[]- planes heading toward corridor
 *                               all[]        - all fetched planes
 *                               pathInfo     - geometry summary
 *
 * Plane object shape:
 *   {
 *     icao, callsign, country,
 *     lat, lon, alt,        // alt in metres
 *     altFt,                // alt in feet
 *     velocity,             // knots
 *     heading,              // degrees
 *     vrate,                // ft/min
 *     squawk,
 *     distFromMid,          // km from path midpoint
 *     doppler,              // Hz
 *     dopplerKHz,           // kHz string e.g. "+1.23"
 *     inPath,               // bool
 *     minsToEntry,          // null if inPath or not approaching, else minutes
 *     minsInPath,           // estimated minutes remaining in corridor (if inPath)
 *   }
 */

const ScatterTrack = (() => {

  // ── Internal state ──
  let _map          = null;
  let _opts         = {};
  let _stationA     = null;  // { lat, lon, locator }
  let _stationB     = null;
  let _freqMHz      = 144;
  let _corridorDeg  = 15;
  let _minElevDeg   = 1.0;   // minimum elevation angle to horizon (degrees)
  let _lookahead    = 10;    // minutes
  let _refreshSecs  = 60;
  let _refreshTimer = null;
  let _markers      = [];
  let _overlays     = [];    // polygon, polyline etc
  let _lastPlanes   = [];
  let _planeMarkers = new Map(); // icao → google.maps.Marker
  let _lastScanTime = 0;
  let _drTimer      = null;
  let _mapFitted    = false;  // true after first fitBounds — don't reset pan/zoom on subsequent scans
  let _lastDiamond  = null;  // cached diamond geometry for DR reclassification

  // ── Constants ──
  const R_EARTH = 6371;   // km, geometric Earth radius
  const R_EFF   = 8495;   // km, effective radius with k=4/3 atmospheric refraction
  const OPENSKY_BASE      = 'https://opensky-network.org/api';
  const DEFAULT_TOKEN_PROXY_URL = 'http://localhost:7329/token';

  // ────────────────────────────────────────────────
  // Geo helpers
  // ────────────────────────────────────────────────

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function destPoint(lat, lon, brng, d) {
    const delta = d / R_EARTH;
    const phi1  = toRad(lat), lam1 = toRad(lon), theta = toRad(brng);
    const phi2  = Math.asin(Math.sin(phi1) * Math.cos(delta) +
                            Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
    const lam2  = lam1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
                                    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
    return { lat: toDeg(phi2), lon: toDeg(lam2) };
  }

  // ────────────────────────────────────────────────
  // Radio horizon visibility check
  // Returns true if the aircraft at planeAltM (metres ASL) is above the
  // radio horizon from the station at stnAltM (metres ASL), with at least
  // minElevDeg degrees of elevation.  Uses k=4/3 effective Earth radius.
  // ────────────────────────────────────────────────
  // Returns elevation angle in degrees from station to aircraft (accounting for Earth curvature)
  function elevationDeg(stnLat, stnLon, stnAltM, planeLat, planeLon, planeAltM) {
    if (planeAltM == null) return null;
    const dKm = haversine(stnLat, stnLon, planeLat, planeLon);
    if (dKm < 1) return 90;
    const d = dKm * 1000; // metres
    const hDiff = planeAltM - stnAltM - (d * d) / (2 * R_EFF * 1000);
    return Math.atan2(hDiff, d) * 180 / Math.PI;
  }

  function isVisibleFrom(stnLat, stnLon, stnAltM, planeLat, planeLon, planeAltM, minElevDeg) {
    if (planeAltM == null) return false;
    const dKm = haversine(stnLat, stnLon, planeLat, planeLon);
    if (dKm < 1) return true;                     // trivially close
    const d = dKm * 1000;                         // metres
    const minElevRad = minElevDeg * Math.PI / 180;
    const hReq = stnAltM + d * Math.sin(minElevRad) + (d * d) / (2 * R_EFF * 1000);
    return planeAltM >= hReq;
  }

  function midpoint(lat1, lon1, lat2, lon2) {
    const phi1 = toRad(lat1), phi2 = toRad(lat2);
    const lam1 = toRad(lon1), lam2 = toRad(lon2);
    const Bx   = Math.cos(phi2) * Math.cos(lam2 - lam1);
    const By   = Math.cos(phi2) * Math.sin(lam2 - lam1);
    const phiM = Math.atan2(Math.sin(phi1) + Math.sin(phi2),
                            Math.sqrt((Math.cos(phi1) + Bx) ** 2 + By ** 2));
    const lamM = lam1 + Math.atan2(By, Math.cos(phi1) + Bx);
    return { lat: toDeg(phiM), lon: toDeg(lamM) };
  }

  // ────────────────────────────────────────────────
  // Maidenhead → lat/lon
  // ────────────────────────────────────────────────

  function maidenheadToLatLon(loc) {
    loc = loc.toUpperCase().trim();
    if (loc.length < 4) return null;
    const A = loc.charCodeAt(0) - 65;
    const B = loc.charCodeAt(1) - 65;
    const C = parseInt(loc[2]);
    const D = parseInt(loc[3]);
    let lon = A * 20 - 180 + C * 2;
    let lat = B * 10 - 90  + D;
    if (loc.length >= 6) {
      const E = loc.charCodeAt(4) - 65;
      const F = loc.charCodeAt(5) - 65;
      lon += (E * 2 / 24) + (1 / 24);
      lat += (F / 24)      + (1 / 48);
    } else {
      lon += 1;
      lat += 0.5;
    }
    return { lat, lon };
  }

  // ────────────────────────────────────────────────
  // Corridor geometry
  // ────────────────────────────────────────────────

  function buildDiamond(latA, lonA, latB, lonB, corridorDeg) {
    const bearAB = bearing(latA, lonA, latB, lonB);
    const dist   = haversine(latA, lonA, latB, lonB);
    const mid    = midpoint(latA, lonA, latB, lonB);
    const offset = (dist / 2) * Math.tan(toRad(corridorDeg));
    const perpL  = (bearAB + 90  + 360) % 360;
    const perpR  = (bearAB - 90  + 360) % 360;
    const leftTip  = destPoint(mid.lat, mid.lon, perpL, offset);
    const rightTip = destPoint(mid.lat, mid.lon, perpR, offset);
    return {
      vertices: [
        { lat: latA,          lon: lonA          },  // A apex
        { lat: leftTip.lat,   lon: leftTip.lon   },  // left wing
        { lat: latB,          lon: lonB          },  // B apex
        { lat: rightTip.lat,  lon: rightTip.lon  },  // right wing
      ],
      mid, bearAB, dist, offset
    };
  }

  // Is a point inside the diamond?
  // Must be within ±corridorDeg of A→B bearing as seen from A,
  // AND within ±corridorDeg of B→A bearing as seen from B.
  function inCorridor(planeLat, planeLon, corridorDeg) {
    if (!_stationA || !_stationB) return false;

    const bearAB   = bearing(_stationA.lat, _stationA.lon, _stationB.lat, _stationB.lon);
    const bearAtoP = bearing(_stationA.lat, _stationA.lon, planeLat, planeLon);
    let diffA = ((bearAtoP - bearAB) + 360) % 360;
    if (diffA > 180) diffA = 360 - diffA;

    const bearBA   = bearing(_stationB.lat, _stationB.lon, _stationA.lat, _stationA.lon);
    const bearBtoP = bearing(_stationB.lat, _stationB.lon, planeLat, planeLon);
    let diffB = ((bearBtoP - bearBA) + 360) % 360;
    if (diffB > 180) diffB = 360 - diffB;

    return diffA <= corridorDeg && diffB <= corridorDeg;
  }

  // ────────────────────────────────────────────────
  // Approach prediction
  // Projects plane forward at current heading + speed,
  // samples every 30 seconds, finds first entry into corridor.
  // Returns minutes to entry, or null if not entering within lookahead window.
  // ────────────────────────────────────────────────

  function predictEntry(plane, lookaheadMins, corridorDeg) {
    if (!plane.velocity || !plane.heading) return null;
    const speedKmPerMin = (plane.velocity / 1.94384) * 60 / 1000; // knots→km/min
    const stepMins = 0.5; // sample every 30 seconds
    const steps = Math.ceil(lookaheadMins / stepMins);

    for (let i = 1; i <= steps; i++) {
      const t = i * stepMins;
      const d = t * speedKmPerMin;
      const pos = destPoint(plane.lat, plane.lon, plane.heading, d);
      if (inCorridor(pos.lat, pos.lon, corridorDeg) &&
          isVisibleFrom(_stationA.lat, _stationA.lon, 0, pos.lat, pos.lon, plane.alt, _minElevDeg) &&
          isVisibleFrom(_stationB.lat, _stationB.lon, 0, pos.lat, pos.lon, plane.alt, _minElevDeg)) {
        return t; // minutes to entry
      }
    }
    return null;
  }

  // How long will a plane remain in the corridor and above horizon from both stations?
  function predictExit(plane, corridorDeg) {
    if (!plane.velocity || !plane.heading) return null;
    const speedKmPerMin = (plane.velocity / 1.94384) * 60 / 1000;
    const stepMins = 0.5;
    const maxMins  = 30; // cap at 30 min
    const steps    = Math.ceil(maxMins / stepMins);

    for (let i = 1; i <= steps; i++) {
      const t = i * stepMins;
      const d = t * speedKmPerMin;
      const pos = destPoint(plane.lat, plane.lon, plane.heading, d);
      if (!inCorridor(pos.lat, pos.lon, corridorDeg) ||
          !isVisibleFrom(_stationA.lat, _stationA.lon, 0, pos.lat, pos.lon, plane.alt, _minElevDeg) ||
          !isVisibleFrom(_stationB.lat, _stationB.lon, 0, pos.lat, pos.lon, plane.alt, _minElevDeg)) {
        return t;
      }
    }
    return maxMins;
  }

  // ────────────────────────────────────────────────
  // Bistatic Doppler
  // fd = (f/c) × v × (cos α + cos β)
  // α = angle between heading and bearing to station A
  // β = angle between heading and bearing to station B
  // ────────────────────────────────────────────────

  function calcDoppler(plane, freqMHz) {
    if (!plane.velocity || plane.heading == null) return null;
    if (!_stationA || !_stationB) return null;
    const f = freqMHz * 1e6;
    const c = 3e8;
    const v = plane.velocity / 1.94384; // knots → m/s
    const bearToA = bearing(plane.lat, plane.lon, _stationA.lat, _stationA.lon);
    const bearToB = bearing(plane.lat, plane.lon, _stationB.lat, _stationB.lon);
    const alphaA  = toRad(((bearToA - plane.heading) + 360) % 360);
    const alphaB  = toRad(((bearToB - plane.heading) + 360) % 360);
    return (f / c) * v * (Math.cos(alphaA) + Math.cos(alphaB)); // Hz
  }

  // ────────────────────────────────────────────────
  // OpenSky fetch
  // ────────────────────────────────────────────────

  // ── Token cache ──
  let _token = null;
  let _tokenExpiry = 0;

  // ── Daily API call counter (persisted to localStorage, keyed by UTC date) ──
  function utcDateKey() {
    return 'opensky_calls_' + new Date().toISOString().slice(0, 10); // e.g. opensky_calls_2026-03-21
  }
  function loadDailyCount() {
    const key = utcDateKey();
    const stored = localStorage.getItem(key);
    return stored ? parseInt(stored, 10) : 0;
  }
  function saveDailyCount(n) {
    localStorage.setItem(utcDateKey(), n);
  }
  let _requestCount = loadDailyCount();

  async function getToken() {
    if (_token && Date.now() < _tokenExpiry) return _token;
    const r = await fetch(_opts.tokenProxyUrl || DEFAULT_TOKEN_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     _opts.clientId,
        client_secret: _opts.clientSecret,
      })
    });
    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('Retry-After') || '60', 10);
      const err = new Error(`OpenSky auth rate limited, retry in ${retryAfter}s`);
      err.rateLimited = true;
      err.retryAfter  = retryAfter;
      throw err;
    }
    if (!r.ok) throw new Error(`OpenSky auth failed (${r.status})`);
    const d = await r.json();
    _token = d.access_token;
    _tokenExpiry = Date.now() + ((d.expires_in - 30) * 1000);
    return _token;
  }

  async function fetchPlanes(latA, lonA, latB, lonB) {
    const latMin = Math.min(latA, latB) - 2;
    const latMax = Math.max(latA, latB) + 2;
    const lonMin = Math.min(lonA, lonB) - 2;
    const lonMax = Math.max(lonA, lonB) + 2;

    const url = `${OPENSKY_BASE}/states/all?lamin=${latMin}&lomin=${lonMin}&lamax=${latMax}&lomax=${lonMax}`;

    let statesData;

    function checkResponse(r) {
      if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('Retry-After') || '60', 10);
        const err = new Error(`OpenSky API error 429 — rate limited, retry in ${retryAfter}s`);
        err.rateLimited = true;
        err.retryAfter  = retryAfter;
        throw err;
      }
      if (!r.ok) throw new Error(`OpenSky API error ${r.status}`);
    }

    if (_opts.clientId && _opts.clientSecret) {
      // ── OAuth2 Bearer token ──
      const token = await getToken();
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      checkResponse(r);
      statesData = await r.json();
    } else {
      // ── Anonymous fallback ──
      const r = await fetch(url);
      checkResponse(r);
      statesData = await r.json();
    }
    _requestCount++;
    saveDailyCount(_requestCount);

    return (statesData.states || [])
      .filter(s => s[5] != null && s[6] != null && !s[8]) // airborne with position
      .map(s => ({
        icao:     s[0],
        callsign: (s[1] || '').trim() || null,
        country:  s[2],
        lat:      s[6],
        lon:      s[5],
        alt:      s[7]  ? Math.round(s[7])           : null,
        altFt:    s[7]  ? Math.round(s[7] * 3.28084) : null,
        velocity: s[9]  ? Math.round(s[9] * 1.94384) : null, // m/s → knots
        heading:  s[10] != null ? Math.round(s[10])  : null,
        vrate:    s[11] ? Math.round(s[11] * 196.85) : null, // m/s → fpm
        squawk:   s[14] || null,
      }));
  }

  // ────────────────────────────────────────────────
  // Google Maps overlay
  // ────────────────────────────────────────────────

  function clearMapOverlays() {
    _markers.forEach(m => m.setMap(null));
    _markers = [];
    _overlays.forEach(o => o.setMap(null));
    _overlays = [];
    _planeMarkers.forEach(m => m.setMap(null));
    _planeMarkers.clear();
    _stopDR();
  }

  function drawDiamondOnMap(diamond) {
    if (!_map) return;
    const path = diamond.vertices.map(v => ({ lat: v.lat, lng: v.lon }));
    // Close the polygon
    path.push(path[0]);

    const poly = new google.maps.Polygon({
      paths: path,
      strokeColor:  '#4488ff',
      strokeOpacity: 0.6,
      strokeWeight:  1.5,
      fillColor:    '#4488ff',
      fillOpacity:   0.08,
      map: _map,
      zIndex: 1,
    });
    _overlays.push(poly);
  }

  // ────────────────────────────────────────────────
  // Aircraft grade — proxy for scatter RCS based on
  // cruise speed + altitude (widebodies fly fast + high)
  // ────────────────────────────────────────────────
  function gradeAircraft(p) {
    const alt = p.alt      != null ? p.alt      : 0;
    const vel = p.velocity != null ? p.velocity : 0;
    if (vel >= 420 && alt >= 7500) return 'heavy';   // ~FL250+, widebody territory
    if (vel >= 280 && alt >= 4500) return 'medium';  // ~FL150+, narrowbody / regional jet
    return 'light';                                   // turboprop / GA / unknown
  }

  function planeIcon(heading, inPath, isApproaching, grade) {
    // Base size by grade; heavy planes get bigger icons
    const base = grade === 'heavy' ? 14 : grade === 'medium' ? 10 : 7;
    const size = inPath ? base + 2 : isApproaching ? base + 1 : base - 1;

    // Colour: blue shades in-path, orange/amber approaching, grey otherwise
    let col, opacity;
    if (inPath) {
      col     = grade === 'heavy' ? '#0033cc' : grade === 'medium' ? '#0066ff' : '#5599ff';
      opacity = 0.95;
    } else if (isApproaching) {
      col     = grade === 'heavy' ? '#cc3300' : grade === 'medium' ? '#ff7700' : '#ffaa44';
      opacity = 0.82;
    } else {
      col     = grade === 'heavy' ? '#777777' : grade === 'medium' ? '#aaaaaa' : '#cccccc';
      opacity = 0.35;
    }

    const h   = heading || 0;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"
      width="${size * 3}" height="${size * 3}"
      viewBox="${-size} ${-size} ${size * 2} ${size * 2}">
      <g transform="rotate(${h})">
        <polygon
          points="0,${-size * 0.75} ${size * 0.4},${size * 0.5} 0,${size * 0.2} ${-size * 0.4},${size * 0.5}"
          fill="${col}" fill-opacity="${opacity}"
          stroke="${col}" stroke-width="0.5"/>
      </g>
    </svg>`;
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      anchor: new google.maps.Point(size * 1.5, size * 1.5),
    };
  }

  function drawPlanesOnMap(planes) {
    if (!_map) return;

    const seen = new Set();
    planes.forEach(p => {
      seen.add(p.icao);
      const icon   = planeIcon(p.heading, p.inPath, p.minsToEntry != null, p.grade);
      const zIndex = p.inPath
        ? (p.grade === 'heavy' ? 13 : p.grade === 'medium' ? 12 : 10)
        : p.minsToEntry != null
        ? (p.grade === 'heavy' ?  8 : p.grade === 'medium' ?  6 :  5)
        : 1;

      if (_planeMarkers.has(p.icao)) {
        // Update existing marker in-place
        const m = _planeMarkers.get(p.icao);
        m.setPosition({ lat: p.lat, lng: p.lon });
        m.setIcon(icon);
        m.setZIndex(zIndex);
      } else {
        // Create new marker
        const m = new google.maps.Marker({
          position: { lat: p.lat, lng: p.lon },
          map:      _map,
          title:    p.callsign || p.icao,
          icon,
          zIndex,
        });
        const iw = new google.maps.InfoWindow({ content: buildInfoWindow(p) });
        m.addListener('click', () => iw.open(_map, m));
        _planeMarkers.set(p.icao, m);
      }
    });

    // Remove markers for planes no longer in this scan
    _planeMarkers.forEach((m, icao) => {
      if (!seen.has(icao)) { m.setMap(null); _planeMarkers.delete(icao); }
    });
  }

  // ────────────────────────────────────────────────
  // Dead-reckoning animation
  // ────────────────────────────────────────────────

  const DR_INTERVAL_MS = 1000;

  function _drTick() {
    if (!_lastScanTime || !_planeMarkers.size || !_lastDiamond) return;
    const elapsedSec  = (Date.now() - _lastScanTime) / 1000;
    const corridorDeg = _corridorDeg;
    const mid         = _lastDiamond.mid;

    const drPlanes = _lastPlanes.map(p => {
      // Dead-reckon position
      let lat = p.lat, lon = p.lon;
      if (p.heading != null && p.velocity) {
        const distKm = (p.velocity * 1.852 / 3600) * elapsedSec;
        const pos    = destPoint(p.lat, p.lon, p.heading, distKm);
        lat = pos.lat; lon = pos.lon;
      }

      // Update map marker position
      const m = _planeMarkers.get(p.icao);
      if (m) m.setPosition({ lat, lng: lon });

      // Reclassify at predicted position
      const visA = isVisibleFrom(_stationA.lat, _stationA.lon, 0, lat, lon, p.alt, _minElevDeg);
      const visB = isVisibleFrom(_stationB.lat, _stationB.lon, 0, lat, lon, p.alt, _minElevDeg);
      const isIn = inCorridor(lat, lon, corridorDeg) && visA && visB;

      let minsToEntry = null, minsInPath = null;
      if (isIn) {
        minsInPath  = predictExit({ ...p, lat, lon }, corridorDeg);
      } else {
        minsToEntry = predictEntry({ ...p, lat, lon }, _lookahead, corridorDeg);
      }

      // Update marker icon/z-index to reflect new classification
      if (m) {
        m.setIcon(planeIcon(p.heading, isIn, minsToEntry != null, p.grade));
        m.setZIndex(isIn
          ? (p.grade === 'heavy' ? 13 : p.grade === 'medium' ? 12 : 10)
          : minsToEntry != null
          ? (p.grade === 'heavy' ?  8 : p.grade === 'medium' ?  6 :  5)
          : 1);
      }

      return { ...p, lat, lon, inPath: isIn, visA, visB,
               distFromMid: haversine(mid.lat, mid.lon, lat, lon),
               minsToEntry, minsInPath };
    });

    // Fire callback with predicted data
    if (_opts.onUpdate) {
      const inPath     = drPlanes.filter(p =>  p.inPath).sort((a, b) => a.distFromMid - b.distFromMid);
      const approaching = drPlanes.filter(p => !p.inPath && p.minsToEntry != null).sort((a, b) => a.minsToEntry - b.minsToEntry);
      _opts.onUpdate({
        inPath, approaching, all: drPlanes, predicted: true,
        pathInfo: {
          stationA: _stationA, stationB: _stationB,
          distance: Math.round(_lastDiamond.dist),
          bearing:  Math.round(_lastDiamond.bearAB),
          midpoint: mid, corridorDeg, freqMHz: _freqMHz,
          inPathCount: inPath.length, approachingCount: approaching.length,
          totalFetched: drPlanes.length,
          requestCount: _requestCount, clientId: _opts.clientId || null,
        },
      });
    }
  }

  function _startDR() {
    _stopDR();
    _drTimer = setInterval(_drTick, DR_INTERVAL_MS);
  }

  function _stopDR() {
    if (_drTimer) { clearInterval(_drTimer); _drTimer = null; }
  }

  function buildInfoWindow(p) {
    const dStr = p.dopplerKHz != null
      ? `<tr><td>Doppler</td><td><b>${p.dopplerKHz} kHz</b></td></tr>`
      : '';
    const entryStr = p.minsToEntry != null
      ? `<tr><td>Entry in</td><td><b>~${Math.round(p.minsToEntry)} min</b></td></tr>`
      : '';
    const exitStr = p.minsInPath != null
      ? `<tr><td>Time in corridor</td><td><b>~${Math.round(p.minsInPath)} min</b></td></tr>`
      : '';
    return `
      <div style="font-family:monospace;font-size:12px;min-width:180px">
        <b style="font-size:14px">${p.callsign || p.icao.toUpperCase()}</b>
        <span style="font-size:11px;color:${p.grade==='heavy'?'#0033cc':p.grade==='medium'?'#0066ff':'#aaaaaa'}">${p.grade==='heavy'?'★★★ Heavy':p.grade==='medium'?'★★ Medium':'★ Light'}</span>
        <table style="margin-top:6px;border-collapse:collapse;width:100%">
          <tr><td>ICAO</td><td>${p.icao.toUpperCase()}</td></tr>
          <tr><td>Alt</td><td>${p.altFt != null ? p.altFt.toLocaleString() + ' ft' : '—'}</td></tr>
          <tr><td>Speed</td><td>${p.velocity != null ? p.velocity + ' kt' : '—'}</td></tr>
          <tr><td>Heading</td><td>${p.heading != null ? p.heading + '°' : '—'}</td></tr>
          ${dStr}${entryStr}${exitStr}
          <tr><td>Horizon A</td><td>${p.visA ? '✓ visible' : '✗ below horizon'}</td></tr>
          <tr><td>Horizon B</td><td>${p.visB ? '✓ visible' : '✗ below horizon'}</td></tr>
          <tr><td>Country</td><td>${p.country || '—'}</td></tr>
        </table>
      </div>`;
  }

  // ────────────────────────────────────────────────
  // Great circle path line
  // ────────────────────────────────────────────────

  function drawPathLine(latA, lonA, latB, lonB, fitMap) {
    if (!_map) return;
    const line = new google.maps.Polyline({
      path: [{ lat: latA, lng: lonA }, { lat: latB, lng: lonB }],
      geodesic:      true,
      strokeColor:   '#4488ff',
      strokeOpacity: 0.8,
      strokeWeight:  2,
      map: _map,
      zIndex: 2,
    });
    _overlays.push(line);

    if (fitMap) {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend({ lat: latA, lng: lonA });
      bounds.extend({ lat: latB, lng: lonB });
      _map.fitBounds(bounds, { top: 60, bottom: 60, left: 60, right: 60 });
    }
  }

  // ────────────────────────────────────────────────
  // Main scan
  // ────────────────────────────────────────────────

  async function _scan() {
    if (!_stationA || !_stationB) return;

    const corridorDeg = _corridorDeg;
    const freqMHz     = _freqMHz;
    const lookahead   = _lookahead;

    let rawPlanes;
    try {
      rawPlanes = await fetchPlanes(
        _stationA.lat, _stationA.lon,
        _stationB.lat, _stationB.lon
      );
    } catch (e) {
      console.error('ScatterTrack fetch error:', e);
      if (e.rateLimited) {
        const waitSecs = e.retryAfter || 60;
        _stopRefresh();
        setTimeout(() => { _scan(); _startRefresh(); }, waitSecs * 1000);
        if (_opts.onUpdate) {
          _opts.onUpdate({ error: e.message, rateLimited: true, retryAfter: waitSecs, inPath: [], approaching: [], all: [], pathInfo: null });
        }
      } else if (_opts.onUpdate) {
        _opts.onUpdate({ error: e.message, inPath: [], approaching: [], all: [], pathInfo: null });
      }
      return;
    }

    // Build diamond geometry
    const diamond = buildDiamond(
      _stationA.lat, _stationA.lon,
      _stationB.lat, _stationB.lon,
      corridorDeg
    );
    _lastDiamond = diamond;

    const mid = diamond.mid;

    // Enrich each plane
    const planes = rawPlanes.map(p => {
      const visA    = isVisibleFrom(_stationA.lat, _stationA.lon, 0, p.lat, p.lon, p.alt, _minElevDeg);
      const visB    = isVisibleFrom(_stationB.lat, _stationB.lon, 0, p.lat, p.lon, p.alt, _minElevDeg);
      const isIn    = inCorridor(p.lat, p.lon, corridorDeg) && visA && visB;
      const dHz     = calcDoppler(p, freqMHz);
      const dkHz    = dHz != null
        ? (dHz >= 0 ? '+' : '') + (dHz / 1000).toFixed(2)
        : null;
      const distMid = haversine(mid.lat, mid.lon, p.lat, p.lon);

      let minsToEntry = null;
      let minsInPath  = null;

      if (isIn) {
        minsInPath = predictExit(p, corridorDeg);
      } else {
        minsToEntry = predictEntry(p, lookahead, corridorDeg);
      }

      return {
        ...p,
        inPath:       isIn,
        visA,
        visB,
        grade:        gradeAircraft(p),
        distFromMid:  distMid,
        doppler:      dHz,
        dopplerKHz:   dkHz,
        minsToEntry,
        minsInPath,
        elevA: elevationDeg(_stationA.lat, _stationA.lon, 0, p.lat, p.lon, p.alt),
        elevB: elevationDeg(_stationB.lat, _stationB.lon, 0, p.lat, p.lon, p.alt),
      };
    });

    // Split and sort
    const inPath = planes
      .filter(p => p.inPath)
      .sort((a, b) => a.distFromMid - b.distFromMid);

    const approaching = planes
      .filter(p => !p.inPath && p.minsToEntry != null)
      .sort((a, b) => a.minsToEntry - b.minsToEntry);

    const all = planes;
    _lastPlanes = planes;

    // Redraw map overlays
    clearMapOverlays();
    drawPathLine(_stationA.lat, _stationA.lon, _stationB.lat, _stationB.lon, !_mapFitted);
    _mapFitted = true;
    drawDiamondOnMap(diamond);
    drawPlanesOnMap([...inPath, ...approaching, ...planes.filter(p => !p.inPath && p.minsToEntry == null)]);

    // Path summary
    const pathInfo = {
      stationA:    _stationA,
      stationB:    _stationB,
      distance:    Math.round(diamond.dist),
      bearing:     Math.round(diamond.bearAB),
      midpoint:    mid,
      corridorDeg,
      freqMHz,
      inPathCount: inPath.length,
      approachingCount: approaching.length,
      totalFetched: planes.length,
      requestCount: _requestCount,
      clientId: _opts.clientId || null,
    };

    // Fire callback
    if (_opts.onUpdate) {
      _opts.onUpdate({ inPath, approaching, all, pathInfo });
    }

    // Start dead-reckoning animation between scans
    _lastScanTime = Date.now();
    _startDR();
  }

  // ────────────────────────────────────────────────
  // Auto-refresh timer
  // ────────────────────────────────────────────────

  function _startRefresh() {
    _stopRefresh();
    _refreshTimer = setInterval(_scan, _refreshSecs * 1000);
  }

  function _stopRefresh() {
    if (_refreshTimer) {
      clearInterval(_refreshTimer);
      _refreshTimer = null;
    }
  }

  // ────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────

  return {

    /**
     * Initialise the module.
     * @param {google.maps.Map} map  - Your existing Google Maps instance
     * @param {object}          opts - Options (see header)
     */
    init(map, opts = {}) {
      _map         = map;
      _opts        = opts;
      _freqMHz     = opts.band          || 144;
      _corridorDeg = opts.corridorDeg   || 5;
      _minElevDeg  = opts.minElevDeg    ?? 1.0;
      _lookahead   = opts.lookaheadMins || 10;
      _refreshSecs = opts.refreshSecs   || 60;


      if (opts.myLocator)    this.setStationA(opts.myLocator);
      if (opts.theirLocator) this.setStationB(opts.theirLocator);
    },

    /**
     * Set station A by Maidenhead locator or lat/lon.
     * @param {string|object} loc - Maidenhead string e.g. 'IO82UJ'
     *                              or { lat, lon } object
     */
    setStationA(loc) {
      if (typeof loc === 'string') {
        const pos = maidenheadToLatLon(loc);
        if (!pos) { console.error('ScatterTrack: invalid locator', loc); return; }
        _stationA = { ...pos, locator: loc.toUpperCase() };
      } else {
        _stationA = { lat: loc.lat, lon: loc.lon, locator: null };
      }
    },

    /**
     * Set station B by Maidenhead locator or lat/lon.
     */
    setStationB(loc) {
      if (typeof loc === 'string') {
        const pos = maidenheadToLatLon(loc);
        if (!pos) { console.error('ScatterTrack: invalid locator', loc); return; }
        _stationB = { ...pos, locator: loc.toUpperCase() };
      } else {
        _stationB = { lat: loc.lat, lon: loc.lon, locator: null };
      }
      _mapFitted = false;  // new path — fit on next scan
    },

    /**
     * Set both stations and immediately scan.
     */
    setPath(locA, locB) {
      this.setStationA(locA);
      this.setStationB(locB);
      this.scan();
    },

    /**
     * Set operating frequency/band.
     * @param {number} mhz - Frequency in MHz
     */
    setBand(mhz) {
      _freqMHz = mhz;
    },

    /**
     * Set corridor half-angle in degrees and immediately redraw with cached planes.
     */
    setCorridorDeg(deg) {
      _corridorDeg = deg;
      if (_lastPlanes.length > 0 && _stationA && _stationB) {
        const diamond = buildDiamond(
          _stationA.lat, _stationA.lon,
          _stationB.lat, _stationB.lon,
          _corridorDeg
        );
        const mid = diamond.mid;

        const planes = _lastPlanes.map(p => {
          const visA = isVisibleFrom(_stationA.lat, _stationA.lon, 0, p.lat, p.lon, p.alt, _minElevDeg);
          const visB = isVisibleFrom(_stationB.lat, _stationB.lon, 0, p.lat, p.lon, p.alt, _minElevDeg);
          const isIn = inCorridor(p.lat, p.lon, _corridorDeg) && visA && visB;
          const minsToEntry = isIn ? null : predictEntry(p, _lookahead, _corridorDeg);
          const minsInPath  = isIn ? predictExit(p, _corridorDeg) : null;
          return { ...p, inPath: isIn, visA, visB,
            grade: gradeAircraft(p),
            distFromMid: haversine(mid.lat, mid.lon, p.lat, p.lon),
            minsToEntry, minsInPath };
        });

        const inPath = planes.filter(p => p.inPath)
          .sort((a, b) => a.distFromMid - b.distFromMid);
        const approaching = planes.filter(p => !p.inPath && p.minsToEntry != null)
          .sort((a, b) => a.minsToEntry - b.minsToEntry);

        _lastPlanes = planes;

        clearMapOverlays();
        drawPathLine(_stationA.lat, _stationA.lon, _stationB.lat, _stationB.lon, false);
        drawDiamondOnMap(diamond);
        drawPlanesOnMap([...inPath, ...approaching,
          ...planes.filter(p => !p.inPath && p.minsToEntry == null)]);

        const pathInfo = {
          stationA: _stationA, stationB: _stationB,
          distance: Math.round(diamond.dist),
          bearing:  Math.round(diamond.bearAB),
          midpoint: mid, corridorDeg: _corridorDeg,
          freqMHz: _freqMHz,
          inPathCount: inPath.length,
          approachingCount: approaching.length,
          totalFetched: planes.length,
      requestCount: _requestCount,
      clientId: _opts.clientId || null,
        };

        if (_opts.onUpdate) _opts.onUpdate({ inPath, approaching, all: planes, pathInfo });
      }
    },

    /**
     * Set minimum elevation angle above radio horizon (degrees, default 1.0).
     * Higher values filter out planes that are only just above the horizon.
     */
    setMinElevDeg(deg) {
      _minElevDeg = deg;
    },

    /**
     * Set lookahead window in minutes.
     */
    setLookahead(mins) {
      _lookahead = mins;
    },

    /**
     * Trigger an immediate scan and start auto-refresh.
     */
    scan() {
      _scan();
      _startRefresh();
    },

    /**
     * Clear all map overlays without stopping the refresh timer.
     */
    clearOverlays() {
      clearMapOverlays();
    },

    /**
     * Clear overlays and stop auto-refresh.
     */
    clear() {
      clearMapOverlays();
      _stopRefresh();
    },

    /**
     * Stop refresh timer, clear overlays, reset state.
     */
    destroy() {
      this.clear();
      _map = null;
      _stationA    = null;
      _stationB    = null;
      _lastPlanes  = [];
      _mapFitted   = false;
      _lastDiamond = null;
    },

    /**
     * Get the last fetched plane data without triggering a new scan.
     */
    getLastPlanes() {
      return _lastPlanes;
    },

    /** Expose geo helpers in case your app wants them */
    geo: { haversine, bearing, destPoint, midpoint, maidenheadToLatLon },
  };

})();