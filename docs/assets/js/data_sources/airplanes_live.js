/**
 * Aircraft datasource for the KST2You-managed aircraft API.
 *
 * ctx object (provided by scatter-track.js):
 *   ctx.geo.haversine(lat1,lon1,lat2,lon2) → km
 *   ctx.geo.bearing(lat1,lon1,lat2,lon2)   → degrees
 *   ctx.geo.destPoint(lat,lon,brng,d)      → {lat,lon}
 *   ctx.counter.increment()                → saves daily count
 */

const AirplanesLiveDatasource = {
  name: 'kst2you-aircraft-api',
  lastProviderName: null,
  blockedProviders: new Set(),

  providers: [
    {
      name: 'kst2you-aircraft-api',
      buildUrl(center, radiusNm, ctx) {
        const base = (ctx.opts.aircraftProxyUrl || '').trim();
        if (base.endsWith('/api/aircraft')) {
          const url = new URL(base);
          const route = ctx.route;
          url.searchParams.set('fromLat', route.fromLat.toFixed(5));
          url.searchParams.set('fromLon', route.fromLon.toFixed(5));
          url.searchParams.set('toLat', route.toLat.toFixed(5));
          url.searchParams.set('toLon', route.toLon.toFixed(5));
          url.searchParams.set('allowanceKm', String(route.allowanceKm));
          return url.toString();
        }
        const sep = base.includes('?') ? '&' : '?';
        return `${base}${sep}lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}&dist=${radiusNm}`;
      },
      requestInit: {
        headers: { 'Accept': 'application/json' },
      },
      isEnabled(ctx) {
        return !!(ctx.opts.aircraftProxyUrl && String(ctx.opts.aircraftProxyUrl).trim());
      },
    },
  ],

  providerOrder(ctx) {
    const proxyUrl = String(ctx.opts.aircraftProxyUrl || '').trim();
    if (!proxyUrl || this.blockedProviders.has('kst2you-aircraft-api')) return [];
    return [this.providers[0]];
  },

  isLikelyCorsError(error) {
    if (!error) return false;
    const msg = String(error && error.message ? error.message : error);
    return error instanceof TypeError || /cors|cross-origin|failed to fetch|body is not available/i.test(msg);
  },

  async fetchWithFallback(center, radiusNm, ctx, preferredProvider) {
    const ordered = this.providerOrder(ctx);
    if (ordered.length === 0) {
      throw new Error('KST2You aircraft API is not configured or is unavailable');
    }
    const candidates = preferredProvider
      ? [preferredProvider].concat(ordered.filter(p => p.name !== preferredProvider.name))
      : ordered;

    let lastError = null;
    for (const provider of candidates) {
      try {
        const response = await fetch(provider.buildUrl(center, radiusNm, ctx), provider.requestInit || {});
        if (!response.ok) throw new Error(`${provider.name} error ${response.status}`);
        const text = await response.text();
        if (!text || !text.trim()) throw new Error(`${provider.name} returned empty response body`);
        let data;
        try {
          data = JSON.parse(text);
        } catch (parseError) {
          throw new Error(`${provider.name} invalid JSON: ${parseError.message}`);
        }
        this.lastProviderName = provider.name;
        return { data, provider };
      } catch (error) {
        lastError = error;
        if (this.isLikelyCorsError(error)) {
          this.blockedProviders.add(provider.name);
          console.warn(`Aircraft API blocked by browser policy: ${provider.name}.`);
        }
        console.warn(`Aircraft feed provider failed: ${provider.name}`, error);
      }
    }

    throw lastError || new Error('All aircraft feed providers failed');
  },

  normalizeAircraft(provider, data) {
    return data.aircraft || data.ac || [];
  },

  async fetchPlanes(latA, lonA, latB, lonB, onPartial, ctx) {
    if (!ctx.state) ctx.state = {};

    const { haversine, bearing, destPoint } = ctx.geo;
    const KM_TO_NM      = 0.539957;
    const MAX_RADIUS_NM = 250;
    const pathKm        = haversine(latA, lonA, latB, lonB);
    const brng          = bearing(latA, lonA, latB, lonB);
    const usesRouteApi = String(ctx.opts.aircraftProxyUrl || '').trim().endsWith('/api/aircraft');
    ctx.route = {
      fromLat: latA,
      fromLon: lonA,
      toLat: latB,
      toLon: lonB,
      allowanceKm: Math.round(Math.max(75, Math.min(200, pathKm * 0.2))),
    };

    // Place 1–3 circles along the path depending on length
    let centers, delays;
    if (usesRouteApi || pathKm < 400) {
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
    let activeProvider = null;

    // Accumulate results deduped by ICAO; emit partial update after each circle
    const planeMap = new Map();

    const fetchCircle = async (center, delaySecs) => {
      if (delaySecs > 0) await new Promise(r => setTimeout(r, delaySecs * 1000));
      const result = await this.fetchWithFallback(center, radiusNm, ctx, activeProvider);
      const data = result.data;
      activeProvider = result.provider;
      ctx.counter.increment();

      for (const ac of this.normalizeAircraft(activeProvider, data)) {
        if (ac.lat == null || ac.lon == null) continue;
        if (ac.alt_baro === 'ground' || ac.on_ground) continue;
        planeMap.set(ac.hex, {
          icao:     ac.hex,
          callsign: (ac.flight || '').trim() || null,
          country:  null,
          category: ac.category || null,
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

    // Keep successful circles even if one provider/circle fails.
    const results = await Promise.allSettled(centers.map((c, i) => fetchCircle(c, delays[i])));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length === results.length) {
      throw failed[0].reason;
    }
    if (failed.length > 0) {
      console.warn(`Aircraft feed completed with partial failures (${failed.length}/${results.length} circles).`);
    }
    return [...planeMap.values()];
  }
};
