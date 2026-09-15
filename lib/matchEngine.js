// lib/matchEngine.js
//
// The real search/discovery layer for CollegeShepherd. Replaces "ask the AI to
// recall school names from memory" with: hard-filter + score the full 1,944-
// school dataset using the student's actual answers, and hand Claude a real,
// data-backed shortlist to choose the final 10 from (and write the narrative,
// fit scores, essay angles, etc.) — Claude never has to invent a school name
// or a statistic again; it only has to reason over real candidates.
//
// This module is pure computation (no network calls), so it's fast even over
// ~1,900 records per request.

const fs = require('fs');
const path = require('path');

let _schools = null; // colleges_scorecard.json, keyed later by lowercased name
let _profiles = null; // character_profiles.json, keyed by scorecard id (string)

function loadData() {
  if (_schools && _profiles) return;
  const dataDir = path.join(__dirname, '..');
  _schools = JSON.parse(fs.readFileSync(path.join(dataDir, 'colleges_scorecard.json'), 'utf8'));
  _profiles = JSON.parse(fs.readFileSync(path.join(dataDir, 'character_profiles.json'), 'utf8'));
}

// ── Answer-band helpers ────────────────────────────────────────────────────

const GPA_BAND_INDEX = {
  "Mostly A's (3.7–4.0+ unweighted)": 4,
  "A's and B's (3.3–3.6)": 3,
  "Mostly B's (2.7–3.2)": 2,
  "B's and C's (2.0–2.6)": 1,
  "C's or below": 0,
  // "My school uses a different system" -> unknown, handled by caller
};

const TEST_BAND_INDEX = {
  'SAT 1450+ or ACT 33+ (top scores)': 4,
  'SAT 1250–1440 or ACT 27–32 (strong)': 3,
  'SAT 1050–1240 or ACT 21–26 (average)': 2,
  'SAT below 1050 or ACT below 21': 1,
  // "Haven't tested yet" / "Going test-optional" -> unknown, handled by caller
};

// [matchLowAdmit, matchHighAdmit] per strength index 0..4 (weakest..strongest).
// Below matchLow => reach for this student. Above matchHigh => safety.
const STRENGTH_TO_MATCH_BAND = [
  [0.75, 1.01],  // 0 - weakest signal
  [0.70, 0.95],  // 1
  [0.55, 0.80],  // 2
  [0.35, 0.65],  // 3
  [0.15, 0.40],  // 4 - strongest
];

function academicStrengthIndex(answers) {
  const gpaIdx = GPA_BAND_INDEX[answers.gpa];
  const testIdx = TEST_BAND_INDEX[answers.testscores];
  if (gpaIdx !== undefined && testIdx !== undefined) return Math.round((gpaIdx + testIdx) / 2);
  if (gpaIdx !== undefined) return gpaIdx;
  if (testIdx !== undefined) return testIdx;
  return 2; // neutral default
}

function tierForSchool(admitRate, strengthIndex) {
  if (admitRate === null || admitRate === undefined) return 'match'; // no data -> neutral
  const [lo, hi] = STRENGTH_TO_MATCH_BAND[strengthIndex];
  if (admitRate < lo) return 'reach';
  if (admitRate > hi) return 'safety';
  return 'match';
}

// ── Major -> Scorecard program_percentage field mapping (soft boost only) ──

const MAJOR_PROGRAM_FIELDS = {
  'STEM (science, tech, engineering, math)': null, // resolved via stem_focus sub-branch
  'Pre-Med / Health Sciences / Nursing': ['latest.academics.program_percentage.health'],
  'Computer Science / Software Engineering': ['latest.academics.program_percentage.computer_science'],
  'Business / Finance / Entrepreneurship': ['latest.academics.program_percentage.business_marketing'],
  'Arts, Design, Film, or Music': ['latest.academics.program_percentage.visual_performing'],
  'Social Sciences (psychology, political science, sociology)': ['latest.academics.program_percentage.psychology'],
  'Humanities (English, history, philosophy, languages)': null,
  'Education': ['latest.academics.program_percentage.education'],
  'Criminal Justice / Law / Government': null,
  'Undecided — I want to explore': null,
};

