#!/usr/bin/env python3
"""Builds sent/: real sentences for the verb drill, from Tatoeba (tatoeba.org, CC BY 2.0 FR; some CC0).

  ~/lector-build/sent-venv/bin/python -I build_sent.py ~/lector-build/tatoeba            build sent/es + sent/en
  ~/lector-build/sent-venv/bin/python -I build_sent.py --check                         re-check every shard against the tables

The venv is Python 3.12 with spaCy 3.8.16 and es_core_news_md / en_core_web_md 3.8.0 (build time only; the app has no
new dependency). preshed 3.0.10, cymem 2.0.11 and murmurhash 1.0.13 are pinned: preshed 3.0.14 fails to load either model
("OverflowError: Python int too large to convert to C ssize_t" in Tokenizer._flush_specials). Inputs, downloaded from https://tatoeba.org/en/downloads into one folder:
  spa_sentences_detailed.tsv.bz2, eng_sentences_detailed.tsv.bz2, spa-eng_links.tsv.bz2, spa_tags.tsv.bz2,
  eng_tags.tsv.bz2, user_languages.tar.bz2, sentences_CC0.tar.bz2, users_sentences.csv

es (an English speaker learning Spanish): a Spanish sentence with ONE finite verb, a verb from conj/top.json, in the
present, preterite, imperfect or future; the verb, tense and person resolved without guessing; a cue word that says
when (ayer, siempre, de niño, ahora, mañana…); its English translation.
en (a Spanish speaker learning English): an English sentence with one finite verb (or have/be + the verb) from
conj-en/verbs.json in one of the four forms the app drills: -s (she drinks), past (went, with a time cue), participle
(has eaten), -ing (is eating); its Spanish translation.

Quality: the sentence and its translation are written by a self-declared native speaker of that language, or tagged OK;
nothing tagged @check / @change / @needs native check / vulgar / ambiguous / voseo / old orthography / Bible, nothing
rated -1 by any reviewer; 4-14 words; no vulgar verbs (the app's CONJ_SKIP) and no violence, sex, drugs or death.
Every shard is re-checked: the gap holds exactly the table's form for that verb + tense + person (or form).
"""
import bz2, collections, csv, io, json, os, re, sys, tarfile, unicodedata

ROOT = os.path.dirname(os.path.abspath(__file__))
TOP = set()   # conj/top.json's 300 everyday verbs
NONFIN = collections.defaultdict(set)   # infinitive, gerund or participle → verbs (hecho is hacer's participle)
OUT = os.path.join(ROOT, 'sent')
CONJ_SKIP = {'cagar', 'coger', 'joder', 'chingar', 'follar', 'culear', 'mamar', 'mear', 'putear', 'pajear', 'encabronar', 'emputar'}
MAIN_T = ['pres', 'pret', 'impf', 'fut']
ALL_T = ['pres', 'pret', 'impf', 'fut', 'cond', 'sub', 'subi', 'imp', 'neg']
EN_FORMS = ['s', 'p', 'pp', 'ing']
# Out of the targets: morir and die keep death out of a daily drill (haber stays, only as hay / había / hubo / habrá);
# shoot is mostly guns on Tatoeba.
NO_TARGET_ES = {'morir', 'morirse', 'matar'}
NO_TARGET_EN = {'die', 'shoot'}
BAD_TAGS = {'@check', '@change', '@needs native check', '@check translation', 'vulgar', 'ambiguous', 'voseo', 'Old orthography',
            'proverb', 'rhyme', 'Spain Spanish', 'insult', 'sexual', 'profanity', 'violence', 'drugs', 'archaic', '@delete', 'offensive'}
