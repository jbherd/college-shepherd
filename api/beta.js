// api/beta.js
// Validates beta access codes with expiry dates
// Add new codes here as needed

const BETA_CODES = {
  'SPRING2026': { expires: '2026-05-31', label: 'Spring 2026 Beta' },
  'COUNSELOR26': { expires: '2026-06-30', label: 'Counselor Beta' },
  'IECA2026':   { expires: '2026-06-30', label: 'IECA Partner Beta' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, error: 'No code provided' });

  const entry = BETA_CODES[code.toUpperCase().trim()];
  if (!entry) return res.status(200).json({ valid: false, error: 'Invalid code' });

  const now = new Date();
  const expiry = new Date(entry.expires);
  if (now > expiry) return res.status(200).json({ valid: false, error: 'Beta access has expired' });

  return res.status(200).json({ valid: true, label: entry.label, expires: entry.expires });
}
