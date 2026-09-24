// lib/trends.js
//
// Anonymous, aggregate-only trend counters for completed questionnaires.
//
// What this is NOT: a per-student record store. It never writes a record
// that says "this one student answered X, Y, Z" -- it only increments a
// running count per (question key, answer value) pair, e.g.
// "trend:cost_concern:Very important" -> 214. There is no way to
// reconstruct any individual's full answer set from what's stored here,
// and nothing here is ever linked to a name, email, IP address, or
// purchase record.
//
// What's deliberately excluded from counting (see EXCLUDED_KEYS below):
// - 'name' -- the student's first name, obviously identifying.
// - 'anything_else' -- a free-text box that could contain anything a
//   student chooses to type, including identifying details.
// Every other questionnaire answer is a fixed multiple-choice option (or a
// short list of them), so counting them can't leak free text.
//
// Storage: the same Vercel KV / Upstash Redis store lib/rateLimit.js uses.
// If no KV store is connected, logTrends() and getTrends() both silently
// no-op -- unlike the rate limiter, there's no in-memory fallback here,
// because trend data that resets on every cold start isn't useful. Connect
// a KV store (Storage tab -> Create Database -> KV) to start accumulating.

const EXCLUDED_KEYS = new Set(['name', 'anything_else']);

function kvConfig() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    return { url, token };
}

// Reduce one answer value down to something safe to count: a short,
// trimmed string. Long strings (free text that slipped past a 'quick'
// question type) and non-scalar values are dropped rather than counted,
// so nothing unbounded or unexpected ends up as a KV key.
function safeScalar(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    if (!trimmed || trimmed.length > 80) return null;
    return trimmed;
}

function safeValues(raw) {
    if (Array.isArray(raw)) {
        return raw.map(safeScalar).filter((v) => v != null).slice(0, 5);
    }
    const v = safeScalar(raw);
    return v == null ? [] : [v];
}

// Fire-and-forget: log one completed questionnaire's answers as aggregate
// counter increments. Never throws -- callers should call this without
// awaiting (or await inside a try/catch) so a KV hiccup never affects the
// actual match/generate response.
async function logTrends(answers) {
    const kv = kvConfig();
    if (!kv || !answers || typeof answers !== 'object') return;

    const commands = [];
    for (const [key, rawValue] of Object.entries(answers)) {
        if (EXCLUDED_KEYS.has(key)) continue;
        for (const value of safeValues(rawValue)) {
            // e.g. "trend:cost_concern:Very important"
            const bucketKey = `trend:${key}:${value}`.slice(0, 200);
            commands.push(['INCR', bucketKey]);
        }
    }
    if (!commands.length) return;

    // Also track total completions per month, so counts can be read as
    // percentages later (e.g. "62% of October's students were cost-sensitive").
    const month = new Date().toISOString().slice(0, 7); // "2026-09"
    commands.push(['INCR', `trend:_total:${month}`]);
    // And keep a registry of every question key we've ever seen an answer
    // for, so the trends viewer can list them without guessing names.
    const questionKeys = Object.keys(answers).filter((k) => !EXCLUDED_KEYS.has(k));
    for (const key of questionKeys) {
        commands.push(['SADD', 'trend:_keys', key]);
    }

    try {
        await fetch(`${kv.url}/pipeline`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(commands),
        });
    } catch (e) {
        console.error('trends: failed to log (non-fatal):', e.message);
    }
}

// Reads back every counter for the trends viewer (api/trends.js). Returns
// { months: {...}, questions: { <key>: { <answer>: count, ... }, ... } }.
async function getTrends() {
    const kv = kvConfig();
    if (!kv) return { configured: false, months: {}, questions: {} };

    async function kvCall(commands) {
        const res = await fetch(`${kv.url}/pipeline`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(commands),
        });
        if (!res.ok) throw new Error(`KV request failed: ${res.status}`);
        return res.json();
    }

    // 1. Get the registry of known question keys, plus all _total:<month> keys.
    const [keysResult] = await kvCall([['SMEMBERS', 'trend:_keys']]);
    const questionKeys = Array.isArray(keysResult.result) ? keysResult.result : [];

    const [monthKeysResult] = await kvCall([['KEYS', 'trend:_total:*']]);
    const monthKeys = Array.isArray(monthKeysResult.result) ? monthKeysResult.result : [];

    const months = {};
    if (monthKeys.length) {
        const [monthValsResult] = await kvCall([['MGET', ...monthKeys]]);
        const vals = monthValsResult.result || [];
        monthKeys.forEach((k, i) => {
            months[k.replace('trend:_total:', '')] = Number(vals[i]) || 0;
        });
    }

    // 2. For each question key, find every "trend:<key>:*" counter and its value.
    const questions = {};
    for (const key of questionKeys) {
        const pattern = `trend:${key}:*`;
        const [found] = await kvCall([['KEYS', pattern]]);
        const bucketKeys = Array.isArray(found.result) ? found.result : [];
        if (!bucketKeys.length) continue;
        const [valsResult] = await kvCall([['MGET', ...bucketKeys]]);
        const vals = valsResult.result || [];
        const prefix = `trend:${key}:`;
        const answers = {};
        bucketKeys.forEach((k, i) => {
            answers[k.slice(prefix.length)] = Number(vals[i]) || 0;
        });
        questions[key] = answers;
    }

    return { configured: true, months, questions };
}

module.exports = { logTrends, getTrends };
