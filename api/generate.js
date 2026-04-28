const RATE_LIMIT = 20;
const WINDOW_MS = 86400000;
  e.c++;
}
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { prompt, max_tokens = 6000 } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  }
};
