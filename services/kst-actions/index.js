const functions = require('@google-cloud/functions-framework');
const Firestore = require('@google-cloud/firestore');
const crypto = require('crypto');

const firestore = new Firestore({
    projectId: 'kst-chat'
});

// Admin-only actions check the callsign and password the admin tab sends.
// Both come from the function's environment, never from this file:
//   ADMIN_USERS            comma-separated callsigns, e.g. "G4XYZ,M0ABC"
//   ADMIN_PASSWORD_SHA256  hex SHA-256 of the admin password
// If either is unset, admin actions are refused for everyone.
function sha256(s) {
    return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

function isAdmin(auth) {
    const users = String(process.env.ADMIN_USERS || '')
        .split(',').map((u) => u.trim().toUpperCase()).filter(Boolean);
    const want = String(process.env.ADMIN_PASSWORD_SHA256 || '').trim().toLowerCase();
    if (!users.length || !/^[0-9a-f]{64}$/.test(want)) return false;
    if (!auth || typeof auth.login !== 'string' || typeof auth.password !== 'string') return false;
    if (!users.includes(auth.login.trim().toUpperCase())) return false;
    return crypto.timingSafeEqual(sha256(auth.password), Buffer.from(want, 'hex'));
}

// getSpots is called on every page load, and one runaway client hammering it
// cost ~19M Firestore reads a day (Nov 2026). Serve it from memory for an
// hour per instance; logSpot clears the cache so new spots still show up on
// the instance that logged them.
const SPOTS_CACHE_MS = 60 * 60 * 1000;
const spotsCache = new Map(); // JSON of query params -> { at, body }

// Per-client rate limit, checked before any Firestore access. Counts live in
// memory, so each instance limits on its own; with max-instances=5 a flooder
// gets at most 5 x RATE_LIMIT per window. A normal page load makes 2-3 calls.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 60;
const rateCounts = new Map(); // client key -> { start, count }

// IPv6 privacy addresses rotate within a household's /64, so limit on that.
function clientKey(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || req.ip || req.socket?.remoteAddress || 'unknown';
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
    return ip;
}

// One structured log line; filter in Logs Explorer with jsonPayload.event="..."
function logEvent(severity, event, req, extra) {
    console.log(JSON.stringify(Object.assign({
        severity: severity,
        event: event,
        client: clientKey(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
        referer: req.headers['referer'] || '',
        action: req.body?.action
    }, extra || {})));
}

// Returns 'ok', 'limited', or 'record' (limited, and worth saving to
// kst-ratelimited so the admin tab can show it).
function rateLimited(req) {
    const now = Date.now();
    if (rateCounts.size > 10000) {
        for (const [k, v] of rateCounts) {
            if (now - v.start >= RATE_WINDOW_MS) rateCounts.delete(k);
        }
    }
    const key = clientKey(req);
    const entry = rateCounts.get(key);
    if (!entry || now - entry.start >= RATE_WINDOW_MS) {
        rateCounts.set(key, { start: now, count: 1 });
        return 'ok';
    }
    entry.count++;
    if (entry.count <= RATE_LIMIT) return 'ok';
    // Log and record the first refusal in each window, then every 500th,
    // so a flood costs at most a few writes a minute.
    if ((entry.count - RATE_LIMIT - 1) % 500 === 0) {
        logEvent('WARNING', 'rateLimited', req, { countThisWindow: entry.count });
        return 'record';
    }
    return 'limited';
}

async function recordRateLimit(req) {
    const key = clientKey(req);
    await firestore.collection('kst-ratelimited').doc(encodeURIComponent(key)).set({
        client: key,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
        lastAction: String(req.body?.action || ''),
        lastSeen: Firestore.FieldValue.serverTimestamp(),
        events: Firestore.FieldValue.increment(1)
    }, { merge: true });
}

functions.http('endpoint', async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    const limit = rateLimited(req);
    if (limit !== 'ok') {
        if (limit === 'record') {
            await recordRateLimit(req).catch((e) => console.error('recordRateLimit:', e.message));
        }
        res.setHeader('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
        return res.status(429).json({
            status: "Error",
            message: "Too many requests"
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            status: "Error",
            message: "Method Not Allowed"
        });
    }

    const action = req.body?.action;
    const data = req.body?.data;

    if (!action) {
        return res.status(400).json({
            status: "Error",
            message: "Missing action in request body"
        });
    }

    try {
        switch (action) {
            case 'logUser': {
                const { user } = data || {};
                logEvent('INFO', 'login', req, { user: user, chat: data?.chat });
                if (!user) {
                    return res.status(400).json({
                        status: "Error",
                        message: "Missing user"
                    });
                }

                // Increment global login counter
                const statsRef = firestore.doc('kst-metadata/stats');
                await statsRef.set({
                    totalLogins: Firestore.FieldValue.increment(1),
                    lastUpdated: Firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                // Increment per-user counter
                const safeId = encodeURIComponent(user);
                const userRef = firestore.collection('kst-users').doc(safeId);
                await userRef.set({
                    loginCount: Firestore.FieldValue.increment(1),
                    lastLogin: Firestore.FieldValue.serverTimestamp(),
                    // Lets the admin tab match rate-limited networks to callsigns.
                    lastClient: clientKey(req)
                }, { merge: true });

                // Daily totals for the admin chart: one small doc per UTC day.
                const day = new Date().toISOString().slice(0, 10);
                await firestore.collection('kst-daily').doc(day).set({
                    date: day,
                    totalLogins: Firestore.FieldValue.increment(1),
                    users: Firestore.FieldValue.arrayUnion(String(user))
                }, { merge: true });

                // Log the full login event
                await firestore.collection('kst-usage').add(data);

                // Fetch updated stats
                const statsSnap = await statsRef.get();
                const statsData = statsSnap.exists ? statsSnap.data() : { totalLogins: 0, totalSpots: 0 };

                return res.status(200).json({
                    status: "OK",
                    message: `User ${user} logged successfully`,
                    stats: {
                        totalLogins: statsData.totalLogins || 0,
                        totalSpots: statsData.totalSpots || 0,
                        lastUpdated: statsData.lastUpdated ? statsData.lastUpdated.toDate() : null
                    }
                });
            }


            case 'logSpot': {
                // Add the spot
                const spotRef = await firestore.collection('kst-spots').add(data);
                spotsCache.clear();

                // Increment totalSpots
                const statsRef = firestore.doc('kst-metadata/stats');
                await statsRef.set({
                    totalSpots: Firestore.FieldValue.increment(1),
                    lastUpdated: Firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                return res.status(200).json({
                    status: "OK",
                    message: `Spot logged successfully with ID: ${spotRef.id}`
                });
            }

            case 'getSpots':{
                try {
                    const { count, fromDate, days } = data || {};

                    const cacheKey = JSON.stringify({ count, fromDate, days });
                    const cached = spotsCache.get(cacheKey);
                    if (cached && Date.now() - cached.at < SPOTS_CACHE_MS) {
                        return res.json(cached.body);
                    }

                    let query = firestore.collection('kst-spots')
                        .orderBy('timestamp', 'desc');
                    
                    const debug = {
                        params: { count, fromDate, days },
                        filterApplied: null,
                        dateCalculation: null
                    };
                    
                    // If days is provided, calculate fromDate as days back from now
                    // and don't apply a limit
                    if (days && days > 0) {
                        const now = new Date();
                        const daysAgo = new Date();
                        daysAgo.setDate(daysAgo.getDate() - days);
                        daysAgo.setHours(0, 0, 0, 0); // Start of day
                        
                        // Convert to Unix timestamp (seconds) to match your data format
                        const unixTimestamp = Math.floor(daysAgo.getTime() / 1000);
                        
                        debug.filterApplied = 'days';
                        debug.dateCalculation = {
                            now: now.toISOString(),
                            daysAgo: daysAgo.toISOString(),
                            daysValue: days,
                            unixTimestamp: unixTimestamp
                        };
                        
                        query = query.where('timestamp', '>=', unixTimestamp);
                    }
                    // Otherwise, if fromDate is provided, filter spots from that date onwards
                    else if (fromDate) {
                        const dateObj = new Date(fromDate);
                        if (!isNaN(dateObj.getTime())) {
                            const unixTimestamp = Math.floor(dateObj.getTime() / 1000);
                            
                            debug.filterApplied = 'fromDate';
                            debug.dateCalculation = { 
                                fromDate: dateObj.toISOString(),
                                unixTimestamp: unixTimestamp
                            };
                            query = query.where('timestamp', '>=', unixTimestamp);
                        }
                    }
                    // If days is not provided, apply the count limit
                    else {
                        const limit = count && count > 0 ? count : 50;
                        debug.filterApplied = 'count';
                        debug.dateCalculation = { limit };
                        query = query.limit(limit);
                    }
                    
                    const snapshot = await query.get();
                    debug.snapshotSize = snapshot.size;
                    
                    const spots = [];
                    const sampleTimestamps = [];
                    
                    snapshot.forEach(doc => {
                        const spotData = doc.data();
                        spots.push(spotData);
                        
                        // Collect first 5 timestamps for debugging
                        if (sampleTimestamps.length < 5) {
                            sampleTimestamps.push({
                                timestamp: spotData.timestamp,
                                type: typeof spotData.timestamp,
                                asDate: new Date(spotData.timestamp * 1000).toISOString()
                            });
                        }
                    });
                    
                    debug.sampleTimestamps = sampleTimestamps;
                    
                    const body = {
                        status: "OK",
                        data: spots,
                        count: spots.length,
                        debug: debug
                    };
                    spotsCache.set(cacheKey, { at: Date.now(), body: body });
                    // Must return: falling through into getSpotsByDay re-read
                    // 90 days of spots and crashed with ERR_HTTP_HEADERS_SENT.
                    return res.json(body);
                } catch (err) {
                    return res.status(500).json({
                        status: "Error",
                        message: 'Error fetching spots',
                        error: err.message
                    });
                }
            }
            
            case 'getSpotsByDay': {
                try {
                    const { days } = data || {};
                    
                    // Default to 90 days if not provided
                    const daysBack = days && days > 0 ? days : 90;
                    
                    // Calculate the start date as Unix timestamp (seconds)
                    const startDate = new Date();
                    startDate.setDate(startDate.getDate() - daysBack);
                    startDate.setHours(0, 0, 0, 0); // Start of day
                    const startTimestamp = Math.floor(startDate.getTime() / 1000);
                    
                    // Query spots from the start date onwards
                    const snapshot = await firestore.collection('kst-spots')
                        .where('timestamp', '>=', startTimestamp)
                        .orderBy('timestamp', 'asc')
                        .get();
                    
                    // Aggregate spots by day
                    const spotsByDay = {};
                    
                    snapshot.forEach(doc => {
                        const spotData = doc.data();
                        // Convert Unix timestamp (seconds) to Date
                        const spotDate = new Date(spotData.timestamp * 1000);
                        
                        // Format date as YYYY-MM-DD
                        const dateKey = spotDate.toISOString().split('T')[0];
                        
                        if (!spotsByDay[dateKey]) {
                            spotsByDay[dateKey] = 0;
                        }
                        spotsByDay[dateKey]++;
                    });
                    
                    // Convert to ordered array
                    const result = Object.keys(spotsByDay)
                        .sort()
                        .map(date => ({
                            date: date,
                            count: spotsByDay[date]
                        }));
                    
                    return res.status(200).json({
                        status: "OK",
                        message: `Spots by day retrieved successfully (${daysBack} days)`,
                        data: result,
                        totalDays: result.length,
                        totalSpots: result.reduce((sum, day) => sum + day.count, 0)
                    });
                    
                } catch (err) {
                    console.error('Error fetching spots by day: ', err);
                    return res.status(500).json({
                        status: "Error",
                        message: 'Error fetching spots by day'
                    });
                }
            }
            
            case 'getStats': {
                const statsSnap = await firestore.doc('kst-metadata/stats').get();
                const statsData = statsSnap.exists ? statsSnap.data() : { totalLogins: 0, totalSpots: 0 };
                
                return res.status(200).json({
                    status: "OK",
                    message: "Stats retrieved successfully",
                    data: {
                        totalLogins: statsData.totalLogins || 0,
                        totalSpots: statsData.totalSpots || 0,
                        lastUpdated: statsData.lastUpdated ? statsData.lastUpdated.toDate() : null
                    }
                });
            }

            // Tells the page whether to show the Admin tab. Takes only the
            // callsign, so ordinary users' passwords are never sent here;
            // the admin data itself still needs the password check below.
            case 'checkAdmin': {
                const users = String(process.env.ADMIN_USERS || '')
                    .split(',').map((u) => u.trim().toUpperCase()).filter(Boolean);
                const login = String(data?.login || '').trim().toUpperCase();
                return res.status(200).json({
                    status: "OK",
                    isAdmin: !!login && users.includes(login)
                });
            }

            case 'getDetailedStats': {
                if (!isAdmin(data?.auth)) {
                    logEvent('WARNING', 'adminDenied', req, { user: data?.auth?.login });
                    return res.status(403).json({
                        status: "Error",
                        message: "Forbidden"
                    });
                }
                const snapshot = await firestore.collection('kst-users').get();

                const users = [];
                const callsByClient = {};

                snapshot.forEach(doc => {
                    const data = doc.data();
                    const user = decodeURIComponent(doc.id);
                    users.push({
                        user: user,
                        loginCount: data.loginCount || 0,
                        lastLogin: data.lastLogin ? data.lastLogin.toDate() : null
                    });
                    if (data.lastClient) {
                        (callsByClient[data.lastClient] = callsByClient[data.lastClient] || []).push(user);
                    }
                });

                users.sort((a, b) => b.loginCount - a.loginCount);

                // Clients refused by the rate limit in the last 30 days.
                const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
                const limitedSnap = await firestore.collection('kst-ratelimited')
                    .where('lastSeen', '>=', since)
                    .orderBy('lastSeen', 'desc')
                    .limit(100)
                    .get();
                const rateLimited = limitedSnap.docs.map((doc) => {
                    const d = doc.data();
                    return {
                        client: d.client,
                        callsigns: callsByClient[d.client] || [],
                        userAgent: d.userAgent || '',
                        lastAction: d.lastAction || '',
                        lastSeen: d.lastSeen ? d.lastSeen.toDate() : null,
                        events: d.events || 0
                    };
                });

                // Last 30 days of logins for the chart, with empty days filled in.
                const days = [];
                for (let i = 29; i >= 0; i--) {
                    days.push(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
                }
                const dailySnap = await firestore.collection('kst-daily')
                    .where('date', '>=', days[0])
                    .get();
                const byDay = {};
                dailySnap.forEach((doc) => { byDay[doc.id] = doc.data(); });
                const firstRecorded = days.findIndex((d) => byDay[d]);
                const dailyLogins = firstRecorded < 0 ? [] : days.slice(firstRecorded).map((d) => ({
                    date: d,
                    totalLogins: byDay[d]?.totalLogins || 0,
                    uniqueLogins: (byDay[d]?.users || []).length
                }));

                return res.status(200).json({
                    status: "OK",
                    message: "Detailed stats retrieved successfully",
                    data: users,
                    rateLimited: rateLimited,
                    dailyLogins: dailyLogins
                });
            }

            default:
                return res.status(400).json({
                    status: "Error",
                    message: "Invalid action"
                });
        }
    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({
            status: "Error",
            message: err.message || "An error occurred"
        });
    }
});
