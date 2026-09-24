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
const { checkLimit } = require('../lib/rateLimit');
const { logTrends } = require('../lib/trends');

// Generous -- this is a cheap, local computation, not an LLM call. Uses the
// same shared KV-backed limiter as generate.js so this cap is a real,
// cross-instance one on Vercel too, instead of the old per-instance Map
// (see lib/rateLimit.js for why that never actually capped anything).
const RATE_LIMIT = 40;
const WINDOW_SECONDS = 86400; // 24h

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'bad method' });

  const ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0];
  const limit = await checkLimit(`match:${ip}`, { max: RATE_LIMIT, windowSeconds: WINDOW_SECONDS });
  if (!limit.ok) return res.status(429).json({ error: 'Rate limit exceeded.' });

  const { answers } = req.body || {};
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'Missing answers object' });
  }

  try {
    const perTier = Math.max(5, Math.min(20, Number(req.body.perTier) || 15));
    const shortlist = buildShortlist(answers, { perTier });

    // Anonymous, aggregate-only trend counters (see lib/trends.js) -- only
    // on the first match call for a given questionnaire session, flagged
    // by the client via logTrend:true, so regenerations of the same
    // student's list don't get double/triple-counted.
    //
    // This is deliberately awaited, not fire-and-forget: Vercel's Node
    // serverless runtime can freeze/terminate the function the instant the
    // response is sent, killing any still-pending network call that wasn't
    // awaited first. A real test confirmed this -- a fire-and-forget call
    // here returned 200 to the client but never actually wrote to KV.
    // logTrends() never throws (it catches its own errors internally), so
    // awaiting it can't turn a trend-logging hiccup into a failed match
    // response -- it only adds one fast KV round-trip (~tens of ms) before
    // replying.
    if (req.body.logTrend) {
      await logTrends(answers);
    }

    return res.status(200).json({ shortlist, count: shortlist.length });
  } catch (err) {
    console.error('match.js error:', err.message, err.stack);
    return res.status(500).json({ error: 'Matching failed: ' + err.message });
  }
};