const STEM_FOCUS_FIELDS = {
  'Engineering (mechanical, civil, electrical, etc.)': ['latest.academics.program_percentage.engineering'],
  'Pure sciences (biology, chemistry, physics)': ['latest.academics.program_percentage.biological'],
  'Environmental science / sustainability': ['latest.academics.program_percentage.biological'],
  'Mathematics or statistics': null,
  'Not sure — all of it is interesting': ['latest.academics.program_percentage.engineering', 'latest.academics.program_percentage.biological'],
};

function programFieldsForAnswers(answers) {
  if (answers.major === 'STEM (science, tech, engineering, math)') {
    return STEM_FOCUS_FIELDS[answers.stem_focus] || null;
  }
  return MAJOR_PROGRAM_FIELDS[answers.major] || null;
}

// ── Setting / locale mapping ────────────────────────────────────────────────

const SETTING_TO_LOCALE = {
  'Major city — NYC, Chicago, LA right outside my door': ['city'],
  'Mid-size city — active but not overwhelming': ['city', 'suburb'],
  'College town — the campus IS the social center': ['town'],
  'Suburban — near a city but quieter': ['suburb'],
  'Rural or small town — focused and immersive': ['rural', 'town'],
};

// ── Campus size mapping ─────────────────────────────────────────────────────

const SIZE_TO_CATEGORY = {
  'Small — everyone knows my name (under 3,000)': ['very small', 'small'],
  'Medium — balanced and friendly (3–10K)': ['small', 'medium'],
  'Large — variety and energy (10–25K)': ['medium', 'large'],
  'Very large — big university culture (25K+)': ['large', 'very large'],
};

// ── Region mapping (mirrors the app's own region question buckets) ─────────

const REGION_STATES = {
  'Northeast (Boston, New York, DC, Philadelphia)': ['CT','ME','MA','NH','NJ','NY','PA','RI','VT','DE','MD','DC'],
  'Southeast (Atlanta, Miami, Charlotte, Nashville)': ['AL','AR','FL','GA','KY','LA','MS','NC','SC','TN','VA','WV'],
  'Midwest (Chicago, Columbus, Ann Arbor, Madison)': ['IL','IN','IA','KS','MI','MN','MO','NE','ND','OH','SD','WI'],
  'Texas (Austin, Houston, Dallas)': ['TX'],
  'Mountain West (Denver, Salt Lake City, Phoenix)': ['AZ','CO','ID','MT','NV','NM','UT','WY'],
  'Pacific Coast (LA, San Francisco, Seattle, Portland)': ['CA','OR','WA','AK','HI'],
};

const STATE_ABBR = {
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',
  Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',
  Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',
  Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH',
  'New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',
  Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
  Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',
  Wisconsin:'WI',Wyoming:'WY','Washington D.C.':'DC',
};

// ── Cost helpers ────────────────────────────────────────────────────────────

const INCOME_TO_NETPRICE_FIELD = {
  'Under $30,000': 'latest.cost.net_price.consumer.by_income_level.0-30000',
  '$30,000 – $48,000': 'latest.cost.net_price.consumer.by_income_level.30001-48000',
  '$48,000 – $75,000': 'latest.cost.net_price.consumer.by_income_level.48001-75000',
  '$75,000 – $110,000': 'latest.cost.net_price.consumer.by_income_level.75001-110000',
  '$110,000 – $150,000': 'latest.cost.net_price.consumer.by_income_level.110001-plus',
  'Over $150,000': 'latest.cost.net_price.consumer.by_income_level.110001-plus',
};

function estimatedNetPrice(school, answers) {
  const field = INCOME_TO_NETPRICE_FIELD[answers.family_income];
  if (!field) return null;
  const v = school[field];
  return typeof v === 'number' ? v : null;
}

// ── Greek life / vibe keyword matching against researched character text ───

function vibeText(profile) {
  if (!profile) return '';
  return [profile.vibe || '', (profile.distinctives || []).join(' '), profile.narrative || ''].join(' ').toLowerCase();
}

