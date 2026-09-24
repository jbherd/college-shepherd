// lib/rateLimit.js
//
// Per-key rate limiting for API routes.
//
// The old approach (a plain `Map` kept in module scope inside each api/*.js
// file) only works within a single warm serverless instance -- Vercel
// spins up separate instances under concurrent load and after cold starts,
// each with its own empty Map, so the "limit" resets constantly and is
// trivial to exceed just by making requests fast enough to hit a fresh
// instance. It was never a real cap, just a per-instance nuisance check.
//
// This module uses Vercel KV / Upstash Redis (same REST API) when it's
// configured, which gives a real, shared, durable counter across every
// instance. If no KV store is connected yet, it falls back to the old
// in-memory Map behavior so nothing breaks -- but that fallback is best-
// effort only, exactly as before. To get the real fix, connect a KV store
// to this Vercel project (Storage tab -> Create Database -> KV) so the
// KV_REST_API_URL / KV_REST_API_TOKEN env vars are set. Upstash's own
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN vars work too, if you
// provision Upstash directly instead of through Vercel's integration.

const memHits = new Map();

function kvConfig() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    return { url, token };
}

// Atomically increments key's counter (creating it with the given TTL on
// first use) and returns the new count. Uses Upstash/Vercel KV's REST
// pipeline so the INCR + EXPIRE happen in one round trip.
async function kvIncrWithTTL(kv, key, ttlSeconds) {
    const res = await fetch(`${kv.url}/pipeline`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${kv.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify([
            ['INCR', key],
            ['EXPIRE', key, String(ttlSeconds), 'NX'], // NX: only set TTL if key had none
        ]),
    });
    if (!res.ok) throw new Error(`KV request failed: ${res.status}`);
    const [incrResult] = await res.json();
    return Number(incrResult.result);
}

// checkLimit(key, { max, windowSeconds })
// Returns { ok, count, remaining, backend } -- backend is 'kv' or 'memory' so
// callers/logs can tell which mode is actually protecting a given request.
async function checkLimit(key, { max, windowSeconds }) {
    const kv = kvConfig();

    if (kv) {
        try {
            const count = await kvIncrWithTTL(kv, key, windowSeconds);
            return { ok: count <= max, count, remaining: Math.max(0, max - count), backend: 'kv' };
        } catch (e) {
            console.error('rateLimit: KV error, falling back to in-memory for this request:', e.message);
            // fall through to in-memory below rather than fail the request
        }
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const entry = memHits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    memHits.set(key, entry);
    return {
        ok: entry.count <= max,
        count: entry.count,
        remaining: Math.max(0, max - entry.count),
        backend: 'memory',
    };
}

module.exports = { checkLimit };
