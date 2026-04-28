const RATE_LIMIT = 20;
const WINDOW_MS = 86400000;
const hits = new Map();

function checkRL(ip) {
  const now = Date.now();
  const e = hits.get(ip) || { c: 0, r: now + WINDOW_MS };
  if (now > e.r) { e.c = 0; e.r = now + WINDOW_MS; }
  e.c++;
  hits.set(ip, e);
  return { ok: e.c <= RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - e.c) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const limit = checkRL(req.headers['x-forwarded-for']?.split(',')[0] || 'x');
  if (!limit.ok) return res.status(429).json({ error: 'Rate limit exceeded' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });

  const { prompt, max_tokens = 6000 } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
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
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Anthropic error' });
    return res.status(200).json({ text: d.content?.[0]?.text || '', remaining: limit.remaining });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};

