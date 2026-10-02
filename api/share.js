// api/share.js
//
// Stores a generated college list's shareable summary server-side (in the
// same Vercel KV / Upstash Redis store api/generate.js, api/verify-payment.js,
// and lib/rateLimit.js already use) under a short random id, so a share link
// can be a handful of characters instead of the whole list URL-encoded into
// the query string (see the Oct 2026 "the share link is a giant garbled URL"
// report).
//
// If no KV store is connected, POST returns 501 and app.html's getShareUrl()
// falls back to the original self-contained ?d= link -- nothing breaks,
// sharing just looks worse until a KV store is connected (Vercel project ->
// Storage -> Create Database -> KV, or set UPSTASH_REDIS_REST_URL/TOKEN).

function kvConfig() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    return { url, token };
}

const TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days -- plenty long for a list to still be worth revisiting/sharing
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_RE = /^[a-z0-9]{4,16}$/;

function randomId(len = 8) {
    let id = '';
    for (let i = 0; i < len; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    return id;
}

// Uses the KV store's REST pipeline (one request, JSON body) instead of
// building values into a URL path/query -- avoids any URL-length or
// encoding surprises for a payload with ~10 schools' worth of data in it.
async function kvPipeline(kv, commands) {
    const res = await fetch(`${kv.url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`KV request failed: ${res.status}`);
    return res.json();
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const kv = kvConfig();
    if (!kv) return res.status(501).json({ error: 'Short links are not configured on this server yet.' });

    if (req.method === 'POST') {
        const { n, c, cr } = req.body || {};
        if (!n || !Array.isArray(c)) return res.status(400).json({ error: 'Missing list data' });

        const payload = JSON.stringify({ n, c: c.slice(0, 10), cr: cr || new Date().toISOString() });
        if (payload.length > 8000) return res.status(400).json({ error: 'List data too large' });

        try {
            let id = null;
            // 36^8 possible ids -- this loop is just a sanity check, not a
            // real collision-handling system.
            for (let attempt = 0; attempt < 3 && !id; attempt++) {
                const candidate = randomId();
                const [getResult] = await kvPipeline(kv, [['GET', `share:${candidate}`]]);
                if (!getResult.result) id = candidate;
            }
            if (!id) return res.status(500).json({ error: 'Could not allocate a share id' });

            await kvPipeline(kv, [['SET', `share:${id}`, payload, 'EX', String(TTL_SECONDS)]]);
            return res.status(200).json({ id });
        } catch (e) {
            console.error('share.js: KV error on create:', e.message);
            return res.status(502).json({ error: 'Could not save share link' });
        }
    }

    if (req.method === 'GET') {
        const id = (req.query && req.query.id) || '';
        if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
        try {
            const [getResult] = await kvPipeline(kv, [['GET', `share:${id}`]]);
            if (!getResult.result) return res.status(404).json({ error: 'Not found' });
            return res.status(200).json(JSON.parse(getResult.result));
        } catch (e) {
            console.error('share.js: KV error on read:', e.message);
            return res.status(502).json({ error: 'Could not load share link' });
        }
    }

    return res.status(405).json({ error: 'bad method' });
};
