// api/verify-payment.js
//
// Real, server-side proof of payment. Call this after Stripe Checkout
// redirects back with a session_id, and it hands back a signed purchase
// token (see lib/purchaseAuth.js) that the rest of the app uses to unlock
// and to track the regeneration cap.
//
// IMPORTANT -- this only works once the Stripe Payment Link's after-payment
// redirect is set to include {CHECKOUT_SESSION_ID} in the URL, e.g.:
//   https://collegeshepherd.com/app.html?session_id={CHECKOUT_SESSION_ID}
// That's a Stripe Dashboard setting per Payment Link (Single/Annual/Family),
// not something this code can change. Until all three are updated, Stripe
// keeps sending the old `?paid=true` (no session id, nothing to verify),
// and app.html's legacy handler for that keeps working exactly as before --
// this endpoint just sits unused until the redirect URLs point to it.

const { issuePurchaseToken, MAX_GENERATIONS } = require('../lib/purchaseAuth');

function kvConfig() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    return { url, token };
}

// If a KV store is connected, look up how many generations this exact
// Stripe session has already used, so re-visiting the success page (or a
// student re-submitting the same session_id) doesn't reset their counter
// back to 0. Without KV this always returns 0 -- same best-effort caveat as
// the rate limiter's in-memory fallback.
async function getAlreadyUsed(kv, sessionId) {
    if (!kv) return 0;
    try {
        const res = await fetch(`${kv.url}/get/purchase:${sessionId}:used`, {
            headers: { Authorization: `Bearer ${kv.token}` },
        });
        if (!res.ok) return 0;
        const data = await res.json();
        return data.result ? Number(data.result) : 0;
    } catch (e) {
        console.error('verify-payment: KV lookup failed, defaulting to 0:', e.message);
        return 0;
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'bad method' });

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) return res.status(500).json({ error: 'Payment verification is not configured' });

    const { session_id } = req.body || {};
    if (!session_id || typeof session_id !== 'string') {
        return res.status(400).json({ error: 'Missing session_id' });
    }

    try {
        const stripeRes = await fetch(
            `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}`,
            { headers: { Authorization: `Bearer ${secretKey}` } }
        );
        const session = await stripeRes.json();

        if (!stripeRes.ok) {
            return res.status(400).json({ error: session.error?.message || 'Could not look up that session' });
        }
        if (session.payment_status !== 'paid') {
            return res.status(402).json({ error: 'This session has not been paid.' });
        }

        const kv = kvConfig();
        const alreadyUsed = await getAlreadyUsed(kv, session_id);
        const purchaseToken = issuePurchaseToken(session_id, alreadyUsed);

        return res.status(200).json({
            purchaseToken,
            generationsUsed: alreadyUsed,
            generationsRemaining: Math.max(0, MAX_GENERATIONS - alreadyUsed),
            maxGenerations: MAX_GENERATIONS,
        });
    } catch (err) {
        console.error('verify-payment error:', err.message);
        return res.status(500).json({ error: 'Verification failed: ' + err.message });
    }
};
