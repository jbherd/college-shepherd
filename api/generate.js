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

async function callAnthropic(apiKey, prompt, max_tokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens,
        messages: [{ role: "user", content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    return r;
  } catch(e) {
    clearTimeout(timeout);
    throw e;
  }
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

  console.log("Calling Anthropic, prompt length:", prompt.length);

  try {
    const r = await callAnthropic(apiKey, prompt, max_tokens);
    const d = await r.json();
    console.log("Anthropic responded, status:", r.status);
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || "Anthropic error" });
    const text = d.content?.[0]?.text || "";
    return res.status(200).json({ text, remaining: limit.remaining });
  } catch (err) {
    console.error("Anthropic error:", err.message);
    return res.status(500).json({ error: "Generation timed out. Please try again." });
  }
};
