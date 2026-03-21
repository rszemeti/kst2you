/**
 * OpenSkyDatasource
 * -----------------
 * Fetches aircraft state data from the OpenSky Network API.
 * Requires OAuth2 credentials routed via the local OpenSky Authenticator proxy.
 *
 * ctx object (provided by scatter-track.js):
 *   ctx.counter.increment()   → saves daily count
 *   ctx.opts.clientId         → OpenSky client ID
 *   ctx.opts.clientSecret     → OpenSky client secret
 *   ctx.opts.tokenProxyUrl    → local proxy URL (default: localhost:7329/token)
 *   ctx.constants.OPENSKY_BASE
 *   ctx.constants.DEFAULT_TOKEN_PROXY_URL
 */

const OpenSkyDatasource = {
  name: 'opensky',
  _token: null,
  _tokenExpiry: 0,

  async getToken(ctx) {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    const proxyUrl = ctx.opts.tokenProxyUrl || ctx.constants.DEFAULT_TOKEN_PROXY_URL;
    const r = await fetch(proxyUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        client_id:     ctx.opts.clientId,
        client_secret: ctx.opts.clientSecret,
      }),
    });
    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('Retry-After') || '60', 10);
      const err = new Error(`OpenSky auth rate limited, retry in ${retryAfter}s`);
      err.rateLimited = true; err.retryAfter = retryAfter;
      throw err;
    }
    if (!r.ok) throw new Error(`OpenSky auth failed (${r.status})`);
    const d = await r.json();
    this._token       = d.access_token;
    this._tokenExpiry = Date.now() + ((d.expires_in - 30) * 1000);
    return this._token;
  },

  async fetchPlanes(latA, lonA, latB, lonB, onPartial, ctx) {
    const latMin = Math.min(latA, latB) - 2;
    const latMax = Math.max(latA, latB) + 2;
    const lonMin = Math.min(lonA, lonB) - 2;
    const lonMax = Math.max(lonA, lonB) + 2;
    const url    = `${ctx.constants.OPENSKY_BASE}/states/all?lamin=${latMin}&lomin=${lonMin}&lamax=${latMax}&lomax=${lonMax}`;

    function checkResponse(r) {
      if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('Retry-After') || '60', 10);
        const err = new Error(`OpenSky rate limited, retry in ${retryAfter}s`);
        err.rateLimited = true; err.retryAfter = retryAfter;
        throw err;
      }
      if (!r.ok) throw new Error(`OpenSky API error ${r.status}`);
    }

    const token = await this.getToken(ctx);
    const r     = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    checkResponse(r);
    const statesData = await r.json();
    ctx.counter.increment();

    const planes = (statesData.states || [])
      .filter(s => s[5] != null && s[6] != null && !s[8])
      .map(s => ({
        icao:     s[0],
        callsign: (s[1] || '').trim() || null,
        country:  s[2],
        lat:      s[6],
        lon:      s[5],
        alt:      s[7]  ? Math.round(s[7])           : null,
        altFt:    s[7]  ? Math.round(s[7] * 3.28084) : null,
        velocity: s[9]  ? Math.round(s[9] * 1.94384) : null,
        heading:  s[10] != null ? Math.round(s[10])  : null,
        vrate:    s[11] ? Math.round(s[11] * 196.85) : null,
        squawk:   s[14] || null,
      }));

    if (onPartial) onPartial(planes);
    return planes;
  }
};
