/**
 * AirplanesLiveDatasource
 * -----------------------
 * Fetches aircraft state data from airplanes.live (api.adsb.one).
 * No authentication required. Rate limit: 1 request/second.
 *
 * Covers the scatter path with 1–3 circles depending on path length,
 * staggered to stay well within the rate limit. Fires onPartial after
 * each circle so the map updates progressively.
 *
 * ctx object (provided by scatter-track.js):
 *   ctx.geo.haversine(lat1,lon1,lat2,lon2) → km
 *   ctx.geo.bearing(lat1,lon1,lat2,lon2)   → degrees
 *   ctx.geo.destPoint(lat,lon,brng,d)      → {lat,lon}
 *   ctx.counter.increment()                → saves daily count
 */

const AirplanesLiveDatasource = {
  name: 'airplanes.live',

  async fetchPlanes(latA, lonA, latB, lonB, onPartial, ctx) {
    const { haversine, bearing, destPoint } = ctx.geo;
    const KM_TO_NM      = 0.539957;
    const MAX_RADIUS_NM = 250;
    const pathKm        = haversine(latA, lonA, latB, lonB);
    const brng          = bearing(latA, lonA, latB, lonB);

    // Place 1–3 circles along the path depending on length
    let centers, delays;
    if (pathKm < 400) {
      centers = [ destPoint(latA, lonA, brng, pathKm / 2) ];
      delays  = [ 0 ];
    } else if (pathKm < 800) {
      centers = [
        destPoint(latA, lonA, brng, pathKm / 3),
        destPoint(latA, lonA, brng, pathKm * 2 / 3),
      ];
      delays = [ 0, 5 ];
    } else {
      centers = [
        destPoint(latA, lonA, brng, pathKm / 4),
        destPoint(latA, lonA, brng, pathKm / 2),
        destPoint(latA, lonA, brng, pathKm * 3 / 4),
      ];
      delays = [ 0, 3, 6 ];
    }

    // Radius covers half the inter-circle spacing + 100km margin, capped at 250nm
    const radiusNm = Math.min(
      Math.ceil((pathKm / centers.length / 2 + 100) * KM_TO_NM),
      MAX_RADIUS_NM
    );

    // Accumulate results deduped by ICAO; emit partial update after each circle
    const planeMap = new Map();

    const fetchCircle = async (center, delaySecs) => {
      if (delaySecs > 0) await new Promise(r => setTimeout(r, delaySecs * 1000));
      const url = `https://api.adsb.one/v2/point/${center.lat.toFixed(4)}/${center.lon.toFixed(4)}/${radiusNm}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`airplanes.live error ${r.status}`);
      const data = await r.json();
      ctx.counter.increment();

      for (const ac of (data.ac || [])) {
        if (ac.lat == null || ac.lon == null) continue;
        if (ac.alt_baro === 'ground' || ac.on_ground) continue;
        planeMap.set(ac.hex, {
          icao:     ac.hex,
          callsign: (ac.flight || '').trim() || null,
          country:  null,
          lat:      ac.lat,
          lon:      ac.lon,
          alt:      ac.alt_baro != null ? Math.round(ac.alt_baro * 0.3048) : null,
          altFt:    ac.alt_baro != null ? Math.round(ac.alt_baro)          : null,
          velocity: ac.gs        != null ? Math.round(ac.gs)               : null,
          heading:  ac.track     != null ? Math.round(ac.track)            : null,
          vrate:    ac.baro_rate != null ? Math.round(ac.baro_rate)        : null,
          squawk:   ac.squawk || null,
        });
      }

      if (onPartial) onPartial([...planeMap.values()]);
    };

    // All circles start in parallel; each waits its own delay internally
    await Promise.all(centers.map((c, i) => fetchCircle(c, delays[i])));
    return [...planeMap.values()];
  }
};
