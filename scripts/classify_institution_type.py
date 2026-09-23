"""
Classifies every school in character_profiles_updates.json into an
`institution_type` tag (traditional / religious_seminary /
adult_online_completion / health_sciences_graduate / trade_vocational),
using regex rules against each profile's curated `vibe`/`distinctives` text
and its official Scorecard name.

Usage (run from the repo root, with a local copy of colleges_scorecard.json
and character_profiles_updates.json):
    python3 scripts/classify_institution_type.py

Re-run this whenever new schools are added to the overlay, or when
Tier A/B research adds/changes distinctives text for existing schools, since
the institution_type tag is derived from that text and won't auto-update.

Read the file-level comments below before changing the regex rules --
several were added specifically to fix real false positives found by
checking every large/well-known school the classifier flagged (see
claude/college-knowledge-base-plan.md, "`institution_type` schema tag"
section, for the full list and reasoning). The founding-cue-stripping logic
in particular is load-bearing: without it, historical mentions like
"Syracuse University, chartered in 1870 out of a Methodist Episcopal
seminary" get misread as the school's current identity.
"""
import json, re

OVERLAY_PATH = 'character_profiles_updates.json'
SCORECARD_PATH = 'colleges_scorecard.json'
OUT_PATH = 'character_profiles_updates.json'  # overwrites in place -- diff before shipping

overlay = json.load(open(OVERLAY_PATH))
scorecard = json.load(open(SCORECARD_PATH))
names = {str(s['id']): s['school.name'] for s in scorecard}

# Historical-founding cue phrases. Each profile's vibe + each distinctives
# bullet is already a single, well-formed sentence/unit in the source data
# (unlike a naive re-split, which breaks on abbreviation periods like
# "Thomas C. Horton"). So: if a UNIT contains a founding cue anywhere, treat
# every keyword match within that whole unit as historical ("what the school
# USED TO BE"), not current identity, and skip it -- e.g. drop the entire
# "chartered in 1870 out of a Methodist Episcopal seminary" sentence.
FOUNDING_CUES = re.compile(
    r'\b(founded|founding|chartered|established|began|born|started|grew out of|'
    r'traces (its )?(roots|founding)|originally|formerly|renamed|reinvented|'
    r'evolved from|descended from|later became|eventually became|used to be|'
    r'stretching back|dating back|with roots in|history (stretching|dating)|'
    r'reunited with|merged with|merger with|affiliated with|houses a|home to a|'
    r'cycled through|known variously as|before becoming|under (the )?name)\b',
    re.I,
)

# A single notable program mention ("known for its culinary arts program")
# at an otherwise general institution isn't enough to call the WHOLE school
# trade_vocational -- require that cue words like these are absent nearby,
# i.e. the sentence isn't just listing one program among several.
NOT_JUST_A_PROGRAM = re.compile(
    r'\b(known for|program in|program and|offers a|also offers|and marine|and nursing|'
    r'alongside|in addition to|and allied health)\b',
    re.I,
)

RULES = [
    ('religious_seminary',
     [r'\byeshiva\b', r'\byeshivath\b', r'\brabbinical\b', r'\bmesivta\b', r'\bkollel\b',
      r'\btalmudic\b', r'\bseminary\b', r'\bbible college\b', r'\bbible institute\b',
      r'\btheological\b'],
     [r'\byeshiva\b', r'\brabbinical\b', r'\btalmudic\b', r'\bhasidic\b', r'\bkollel\b',
      r'\bseminary\b', r'\bbible college\b', r'\bbible institute\b',
      r'\ball-male\b.{0,30}(orthodox|yeshiva|talmudic)']),
    ('health_sciences_graduate',
     [r'health science(s)? center', r'\blaw center\b', r'\bcancer center\b',
      r'\bmedical (sciences? )?center\b'],
     [r'\bgraduate[- ]only\b', r'\bno undergraduate\b', r'\bdoes not enroll undergraduate',
      r'\bprofessional[- ]only institution\b']),
    ('trade_vocational',
     [r'\bculinary\b', r'\bcosmetology\b', r'\bmortuary science\b', r'\bparalegal\b',
      r'\baeronautical\b', r'\bcourt reporting\b', r'\bfilm (school|academy)\b',
      r'\bveterinary technology\b', r'\bmassage therapy\b'],
     [r'\bculinary arts\b', r'\bcosmetology\b', r'\bmortuary science\b', r'\bparalegal studies\b',
      r'\bveterinary technology\b']),
    ('adult_online_completion',
     [r'\bonline\b', r'college of continuing', r'continuing (professional )?education',
      r'professional studies', r'extended education', r'degree completion',
      r'national & global', r'-flex\b', r'professional programs'],
     [r'\baccelerated scheduling\b', r'\bprimarily online\b', r'\blargely online\b',
      r'\bfully online\b', r'\bmassive online\b', r'\blarge-scale.{0,20}online\b',
      r'\bonline (student population|division|degrees?)\b.{0,30}(largest|massive|large-scale)',
      r'\b(aimed at|designed for|built for|targeted at|tailored for|created for)\b.{0,30}(working adults|career-changers)',
      r'\b(serves|serving) (primarily|mostly|mainly|almost entirely) working adults\b']),
]

COMPILED = [
    (tag, [re.compile(p, re.I) for p in name_pats], [re.compile(p, re.I) for p in text_pats])
    for tag, name_pats, text_pats in RULES
]


def units(profile):
    """One text unit per vibe / distinctives bullet, since each is already a
    coherent, single sentence in the source data -- avoids abbreviation-period
    sentence-splitting bugs."""
    u = []
    if profile.get('vibe'):
        u.append(profile['vibe'])
    u.extend(profile.get('distinctives', []) or [])
    return u


# Manual overrides for well-known institutions whose NAME contains a
# category keyword (e.g. "Yeshiva") but whose actual current identity is a
# broad, comprehensive university with secular graduate/professional schools
# -- not a narrow single-purpose seminary/vocational institution. Keyword and
# proximity heuristics can't reliably tell these apart from the true
# narrow-purpose cases, so they're listed explicitly rather than guessed at.
MANUAL_OVERRIDES = {
    'Yeshiva University': 'traditional',  # comprehensive research univ. (law, medicine, business schools)
}


def classify(school_id, profile):
    name = (names.get(school_id, '') or '')
    if name in MANUAL_OVERRIDES:
        return MANUAL_OVERRIDES[name]
    for tag, name_pats, text_pats in COMPILED:
        for pat in name_pats:
            if pat.search(name):
                return tag
    for tag, name_pats, text_pats in COMPILED:
        for unit_text in units(profile):
            if FOUNDING_CUES.search(unit_text):
                continue  # whole unit describes origin/history, not current identity
            for pat in text_pats:
                m = pat.search(unit_text)
                if not m:
                    continue
                if tag == 'trade_vocational' and NOT_JUST_A_PROGRAM.search(unit_text):
                    continue
                return tag
    return 'traditional'


counts = {}
for school_id, profile in overlay.items():
    tag = classify(school_id, profile)
    profile['institution_type'] = tag
    counts[tag] = counts.get(tag, 0) + 1

print('Classification counts:')
for k, v in sorted(counts.items(), key=lambda x: -x[1]):
    print(f'  {k}: {v}')

json.dump(overlay, open(OUT_PATH, 'w'), indent=2, ensure_ascii=False)
print('\nWrote', OUT_PATH, 'total keys:', len(overlay))
