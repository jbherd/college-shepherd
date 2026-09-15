#!/usr/bin/env node
/**
 * diversity-test.js
 *
 * Checks whether CollegeShepherd's college-list generator produces genuinely
 * different results for genuinely different students, or whether it's
 * converging on the same handful of "safe" schools (e.g. Indiana, Ohio State)
 * regardless of who's asking.
 *
 * HOW IT WORKS (updated for the real-search pipeline — see lib/matchEngine.js)
 * As of the matching-pipeline redesign, the AI no longer picks schools from
 * memory or a static reference block — it picks from a real, per-student
 * shortlist computed by lib/matchEngine.js against the full ~1,944-school
 * College Scorecard dataset. So this script now does what the real app does:
 * for each synthetic profile, it runs the SAME buildShortlist() the server
 * uses (via a direct require — no HTTP needed, this is the same Node module
 * api/match.js calls), builds the same referenceSection text app.html builds,
 * and substitutes it into the live prompt template extracted from app.html.
 * That means a genuinely useful diversity check now also implicitly verifies
 * the shortlist step is producing distinct, well-matched candidate pools per
 * profile — if all profiles got the same shortlist, this script would catch
 * that just as it would catch the AI converging on the same picks.
 *
 * Each synthetic profile below carries a structured `answers` object (the
 * same key/value shape as the real app's S.answers) so it exercises the
 * actual matching logic, not just free-text the model has to interpret. The
 * `text` field is still what gets shown to the AI as "STUDENT: ...".
 *
 * USAGE
 *   ANTHROPIC_API_KEY=sk-ant-... node tools/diversity-test.js
 *
 * Run this from the repo root. Requires Node 18+ (built-in fetch).
 * Uses the real production model (claude-haiku-4-5-20251001) and the real
 * max_tokens (2500) so results reflect what actual users see.
 *
 * COST: each profile is one Haiku call (~5-10k input tokens now that the
 * per-profile shortlist replaces the old always-included static reference
 * block, ~2500 output tokens). At current Haiku pricing that's a cent or two
 * per profile — a 16-profile run costs well under a dollar. This does NOT
 * touch your production rate limiter or your users' quota; it calls
 * Anthropic directly.
 *
 * Run this after any change to the prompt/matching logic, or periodically
 * (e.g. monthly) as a regression check. Results are also saved to
 * tools/diversity-results/<timestamp>.json so you can track trends over time.
 */

const fs = require('fs');
const path = require('path');
const { buildShortlist } = require('../lib/matchEngine.js');

const APP_HTML_PATH = path.join(__dirname, '..', 'public', 'app.html');
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 16000; // 2500, 4096, and 8192 all still truncated some profiles. Haiku 4.5 supports up to 64k output tokens, so there's plenty of headroom here — raising this costs nothing extra unless the model actually uses it (billed on actual output, not the cap).

// ── 1. Extract the live prompt template from app.html ─────────────────────

