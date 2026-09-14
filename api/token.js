// api/token.js
// Issues and validates signed dev-access tokens (see lib/devAuth.js).
// No secret is ever shipped to the browser.

const { issueToken, verifyToken } = require('../lib/devAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dev-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST /api/token — mint a new token.
  // Authorized either by the master secret (Vercel env var, known only to
  // Jim) or by presenting an already-valid token — so one bookmarked link
  // can keep refreshing itself without re-entering the secret each time.
  if (req.method === 'POST') {
    const { secret, token: existingToken } = req.body || {};
    const masterSecret = process.env.DEV_ACCESS_SECRET;
    const okBySecret = masterSecret && secret === masterSecret;
    const okByToken = existingToken && verifyToken(existingToken).valid;

    if (!okBySecret && !okByToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let token;
    try {
      token = issueToken();
    } catch (e) {
      return res.status(500).json({ error: 'Dev access not configured' });
    }

    return res.status(200).json({
      token,
      url: `https://collegeshepherd.com/app.html?token=${token}`,
    });
  }

  // GET /api/token?t=xxx — validate a token
  if (req.method === 'GET') {
    const result = verifyToken(req.query.t);
    return res.status(200).json(result);
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
