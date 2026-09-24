// lib/purchaseAuth.js
//
// Stateless, signed purchase tokens -- proof that a student actually paid,
// plus a tamper-proof generation counter, without needing a database.
//
// Why this exists: the app previously unlocked on nothing more than the URL
// containing `?paid=true`, with no check that a real Stripe payment had
// happened -- anyone could type that into the address bar and get the full
// product for free. Separately, the "up to 7 regenerations" promised on the
// pricing page was pure UI copy; nothing on the server ever counted or
// capped how many times /api/generate could be called.
//
// This closes both gaps the same way lib/devAuth.js already closes the
// personal dev-access one: the token is signed with a secret that only
// lives in a Vercel env var and is never sent to the browser, so the
// browser can carry the token and its generation count around, but can't
// forge a token, raise its own count, or lower it back down.
//
// Flow:
//   1. Stripe Checkout redirects back to the app with ?session_id=... (this
//      requires the Payment Link's after-payment redirect to be configured
//      to include {CHECKOUT_SESSION_ID} -- see api/verify-payment.js).
//   2. The app calls POST /api/verify-payment with that session_id.
//   3. verify-payment.js checks the session against the real Stripe API
//      (server-to-server, using STRIPE_SECRET_KEY) and, only if it's really
//      paid, calls issuePurchaseToken() here and hands the token back.
//   4. The app stores that token and sends it with every /api/generate call.
//      generate.js calls verifyPurchaseToken(), checks the embedded
//      generation count against the cap, and if it's under the cap, calls
//      Anthropic and returns a NEW token (via bumpGenerationCount()) with
//      the count incremented -- the app overwrites its stored token with
//      this one. A client can't just keep resending the old token to avoid
//      the bump, because the count only ever goes up from what the server
//      last issued; there's no client-writable field.

const crypto = require('crypto');

const TOKEN_TTL_DAYS = 365; // "one payment, yours forever" -- long-lived, not a demo link
const MAX_GENERATIONS = 8;  // 1 initial list + up to 7 regenerations, matching pricing copy

function getSecret() {
    const secret = process.env.PURCHASE_TOKEN_SECRET;
    if (!secret) throw new Error('PURCHASE_TOKEN_SECRET is not configured');
    return secret;
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

// token shape: base64url("<stripeSessionId>.<expiryMs>.<generationsUsed>.<hmacSig>")
function issuePurchaseToken(stripeSessionId, generationsUsed = 0) {
    const secret = getSecret();
    const expiry = Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    const payload = `${stripeSessionId}.${expiry}.${generationsUsed}`;
    const sig = sign(payload, secret);
    return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyPurchaseToken(token) {
    if (!token || typeof token !== 'string') return { valid: false, reason: 'missing' };
    let secret;
    try {
        secret = getSecret();
    } catch (e) {
        return { valid: false, reason: 'not configured' };
    }
    try {
        const decoded = Buffer.from(token, 'base64url').toString('utf8');
        const parts = decoded.split('.');
        if (parts.length !== 4) return { valid: false, reason: 'malformed' };
        const [sessionId, expiryStr, usedStr, sig] = parts;
        const expiry = parseInt(expiryStr, 10);
        const generationsUsed = parseInt(usedStr, 10);
        if (!sessionId || !expiry || Number.isNaN(generationsUsed)) {
            return { valid: false, reason: 'malformed' };
        }

        const payload = `${sessionId}.${expiry}.${generationsUsed}`;
        const expected = sign(payload, secret);
        const sigBuf = Buffer.from(sig);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            return { valid: false, reason: 'bad signature' };
        }
        if (Date.now() > expiry) return { valid: false, reason: 'expired' };

        return { valid: true, sessionId, expiry, generationsUsed };
    } catch (e) {
        return { valid: false, reason: 'malformed' };
    }
}

// Returns a fresh token with generationsUsed incremented by 1, carrying
// forward the same sessionId. Only call this after verifyPurchaseToken()
// has confirmed the token is valid and under the cap.
function bumpGenerationCount(verified) {
    return issuePurchaseToken(verified.sessionId, verified.generationsUsed + 1);
}

function tokenFromRequest(req) {
    return (req.headers && (req.headers['x-purchase-token'] || req.headers['X-Purchase-Token']))
        || (req.body && req.body.purchaseToken)
        || null;
}

module.exports = {
    issuePurchaseToken,
    verifyPurchaseToken,
    bumpGenerationCount,
    tokenFromRequest,
    MAX_GENERATIONS,
};
