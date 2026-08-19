#!/usr/bin/env node
/**
 * diversity-test.js
 *
 * Checks whether CollegeShepherd's college-list generator produces genuinely
 * different results for genuinely different students, or whether it's
 * converging on the same handful of "safe" schools (e.g. Indiana, Ohio State)
 * regardless of who's asking.
 *
 * HOW IT WORKS
 * It reads the live prompt-building logic straight out of public/app.html
 * (the same RANKINGS_REF reference data and instructions the real site uses),
 * runs it against a batch of synthetic student profiles that deliberately
 * span very different majors/budgets/regions/vibes, calls the Anthropic API
 * directly, and reports how much the resulting lists overlap.
 *
 * Because it reads app.html at runtime, this stays in sync automatically —
 * if you edit the prompt in app.html, re-running this script tests the new
 * version, no manual updates needed here.
 *
 * USAGE
 *   ANTHROPIC_API_KEY=sk-ant-... node tools/diversity-test.js
 *
 * Run this from the repo root. Requires Node 18+ (built-in fetch).
 * Uses the real production model (claude-haiku-4-5-20251001) and the real
 * max_tokens (2500) so results reflect what actual users see.
 *
 * COST: each profile is one Haiku call (~13-15k input tokens with the
 * reference data included, ~2500 output tokens). At current Haiku pricing
 * that's roughly $0.01-0.02 per profile — a 16-profile run costs well under
 * a dollar. This does NOT touch your production rate limiter or your users'
 * quota; it calls Anthropic directly.
 *
 * Run this after any change to the prompt/reference data, or periodically
 * (e.g. monthly) as a regression check. Results are also saved to
 * tools/diversity-results/<timestamp>.json so you can track trends over time.
 */

const fs = require('fs');
const path = require('path');

const APP_HTML_PATH = path.join(__dirname, '..', 'public', 'app.html');
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 16000; // 2500, 4096, and 8192 all still truncated some profiles. Haiku 4.5 supports up to 64k output tokens, so there's plenty of headroom here — raising this costs nothing extra unless the model actually uses it (billed on actual output, not the cap).

// ── 1. Extract the live prompt-building pieces from app.html ──────────────

