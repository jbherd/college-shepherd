// api/trends.js
//
// Read-only viewer for the anonymous, aggregate-only trend counters built
// by lib/trends.js. Returns JSON: counts per question/answer, plus total
// completions per month. No individual student's answers are retrievable
// from this endpoint or from the underlying storage -- only running totals.
//
// Gated behind the same signed dev-access token Jim already uses for his
// personal app access (see lib/devAuth.js / api/token.js) -- no new secret
// to manage. Pass it as ?t=<token> (the same token from your bookmarked
// ?token= dev-access link) or as an X-Dev-Token header.

const { verifyToken } = require('../lib/devAuth');
const { getTrends } = require('../lib/trends');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dev-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'bad method' });

  const token = req.query.t || req.headers['x-dev-token'];
  const verified = verifyToken(token);
  if (!verified.valid) {
    return res.status(401).json({ error: 'Unauthorized (' + verified.reason + ')' });
  }

  try {
    const data = await getTrends();
    if (!data.configured) {
      return res.status(200).json({
        configured: false,
        note: 'No KV store connected yet -- nothing has been logged. Connect Vercel KV (Storage tab -> Create Database -> KV) to start collecting.',
      });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error('trends.js error:', err.message);
    return res.status(500).json({ error: 'Failed to read trends: ' + err.message });
  }
};
