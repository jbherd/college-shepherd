// api/token.js
// Creates and validates 24-hour demo tokens
// Stores tokens in Vercel KV or falls back to a simple in-memory store

const tokens = new Map(); // In-memory fallback (resets on cold start)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST /api/token - create a new token
  if (req.method === 'POST') {
    const { secret } = req.body || {};
    if (secret !== 'shepherd2026') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = Math.random().toString(36).substring(2, 10) + 
                  Date.now().toString(36) +
                  Math.random().toString(36).substring(2, 6);
    const expiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours

    tokens.set(token, expiry);

    return res.status(200).json({ token, expiry, 
      url: `https://collegeshepherd.com/app.html?token=${token}` });
  }

  // GET /api/token?t=xxx - validate a token
  if (req.method === 'GET') {
    const token = req.query.t;
    if (!token) return res.status(400).json({ valid: false, error: 'No token' });

    const expiry = tokens.get(token);
    if (!expiry) return res.status(200).json({ valid: false, reason: 'expired' });
    if (Date.now() > expiry) {
      tokens.delete(token);
      return res.status(200).json({ valid: false, reason: 'expired' });
    }

    return res.status(200).json({ valid: true, expiresIn: expiry - Date.now() });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
