const RATE_LIMIT = 20;
const WINDOW_MS = 864e5;
const hits = new Map();

function checkRL(ip) {
  const now = new Date().getTime();
  const e = hits.get(ip) || { c: 0, r: now + WINDOW_MS };
  if (now > e.r) { e.c = 0; e.r = now + WINDOW_MS; }
  e.c++;
  hits.set(ip, e);
  return { ok: e.c <= RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - e.c) };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "bad method" });

  const limit = checkRL((req.headers["x-forwarded-for"] || "x").split(",")[0]);
  if (!limit.ok) return res.status(429).json({ error: "Rate limit exceeded. Try again tomorrow." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "No API key" });

  const { prompt, max_tokens = 6000 } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  // Set headers for streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "messages-2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens,
        stream: false,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const d = await r.json();
    if (!r.ok) {
      res.write("data: " + JSON.stringify({ error: d.error?.message || "Anthropic error" }) + "\n\n");
      return res.end();
    }

    const text = d.content?.[0]?.text || "";
    res.write("data: " + JSON.stringify({ text, remaining: limit.remaining, done: true }) + "\n\n");
    return res.end();

  } catch (err) {
    res.write("data: " + JSON.stringify({ error: err.message }) + "\n\n");
    return res.end();
  }
};
