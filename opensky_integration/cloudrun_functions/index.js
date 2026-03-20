const functions = require('@google-cloud/functions-framework');

const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_API_BASE  = 'https://opensky-network.org/api';

// Token cache — keyed by clientId, avoids hammering the auth server
// Entries expire 30s before actual expiry to be safe
const tokenCache = {};

functions.http('openskyProxy', async (req, res) => {

    // ── CORS ──
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });
    }

    const action = req.body?.action;
    const data   = req.body?.data;

    if (!action) {
        return res.status(400).json({ status: 'Error', message: 'Missing action' });
    }

    try {
        switch (action) {

            // ── Get an OAuth2 token ──
            // Used if you ever need the token client-side for something else.
            // Normally getStates handles this internally.
            case 'getToken': {
                const { clientId, clientSecret } = data || {};
                if (!clientId || !clientSecret) {
                    return res.status(400).json({ status: 'Error', message: 'Missing clientId or clientSecret' });
                }
                const token = await getToken(clientId, clientSecret);
                return res.status(200).json({ status: 'OK', token });
            }

            // ── Fetch aircraft states for a bounding box ──
            case 'getStates': {
                const { clientId, clientSecret, lamin, lomin, lamax, lomax, icao24 } = data || {};

                if (!clientId || !clientSecret) {
                    return res.status(400).json({ status: 'Error', message: 'Missing clientId or clientSecret' });
                }
                if (lamin == null || lomin == null || lamax == null || lomax == null) {
                    return res.status(400).json({ status: 'Error', message: 'Missing bounding box (lamin, lomin, lamax, lomax)' });
                }

                // Get a valid token (cached if possible)
                const token = await getToken(clientId, clientSecret);

                // Build OpenSky URL
                let url = `${OPENSKY_API_BASE}/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
                if (icao24) {
                    // Allow filtering by specific ICAO24 addresses
                    const addresses = Array.isArray(icao24) ? icao24 : [icao24];
                    addresses.forEach(a => { url += `&icao24=${a}`; });
                }

                const r = await fetch(url, {
                    headers: { Authorization: `Bearer ${token}` }
                });

                if (!r.ok) {
                    const body = await r.text();
                    console.error(`OpenSky API error ${r.status}:`, body);
                    return res.status(502).json({
                        status: 'Error',
                        message: `OpenSky API returned ${r.status}`,
                        detail: body
                    });
                }

                const states = await r.json();
                return res.status(200).json({ status: 'OK', data: states });
            }

            default:
                return res.status(400).json({ status: 'Error', message: `Unknown action: ${action}` });
        }

    } catch (err) {
        console.error('openskyProxy error:', err);
        return res.status(500).json({ status: 'Error', message: err.message || 'Internal error' });
    }
});

// ────────────────────────────────────────────────
// Token management — cached per clientId
// ────────────────────────────────────────────────

async function getToken(clientId, clientSecret) {
    const cached = tokenCache[clientId];
    if (cached && Date.now() < cached.expiresAt) {
        return cached.token;
    }

    const r = await fetch(OPENSKY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'client_credentials',
            client_id:     clientId,
            client_secret: clientSecret,
        })
    });

    if (!r.ok) {
        const body = await r.text();
        throw new Error(`OpenSky auth failed (${r.status}): ${body}`);
    }

    const d = await r.json();
    // Cache with 30s safety margin
    tokenCache[clientId] = {
        token:     d.access_token,
        expiresAt: Date.now() + ((d.expires_in - 30) * 1000)
    };

    return d.access_token;
}