function extractPromptPieces(html) {
  const promptMatch = html.match(/const prompt = `([\s\S]*?)`;\s*\n\s*try \{/);
  if (!promptMatch) throw new Error('Could not find the prompt template in app.html — has the code changed shape?');
  return { rawTemplate: promptMatch[1] };
}

// Mirrors the shortlist -> prompt-text formatting in app.html's doGenerate().
// Kept in sync manually since one half runs in the browser and one half runs
// in Node — if you change the formatting in app.html, update this to match.
function formatShortlistForPrompt(shortlist) {
  return shortlist.map(s => {
    const parts = [
      s.name + ' (' + s.city + ', ' + s.state + ')',
      'tier-for-student:' + s.tierForStudent,
      'admit:' + (s.admitRatePct != null ? s.admitRatePct + '%' : 'N/A'),
      'size:' + (s.size || 'N/A') + (s.sizeCategory ? ' (' + s.sizeCategory + ')' : ''),
      'ownership:' + (s.ownership || '?'),
      'est-net-price-for-this-student:' + (s.estimatedNetPrice != null ? '$' + s.estimatedNetPrice.toLocaleString() + '/yr' : 'N/A'),
      'sticker-in-state:' + (s.tuitionInState != null ? '$' + s.tuitionInState.toLocaleString() : 'N/A'),
      'sticker-out-of-state:' + (s.tuitionOutOfState != null ? '$' + s.tuitionOutOfState.toLocaleString() : 'N/A'),
      '4yr-completion:' + (s.completionRate4yr != null ? Math.round(s.completionRate4yr * 100) + '%' : 'N/A'),
      'median-earnings-10yr:' + (s.medianEarnings10yr != null ? '$' + s.medianEarnings10yr.toLocaleString() : 'N/A'),
      (s.dominantPrograms && s.dominantPrograms.length) ? 'strong-programs:' + s.dominantPrograms.join('/') : '',
      s.vibe ? 'CHARACTER:' + s.vibe : '',
      (s.distinctives && s.distinctives.length) ? 'DISTINCTIVE-FACTS:' + s.distinctives.join(' | ') : '',
    ].filter(Boolean);
    return '- ' + parts.join(' | ');
  }).join('\n');
}

function buildReferenceSection(shortlist) {
  const shortlistText = formatShortlistForPrompt(shortlist);
  return `REAL CANDIDATE SCHOOLS — this is the ONLY list you may choose from. Every figure below comes straight from live U.S. Dept. of Education College Scorecard data for THIS student's specific situation (major fit, cost for their income bracket, size/setting preference, home-state value, and a mechanically-computed reach/match/safety tier vs. their academic profile):
${shortlistText}

STRICT RULES:
- Choose your 10 schools ONLY from the list above, using the exact name given. Never invent, substitute, or add a school that is not in this list.
- Use the exact admit rate, net price, tuition, completion rate, and earnings figures given above for each school — do not estimate or invent your own numbers.
- The "tier-for-student" value given is a mechanical estimate based on admit rate vs. this student's academic profile — use it as your primary guide for the reach/match/safety label, but you may adjust individual schools with good judgment if the CHARACTER/DISTINCTIVE-FACTS suggest otherwise. Still aim for roughly 3-4 reach, 4-5 match, 2-3 safety overall.
- Schools with a CHARACTER line and DISTINCTIVE-FACTS have real, researched detail — draw directly on it for "why", highlights, and fun facts. Schools WITHOUT those fields have only verified hard data (cost, size, admissions, programs) and no researched color yet — for those, keep "why"/highlights/funFacts grounded in the real facts given (location, size, program strength, cost, outcomes) rather than inventing campus-culture claims you have no data for. It's fine for a data-only school's highlights to be more factual/less colorful than a researched one's — don't compensate by making things up.
- HIDDEN GEMS: the list above already reflects this student's hidden_gem preference in which schools were surfaced — pick across the range you're given rather than defaulting only to the most recognizable names, unless the student's profile says otherwise.`;
}

function buildPrompt(rawTemplate, referenceSection, profileText) {
  return rawTemplate
    .replace('${referenceSection}', referenceSection)
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
    answers: {
      home_state: 'California',
      family_income: 'Under $30,000',
      major: 'Pre-Med / Health Sciences / Nursing',
      premed_focus: 'I want to be a physician (MD or DO)',
      gpa: "Mostly A's (3.7–4.0+ unweighted)",
      testscores: 'SAT 1450+ or ACT 33+ (top scores)',
      campus_size: 'Very large — big university culture (25K+)',
      greek_life: 'Neutral — doesn\'t matter either way',
      setting: 'Mid-size city — active but not overwhelming',
      cost_concern: 'Major — we need maximum financial aid and scholarships',
      school_type: 'No preference — best fit regardless',
      distance: 'Anywhere in the country — I\'m open',
      region: 'No preference — best fit anywhere',
      hidden_gem: 'Stick mostly to schools I already know about',
      name_recognition: 'Very important — I want a name that opens doors',
    },
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
    answers: {
      home_state: 'Texas',
      family_income: 'Over $150,000',
      major: 'Business / Finance / Entrepreneurship',
      biz_focus: 'Finance or investment banking',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'SAT 1250–1440 or ACT 27–32 (strong)',
      campus_size: 'Large — variety and energy (10–25K)',
      greek_life: 'Very important — I definitely want to rush',
      setting: 'College town — the campus IS the social center',
      cost_concern: 'Not a primary concern — focused on fit first',
      school_type: 'No preference — best fit regardless',
      distance: 'Same region — within half a day\'s drive',
      region: 'Texas (Austin, Houston, Dallas)',
      hidden_gem: 'Stick mostly to schools I already know about',
      name_recognition: 'Important — I\'d like a well-regarded school',
    },
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
    answers: {
      home_state: 'Vermont',
      family_income: '$48,000 – $75,000',
      major: 'Arts, Design, Film, or Music',
      arts_focus: 'Fine art or studio art',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'Going test-optional',
      campus_size: 'Small — everyone knows my name (under 3,000)',
      greek_life: 'Not for me — prefer a non-Greek social scene',
      setting: 'Rural or small town — focused and immersive',
      cost_concern: 'Significant — cost is a real factor but we have some flexibility',
      school_type: 'Specifically interested in liberal arts colleges',
      distance: 'Anywhere in the country — I\'m open',
      region: 'No preference — best fit anywhere',
      hidden_gem: 'Absolutely — show me more hidden gems than well-known schools',
      name_recognition: 'Not a priority — I\'ll build my own reputation',
    },
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
    answers: {
      home_state: 'Florida',
      family_income: '$30,000 – $48,000',
      major: 'STEM (science, tech, engineering, math)',
      stem_focus: 'Engineering (mechanical, civil, electrical, etc.)',
      gpa: "Mostly A's (3.7–4.0+ unweighted)",
      testscores: 'SAT 1450+ or ACT 33+ (top scores)',
      campus_size: 'Medium — balanced and friendly (3–10K)',
      greek_life: 'Neutral — doesn\'t matter either way',
      setting: 'Suburban — near a city but quieter',
      cost_concern: 'Major — we need maximum financial aid and scholarships',
      school_type: 'I prefer public — lower cost especially in-state',
      distance: 'Same region — within half a day\'s drive',
      region: 'Southeast (Atlanta, Miami, Charlotte, Nashville)',
      hidden_gem: 'A mix of well-known and hidden gems is fine',
      name_recognition: 'Somewhat — regional reputation is fine',
    },
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
    answers: {
      home_state: 'Washington',
      family_income: '$110,000 – $150,000',
      major: 'Undecided — I want to explore',
      undecided_lean: 'History and current events fascinate me',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'SAT 1250–1440 or ACT 27–32 (strong)',
      campus_size: 'Small — everyone knows my name (under 3,000)',
      greek_life: 'Not for me — prefer a non-Greek social scene',
      setting: 'College town — the campus IS the social center',
      cost_concern: 'Moderate — we\'d appreciate aid but aren\'t limited',
      school_type: 'Specifically interested in liberal arts colleges',
      distance: 'Anywhere in the country — I\'m open',
      region: 'No preference — best fit anywhere',
      hidden_gem: 'Absolutely — show me more hidden gems than well-known schools',
      name_recognition: 'Somewhat — regional reputation is fine',
    },
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
    answers: {
      home_state: 'Georgia',
      family_income: 'Under $30,000',
      major: 'Pre-Med / Health Sciences / Nursing',
      premed_focus: 'Nursing or nurse practitioner',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'SAT 1050–1240 or ACT 21–26 (average)',
      campus_size: 'Medium — balanced and friendly (3–10K)',
      greek_life: 'Neutral — doesn\'t matter either way',
      setting: 'Suburban — near a city but quieter',
      cost_concern: 'Major — we need maximum financial aid and scholarships',
      school_type: 'I prefer public — lower cost especially in-state',
      distance: 'Close — within 1–2 hours of home',
      hidden_gem: 'Absolutely — show me more hidden gems than well-known schools',
      name_recognition: 'Not a priority — I\'ll build my own reputation',
    },
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
    answers: {
      home_state: 'Illinois',
      family_income: 'Over $150,000',
      major: 'Computer Science / Software Engineering',
      cs_focus: 'AI, machine learning, or data science',
      gpa: "Mostly A's (3.7–4.0+ unweighted)",
      testscores: 'SAT 1450+ or ACT 33+ (top scores)',
      campus_size: 'No preference',
      greek_life: 'Somewhat — I\'d like the option',
      setting: 'Mid-size city — active but not overwhelming',
      cost_concern: 'Not a primary concern — focused on fit first',
      school_type: 'No preference — best fit regardless',
      distance: 'Anywhere in the country — I\'m open',
      region: 'No preference — best fit anywhere',
      hidden_gem: 'Stick mostly to schools I already know about',
      name_recognition: 'Very important — I want a name that opens doors',
    },
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
    answers: {
      home_state: 'Mississippi',
      family_income: '$48,000 – $75,000',
      major: 'Arts, Design, Film, or Music',
      arts_focus: 'Music performance or composition',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'SAT 1050–1240 or ACT 21–26 (average)',
      campus_size: 'Small — everyone knows my name (under 3,000)',
      greek_life: 'Not for me — prefer a non-Greek social scene',
      setting: 'College town — the campus IS the social center',
      cost_concern: 'Significant — cost is a real factor but we have some flexibility',
      school_type: 'Open to private if financial aid is strong',
      distance: 'Anywhere in the country — I\'m open',
      region: 'No preference — best fit anywhere',
      hidden_gem: 'Absolutely — show me more hidden gems than well-known schools',
      name_recognition: 'Not a priority — I\'ll build my own reputation',
    },
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
    answers: {
      home_state: 'Arizona',
      family_income: '$30,000 – $48,000',
      major: 'STEM (science, tech, engineering, math)',
      stem_focus: 'Environmental science / sustainability',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'SAT 1250–1440 or ACT 27–32 (strong)',
      campus_size: 'Small — everyone knows my name (under 3,000)',
      greek_life: 'Not for me — prefer a non-Greek social scene',
      setting: 'Rural or small town — focused and immersive',
      cost_concern: 'Major — we need maximum financial aid and scholarships',
      school_type: 'No preference — best fit regardless',
      distance: 'Anywhere in the country — I\'m open',
      region: 'Mountain West (Denver, Salt Lake City, Phoenix)',
      hidden_gem: 'Absolutely — show me more hidden gems than well-known schools',
      name_recognition: 'Not a priority — I\'ll build my own reputation',
    },
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
    answers: {
      home_state: 'New York',
      family_income: 'Over $150,000',
      major: 'Arts, Design, Film, or Music',
      arts_focus: 'Theater or performing arts',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'Going test-optional',
      campus_size: 'No preference',
      greek_life: 'Not for me — prefer a non-Greek social scene',
      setting: 'Major city — NYC, Chicago, LA right outside my door',
      cost_concern: 'Not a primary concern — focused on fit first',
      school_type: 'No preference — best fit regardless',
      distance: 'Anywhere in the country — I\'m open',
      region: 'No preference — best fit anywhere',
      hidden_gem: 'A mix of well-known and hidden gems is fine',
      name_recognition: 'Important — I\'d like a well-regarded school',
    },
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
    answers: {
      home_state: 'Ohio',
      family_income: '$75,000 – $110,000',
      major: 'Undecided — I want to explore',
      undecided_lean: 'Science class is my favorite',
      gpa: "A's and B's (3.3–3.6)",
      testscores: 'SAT 1050–1240 or ACT 21–26 (average)',
      campus_size: 'Very large — big university culture (25K+)',
      greek_life: 'Somewhat — I\'d like the option',
      setting: 'College town — the campus IS the social center',
      cost_concern: 'Moderate — we\'d appreciate aid but aren\'t limited',
      school_type: 'I prefer public — lower cost especially in-state',
      distance: 'Same region — within half a day\'s drive',
      region: 'Midwest (Chicago, Columbus, Ann Arbor, Madison)',
      hidden_gem: 'Stick mostly to schools I already know about',
      name_recognition: 'Important — I\'d like a well-regarded school',
    },
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
    answers: {
      home_state: 'New Mexico',
      family_income: 'Under $30,000',
      major: 'Criminal Justice / Law / Government',
      gpa: "Mostly B's (2.7–3.2)",
      testscores: 'SAT below 1050 or ACT below 21',
      campus_size: 'Small — everyone knows my name (under 3,000)',
      greek_life: 'Not for me — prefer a non-Greek social scene',
      setting: 'Suburban — near a city but quieter',
      cost_concern: 'Major — we need maximum financial aid and scholarships',
      school_type: 'No preference — best fit regardless',
      distance: 'Same region — within half a day\'s drive',
      region: 'Mountain West (Denver, Salt Lake City, Phoenix)',
      hidden_gem: 'Absolutely — show me more hidden gems than well-known schools',
      name_recognition: 'Not a priority — I\'ll build my own reputation',
    },
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
  const { rawTemplate } = extractPromptPieces(html);

  console.log(`Running ${PROFILES.length} synthetic profiles through the live prompt...\n`);

  const results = [];
  for (const p of PROFILES) {
    process.stdout.write(`  ${p.label} ... `);
    try {
      const shortlist = buildShortlist(p.answers, { perTier: 15 });
      const referenceSection = buildReferenceSection(shortlist);
      const prompt = buildPrompt(rawTemplate, referenceSection, p.text);
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
