const { checkLimit } = require('../lib/rateLimit');
const { verifyPurchaseToken, bumpGenerationCount, tokenFromRequest, MAX_GENERATIONS } = require('../lib/purchaseAuth');

// Anonymous/legacy fallback cap -- used only when the request carries no
// purchase token (i.e. the old `?paid=true` unlock, or verify-payment isn't
// wired up yet because the Stripe redirect URLs haven't been updated). This
// used to be 20/day; tightened to match MAX_GENERATIONS so an un-verified
// visitor can't run up meaningfully more usage than a real customer is
// promised, even though this path still can't tell a payer from a
// non-payer. See api/verify-payment.js for the real, per-purchase
// enforcement, which is what should be protecting real revenue once the
// Stripe Payment Link redirect URLs are updated to send session_id.
const ANON_RATE_LIMIT = MAX_GENERATIONS;
const RATE_WINDOW_SECONDS = 86400; // 24h

function kvConfig() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    return { url, token };
}

// Mirror the bumped count into KV (if connected) so a student who discards
// their token and re-calls /api/verify-payment with the same session_id
// gets a token reflecting real usage, not a reset-to-zero one. Best effort
// -- if this fails, the per-token signed count (already enforced above)
// still holds, it just won't survive a token-discard-and-reverify round trip.
async function persistUsedCount(kv, sessionId, used) {
    if (!kv) return;
    try {
        await fetch(`${kv.url}/set/purchase:${sessionId}:used/${used}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${kv.token}` },
        });
    } catch (e) {
        console.error('generate.js: failed to persist used count to KV:', e.message);
    }
}

module.exports = async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Purchase-Token");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "bad method" });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "No API key" });

    const { prompt, max_tokens = 3000 } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // ── Access + quota check ────────────────────────────────────────────
    const rawToken = tokenFromRequest(req);
    let purchase = null;
    let anonRemaining = null; // set only on the no-token path, for the counter UI

    if (rawToken) {
        const verified = verifyPurchaseToken(rawToken);
        if (!verified.valid) {
            return res.status(401).json({ error: 'Invalid or expired purchase token (' + verified.reason + ')' });
        }
        if (verified.generationsUsed >= MAX_GENERATIONS) {
            return res.status(429).json({
                error: `You've used all ${MAX_GENERATIONS} list generations included with your purchase (your first list plus up to ${MAX_GENERATIONS - 1} regenerations). Need another? Email hello@collegeshepherd.com.`,
                rateLimited: true,
                capReached: true,
                limit: MAX_GENERATIONS,
                remaining: 0,
            });
        }
        purchase = verified;
    } else {
        // No purchase token -- anonymous/legacy path, capped harder than before.
        const ip = (req.headers["x-forwarded-for"] || "x").split(",")[0];
        const limit = await checkLimit(`anon:${ip}`, { max: ANON_RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
        if (!limit.ok) {
            return res.status(429).json({ error: "Rate limit exceeded.", rateLimited: true, limit: ANON_RATE_LIMIT, remaining: 0 });
        }
        anonRemaining = limit.remaining;
    }

    console.log("START - prompt chars:", prompt.length, "max_tokens:", max_tokens, "authed:", !!purchase);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 170000);

    try {
        console.log("Calling Anthropic...");
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens,
                messages: [{ role: "user", content: prompt }]
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        console.log("Anthropic responded, status:", r.status);
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: d.error?.message || "Anthropic error" });
        const text = d.content?.[0]?.text || "";
        console.log("Response text length:", text.length);

        const responseBody = { text, limit: MAX_GENERATIONS };

        if (purchase) {
            const newToken = bumpGenerationCount(purchase);
            const newUsed = purchase.generationsUsed + 1;
            await persistUsedCount(kvConfig(), purchase.sessionId, newUsed);
            responseBody.purchaseToken = newToken;
            responseBody.remaining = Math.max(0, MAX_GENERATIONS - newUsed);
        } else {
            responseBody.remaining = anonRemaining;
            responseBody.limit = ANON_RATE_LIMIT;
        }

        return res.status(200).json(responseBody);
    } catch (err) {
        clearTimeout(timeout);
        console.error("Error:", err.message);
        return res.status(500).json({ error: err.message === "This operation was aborted" ? "Generation timed out. Please try again." : err.message });
    }
};
