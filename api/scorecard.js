// api/scorecard.js
// Fetches real College Scorecard data for a list of college names
// Called after AI generates the college list to enrich with verified federal data

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.SCORECARD_API_KEY || 'DEMO_KEY';
  const { colleges, incomeLevel } = req.body;

  if (!colleges || !Array.isArray(colleges)) {
    return res.status(400).json({ error: 'Missing colleges array' });
  }

  // Map income level answer to College Scorecard bracket
  const incomeBracket = getIncomeBracket(incomeLevel);

  const results = {};

  // Fetch data for each college (in parallel, max 5 at once)
  const chunks = chunkArray(colleges, 5);

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (collegeName) => {
      try {
        const data = await fetchCollegeData(collegeName, incomeBracket, apiKey);
        if (data) results[collegeName] = data;
      } catch (e) {
        console.error(`Failed to fetch ${collegeName}:`, e.message);
      }
    }));
  }

  return res.status(200).json({ results });
}

async function fetchCollegeData(name, incomeBracket, apiKey) {
  const fields = [
    'school.name',
    'school.city',
    'school.state',
    'school.school_url',
    'latest.admissions.admission_rate.overall',
    'latest.student.size',
    'latest.cost.tuition.in_state',
    'latest.cost.tuition.out_of_state',
    'latest.cost.net_price.consumer.by_income_level.0-30000',
    'latest.cost.net_price.consumer.by_income_level.30001-48000',
    'latest.cost.net_price.consumer.by_income_level.48001-75000',
    'latest.cost.net_price.consumer.by_income_level.75001-110000',
    'latest.cost.net_price.consumer.by_income_level.110001-plus',
    'latest.completion.completion_rate_4yr_150nt',
    'latest.earnings.10_yrs_after_entry.median',
    'latest.academics.program_percentage.computer_science',
    'latest.academics.program_percentage.business_marketing',
    'latest.academics.program_percentage.health',
    'latest.academics.program_percentage.engineering',
  ].join(',');

  // Clean name for search
  const searchName = name
    .replace(/\s+(University|College|Institute|School)\s+of\s+/gi, ' ')
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(' ').slice(0, 4).join('+');

  const url = `https://api.data.gov/ed/collegescorecard/v1/schools.json?school.name=${encodeURIComponent(name)}&fields=${fields}&per_page=1&api_key=${apiKey}`;

  const response = await fetch(url);
  if (!response.ok) return null;

  const json = await response.json();
  const school = json?.results?.[0];
  if (!school) return null;

  // Get net price for the student's income bracket
  const netPriceByBracket = {
    'Under $30,000':       school['latest.cost.net_price.consumer.by_income_level.0-30000'],
    '$30,000 – $48,000':   school['latest.cost.net_price.consumer.by_income_level.30001-48000'],
    '$48,000 – $75,000':   school['latest.cost.net_price.consumer.by_income_level.48001-75000'],
    '$75,000 – $110,000':  school['latest.cost.net_price.consumer.by_income_level.75001-110000'],
    '$110,000 – $150,000': school['latest.cost.net_price.consumer.by_income_level.110001-plus'],
    'Over $150,000':       school['latest.cost.net_price.consumer.by_income_level.110001-plus'],
  };

  const netPrice = incomeBracket ? netPriceByBracket[incomeBracket] : null;
  const admissionRate = school['latest.admissions.admission_rate.overall'];
  const gradRate = school['latest.completion.completion_rate_4yr_150nt'];
  const medianEarnings = school['latest.earnings.10_yrs_after_entry.median'];

  return {
    name: school['school.name'],
    city: school['school.city'],
    state: school['school.state'],
    admissionRate: admissionRate ? `${Math.round(admissionRate * 100)}%` : null,
    studentSize: school['latest.student.size'],
    tuitionInState: school['latest.cost.tuition.in_state'],
    tuitionOutOfState: school['latest.cost.tuition.out_of_state'],
    netPrice: netPrice ? `$${netPrice.toLocaleString()}/yr` : null,
    netPriceRaw: netPrice,
    gradRate: gradRate ? `${Math.round(gradRate * 100)}%` : null,
    medianEarnings: medianEarnings ? `$${medianEarnings.toLocaleString()}` : null,
    dataSource: 'U.S. Department of Education College Scorecard',
    dataYear: '2023-24',
  };
}

function getIncomeBracket(incomeAnswer) {
  if (!incomeAnswer) return null;
  const map = {
    'Under $30,000': 'Under $30,000',
    '$30,000 – $48,000': '$30,000 – $48,000',
    '$48,000 – $75,000': '$48,000 – $75,000',
    '$75,000 – $110,000': '$75,000 – $110,000',
    '$110,000 – $150,000': '$110,000 – $150,000',
    'Over $150,000': 'Over $150,000',
  };
  return map[incomeAnswer] || null;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
