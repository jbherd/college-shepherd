// api/match.js
//
// Real search/discovery step. Given the student's intake answers, returns a
// shortlist of real colleges (from the full 1,944-school College Scorecard
// dataset) hard-scored against their actual profile — cost, size, setting,
// major/program alignment, home-state/region, selectivity band (reach/match/
// safety), Greek life preference, and hidden-gem openness.
//
// This replaces the old approach of asking the AI model to recall college
// names from memory. The AI (called separately via /api/generate) now only
// picks and narrates the best 10 FROM this real shortlist — it no longer
// invents which schools exist or what their stats are.

const { buildShortlist } = require('../lib/matchEngine.js');

const RATE_LIMIT = 40; // generous -- this is a cheap, local computation, not an LLM call
const WINDOW_MS = 864e5;
const hits = new Map();

function checkRL(ip) {
  const now = Date.now();
  const e = hits.get(ip) || { c: 0, r: now + WINDOW_MS };
  if (now > e.r) { e.c = 0; e.r = now + WINDOW_MS; }
  e.c++;
  hits.set(ip, e);
  return { ok: e.c <= RATE_LIMIT };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'bad method' });

  const limit = checkRL((req.headers['x-forwarded-for'] || 'x').split(',')[0]);
  if (!limit.ok) return res.status(429).json({ error: 'Rate limit exceeded.' });

  const { answers } = req.body || {};
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'Missing answers object' });
  }

  try {
    const perTier = Math.max(5, Math.min(20, Number(req.body.perTier) || 15));
    const shortlist = buildShortlist(answers, { perTier });
    return res.status(200).json({ shortlist, count: shortlist.length });
  } catch (err) {
    console.error('match.js error:', err.message, err.stack);
    return res.status(500).json({ error: 'Matching failed: ' + err.message });
  }
};
