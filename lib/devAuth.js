// lib/devAuth.js
// Stateless, signed dev-access tokens for CollegeShepherd.
//
// Why stateless: Vercel serverless functions don't reliably share memory
// between invocations (cold starts spin up fresh instances), so an
// in-memory Map of issued tokens — the old approach — could mint a token
// in one instance and fail to find it in another. A signed token needs no
// storage: the server just recomputes the signature and checks it matches.
//
// Why signed instead of a fixed shared word: the old bypass was a single
// hardcoded string ('shepherd2026') that lived directly in the public
// browser JS bundle — anyone who viewed page source got permanent free
// access to a paid product. DEV_ACCESS_SECRET here lives ONLY as a Vercel
// environment variable and is never sent to the browser. The browser only
// ever sees short-lived signed tokens it can't forge without that secret.

const crypto = require('crypto');

const DEFAULT_TTL_HOURS = 24 * 90; // 90 days — this is a personal dev-access
                                    // link meant to be reused, not a one-time demo

function getSecret() {
    const secret = process.env.DEV_ACCESS_SECRET;
    if (!secret) throw new Error('DEV_ACCESS_SECRET is not configured');
    return secret;
}

function sign(expiry, secret) {
    return crypto.createHmac('sha256', secret).update(String(expiry)).digest('base64url');
}

// token shape: base64url("<expiryMs>.<hmacSignature>")
function issueToken(ttlHours = DEFAULT_TTL_HOURS) {
    const secret = getSecret();
    const expiry = Date.now() + ttlHours * 60 * 60 * 1000;
    const sig = sign(expiry, secret);
    return Buffer.from(`${expiry}.${sig}`).toString('base64url');
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return { valid: false, reason: 'missing' };
    let secret;
    try {
          secret = getSecret();
    } catch (e) {
          return { valid: false, reason: 'not configured' };
    }
    try {
          const decoded = Buffer.from(token, 'base64url').toString('utf8');
          const dot = decoded.indexOf('.');
          if (dot === -1) return { valid: false, reason: 'malformed' };
          const expiryStr = decoded.slice(0, dot);
          const sig = decoded.slice(dot + 1);
          const expiry = parseInt(expiryStr, 10);
          if (!expiry || !sig) return { valid: false, reason: 'malformed' };

      const expected = sign(expiry, secret);
          const sigBuf = Buffer.from(sig);
          const expBuf = Buffer.from(expected);
          if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
                  return { valid: false, reason: 'bad signature' };
          }
          if (Date.now() > expiry) return { valid: false, reason: 'expired' };
          return { valid: true, expiresIn: expiry - Date.now(), expiry };
    } catch (e) {
          return { valid: false, reason: 'malformed' };
    }
}

// Pull a dev token out of a request from either a header or query string —
// lets any API route (not just token.js) gate itself the same way.
function tokenFromRequest(req) {
    return (req.headers && (req.headers['x-dev-token'] || req.headers['X-Dev-Token']))
      || (req.query && req.query.token)
      || (req.body && req.body.token)
      || null;
}

module.exports = { issueToken, verifyToken, tokenFromRequest, DEFAULT_TTL_HOURS };
