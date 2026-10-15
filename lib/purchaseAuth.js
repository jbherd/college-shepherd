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

const TOKEN_TTL_DAYS = 365; // one payment, full access for a full year -- long-lived, not a demo link
// 1 initial list + up to 9 regenerations, usable any time across the full
// year of access -- NOT a daily allowance. (Was 8 total; raised to 10 on
// 2026-10-05 after the on-screen copy was found to incorrectly describe
// this as "7 a day," which it has never actually been -- see app.html's
// copy fixes shipped the same day.)
//
// As of 2026-10-15 this is a PER-PROFILE cap, not a per-purchase-total one.
// It used to be enforced against this token's own embedded generationsUsed
// field, which is shared by every named profile on one device/purchase --
// a real customer whose family (parent + kids, or a parent just testing
// under two different names) used more than one profile on one purchase
// hit "all 10 used" after only a couple of real generations, because
// everyone was drawing from the same pool. Real enforcement now lives in
// api/generate.js, keyed per (stripeSessionId, profileId) in KV, so each
// named profile gets its own full MAX_GENERATIONS -- see
// MAX_PROFILES_PER_PURCHASE below for the guardrail that keeps that from
// being an unbounded-free-generations loophole. This token's embedded
// generationsUsed field is kept only as an informational running total
// across all profiles (and for the KV "discard and reverify" fallback in
// api/verify-payment.js) -- it no longer gates anything by itself.
const MAX_GENERATIONS = 10;

// How many distinct named profiles one purchase can ever register with
// /api/generate. Without this, since each new profile id gets a fresh
// MAX_GENERATIONS allowance (api/generate.js), anyone could keep typing a
// new name at the "what's your name?" question to mint unlimited free
// generations. 5 comfortably covers the advertised Family Pack use case
// (a parent plus several kids) while keeping the worst case bounded and
// deliberate (5 x 10 = 50 generations per purchase, not unlimited). An
// already-registered profile id is never blocked by this -- it only
// refuses a never-seen-before one past the limit.
const MAX_PROFILES_PER_PURCHASE = 5;

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
    MAX_PROFILES_PER_PURCHASE,
    TOKEN_TTL_DAYS,
};