BAD_TAG_RE = re.compile(r'^(Bib|Biblia|Libro de|by )', re.I)
# no violence, sex, drugs, death or insults, in either language (word starts; checked on the folded lowercase text)
BAD_ES = re.compile(r'\b(sex|desnud|viol[aóoe]|matar|mat[óoéa]|mataron|asesin|suicid|muert|morir|muri|muer[eoa]|droga|coca[ií]na|hero[ií]na|marihuana|pistola|armas?\b|dispar|bomba|terroris|guerra|nazi|hitler|esclav|puta|puto|mierda|carajo|pendej|cabr[oó]n|culo\b|pene\b|vagina|co[ñn]o\b|polla\b|gilipoll|idiota|est[uú]pid|imb[eé]cil|borrach|cad[aá]ver|sangr|tortur|secuestr|racis|maric|masturb|orgasm|cond[oó]n|porno|prostitu|er[oó]tic|tonto|tonta|odi[oa]r?\b|odi[aeé])', re.I)
BAD_EN = re.compile(r"\b(sex|naked|nude|rape|kill|murder|suicid|dead|death|die|died|dies|dying|drug|cocaine|heroin|marijuana|gun|pistol|weapon|shoot|shot|bomb|terror|war\b|wars\b|nazi|hitler|slave|whore|bitch|shit|fuck|damn|hell\b|ass\b|bastard|dick|pussy|penis|vagina|corpse|blood|tortur|kidnap|masturbat|orgasm|condom|porn|prostitut|erotic|racis|stupid|idiot|retard|moron|hate|hated|hates|drunk)", re.I)
SUBJ_ES = {'yo': 0, 'tú': 1, 'él': 2, 'ella': 2, 'usted': 2, 'nosotros': 3, 'nosotras': 3, 'ellos': 4, 'ellas': 4, 'ustedes': 4}
SUBJ_EN = {'i': 0, 'you': 1, 'he': 2, 'she': 2, 'it': 2, 'we': 3, 'they': 4}
DAYS_ES = 'lunes|martes|miércoles|jueves|viernes|sábado|domingo|sábados|domingos'
NUM_ES = r'(?:un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cien|mil|varios|varias|muchos|muchas|algunos|algunas|pocos|pocas|\d+)'
UNIT_ES = r'(?:segundos?|minutos?|horas?|días?|semanas?|mes|meses|años?|décadas?|siglos?|rato)'
# Spanish cues: (regex on the lowercase sentence, class). Classes: past (one finished time), then (back then),
# habit (a habit), now (right now), fut (ahead). habit + then together = habitThen.
CUES_ES = [
  (r'(?<!\bdesde )(?<!\bhasta )\bayer\b', 'past'), (r'(?<!\bdesde )(?<!\bhasta )\banoche\b', 'past'), (r'\banteayer\b', 'past'), (r'\bantier\b', 'past'),
  (r'\b(?:la semana|el mes|el año|el verano|el invierno|el otoño|el fin de semana|el siglo) pasad[oa]\b', 'past'),
  (r'\bel (?:' + DAYS_ES + r') pasado\b', 'past'), (r'\bel otro día\b', 'past'), (r'\bla última vez\b', 'past'),
  (r'(?<!\bdesde )\bhace ' + NUM_ES + r'(?: [a-záéíóúñ]+)?? ' + UNIT_ES + r'\b', 'past'), (r'(?<!\bdesde )\bhace (?:mucho tiempo|tiempo|poco|un rato|años|meses|días|semanas)\b', 'past'),
  (r'\ben (?:19|20)\d\d\b', 'past'), (r'\bde repente\b', 'past'),
  (r'\bde (?:niño|niña|niños|niñas|pequeño|pequeña|pequeños|pequeñas|joven|jóvenes|chico|chica|chicos|chicas)\b', 'then'),
  (r'\ben (?:aquella|esa) época\b', 'then'), (r'\ben aquellos (?:tiempos|días|años)\b', 'then'), (r'\b(?:en|por) aquel (?:entonces|tiempo|momento)\b', 'then'),
  (r'\bsiempre\b', 'habit'), (r'\btod[oa]s l[oa]s (?:días|mañanas|noches|tardes|años|meses|semanas|veranos|fines de semana|' + DAYS_ES + r')\b', 'habit'),
  (r'\bcada (?:día|mañana|noche|tarde|semana|mes|año|verano|invierno|' + DAYS_ES + r')\b', 'habit'),
  (r'\ba menudo\b', 'habit'), (r'\bnormalmente\b', 'habit'), (r'\bgeneralmente\b', 'habit'), (r'\bpor lo general\b', 'habit'),
  (r'\bcon frecuencia\b', 'habit'), (r'\bfrecuentemente\b', 'habit'), (r'\ba veces\b', 'habit'), (r'\bde vez en cuando\b', 'habit'), (r'\bhabitualmente\b', 'habit'),
  (r'\bahora\b', 'now'), (r'\ben este momento\b', 'now'), (r'\ben estos momentos\b', 'now'), (r'\bactualmente\b', 'now'),
  (r'\bhoy en día\b', 'now'), (r'\bhoy día\b', 'now'), (r'\bestos días\b', 'now'),
  (r'\bpasado mañana\b', 'fut'), (r'(?<!\bla )(?<!\besta )(?<!\bcada )(?<!\buna )(?<!\btoda )(?<!\bde )(?<!\blas )(?<!\bel )(?<!\bpasado )\bmañana\b(?! por la mañana)', 'fut'),
  (r'\b(?:la semana|el mes|el año|el verano|el invierno|el lunes|el fin de semana) que viene\b', 'fut'),
  (r'\b(?:la próxima|el próximo) (?:semana|mes|año|verano|invierno|vez|fin de semana|' + DAYS_ES + r')\b', 'fut'),
  (r'\b(?:la semana|el mes|el año|el verano) próxim[oa]\b', 'fut'), (r'\bdentro de ' + NUM_ES + r' ' + UNIT_ES + r'\b', 'fut'), (r'\balgún día\b', 'fut'),
]
CUES_ES = [(re.compile(p), c) for p, c in CUES_ES]
# Which answer tenses a cue class allows (anything else is dropped): habit + impf without "back then" is dropped,
# since siempre llegaba / siempre llega are both right with nothing to choose between them.
ALLOW_ES = {'past': {'pret', 'impf'}, 'then': {'impf', 'pret'}, 'habitThen': {'impf'}, 'habit': {'pres'}, 'now': {'pres'}, 'fut': {'fut', 'pres'}}
MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december'
DAYS_EN = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday'
NUM_EN = r'(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|fifty|a hundred|a few|a couple of|several|many|\d+)'
UNIT_EN = r'(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|decades?|centuries)'
CUES_EN = [
  (r'\byesterday\b', 'past'), (r'\bthe day before yesterday\b', 'past'),
  (r'\blast (?:night|week|month|year|summer|winter|spring|fall|autumn|weekend|time|' + DAYS_EN + '|' + MONTHS + r')\b', 'past'),
  (r'\b' + NUM_EN + r' ' + UNIT_EN + r' ago\b', 'past'), (r'\b(?:long|a long time|a while|not long) ago\b', 'past'),
  (r'\bthe other day\b', 'past'), (r'\bin (?:19|20)\d\d\b', 'past'),
  (r'\balways\b', 'habit'), (r'\busually\b', 'habit'), (r'\boften\b', 'habit'), (r'\bsometimes\b', 'habit'), (r'\brarely\b', 'habit'),
  (r'\bseldom\b', 'habit'), (r'\bgenerally\b', 'habit'), (r'\bnormally\b', 'habit'),
  (r'\bevery (?:day|morning|night|evening|afternoon|week|month|year|summer|winter|weekend|time|' + DAYS_EN + r')\b', 'habit'),
  (r'\bon (?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekends)\b', 'habit'),
  (r'\b(?:once|twice|three times) a (?:day|week|month|year)\b', 'habit'),
  (r'\bright now\b', 'now'), (r'\bnow\b', 'now'), (r'\bat the moment\b', 'now'), (r'\bcurrently\b', 'now'), (r'\bnowadays\b', 'now'), (r'\bthese days\b', 'now'),
  (r'\balready\b', 'perf'), (r'\byet\b', 'perf'), (r'\bever\b', 'perf'), (r'\bnever\b', 'perf'), (r'\bjust\b', 'perf'), (r'\bsince\b', 'perf'),
  (r'\bso far\b', 'perf'), (r'\brecently\b', 'perf'), (r'\blately\b', 'perf'), (r'\bfor (?:' + NUM_EN + r') ' + UNIT_EN + r'\b', 'perf'),
]
CUES_EN = [(re.compile(p), c) for p, c in CUES_EN]
WORD = re.compile(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ']+")
DEBUG = bool(os.environ.get('SENT_DEBUG'))

def tsv(path):
  with bz2.open(path, 'rt', encoding='utf-8', newline='') as f:
    for line in f: yield line.rstrip('\n').split('\t')

def load_meta(src):
  natives = collections.defaultdict(set)
  with tarfile.open(os.path.join(src, 'user_languages.tar.bz2')) as t:
    for line in t.extractfile('user_languages.csv').read().decode('utf-8').splitlines():
      p = line.split('\t')
      if len(p) >= 3 and p[1] == '5': natives[p[0]].add(p[2])
  cc0 = set()
  with tarfile.open(os.path.join(src, 'sentences_CC0.tar.bz2')) as t:
    for line in io.TextIOWrapper(t.extractfile('sentences_CC0.csv'), encoding='utf-8'):
      p = line.split('\t', 2)
      if len(p) > 1 and p[1] in ('spa', 'eng'): cc0.add(int(p[0]))
  tags, ok = collections.defaultdict(set), set()
  for f in ('spa_tags.tsv.bz2', 'eng_tags.tsv.bz2'):
    for p in tsv(os.path.join(src, f)):
      if len(p) < 2: continue
      tags[int(p[0])].add(p[1])
      if p[1] == 'OK': ok.add(int(p[0]))
  bad = {i for i, ts in tags.items() if ts & BAD_TAGS or any(BAD_TAG_RE.match(x) for x in ts)}
  minus, plus = set(), collections.Counter()
  with open(os.path.join(src, 'users_sentences.csv'), encoding='utf-8', newline='') as f:
    for p in csv.reader(f, delimiter='\t'):
      if len(p) < 3: continue
      if p[2] == '-1': minus.add(int(p[1]))
      elif p[2] == '1': plus[int(p[1])] += 1
  return natives, cc0, ok, bad | minus, plus

def load_sents(src, lang, keep=None):
  out = {}
  for p in tsv(os.path.join(src, f'{lang}_sentences_detailed.tsv.bz2')):
    if len(p) < 4: continue
    i = int(p[0])
    if keep is None or i in keep: out[i] = (p[2], p[3])
  return out

def load_dict(d):   # every headword in a dict/ folder (lowercase keys), or None if it can't be read
  out = set()
  for f in os.listdir(d):
    if f.endswith('.json') and not f.startswith('_'): out.update(json.load(open(os.path.join(d, f), encoding='utf-8')))
  return out
APOS = {'s', 'm', 're', 've', 'll', 'd'}
foldw = lambda w: ''.join(c for c in unicodedata.normalize('NFD', w.lower()) if unicodedata.category(c) != 'Mn')
def unknown_word(text, other, D):   # the first word not in the dictionary; None when every word is in it
  fo = {foldw(x) for x in WORD.findall(other.replace('’', "'"))}
  for k, w in enumerate(WORD.findall(text.replace('’', "'"))):
    lw = w.lower()
    if lw in D or lw + '.' in D: continue
    if lw.endswith("n't"): lw = {"won't": 'will', "can't": 'can', "shan't": 'shall'}.get(lw, lw[:-3])   # didn't → did
    parts = [x for x in lw.split("'") if x]
    if not parts or any(r not in APOS for r in parts[1:]): return w
    base = parts[0]
    if base in D or base + '.' in D: continue
    # a name: capitalised inside the sentence, or at its start when the translation has it too (Paris / París)
    if w[0].isupper() and (k > 0 or foldw(w.split("'")[0]) in fo): continue
    return w
  return None
BAD_GLOSS = re.compile(r'^(misspelling|obsolete|archaic|dated|rare|alternative|nonstandard|eye dialect|pronunciation spelling|superseded|uncommon)', re.I)
def real_verb(v, D_es_entries):   # a verb with at least one plain verb sense in the dictionary (hechar is only "misspelling of echar")
  e = D_es_entries.get(v)
  return bool(e) and any(pos == 'verb' and any(not BAD_GLOSS.match(g) for g in gl) for pos, _, gl in e.get('d', []))

def nwords(s): return len(WORD.findall(s))
def clean(s):   # one plain sentence: no quotes, dialogue, brackets, digits outside a year, or line noise
  return (4 <= nwords(s) <= 14 and len(s) <= 110 and not re.search(r'["“”«»()\[\]/\\—–;:…*#@&_=+<>|~^]|\.\.|--', s)
          and re.match(r'^[¿¡]?[A-ZÁÉÍÓÚÑ]', s) and re.search(r'[.!?]$', s) and not re.search(r'\d', re.sub(r'\b(19|20)\d\d\b', '', s)))

def quality(i, user, lang, natives, ok, plus):
  return i in ok or user in natives[lang] or plus[i] > 0

def score(i, s, user, lang, natives, ok, plus):
  n = nwords(s)
  return (2 if i in ok else 0) + (2 if user in natives[lang] else 0) + min(plus[i], 2) - abs(n - 8) * 0.3

# ---------- Spanish ----------
def conj_index():
  tables = {}
  for f in os.listdir(os.path.join(ROOT, 'conj')):
    if re.match(r'^[a-zñ]{1,2}\.json$', f): tables.update(json.load(open(os.path.join(ROOT, 'conj', f), encoding='utf-8')))
  top = json.load(open(os.path.join(ROOT, 'conj', 'top.json'), encoding='utf-8'))
  tables.update(top['tables'])
  finite = collections.defaultdict(set)   # form → {(verb, tense, person)}, every finite tense of every verb
  anyform = collections.defaultdict(set)  # form → verbs (finite, infinitive, gerund, participle)
  for v, t in tables.items():
    for tense in ALL_T:
      for i, f in enumerate(t.get(tense) or []):
        if f: finite[f.lower()].add((v, tense, i)); anyform[f.lower()].add(v)
    for k, f in (t.get('alt') or {}).items():
      if '.' in k:
        tense, i = k.split('.');
        for g in (f if isinstance(f, list) else [f]): finite[g.lower()].add((v, tense, int(i))); anyform[g.lower()].add(v)
    for k in ('inf', 'ger', 'pp'):
      if t.get(k): anyform[t[k].lower()].add(v); NONFIN[t[k].lower()].add(v)
  # any verb with a table can be a target (a saved verb outside the top 300 gets sentences too)
  targets = [v for v, t in tables.items() if v not in CONJ_SKIP and v not in NO_TARGET_ES and not t.get('old') and not t.get('se')]
  skipforms = {f for f, vs in anyform.items() if vs & CONJ_SKIP}
  TOP.update(top['verbs'])
  return tables, finite, set(targets), skipforms

def cues_of(text, table):
  low = text.lower(); out = []
  for rx, cls in table:
    for m in rx.finditer(low): out.append([m.start(), m.end(), cls])
  out.sort(); keep = []
  for c in out:   # longest match wins where two overlap (la semana pasada over pasado)
    if keep and c[0] < keep[-1][1]:
      if c[1] - c[0] > keep[-1][1] - keep[-1][0]: keep[-1] = c
      continue
    keep.append(c)
  return keep

def es_class(cues):
  cs = {c[2] for c in cues}
  if cs == {'habit', 'then'}: return 'habitThen'
  return cs.pop() if len(cs) == 1 else None

def es_dict_dir():   # iCloud can keep dict/ shards as placeholders that fail to read; the byte-identical scratch copy then
  for d in (os.path.join(ROOT, 'dict'), os.path.expanduser('~/lector-build/dict-live')):
    try: return d, load_dict(d)
    except OSError: continue
  raise SystemExit('no readable Spanish dict/')
DICTS = {}
def dicts():
  if not DICTS:
    DICTS['es_dir'], DICTS['es'] = es_dict_dir(); DICTS['en'] = load_dict(os.path.join(ROOT, 'dict', 'en')); DICTS['ent'] = {}
  return DICTS
def es_entry(v):   # the Spanish dictionary entry for a word, read from its shard
  D = dicts(); k = shard(v)
  if k not in D['ent']: D['ent'][k] = json.load(open(os.path.join(D['es_dir'], k + '.json'), encoding='utf-8'))
  return D['ent'][k].get(v)
STRICT = collections.Counter()   # what the dictionary checks removed from sentences that passed everything else

def build_es(src, meta, nlp_es, nlp_en):
  natives, cc0, ok, bad, plus = meta
  tables, finite, targets, skipforms = conj_index()
  links = collections.defaultdict(list)
  for p in tsv(os.path.join(src, 'spa-eng_links.tsv.bz2')): links[int(p[0])].append(int(p[1]))
  spa = load_sents(src, 'spa')
  eng = load_sents(src, 'eng', {e for es in links.values() for e in es})
  cands = []
  for i, (s, u) in spa.items():
    if i in bad or i not in links or not quality(i, u, 'spa', natives, ok, plus) or not clean(s) or BAD_ES.search(s.lower()): continue
    if any(w.lower() in skipforms for w in WORD.findall(s)): continue
    cues = cues_of(s, CUES_ES)
    if not cues or not es_class(cues): continue
    tr = [(score(e, eng[e][0], eng[e][1], 'eng', natives, ok, plus), e) for e in links[i] if e in eng and e not in bad and quality(e, eng[e][1], 'eng', natives, ok, plus)
          and 3 <= nwords(eng[e][0]) <= 20 and not BAD_EN.search(eng[e][0].lower())]
    if not tr: continue
    cands.append((i, s, u, cues, max(tr)[1], [e for _, e in sorted(tr, reverse=True)]))
  print(f'es: {len(cands)} candidates with a cue and a good translation', file=sys.stderr)
  D = dicts()
  docs = nlp_es.pipe([c[1] for c in cands], batch_size=512)
  edocs = nlp_en.pipe([eng[c[4]][0] for c in cands], batch_size=512)
  out, why = [], collections.Counter()
  for (i, s, u, cues, e, trs), d, ed in zip(cands, docs, edocs):
    r = es_one(s, d, ed, cues, finite, targets, tables)
    if isinstance(r, str):
      why[r] += 1
      if DEBUG and why[r] <= 12: print('  es drop', r, '|', s, '|', eng[e][0], file=sys.stderr)
      continue
    v, tense, person, gs, ge = r
    # Tatoeba has typos: "le hecho miel" reads as hechar (only "misspelling of echar"). The verb must be a real one,
    # the form must not also be another everyday verb's participle or infinitive, and every word must be in dict/.
    w = s[gs:ge].lower(); why2 = None
    if v not in TOP and not real_verb(v, {v: es_entry(v)} if es_entry(v) else {}): why2 = 'rare or misspelt verb'
    elif NONFIN.get(w, set()) & TOP - {v}: why2 = 'form is also another verb’s participle or infinitive'
    elif unknown_word(s, ' '.join(eng[x][0] for x in trs), D['es']): why2 = 'a word not in the Spanish dictionary'
    else:
      ok_tr = [x for x in trs if not unknown_word(eng[x][0], s, D['en'])]
      if not ok_tr: why2 = 'a word not in the English dictionary (translation)'
      else: e = ok_tr[0]
    if why2:
      STRICT['es: ' + why2] += 1
      if DEBUG and STRICT['es: ' + why2] <= 15: print('  es strict', why2, '|', s, '|', eng[e][0], '|', unknown_word(s, eng[e][0], D['es']) or unknown_word(eng[e][0], s, D['en']), file=sys.stderr)
      continue
    lic = (1 if i in cc0 else 0) | (2 if e in cc0 else 0)
    out.append({'i': i, 's': s, 'g': [gs, ge], 'v': v, 't': tense, 'p': person, 'k': es_class(cues), 'c': [c[:3] for c in cues],
                'e': eng[e][0], 'ei': e, 'a': u, 'ea': eng[e][1], 'l': lic, 'sc': score(i, s, u, 'spa', natives, ok, plus)})
  print('es dropped:', dict(why.most_common()), file=sys.stderr)
  return out

def en_subject(ed):   # the English translation's subject: 0 I, 2 he/she/it/a singular noun, 4 they/plural, None
  for t in ed:
    if t.dep_ == 'ROOT':
      for c in t.children:
        if c.dep_ in ('nsubj', 'nsubjpass'):
          w = c.text.lower()
          if w in SUBJ_EN: return SUBJ_EN[w]
          if c.pos_ in ('NOUN', 'PROPN'): return 4 if c.tag_ in ('NNS', 'NNPS') else 2
      return None
  return None

def en_imperative(ed):
  root = [t for t in ed if t.dep_ == 'ROOT']
  return bool(root) and root[0].tag_ == 'VB' and not any(c.dep_.startswith('nsubj') for c in root[0].children)

def es_one(s, d, ed, cues, finite, targets, tables):
  incue = lambda a, b: any(c[0] <= a and b <= c[1] for c in cues)
  verbs = [t for t in d if (t.pos_ in ('VERB', 'AUX') or 'VerbForm=Fin' in str(t.morph)) and t.text.lower() in finite and not incue(t.idx, t.idx + len(t))]
  fin = [t for t in d if 'VerbForm=Fin' in str(t.morph) and not incue(t.idx, t.idx + len(t))]
  if len(verbs) != 1 or len({t.i for t in fin} - {verbs[0].i}): return 'not one finite verb'
  tok = verbs[0]; w = tok.text.lower()
  nxt = d[tok.i + 1] if tok.i + 1 < len(d) else None
  part_next = nxt is not None and 'VerbForm=Part' in str(nxt.morph) and nxt.pos_ in ('VERB', 'AUX')
  ira = nxt is not None and nxt.text.lower() == 'a' and tok.i + 2 < len(d) and 'VerbForm=Inf' in str(d[tok.i + 2].morph)
  prev = d[tok.i - 1].text.lower() if tok.i else ''
  # a pronominal twin counts as its base verb (llamarse → llamar); an everyday verb beats a rare one (ir over fuir)
  base = lambda v: v[:-2] if v.endswith('se') and v[:-2] in tables else v
  ms = sorted({(base(m[0]), m[1], m[2]) for m in finite[w] if m[1] in MAIN_T})
  if not ms: return 'not indicative'
  vs = {m[0] for m in ms}
  if len(vs) > 1 and vs & TOP: vs &= TOP
  if len(vs) > 1:   # fui, fue: ser or ir; siento: sentir or sentar. The English decides.
    en = {t.lemma_.lower() for t in ed}
    if vs == {'ser', 'ir'}:
      if prev in ('me', 'te', 'se', 'nos'): vs = {'ir'}   # se fue: irse (ser is never pronominal)
      elif 'go' in en and 'be' not in en: vs = {'ir'}
      elif 'be' in en and 'go' not in en: vs = {'ser'}
      else: return 'ser or ir'
    elif vs == {'sentir', 'sentar'}:
      if 'sit' in en and not en & {'feel', 'sorry'}: vs = {'sentar'}
      elif en & {'feel', 'sorry'} and 'sit' not in en: vs = {'sentir'}
      else: return 'sentir or sentar'
    else: return 'two verbs share the form'
  v = vs.pop()
  if v not in targets: return 'not a drill verb'
  if part_next and v in ('haber', 'ser'): return 'compound tense or passive'
  if ira and v == 'ir': return 'ir a + infinitive'
  ms = [m for m in ms if m[0] == v]
  cls = es_class(cues)
  tenses = {m[1] for m in ms} & ALLOW_ES[cls]
  if not tenses: return 'tense does not fit the cue'
  if len(tenses) > 1:   # hablamos: present or preterite; the cue decides
    if cls == 'past' and 'pret' in tenses: tenses = {'pret'}
    elif cls in ('habit', 'now', 'fut') and 'pres' in tenses: tenses = {'pres'}
    else: return 'tense ambiguous'
  tense = tenses.pop()
  persons = {m[2] for m in ms if m[1] == tense}
  # the subject: a subject pronoun anywhere, or a noun before the verb (spaCy often takes a noun after it, or the
  # cue itself, todas las mañanas, for the subject)
  subj, pron = None, False
  for c in tok.children:
    if not c.dep_.startswith('nsubj') or incue(c.idx, c.idx + len(c)): continue
    cw = c.text.lower(); conj = [x for x in c.children if x.dep_ == 'conj']
    if conj: subj, pron = (3 if {cw, *(x.text.lower() for x in conj)} & {'yo', 'nosotros', 'nosotras'} else 4), cw in SUBJ_ES   # yo y mi padre: nosotros
    elif cw in SUBJ_ES: subj, pron = SUBJ_ES[cw], True
    elif c.pos_ in ('NOUN', 'PROPN') and c.i < tok.i: subj = 4 if 'Number=Plur' in str(c.morph) else 2
  if subj is not None and subj not in persons:
    if pron: return 'subject disagrees'
    subj = None
  if len(persons) > 1:
    if subj is None:
      es = en_subject(ed)
      subj = es if es in persons else None
    if subj is None: return 'person ambiguous'
    persons = {subj}
  p = persons.pop()
  if v == 'haber' and p != 2: return 'haber as a helper'
  # habla is also the command "speak!": dropped when the English is a command
  if w in {f.lower() for f in (tables[v].get('imp') or []) if f} and en_imperative(ed): return 'could be a command'
  if tables[v][tense][p].lower() != w and w not in [a.lower() for a in (tables[v].get('alt') or {}).get(f'{tense}.{p}', [])]: return 'table mismatch'
  return v, tense, p, tok.idx, tok.idx + len(tok)

# ---------- English ----------
def ev_index():
  ev = json.load(open(os.path.join(ROOT, 'conj-en', 'verbs.json'), encoding='utf-8'))
  forms = collections.defaultdict(set)
  for v in ev['verbs']:
    for k in ['b'] + EN_FORMS:
      for f in v[k].split(' / '): forms[f.lower()].add((v['b'], k))
  return {v['b']: v for v in ev['verbs']}, forms

BE = {'am', 'is', 'are', 'was', 'were', "'m", "'s", "'re"}
HAVE = {'have', 'has', 'had', "'ve", "'s", "'d"}

def build_en(src, meta, nlp_en):
  natives, cc0, ok, bad, plus = meta
  ev, forms = ev_index()
  links = collections.defaultdict(list)
  for p in tsv(os.path.join(src, 'spa-eng_links.tsv.bz2')): links[int(p[1])].append(int(p[0]))
  spa = load_sents(src, 'spa')
  eng = load_sents(src, 'eng', set(links))
  cands = []
  for i, (s, u) in eng.items():
    if i in bad or not quality(i, u, 'eng', natives, ok, plus) or not clean(s) or BAD_EN.search(s.lower()): continue
    if not any(w.lower() in forms for w in WORD.findall(s)): continue
    tr = [(score(x, spa[x][0], spa[x][1], 'spa', natives, ok, plus), x) for x in links[i] if x in spa and x not in bad and quality(x, spa[x][1], 'spa', natives, ok, plus)
          and 3 <= nwords(spa[x][0]) <= 20 and not BAD_ES.search(spa[x][0].lower())]
    if not tr: continue
    cands.append((i, s, u, max(tr)[1], [x for _, x in sorted(tr, reverse=True)]))
  print(f'en: {len(cands)} candidates with a good translation', file=sys.stderr)
  D = dicts()
  out, why = [], collections.Counter()
  for (i, s, u, x, trs), d in zip(cands, nlp_en.pipe([c[1] for c in cands], batch_size=512)):
    r = en_one(s, d, ev, forms)
    if isinstance(r, str):
      why[r] += 1
      if DEBUG and why[r] <= 8: print('  en drop', r, '|', s, file=sys.stderr)
      continue
    b, form, gs, ge, cues, cls = r
    why2 = None
    if unknown_word(s, ' '.join(spa[y][0] for y in trs), D['en']): why2 = 'a word not in the English dictionary'
    else:
      ok_tr = [y for y in trs if not unknown_word(spa[y][0], s, D['es'])]
      if not ok_tr: why2 = 'a word not in the Spanish dictionary (translation)'
      else: x = ok_tr[0]
    if why2:
      STRICT['en: ' + why2] += 1
      if DEBUG and STRICT['en: ' + why2] <= 15: print('  en strict', why2, '|', s, '|', spa[x][0], '|', unknown_word(s, spa[x][0], D['en']) or unknown_word(spa[x][0], s, D['es']), file=sys.stderr)
      continue
    lic = (1 if i in cc0 else 0) | (2 if x in cc0 else 0)
    out.append({'i': i, 's': s, 'g': [gs, ge], 'v': b, 'f': form, 'k': cls, 'c': cues, 'e': spa[x][0], 'ei': x, 'a': u, 'ea': spa[x][1], 'l': lic,
                'sc': score(i, s, u, 'eng', natives, ok, plus)})
  print('en dropped:', dict(why.most_common()), file=sys.stderr)
  return out

def en_one(s, d, ev, forms):
  fin = [t for t in d if t.tag_ in ('VBD', 'VBZ', 'VBP', 'MD')]
  if len(fin) != 1: return 'not one finite verb'
  f0 = fin[0]
  if any(t.text.lower() in ("n't", 'not') for t in d): return 'negative'
  if d[-1].text == '?' or d[0].tag_ in ('VBD', 'VBZ', 'VBP', 'MD'): return 'question'
  if f0.tag_ == 'MD': return 'modal'
  tcues = cues_of(s, CUES_EN)
  head = f0
  # have + participle, be + -ing: the finite word is the helper, the target is the verb it serves
  if f0.text.lower() in HAVE | BE and f0.dep_ == 'aux' and f0.head.i > f0.i:
    tgt = f0.head
    between = d[f0.i + 1:tgt.i]
    if any(t.pos_ not in ('ADV', 'PART') for t in between) or tgt.i - f0.i > 3: return 'helper too far'
    if tgt.tag_ == 'VBN' and f0.text.lower() in HAVE and f0.lemma_ == 'have': form = 'pp'
    elif tgt.tag_ == 'VBG' and f0.lemma_ == 'be': form = 'ing'
    else: return 'not have + pp or be + ing'
    if form == 'ing' and tgt.text.lower() == 'going' and tgt.i + 1 < len(d) and d[tgt.i + 1].text.lower() == 'to': return 'going to'
    if any(t.dep_ in ('auxpass',) for t in d): return 'passive'
    head = tgt
  else:
    tgt = f0
    if f0.tag_ == 'VBZ': form = 's'
    elif f0.tag_ == 'VBD': form = 'p'
    else: return 'base form (no card)'
  w = tgt.text.lower()
  if form == 'p' and tgt.lemma_.lower() == 'be' and w not in ('was', 'were'): return 'be'
  vs = {vb for vb, k in forms.get(w, ()) if k == form}
  if len(vs) != 1: return 'not a drill verb' if not vs else 'two verbs share the form'
  b = vs.pop()
  if b in NO_TARGET_EN: return 'not a drill verb'
  if tgt.lemma_.lower() != b: return 'lemma disagrees'
  if len({vb for vb, k in forms.get(w, ())}) > 1: return 'two verbs share the form'
  if w not in [x.lower() for x in ev[b][form].split(' / ')]: return 'table mismatch'
  subj = [c for c in (f0.children if form in ('pp', 'ing') else tgt.children) if c.dep_ in ('nsubj', 'nsubjpass', 'expl')]
  if form in ('pp', 'ing'): subj += [c for c in tgt.children if c.dep_ in ('nsubj', 'nsubjpass', 'expl')]
  if not subj: return 'no subject'
  sj = subj[0]
  if sj.dep_ == 'expl' or sj.text.lower() in ('there', 'that', 'this', 'what', 'who', 'which'): return 'there / that subject'
  cues = []
  if form == 's':
    if sj.text.lower() not in ('he', 'she', 'it') and sj.pos_ not in ('PROPN', 'NOUN'): return 'subject not he/she/it'
    if sj.tag_ in ('NNS', 'NNPS'): return 'plural subject'
    l, r = sj.left_edge.idx, sj.idx + len(sj)
    if sj.i - sj.left_edge.i > 2: l = sj.idx
    cues.append([l, r, 'g'])
    if any(c[2] == 'past' for c in tcues): return 'past cue with -s'
    cls = 'third'
  elif form == 'p':
    pc = [c for c in tcues if c[2] == 'past' and not (c[0] > tgt.idx and re.search(r'[,;]', s[tgt.idx:c[0]]))]
    if not pc or any(c[2] in ('now', 'perf') for c in tcues if c[2] != 'past' and c[2] != 'habit'): return 'no past cue'
    cls = 'past'
  elif form == 'pp':
    if any(c[2] == 'past' for c in tcues): return 'past cue with have'
    cues.append([f0.idx, f0.idx + len(f0), 'g']); cls = 'perf'
  else:
    cues.append([f0.idx, f0.idx + len(f0), 'g']); cls = 'prog'
  for c in tcues:
    if c[0] > tgt.idx and re.search(r'[,;]', s[tgt.idx:c[0]]): continue   # "have gone, never to return": never is not about the perfect
    if (form == 'p' and c[2] == 'past') or (form == 's' and c[2] in ('habit', 'now')) or (form == 'pp' and c[2] == 'perf') or (form == 'ing' and c[2] == 'now'): cues.append(c)
  cues.sort()
  return b, form, tgt.idx, tgt.idx + len(tgt), cues, cls

# ---------- choose, write, check ----------
def pick(items, key, cap_key, cap_verb):
  items.sort(key=lambda x: (-x['sc'], x['i']))
  per, perv, seen, out = collections.Counter(), collections.Counter(), set(), []
  for x in items:
    if x['s'] in seen or per[key(x)] >= cap_key or perv[x['v']] >= cap_verb: continue
    seen.add(x['s']); per[key(x)] += 1; perv[x['v']] += 1; out.append(x)
  return out

import unicodedata
def shard(w):   # the app's shardOf(): the first two letters, accents folded (oír → oi), like dict/ and conj/
  f = re.sub(r'[^a-z]', '', ''.join(c for c in unicodedata.normalize('NFD', w.lower()) if unicodedata.category(c) != 'Mn'))
  return f[:2] if len(f) >= 2 else (f + '_')[:2]

def write(side, items, fields):
  d = os.path.join(OUT, side); os.makedirs(d, exist_ok=True)
  for f in os.listdir(d):
    if f.endswith('.json'): os.remove(os.path.join(d, f))
  byv = collections.defaultdict(list)
  for x in sorted(items, key=lambda x: x['i']): byv[x['v']].append([x[k] for k in fields])
  bysh = collections.defaultdict(dict)
  for v, rows in sorted(byv.items()): bysh[shard(v)][v] = rows
  for k, vs in sorted(bysh.items()):
    json.dump(vs, open(os.path.join(d, k + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
  idx = {v: len(rows) for v, rows in sorted(byv.items())}
  json.dump({'fields': fields, 'verbs': idx, 'n': sum(idx.values()), 'shards': sorted(bysh),
             'source': 'Tatoeba (tatoeba.org), sentences and translations by their contributors, CC BY 2.0 FR (some CC0). l: 1 = sentence CC0, 2 = translation CC0.'},
            open(os.path.join(d, '_index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
  return len(items)

ES_FIELDS = ['i', 's', 'g', 't', 'p', 'k', 'c', 'e', 'ei', 'a', 'ea', 'l']
EN_FIELDS = ['i', 's', 'g', 'f', 'k', 'c', 'e', 'ei', 'a', 'ea', 'l']

def check():
  tables, finite, targets, skipforms = conj_index()
  ev, forms = ev_index()
  bad, n = [], collections.Counter()
  for side, fields in (('es', ES_FIELDS), ('en', EN_FIELDS)):
    idx = json.load(open(os.path.join(OUT, side, '_index.json'), encoding='utf-8'))
    for v, cnt in idx['verbs'].items():
      rows = json.load(open(os.path.join(OUT, side, shard(v) + '.json'), encoding='utf-8')).get(v, [])
      if len(rows) != cnt: bad.append(f'{side}/{v}: index says {cnt}, file has {len(rows)}')
      for r in rows:
        x = dict(zip(fields, r)); gap = x['s'][x['g'][0]:x['g'][1]].lower(); n[side] += 1
        if side == 'es':
          want = [tables[v][x['t']][x['p']].lower()] + [a.lower() for a in (tables[v].get('alt') or {}).get(f"{x['t']}.{x['p']}", [])]
          if x['t'] not in MAIN_T or gap not in want: bad.append(f"es #{x['i']} {v} {x['t']} {x['p']}: gap '{gap}' is not {want}")
          if v not in targets: bad.append(f"es #{x['i']}: {v} is not a drill verb")
          if x['t'] not in ALLOW_ES[x['k']]: bad.append(f"es #{x['i']}: {x['t']} does not fit class {x['k']}")
        else:
          want = [f.lower() for f in ev[v][x['f']].split(' / ')]
          if gap not in want: bad.append(f"en #{x['i']} {v} {x['f']}: gap '{gap}' is not {want}")
        for c in x['c']:
          if not (0 <= c[0] < c[1] <= len(x['s'])) or (c[0] < x['g'][1] and x['g'][0] < c[1]): bad.append(f"{side} #{x['i']}: cue span {c} overlaps the gap or the edge")
        if not x['c']: bad.append(f"{side} #{x['i']}: no cue")
        D = dicts(); es_t, en_t = (x['s'], x['e']) if side == 'es' else (x['e'], x['s'])
        u1, u2 = unknown_word(es_t, en_t, D['es']), unknown_word(en_t, es_t, D['en'])
        if u1 or u2: bad.append(f"{side} #{x['i']}: not in the dictionary: {u1 or u2}")
        if side == 'es' and v not in TOP and not real_verb(v, {v: es_entry(v)} if es_entry(v) else {}): bad.append(f"es #{x['i']}: {v} is not a real everyday verb")
        if side == 'es' and NONFIN.get(gap, set()) & TOP - {v}: bad.append(f"es #{x['i']}: '{gap}' is also another verb's participle or infinitive")
        if BAD_ES.search((x['s'] if side == 'es' else x['e']).lower()) or BAD_EN.search((x['e'] if side == 'es' else x['s']).lower()): bad.append(f"{side} #{x['i']}: blocked word")
  print(f"checked es {n['es']}, en {n['en']}: {len(bad)} problems")
  for b in bad[:40]: print('  ', b)
  return not bad

def main():
  if sys.argv[1:] == ['--check']: sys.exit(0 if check() else 1)
  src = os.path.expanduser(sys.argv[1])
  import spacy
  nlp_es = spacy.load('es_core_news_md', disable=['ner'])
  nlp_en = spacy.load('en_core_web_md', disable=['ner'])
  meta = load_meta(src)
  es = build_es(src, meta, nlp_es, nlp_en)
  print('dictionary checks removed (es):', {k: v for k, v in STRICT.items() if k.startswith('es')}, file=sys.stderr)
  es = pick(es, lambda x: (x['v'], x['t'], x['p'], x['k']), 8, 100)
  print('es written:', write('es', es, ES_FIELDS), file=sys.stderr)
  en = build_en(src, meta, nlp_en)
  print('dictionary checks removed (en):', {k: v for k, v in STRICT.items() if k.startswith('en')}, file=sys.stderr)
  en = pick(en, lambda x: (x['v'], x['f']), 14, 56)
  print('en written:', write('en', en, EN_FIELDS), file=sys.stderr)
  sys.exit(0 if check() else 1)

if __name__ == '__main__':
  main()