function greekLifeBoost(answers, profile) {
  const pref = answers.greek_life;
  if (!pref || !profile || profile.profile_type !== 'researched') return 0;
  const text = vibeText(profile);
  const mentionsNoGreek = /no greek life|no fraternities|abolished fraternities|without fraternities/.test(text);
  const mentionsStrongGreek = /greek life|fraternities and sororities|rush culture|big greek/.test(text);
  if (pref === 'Very important — I definitely want to rush') {
    if (mentionsStrongGreek) return 2;
    if (mentionsNoGreek) return -3;
  }
  if (pref === 'Not for me — prefer a non-Greek social scene') {
    if (mentionsNoGreek) return 2;
    if (mentionsStrongGreek) return -1.5;
  }
  return 0;
}

// ── Main scoring ─────────────────────────────────────────────────────────────

function scoreSchool(school, profile, answers, ctx) {
  let score = 0;
  const reasons = [];

  // Ownership: mild penalty for for-profit (federal outcomes data consistently
  // shows weaker value at for-profits; this is a soft nudge, not an exclusion).
  if (school['school.ownership'] === 3) score -= 3;

  // Selectivity/major fit only matters if we have decent enrollment data.
  const size = school['latest.student.size'];
  const sizeCategory = profile ? profile.facts.size_category : null;

  // Campus size preference (soft boost)
  const sizePref = SIZE_TO_CATEGORY[answers.campus_size];
  if (sizePref && sizeCategory) {
    if (sizePref.includes(sizeCategory)) { score += 3; reasons.push('size match'); }
  }

  // Setting preference (soft boost)
  const localePref = SETTING_TO_LOCALE[answers.setting];
  const locale = profile ? profile.facts.locale_bucket : null;
  if (localePref && locale && localePref.includes(locale)) { score += 2; reasons.push('setting match'); }

  // Major/program fit (soft boost)
  const programFields = ctx.programFields;
  if (programFields) {
    let best = 0;
    for (const f of programFields) {
      const v = school[f];
      if (typeof v === 'number') best = Math.max(best, v);
    }
    if (best >= 0.30) { score += 4; reasons.push('strong program match'); }
    else if (best >= 0.15) { score += 2; reasons.push('program match'); }
  }

  // Cost fit (soft boost, weighted by how much the family cares)
  const netPrice = estimatedNetPrice(school, answers);
  const costWeight = {
    'Major — we need maximum financial aid and scholarships': 1.5,
    'Significant — cost is a real factor but we have some flexibility': 1,
    'Moderate — we\'d appreciate aid but aren\'t limited': 0.4,
    'Not a primary concern — focused on fit first': 0.1,
    'I honestly don\'t know our financial situation': 0.6,
  }[answers.cost_concern] || 0.6;
  if (netPrice !== null) {
    // Cheaper = better. Normalize roughly against a $60k ceiling.
    const costScore = Math.max(0, (60000 - netPrice) / 60000) * 5 * costWeight;
    score += costScore;
  }

  // School type preference (public/private)
  const ownership = school['school.ownership'];
  if (answers.school_type === 'I prefer public — lower cost especially in-state' && ownership === 1) { score += 2; }
  if (answers.school_type === 'I prefer private — smaller classes, more aid available' && ownership === 2) { score += 2; }

  // Home state boost
  const homeAbbr = STATE_ABBR[answers.home_state];
  if (homeAbbr && school['school.state'] === homeAbbr) {
    score += 2;
    if (ownership === 1) score += 2; // public in-state is a strong value signal
    reasons.push('home state');
  } else if (ctx.regionStates && ctx.regionStates.includes(school['school.state'])) {
    score += 1.5;
    reasons.push('preferred region');
  }

  // "Close to home" / commute distance -> strongly prioritize home state
  if ((answers.distance === 'Close — within 1–2 hours of home' || answers.distance === 'Commute distance — saving money') && homeAbbr) {
    score += (school['school.state'] === homeAbbr) ? 6 : -4;
  }

  // Greek life keyword match
  score += greekLifeBoost(answers, profile);

  // Academic selectivity fit (favor schools near the student's competitive band,
  // but don't zero out reach/safety entirely — diversity pass handles banding)
  const admit = school['latest.admissions.admission_rate.overall'];
  const tier = tierForSchool(admit, ctx.strengthIndex);

  // Hidden-gem / name-recognition preference shapes how much we favor
  // well-known (profile_type researched) vs. lesser-known schools.
  const isResearched = profile && profile.profile_type === 'researched';
  const gemPref = answers.hidden_gem;
  const nameRecPref = answers.name_recognition;
  if (gemPref === 'Stick mostly to schools I already know about' || nameRecPref === 'Very important — I want a name that opens doors') {
    if (isResearched) score += 3;
  }
  if (gemPref === 'Absolutely — show me more hidden gems than well-known schools') {
    if (!isResearched) score += 2;
  }

  // Outcomes: mild boost for strong completion rate (proxy for institutional
  // health/resourcing, relevant regardless of stated preferences)
  const completion = school['latest.completion.completion_rate_4yr_150nt'];
  if (typeof completion === 'number') score += completion * 2;

  return { score, tier };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a real, data-backed shortlist for a student.
 * @param {Object} answers - the S.answers object from app.html (key -> answer text)
 * @param {Object} [opts]
 * @param {number} [opts.perTier=15] - how many schools to keep per reach/match/safety band
 * @returns {Array} shortlist of schools with score, tier, and real facts/profile data
 */
function buildShortlist(answers, opts) {
  loadData();
  opts = opts || {};
  const perTier = opts.perTier || 15;

  const strengthIndex = academicStrengthIndex(answers);
  const programFields = programFieldsForAnswers(answers);
  const regionStates = (answers.region && REGION_STATES[answers.region]) || null;
  const ctx = { strengthIndex, programFields, regionStates };

  const scored = [];
  for (const school of _schools) {
    // Skip schools with no usable name or clearly non-operating/duplicate entries.
    if (!school['school.name']) continue;
    const profile = _profiles[String(school.id)] || null;
    const { score, tier } = scoreSchool(school, profile, answers, ctx);
    scored.push({ school, profile, score, tier });
  }

  // Band into reach/match/safety, take top-N by score within each band so the
  // final shortlist always has enough of each for Claude's 3-4/4-5/2-3 split,
  // regardless of how score happens to skew overall.
  const byTier = { reach: [], match: [], safety: [] };
  for (const s of scored) byTier[s.tier].push(s);
  for (const k of Object.keys(byTier)) byTier[k].sort((a, b) => b.score - a.score);

  const picked = [
    ...byTier.reach.slice(0, perTier),
    ...byTier.match.slice(0, perTier),
    ...byTier.safety.slice(0, perTier),
  ];

  return picked.map(({ school, profile, score, tier }) => serializeForPrompt(school, profile, score, tier, answers));
}

function serializeForPrompt(school, profile, score, tier, answers) {
  let netPrice = estimatedNetPrice(school, answers);
  // Scorecard's net-price-by-income-bracket figure can come back slightly
  // negative for extremely generous need-based-aid schools (small sample
  // sizes in a bracket + grant aid that nets out at/near $0) -- that's a real
  // federal-data quirk, not a bug, but it's not a sane number to show a
  // family, so clamp for display only; the underlying data isn't altered.
  if (netPrice !== null && netPrice < 0) netPrice = 0;
  const admit = school['latest.admissions.admission_rate.overall'];
  return {
    name: school['school.name'],
    city: school['school.city'],
    state: school['school.state'],
    ownership: profile ? profile.facts.ownership : null,
    sizeCategory: profile ? profile.facts.size_category : null,
    size: school['latest.student.size'],
    admitRatePct: admit !== null && admit !== undefined ? Math.round(admit * 100) : null,
    tierForStudent: tier, // reach/match/safety, computed from real admit rate vs student's academic band
    tuitionInState: school['latest.cost.tuition.in_state'] ?? null,
    tuitionOutOfState: school['latest.cost.tuition.out_of_state'] ?? null,
    estimatedNetPrice: netPrice,
    completionRate4yr: school['latest.completion.completion_rate_4yr_150nt'] ?? null,
    medianEarnings10yr: school['latest.earnings.10_yrs_after_entry.median'] ?? null,
    dominantPrograms: profile ? profile.facts.dominant_programs : [],
    profileType: profile ? profile.profile_type : 'data_grounded', // "researched" = real character data below; "data_grounded" = hard facts only
    vibe: profile && profile.profile_type === 'researched' ? profile.vibe : null,
    distinctives: profile && profile.profile_type === 'researched' ? profile.distinctives : [],
    narrative: profile ? profile.narrative : null,
    _matchScore: score, // internal use only, not for display
  };
}

module.exports = { buildShortlist, academicStrengthIndex, loadData };
