// api/demo.js
// Generates a random but realistic college list for demo purposes
// Called from ?access=shepherd2026&demo=true

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // Random student profiles
  const profiles = [
    { name: 'Bella', grade: 'Junior', gpa: '3.7-3.9', major: 'Business/Finance', state: 'Washington', income: '$75K-$110K', vibe: 'Big Ten school, campus life, sports' },
    { name: 'Marcus', grade: 'Junior', gpa: '3.9-4.0', major: 'Pre-Med/Biology', state: 'Georgia', income: '$48K-$75K', vibe: 'HBCU or strong pre-med program, diverse campus' },
    { name: 'Jake', grade: 'Senior', gpa: '3.5-3.7', major: 'Computer Science', state: 'California', income: '$110K-$150K', vibe: 'Tech hubs, startup culture, West Coast' },
    { name: 'Sofia', grade: 'Junior', gpa: '3.8-4.0', major: 'Fine Arts/Design', state: 'New York', income: '$30K-$48K', vibe: 'Small liberal arts, creative community, East Coast' },
  ];

  const profile = profiles[Math.floor(Math.random() * profiles.length)];

  const prompt = `You are CollegeShepherd, an expert college counselor AI. Generate a personalized college list for this student:

Student Profile:
- Name: ${profile.name}
- Grade: ${profile.grade}
- GPA: ${profile.gpa}
- Intended Major: ${profile.major}
- Home State: ${profile.state}
- Family Income: ${profile.income}
- Looking for: ${profile.vibe}

Generate a top-10 college list with 5 match, 2 reach, and 3 safety schools. Use REAL current data.

Return ONLY valid JSON (no markdown, no backticks) in this exact format:
{
  "studentName": "${profile.name}",
  "personalSummary": "2-3 sentence summary of this student's college search",
  "colleges": [
    {
      "rank": 1,
      "name": "Full University Name",
      "location": "City, State",
      "tier": "match",
      "why": "2 sentence personalized reason",
      "highlights": ["highlight 1", "highlight 2", "highlight 3"],
      "acceptanceRate": "X%",
      "size": "Large/Medium/Small",
      "fitScores": {"academic": 8, "campusVibe": 7, "costFit": 8, "location": 9, "socialLife": 7},
      "netPrice": {"estimated": "$X,XXX/yr", "sticker": "$X,XXX/yr", "savings": "$X,XXX/yr", "basis": "income bracket", "tuition": "$X,XXX/yr", "housing": "$X,XXX/yr", "meals": "$X,XXX/yr", "totalCOA": "$X,XXX/yr"},
      "funFacts": [{"emoji": "🏆", "fact": "specific compelling fact"}, {"emoji": "💼", "fact": "career/salary fact"}, {"emoji": "🎉", "fact": "campus life fact"}],
      "rankings": {"usNews": "#XX National Universities (required)", "programRank": "#X for major if notable (required)", "princetonReview": "Best Value or other superlative (required)", "niche": "A+ or grade (required)", "payScale": "~$XX,XXX median early career (required)"}
    }
  ],
  "essayAngles": [
    {"title": "Essay title", "hook": "Opening hook sentence", "why": "Why this works for this student"}
  ],
  "nextSteps": ["step 1", "step 2", "step 3"]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    
    // Clean and parse JSON
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    
    return res.status(200).json({ result, profile: profile.name });

  } catch (err) {
    console.error('Demo error:', err);
    return res.status(500).json({ error: err.message });
  }
}
