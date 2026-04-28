// api/generate.js — streaming proxy to Anthropic
export const config = { maxDuration: 60 };

const RATE_LIMIT = 20;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const hits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + WINDOW_MS; }
  entry.count++;
  hits.set(ip, entry);
  return { ok: entry.count <= RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - entry.count), resetAt: entry.reset, message: `Rate limit exceeded. Try again tomorrow.` };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  const limit = checkRateLimit(ip);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining));

  if (!limit.ok) return res.status(429).json({ error: limit.message, rateLimited: true, resetAt: limit.resetAt, limit: RATE_LIMIT });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { prompt, max_tokens = 4000 } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || `Anthropic API error ${response.status}` });
    }

    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text, remaining: limit.remaining });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
}
