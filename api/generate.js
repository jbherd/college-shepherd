const { checkLimit } = require('../lib/rateLimit');
const {
    verifyPurchaseToken,
    bumpGenerationCount,
    tokenFromRequest,
    MAX_GENERATIONS,
    MAX_PROFILES_PER_PURCHASE,
    TOKEN_TTL_DAYS,
} = require('../lib/purchaseAuth');
// A valid personal dev-access token (the same one that already unlocks the
// paywall via ?token=xxx and gates /api/demo and /api/trends) now also lets
// its holder skip the purchase/anonymous generation cap entirely here. This
// exists so testing the real questionnaire -> real Claude call flow doesn't
// burn down a purchase token's 8-generation allowance or trip the shared
// anonymous per-IP limit -- previously there was no way to QA this endpoint
// repeatedly without eating into the same cap a paying customer gets.
const { verifyToken: verifyDevToken, tokenFromRequest: devTokenFromRequest } = require('../lib/devAuth');

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

// Per-profile generation cap and per-purchase profile-count guardrail (see
// the comments on MAX_GENERATIONS / MAX_PROFILES_PER_PURCHASE in
// lib/purchaseAuth.js for why this moved off the token's own count) share
// the purchase token's own 365-day lifetime, so a profile's allowance
// doesn't quietly expire before the purchase itself does.
const PROFILE_WINDOW_SECONDS = TOKEN_TTL_DAYS * 24 * 60 * 60;

// Keeps the request's X-Profile-Id header (the active named profile on the
// client, e.g. "jim" or "bella-2") safe to use as a KV key component --
// strips anything that isn't lowercase alphanumeric/hyphen and caps length.
// A missing/unreadable id (old client build, header stripped somewhere,
// anonymous/dev path) collapses to 'default' rather than failing the
// request -- that just means that purchase's cap is tracked as a single
// pool until the client sends a real id, matching the old shared-pool
// behavior instead of breaking generation entirely.
function sanitizeProfileId(raw) {
    if (!raw || typeof raw !== 'string') return 'default';
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    return cleaned || 'default';
}

// In-memory fallback for the profile-count guardrail when KV isn't
// connected -- best-effort only (resets per cold serverless instance), same
// philosophy as lib/rateLimit.js's own in-memory fallback.
const memProfileSets = new Map();

