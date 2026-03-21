/**
 * Cloudflare Worker — OpenSky token proxy
 *
 * Works around the missing CORS headers on the OpenSky OAuth2 token endpoint.
 * The browser POSTs credentials here; this worker fetches the token server-side
 * and returns it with proper CORS headers.
 *
 * Deploy:
 *   npx wrangler deploy
 *
 * Usage from browser:
 *   POST https://<your-worker>.workers.dev/token
 *   Content-Type: application/json
 *   { "client_id": "...", "client_secret": "..." }
 *
 *   Response: { "access_token": "...", "expires_in": 3600, ... }
 */

const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { client_id, client_secret } = body;
    if (!client_id || !client_secret) {
      return json({ error: 'Missing client_id or client_secret' }, 400);
    }

    const r = await fetch(OPENSKY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id,
        client_secret,
      }),
    });

    const text = await r.text();

    if (!r.ok) {
      return json({ error: `OpenSky auth failed (${r.status})`, detail: text }, 502);
    }

    let token;
    try {
      token = JSON.parse(text);
    } catch {
      return json({ error: 'Unexpected response from OpenSky', detail: text }, 502);
    }

    return json(token, 200);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
