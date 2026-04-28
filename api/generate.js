export const config = { maxDuration: 300 }; 
// api/generate.js — Edge Function (no timeout)
export const config = { maxDuration: 300 };

const RATE_LIMIT = 20;

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });

  let body;
  try { body = await req.json(); } catch(e) { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { prompt, max_tokens = 2000 } = body;
  if (!prompt) return new Response(JSON.stringify({ error: 'Missing prompt' }), { status: 400 });

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
    if (!response.ok) return new Response(JSON.stringify({ error: data.error?.message || 'Anthropic error' }), { status: response.status, headers: { 'Access-Control-Allow-Origin': '*' } });

    const text = data.content?.[0]?.text || '';
    return new Response(JSON.stringify({ text, remaining: RATE_LIMIT }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}