// Has this purchase already registered MAX_PROFILES_PER_PURCHASE distinct
// profile ids with /api/generate? An id that's already registered is NEVER
// blocked here, no matter how many profiles exist on the purchase -- this
// only refuses a never-seen-before id once the purchase is already full.
async function checkProfileCount(kv, sessionId, profileId) {
    const key = `purchase-profiles:${sessionId}`;
    if (kv) {
        try {
            const res = await fetch(`${kv.url}/pipeline`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify([
                    ['SISMEMBER', key, profileId],
                    ['SADD', key, profileId],
                    ['EXPIRE', key, String(PROFILE_WINDOW_SECONDS), 'NX'],
                    ['SCARD', key],
                ]),
            });
            if (!res.ok) throw new Error(`KV request failed: ${res.status}`);
            const results = await res.json();
            const alreadyKnown = Number(results[0].result) === 1;
            const count = Number(results[3].result);
            return { ok: alreadyKnown || count <= MAX_PROFILES_PER_PURCHASE };
        } catch (e) {
            console.error('generate.js: KV error checking profile count, falling back to in-memory:', e.message);
            // fall through to in-memory below rather than fail the request
        }
    }
    const set = memProfileSets.get(sessionId) || new Set();
    const alreadyKnown = set.has(profileId);
    if (!alreadyKnown) set.add(profileId);
    memProfileSets.set(sessionId, set);
    return { ok: alreadyKnown || set.size <= MAX_PROFILES_PER_PURCHASE };
}

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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Purchase-Token, X-Dev-Token, X-Profile-Id");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "bad method" });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "No API key" });

    const { prompt, max_tokens = 3000 } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // ── Access + quota check ────────────────────────────────────────────
    // A valid dev token bypasses everything below -- no purchase/anonymous
    // cap applies at all for this request.
    const isDev = verifyDevToken(devTokenFromRequest(req)).valid;

    const rawToken = tokenFromRequest(req);
    const profileId = sanitizeProfileId(req.headers['x-profile-id'] || req.headers['X-Profile-Id']);
    let purchase = null;
    let anonRemaining = null; // set only on the no-token path, for the counter UI
    let profileRemaining = null; // set only on the purchase-token path, for the counter UI

    if (isDev) {
        // Skip quota checks entirely.
    } else if (rawToken) {
        const verified = verifyPurchaseToken(rawToken);
        if (!verified.valid) {
            return res.status(401).json({ error: 'Invalid or expired purchase token (' + verified.reason + ')' });
        }

        const kv = kvConfig();

        const profileCountCheck = await checkProfileCount(kv, verified.sessionId, profileId);
        if (!profileCountCheck.ok) {
            return res.status(429).json({
                error: `This purchase already has ${MAX_PROFILES_PER_PURCHASE} people using it. Need room for one more? Email hello@collegeshepherd.com.`,
                rateLimited: true,
                capReached: true,
            });
        }

        // Each named profile on this purchase gets its own full
        // MAX_GENERATIONS allowance, tracked per (sessionId, profileId) in
        // KV -- not the generationsUsed count embedded in the token itself,
        // which used to be shared by every profile on the device. See the
        // long comment on MAX_GENERATIONS in lib/purchaseAuth.js.
        const genLimit = await checkLimit(`profile-gen:${verified.sessionId}:${profileId}`, {
            max: MAX_GENERATIONS,
            windowSeconds: PROFILE_WINDOW_SECONDS,
        });
        if (!genLimit.ok) {
            return res.status(429).json({
                error: `You've used all ${MAX_GENERATIONS} list generations included with your purchase (your first list plus up to ${MAX_GENERATIONS - 1} regenerations). Need another? Email hello@collegeshepherd.com.`,
                rateLimited: true,
                capReached: true,
                limit: MAX_GENERATIONS,
                remaining: 0,
            });
        }
        profileRemaining = genLimit.remaining;
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

    // Does `raw` parse as the college-list JSON app.html expects, once the
    // same cleanup app.html's own client-side repair applies (strip markdown
    // fences, drop trailing commas, drop stray apostrophes inside strings)?
    // Mirrors the client's repair steps in app.html's doGenerate() so
    // "this needed repair-step N to parse" isn't flagged as a server-side
    // failure when the client would have fixed it too; this only catches
    // output the client could NOT have recovered from.
    function looksLikeUsableCollegeJSON(raw) {
        if (!raw) return false;
        try {
            let fixed = raw.trim()
                .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/"([^"\\\n]*)'([^"\\\n]*)"/g, '"$1$2"');
            const parsed = JSON.parse(fixed);
            return !!(parsed && Array.isArray(parsed.colleges) && parsed.colleges.length > 0);
        } catch (e) {
            return false;
        }
    }

    // One call to the Anthropic API, bounded by its own timeout. Returns
    // either { ok:true, text } or { ok:false, status, error }.
    async function callAnthropicOnce(timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
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
            const d = await r.json();
            if (!r.ok) return { ok: false, status: r.status, error: d.error?.message || "Anthropic error" };
            return { ok: true, text: d.content?.[0]?.text || "" };
        } catch (err) {
            clearTimeout(timeout);
            return { ok: false, status: 500, error: err.message === "This operation was aborted" ? "Generation timed out. Please try again." : err.message };
        }
    }

    try {
        // Claude occasionally returns text that isn't valid (or repairable)
        // JSON -- stray commentary, a truncated object, a smart quote where
        // a straight one belongs -- and until now that went straight back
        // to the browser as an opaque "Generation failed" error, costing
        // the user one of their paid generations for a response nobody
        // could read. Since this is non-deterministic model output, a
        // second attempt is very likely to come back clean, so retry once
        // in-process (still counted as ONE generation against the user's
        // cap, since the cap was already checked/consumed above) before
        // giving up and surfacing an error. Two attempts at 85s each keeps
        // the worst case under vercel.json's 180s maxDuration for api/*.js.
        const MAX_ATTEMPTS = 2;
        const PER_ATTEMPT_TIMEOUT_MS = 85000;
        let text = "";
        let lastError = null;
        let lastStatus = 500;
        let usable = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            console.log(`Calling Anthropic (attempt ${attempt}/${MAX_ATTEMPTS})...`);
            const result = await callAnthropicOnce(PER_ATTEMPT_TIMEOUT_MS);
            if (!result.ok) {
                lastError = result.error;
                lastStatus = result.status;
                console.error(`generate.js: attempt ${attempt} failed:`, result.error);
                continue;
            }
            text = result.text;
            console.log("Response text length:", text.length);
            usable = looksLikeUsableCollegeJSON(text);
            if (usable) break;
            lastError = "The model's response could not be read as a valid list.";
            console.error(
                `generate.js: attempt ${attempt} returned unparseable JSON (length ${text.length}). First 300 chars:`,
                text.slice(0, 300)
            );
        }

        if (!usable) {
            return res.status(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502).json({
                error: lastError || "Generation failed - please try again.",
            });
        }

        const responseBody = { text, limit: MAX_GENERATIONS };

        if (isDev) {
            responseBody.remaining = 'unlimited';
        } else if (purchase) {
            // The real per-profile cap was already enforced (and counted)
            // above via checkLimit, so profileRemaining is authoritative for
            // this profile. The token's own embedded count is still bumped
            // and persisted as a running informational total across every
            // profile on this purchase (and to support the "discard and
            // reverify" KV fallback in api/verify-payment.js) -- it no
            // longer gates anything itself.
            const newToken = bumpGenerationCount(purchase);
            const newUsed = purchase.generationsUsed + 1;
            await persistUsedCount(kvConfig(), purchase.sessionId, newUsed);
            responseBody.purchaseToken = newToken;
            responseBody.remaining = profileRemaining;
        } else {
            responseBody.remaining = anonRemaining;
            responseBody.limit = ANON_RATE_LIMIT;
        }

        return res.status(200).json(responseBody);
    } catch (err) {
        console.error("Error:", err.message);
        return res.status(500).json({ error: err.message === "This operation was aborted" ? "Generation timed out. Please try again." : err.message });
    }
};