function extractPromptPieces(html) {
  // RANKINGS_REF's template literal has no semicolon right after its closing
  // backtick (relies on ASI), so we anchor on the following `const prompt =`
  // rather than on a `; sequence — the latter would run past this variable's
  // real end and swallow the prompt declaration itself as string content.
  const rankingsMatch = html.match(/const RANKINGS_REF = `([\s\S]*?)`\s*\n\s*const prompt = /);
  if (!rankingsMatch) throw new Error('Could not find RANKINGS_REF in app.html — has the code changed shape?');
  const rankingsRef = rankingsMatch[1];

  const promptMatch = html.match(/const prompt = `([\s\S]*?)`;\s*\n\s*try \{/);
  if (!promptMatch) throw new Error('Could not find the prompt template in app.html — has the code changed shape?');

  // The raw template as authored uses `${profile}` and `${RANKINGS_REF}` — turn
  // it into a real JS template function we can call per synthetic profile.
  const rawTemplate = promptMatch[1];

  return { rawTemplate, rankingsRef };
}

function buildPrompt(rawTemplate, rankingsRef, profileText) {
  return rawTemplate
    .replace('${RANKINGS_REF}', rankingsRef)
    .replace('${profile}', profileText);
}

// ── 2. Synthetic student profiles — deliberately spread across very ───────
//    different majors, budgets, regions, campus vibes, and academic bands.

const PROFILES = [
  {
    label: 'CA, low-income, pre-med, wants huge research school',
    text: `Home State: California
Family Income Bracket: Under $30,000
Intended Major: Biology / Pre-Med
GPA: 3.9 unweighted
Test Scores: 1480 SAT
Campus Size Preference: Large research university
Campus Vibe: Intense academics, competitive
Hidden Gem Openness: Not very open — I want a recognizable name for med school applications
Greek Life Interest: No preference
First Gen: first in my family`,
  },
  {
    label: 'TX, wealthy, business/finance, wants Greek life + football',
    text: `Home State: Texas
Family Income Bracket: Over $150,000
Intended Major: Finance / Business
GPA: 3.4 unweighted
Test Scores: 1280 SAT
Campus Size Preference: Large
Campus Vibe: Big Greek life, big football culture, social
Hidden Gem Openness: Not open, want a well-known school
Greek Life Interest: Very important`,
  },
  {
    label: 'VT, middle-income, art/design, wants small arts school',
    text: `Home State: Vermont
Family Income Bracket: $48,000 – $75,000
Intended Major: Studio Art / Design
GPA: 3.6 unweighted
Test Scores: did not submit (test-optional)
Campus Size Preference: Small, under 3,000 students
Campus Vibe: Artsy, quirky, creative
Hidden Gem Openness: Very open — prefer schools I've never heard of
Greek Life Interest: Not interested`,
  },
  {
    label: 'FL, low-income, engineering, wants warm climate, cost-sensitive',
    text: `Home State: Florida
Family Income Bracket: $30,000 – $48,000
Intended Major: Mechanical Engineering
GPA: 4.0 unweighted
Test Scores: 1520 SAT
Campus Size Preference: Medium
Campus Vibe: Serious, career-focused
Hidden Gem Openness: Somewhat open if it saves money
Greek Life Interest: No preference
First Gen: first in my family`,
  },
  {
    label: 'WA, upper-middle, undecided/exploratory, wants small liberal arts',
    text: `Home State: Washington
Family Income Bracket: $110,000 – $150,000
Intended Major: Undecided — interested in philosophy, poli sci, maybe pre-law
GPA: 3.7 unweighted
Test Scores: 1350 SAT
Campus Size Preference: Small, under 2,500 students
Campus Vibe: Intellectual, discussion-based classes, close to faculty
Hidden Gem Openness: Very open
Greek Life Interest: Not interested`,
  },
  {
    label: 'GA, low-income, nursing, wants close to home + affordable',
    text: `Home State: Georgia
Family Income Bracket: Under $30,000
Intended Major: Nursing
GPA: 3.5 unweighted
Test Scores: 1150 SAT
Campus Size Preference: Medium
Campus Vibe: Practical, hands-on, supportive
Hidden Gem Openness: Very open, cost matters more than prestige
Greek Life Interest: No preference
Home Region Preference: Wants to stay within driving distance of home
First Gen: first in my family`,
  },
  {
    label: 'IL, wealthy, computer science, wants elite tech-adjacent school',
    text: `Home State: Illinois
Family Income Bracket: Over $150,000
Intended Major: Computer Science
GPA: 3.95 unweighted
Test Scores: 1550 SAT
Campus Size Preference: No preference
Campus Vibe: Competitive, tech culture, strong recruiting pipeline
Hidden Gem Openness: Not open — wants strong brand recognition for tech recruiting
Greek Life Interest: Mild interest`,
  },
  {
    label: 'MS, middle-income, music performance, wants conservatory feel',
    text: `Home State: Mississippi
Family Income Bracket: $48,000 – $75,000
Intended Major: Music Performance (Vocal)
GPA: 3.3 unweighted
Test Scores: 1120 SAT
Campus Size Preference: Small to medium
Campus Vibe: Arts-focused, strong music program, performance opportunities
Hidden Gem Openness: Very open, program quality matters far more than name
Greek Life Interest: Not interested`,
  },
  {
    label: 'AZ, low-income, environmental science, wants outdoorsy/rural',
    text: `Home State: Arizona
Family Income Bracket: $30,000 – $48,000
Intended Major: Environmental Science
GPA: 3.6 unweighted
Test Scores: 1250 SAT
Campus Size Preference: Small to medium
Campus Vibe: Outdoorsy, close to nature, sustainability-focused
Hidden Gem Openness: Very open
Greek Life Interest: Not interested
First Gen: first in my family`,
  },
  {
    label: 'NY, wealthy, theater/performing arts, wants urban',
    text: `Home State: New York
Family Income Bracket: Over $150,000
Intended Major: Musical Theater
GPA: 3.2 unweighted
Test Scores: did not submit (test-optional)
Campus Size Preference: No preference
Campus Vibe: Urban, close to a performing arts scene, competitive conservatory-style program
Hidden Gem Openness: Somewhat open if the program is strong
Greek Life Interest: Not interested`,
  },
  {
    label: 'OH, middle-income, undecided STEM, wants Big Ten energy',
    text: `Home State: Ohio
Family Income Bracket: $75,000 – $110,000
Intended Major: Undecided — leaning STEM, maybe biology or chemistry
GPA: 3.5 unweighted
Test Scores: 1230 SAT
Campus Size Preference: Large
Campus Vibe: Big school spirit, football culture, lots of clubs
Hidden Gem Openness: Not very open, wants a recognizable school
Greek Life Interest: Somewhat interested`,
  },
  {
    label: 'NM, low-income, criminal justice, wants small and supportive',
    text: `Home State: New Mexico
Family Income Bracket: Under $30,000
Intended Major: Criminal Justice
GPA: 3.1 unweighted
Test Scores: 1050 SAT
Campus Size Preference: Small
Campus Vibe: Supportive, small class sizes, hands-on advising
Hidden Gem Openness: Very open
Greek Life Interest: Not interested
First Gen: first in my family`,
  },
];

// ── 3. Call Anthropic directly ─────────────────────────────────────────────

async function callAnthropic(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  const text = data.content?.[0]?.text || '';
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  // Pull out just the first balanced-brace {...} object rather than assuming
  // the whole string is clean JSON — the model sometimes appends trailing
  // text/notes after a perfectly valid JSON object, which a plain JSON.parse
  // rejects even though the actual data is fine.
  function extractFirstJsonObject(str) {
    const start = str.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inString = false, escape = false;
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
    }
    return null; // never closed — genuinely truncated
  }

  const candidate = extractFirstJsonObject(cleaned);
  try {
    if (!candidate) throw new Error('no balanced { ... } object found');
    return JSON.parse(candidate);
  } catch (parseErr) {
    // stop_reason tells us definitively whether this is truncation (hit the
    // max_tokens cap mid-response) vs. a genuine malformed-JSON bug — much
    // more reliable than guessing from where the parser choked.
    const truncated = data.stop_reason === 'max_tokens';
    const hint = truncated
      ? `response was CUT OFF at the ${MAX_TOKENS}-token output limit before finishing (stop_reason: max_tokens, ${text.length} chars received) — the fix is to raise max_tokens`
      : `stop_reason was "${data.stop_reason}", not max_tokens, so this is NOT truncation — looks like a genuine malformed-JSON bug in the model's output (${text.length} chars received). Last 200 chars: ${JSON.stringify(text.slice(-200))}`;
    throw new Error(`JSON parse failed (${parseErr.message}) — ${hint}`);
  }
}

