// api/generate.js
// Vercel serverless function — proxies requests to Anthropic API
//
// TESTING MODE: API key is hardcoded below for beta testing.
// Before public launch: remove the hardcoded key and uncomment
// the process.env line, then add key in Vercel dashboard.

const RATE_LIMIT = 7;
const WINDOW_MS  = 24 * 60 * 60 * 1000;
const ipStore    = new Map();

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = ipStore.get(ip);
  if (!entry || now > entry.resetAt) {
    ipStore.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1, resetAt: now + WINDOW_MS };
  }
  if (entry.count >= RATE_LIMIT) {
    const hoursLeft = Math.ceil((entry.resetAt - now) / 3600000);
    const minsLeft  = Math.ceil((entry.resetAt - now) / 60000);
    return {
      allowed: false, remaining: 0, resetAt: entry.resetAt,
      message: hoursLeft > 1
        ? `You've used all ${RATE_LIMIT} list generations for today. Resets in ${hoursLeft} hours.`
        : `You've used all ${RATE_LIMIT} list generations for today. Resets in ${minsLeft} minutes.`
    };
  }
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count, resetAt: entry.resetAt };
}

let reqCount = 0;
function cleanup() {
  if (++reqCount % 100 === 0) {
    const now = Date.now();
    for (const [ip, e] of ipStore.entries()) {
      if (now > e.resetAt) ipStore.delete(ip);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  cleanup();
  const limit = checkRateLimit(ip);
  res.setHeader('X-RateLimit-Limit',     String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
  res.setHeader('X-RateLimit-Reset',     String(Math.ceil((limit.resetAt || Date.now()) / 1000)));

  if (!limit.allowed) {
    return res.status(429).json({
      error: limit.message, rateLimited: true, resetAt: limit.resetAt, limit: RATE_LIMIT
    });
  }

  // ── API KEY ───────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured.' });
  }

  try {
    const { prompt, max_tokens = 10000 } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid prompt' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:    'claude-sonnet-4-5',
        max_tokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || `Anthropic API error ${response.status}`
      });
    }

    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text, remaining: limit.remaining });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
}
