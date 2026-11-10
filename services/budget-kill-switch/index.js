// Budget kill switch for kst-chat.
//
// A billing budget scoped to the kst-chat project publishes its current spend
// to a Pub/Sub topic several times a day. When spend reaches the budget
// amount this function takes kst-chat off the public internet:
//   - every Cloud Run service / gen2 function in REGIONS -> internal-only ingress
//   - the Maps JavaScript and Elevation APIs are disabled
// No data is touched and billing stays on. Everything is reversed with the
// commands in setup.ps1 ("Undo"). Set DRY_RUN=true to only log what it would do.
//
// Billing data lags real usage by hours, so this is a backstop, not a precise cap.

const functions = require('@google-cloud/functions-framework');
const { GoogleAuth } = require('google-auth-library');

const PROJECT = process.env.TARGET_PROJECT || 'kst-chat';
const REGIONS = (process.env.REGIONS || 'europe-west1,europe-west2').split(',');
const APIS = (process.env.DISABLE_APIS ||
    'maps-backend.googleapis.com,elevation-backend.googleapis.com').split(',');
const SELF = process.env.K_SERVICE || 'budget-kill-switch';
const DRY_RUN = process.env.DRY_RUN === 'true';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

async function call(client, method, url, data) {
    if (DRY_RUN && method !== 'GET') {
        console.log(`DRY_RUN: would ${method} ${url} ${data ? JSON.stringify(data) : ''}`);
        return {};
    }
    const res = await client.request({ method, url, data });
    return res.data;
}

async function closeServices(client) {
    for (const region of REGIONS) {
        const base = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${region}/services`;
        const list = await call(client, 'GET', base);
        for (const svc of list.services || []) {
            const name = svc.name.split('/').pop();
            if (name === SELF) continue;
            if (svc.ingress === 'INGRESS_TRAFFIC_INTERNAL_ONLY') {
                console.log(`${name} (${region}) already internal-only`);
                continue;
            }
            await call(client, 'PATCH', `${base}/${name}?updateMask=ingress`,
                { ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' });
            console.warn(`KILL SWITCH: ${name} (${region}) set to internal-only`);
        }
    }
}

async function disableApis(client) {
    for (const api of APIS) {
        await call(client, 'POST',
            `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/${api}:disable`,
            { disableDependentServices: false });
        console.warn(`KILL SWITCH: disabled ${api}`);
    }
}

functions.cloudEvent('killSwitch', async (event) => {
    const raw = event.data?.message?.data;
    if (!raw) return;
    const msg = JSON.parse(Buffer.from(raw, 'base64').toString());
    const cost = Number(msg.costAmount || 0);
    const budget = Number(msg.budgetAmount || 0);
    console.log(`Budget "${msg.budgetDisplayName}": ${cost} of ${budget} ${msg.currencyCode}` +
        ` since ${msg.costIntervalStart}`);

    if (!budget || cost < budget) return;

    console.warn(`KILL SWITCH TRIGGERED: ${cost} >= ${budget} ${msg.currencyCode}` +
        (DRY_RUN ? ' (dry run)' : ''));
    const client = await auth.getClient();
    const errors = [];
    // Run both halves even if one fails, then fail the event so Pub/Sub retries.
    await closeServices(client).catch((e) => errors.push(e));
    await disableApis(client).catch((e) => errors.push(e));
    if (errors.length) {
        errors.forEach((e) => console.error('KILL SWITCH ERROR:', e.message));
        throw errors[0];
    }
});