// ── 4. Run + analyze ────────────────────────────────────────────────────────

function promptForKey() {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Paste your Anthropic API key and press Enter (it will not be saved anywhere): ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  // .trim() guards against a stray trailing newline/space from copy-paste,
  // which otherwise produces a confusing "invalid x-api-key" with no other clue.
  let apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    apiKey = (await promptForKey()).trim();
  }
  if (!apiKey) {
    console.error('No API key entered. Run the script again and paste your key when asked.');
    process.exit(1);
  }
  const masked = apiKey.length > 14
    ? `${apiKey.slice(0, 10)}...${apiKey.slice(-4)} (${apiKey.length} chars)`
    : '(too short to be a real key)';
  console.log(`Using API key: ${masked}`);
  if (!apiKey.startsWith('sk-ant-')) {
    console.log(`WARNING: Anthropic keys normally start with "sk-ant-" — this one doesn't. Double check what got pasted.`);
  }

  const html = fs.readFileSync(APP_HTML_PATH, 'utf8');
  const { rawTemplate, rankingsRef } = extractPromptPieces(html);

  console.log(`Running ${PROFILES.length} synthetic profiles through the live prompt...\n`);

  const results = [];
  for (const p of PROFILES) {
    process.stdout.write(`  ${p.label} ... `);
    try {
      const prompt = buildPrompt(rawTemplate, rankingsRef, p.text);
      const out = await callAnthropic(apiKey, prompt);
      const schools = (out.colleges || []).map(c => c.name).filter(Boolean);
      results.push({ label: p.label, topPick: out.topPick?.school || null, schools });
      console.log(`OK (top pick: ${out.topPick?.school || '?'})`);
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      results.push({ label: p.label, topPick: null, schools: [], error: e.message });
    }
  }

  // Frequency of every school across all lists
  const freq = new Map();
  for (const r of results) {
    for (const s of r.schools) freq.set(s, (freq.get(s) || 0) + 1);
  }
  const sortedFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]);

  // Top-pick concentration
  const topPickFreq = new Map();
  for (const r of results) {
    if (r.topPick) topPickFreq.set(r.topPick, (topPickFreq.get(r.topPick) || 0) + 1);
  }
  const sortedTopPicks = [...topPickFreq.entries()].sort((a, b) => b[1] - a[1]);

  // Pairwise overlap (Jaccard) between every pair of profiles' 10-school lists
  let totalJaccard = 0, pairs = 0;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = new Set(results[i].schools), b = new Set(results[j].schools);
      if (a.size === 0 || b.size === 0) continue;
      const intersection = [...a].filter(x => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      totalJaccard += intersection / union;
      pairs++;
    }
  }
  const avgJaccard = pairs ? (totalJaccard / pairs) : 0;

  console.log('\n' + '='.repeat(70));
  console.log('DIVERSITY REPORT');
  console.log('='.repeat(70));

  console.log(`\nTop-pick distribution (${results.length} profiles):`);
  for (const [school, count] of sortedTopPicks) {
    const pct = Math.round((count / results.length) * 100);
    const flag = pct >= 25 ? '  <-- appears as the top pick for a lot of very different students' : '';
    console.log(`  ${String(count).padStart(2)}x (${pct}%)  ${school}${flag}`);
  }

  console.log(`\nMost over-represented schools across all 10-school lists:`);
  for (const [school, count] of sortedFreq.slice(0, 12)) {
    const pct = Math.round((count / results.length) * 100);
    console.log(`  ${String(count).padStart(2)}x (${pct}% of lists)  ${school}`);
  }

  console.log(`\nAverage overlap between any two different students' 10-school lists: ${(avgJaccard * 100).toFixed(1)}%`);
  console.log(`  (Jaccard similarity — 0% = completely different lists, 100% = identical lists.`);
  console.log(`   Since profiles here are deliberately very different from each other, healthy`);
  console.log(`   overlap is roughly under 15-20%. Higher than that suggests convergence.)`);

  // Save results for trend-tracking
  const outDir = path.join(__dirname, 'diversity-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ results, sortedFreq, sortedTopPicks, avgJaccard }, null, 2));
  console.log(`\nFull results saved to ${path.relative(process.cwd(), outPath)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
