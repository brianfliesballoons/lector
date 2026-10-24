#!/usr/bin/env python3
"""Build Lector's English->Spanish dictionary (dict/en/) for a Spanish speaker reading English.

usage: build_dict_en.py <kaikki English en.jsonl.gz> <kaikki es-wiktionary Inglés .jsonl> \
                        <kaikki Spanish es.jsonl.gz> <out_dir>

Three Wiktionary sources, all CC BY-SA 4.0, all via kaikki.org (Wiktextract):
  1. Spanish Wiktionary's English entries (es.wiktionary.org, about 23,000): short definitions
     written in Spanish for Spanish speakers ("happy" -> "feliz", "afortunado, dichoso"). These lead.
  2. English Wiktionary's English entries: the Spanish rows of each translation table, ordered by
     the sense they belong to (the first sense is usually the everyday one). These fill every word
     the Spanish edition lacks and add senses it misses.
  3. English Wiktionary's Spanish entries read backwards (formación: "formation" -> formation:
     formación), only for single English words that still have no Spanish meaning after 1 and 2.
     These entries carry "r": 1 so the app can say the meaning is less certain.
Last fallbacks, for words with neither: British spellings point at the American one (grey -> gray,
defence -> defense), -ly adverbs point at their adjective (keenly -> keen), and contractions
(can't, you're, I'll) get Spanish meanings from a hand-written table in this file.
Inflected forms point at their lemma (went -> go, children -> child, happier -> happy), from
English Wiktionary's form-of senses and each lemma's own list of forms.

Output has the same shape and sharding as dict/ (see build_dict.py): <out>/<prefix>.json maps
word -> {"d": [[pos, "", [spanish glosses]]...], "f": [[lemma, spanish label]...], "fl": 1?}, keyed by the
lowercase word and sharded by its accent-folded two-letter prefix; plus <out>/_index.json.
"fl": 1 marks a word whose form reading should be shown first (saw: the past of see, before "sierra").
Run it with wordfreq installed (~/lector-build/venv) so form pointers are ordered by frequency.
"""
import gzip, json, os, re, sys, unicodedata
from collections import defaultdict

MAX_POS, MAX_SENSES, MAX_GLOSS, MAX_WORDS_PER_SENSE = 3, 4, 140, 3
SKIP_TAGS = {"obsolete", "archaic", "rare", "dated", "nonstandard", "dialectal", "misspelling",
             "pronunciation-spelling", "eye-dialect", "outdated", "humorous", "nonce-word"}
FORM_SKIP = SKIP_TAGS | {"table-tags", "inflection-template", "class", "romanization", "suppletive"}
WORD_OK = re.compile(r"[a-zà-ÿ][a-zà-ÿ'’ .-]*")
# Spanish Wiktionary glosses that only describe a form ("Tiempo pasado del verbo go (ir).") are left
# to the form pointers, which carry the lemma's real meanings.
ES_FORM_GLOSS = re.compile(r"^(forma|tiempo pasado|pasado|participio|gerundio|plural|(primera|segunda|tercera) persona|"
                           r"comparativo|superlativo|variante|grafía|contracción de|abreviatura de|"
                           r"(sigla|acrónimo|abreviatura|símbolo)\b|(\w+ )?letra del (alfabeto|abecedario))", re.I)
# Pointers from abbreviations (i -> interstate) and spelling variants of a word that already has
# its own meanings (the -> thee) only get in the way.
PTR_SKIP = {"abbreviation", "initialism", "acronym", "clipping", "symbol", "suppletive"}
LETTER_POS = {"character", "letter", "symbol"}
SPELLING_OF = re.compile(r"^(?:(?:Commonwealth|British|UK|Canadian|Australian|American|US)[a-z ,/-]* )?"
                         r"(?:standard |alternative |dated )?spelling of ([a-z]+)\.?$", re.I)
# Prefer what a Mexican reader says: Mexico, then Latin America, then untagged, then Spain last.
REGION_RANK = {"Mexico": 0, "Latin-America": 1, "Spain": 9}

def fold(w):
    w = unicodedata.normalize("NFD", w.lower())
    w = "".join(c for c in w if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z]", "", w)

def shard(w):
    f = fold(w)
    return (f[:2] if len(f) >= 2 else (f + "_")[:2]) or "__"

def key_of(word):
    w = unicodedata.normalize("NFC", word.strip()).replace("’", "'")
    lw = w.lower()
    if len(lw) > 40 or lw.count(" ") > 2 or not WORD_OK.fullmatch(lw):
        return None
    return lw

def es_label(tags):
    t = set(tags)
    if "participle" in t and "past" in t:
        return "participio"
    if "participle" in t and "present" in t or "gerund" in t:
        return "gerundio (-ing)"
    if "past" in t:
        return "pasado"
    if "third-person" in t and "singular" in t:
        return "3.ª persona"
    if "plural" in t:
        return "plural"
    if "comparative" in t:
        return "comparativo"
    if "superlative" in t:
        return "superlativo"
    if "present" in t:
        return "presente"
    return "forma"

def clean_es(g, keep_case=False):
    g = re.sub(r"[₀-₉¹²³⁰-⁹]+", "", g).strip()            # sense numbers: "nervio₆"
    prev = None
    while prev != g:                                   # drop long asides, innermost first
        prev, g = g, re.sub(r"\s*\([^()]{30,}\)", "", g).strip()
    g = g.rstrip(".").strip()
    if not keep_case and (len(g) > 1 and g[0].isupper() and g[1].islower() or len(g) == 1):
        g = g[0].lower() + g[1:]
    g = re.sub(r"^([A-ZÁÉÍÓÚ])(, )", lambda m: m.group(1).lower() + m.group(2), g)   # "A, en" -> "a, en"
    return g[:MAX_GLOSS]

def clean_tr(es):
    """Strip editors' notes from a translation: "gustarle, nonromantically: caerle [with le and a]"."""
    es = re.sub(r"\[[^\]]*\]", "", es)
    es = re.sub(r"\s*\((disused|archaic|dated|obsolete|formal|informal|colloquial|slang|vulgar|rare|"
                r"literary|regional|figuratively|literally|uncommon|Spain|Mexico|Latin America)\)", "", es)
    if ":" in es:
        es = es.split(":")[-1]
    es = re.sub(r"[₀-₉¹²³⁰-⁹]+", "", es)                  # sense numbers: "dejar₉"
    return es.strip(" ,;")

def argmax(scores):
    try:
        v = [float(x) for x in scores.split()]
    except ValueError:
        return None
    return v.index(max(v)) if v else None

# ---------------------------------------------------------------- English Wiktionary
def read_enwikt(src):
    """-> trans[word] = [(pos, [(rank, region, spanish)...], is_name)...] in page order,
          forms[word] = [(lemma, label)...], known[word] = [pos...] for every English entry"""
    trans = defaultdict(list)
    forms = defaultdict(list)
    known = defaultdict(list)
    with gzip.open(src, "rt", encoding="utf-8") as fh:
        for line in fh:
            e = json.loads(line)
            if e.get("lang_code") != "en":
                continue
            w = key_of(e.get("word", ""))
            if not w:
                continue
            pos = e.get("pos", "")
            senses = e.get("senses", [])
            bad = {i for i, s in enumerate(senses) if SKIP_TAGS & set(s.get("tags", []))}
            if len(bad) < len(senses) and pos not in known[w]:
                known[w].append(pos)
            if e.get("word", "") == w:
                LOWER_HEADS.add(w)
            for s in senses:                               # grey: "Commonwealth standard spelling of gray."
                m = SPELLING_OF.match((s.get("glosses") or [""])[-1])
                lem = key_of(m.group(1)) if m else None
                if lem and lem != w and [lem, "variante"] not in forms[w]:
                    forms[w].append([lem, "variante"])
            for s in senses:
                tags = set(s.get("tags", []))
                ptr = s.get("form_of") or s.get("alt_of")
                if not ptr or tags & (SKIP_TAGS | PTR_SKIP):
                    continue
                lem = key_of(ptr[0].get("word", ""))
                if lem and lem != w and lem.count(" ") <= w.count(" "):
                    lab = "variante" if s.get("alt_of") and not s.get("form_of") else es_label(tags)
                    if [lem, lab] not in forms[w]:
                        forms[w].append([lem, lab])
            for f in e.get("forms", []):
                tags = set(f.get("tags", []))
                fw = key_of(f.get("form", ""))
                if not fw or fw == w or " " in fw or tags & FORM_SKIP or f.get("source") == "conjugation":
                    continue
                if not tags & {"plural", "past", "participle", "present", "comparative", "superlative",
                               "third-person", "gerund"}:
                    continue
                lab = es_label(tags)
                if [w, lab] not in forms[fw]:
                    forms[fw].append([w, lab])
            items = []
            for i, s in enumerate(senses):
                for t in s.get("translations", []):
                    if t.get("lang_code") == "es" and i not in bad:
                        items.append((i, t))
            for t in e.get("translations", []):
                if t.get("lang_code") == "es":
                    i = argmax(t.get("_dis1", ""))
                    items.append((i if i is not None else 0.5, t))
            out = []
            for rank, t in items:
                es = clean_tr(t.get("word") or "")
                tags = set(t.get("tags", []))
                if not es or len(es) > 40 or tags & {"archaic", "obsolete", "dated", "rare"}:
                    continue
                region = min([REGION_RANK.get(x, 5) for x in tags if x in REGION_RANK] or [5])
                out.append((rank, region, es))
            if pos in LETTER_POS:
                continue
            if out or pos == "name":
                # A capitalised headword (IS, Will, Rose) is a name or an acronym: it is used only when the
                # lowercase word has no entry of its own. Single letters are exempt (I).
                orig = e.get("word", "")
                trans[w].append((pos, out, pos == "name" or (len(orig) > 1 and orig != orig.lower())))
    return trans, forms, known

ZIPF = {"en": lambda w: 0.0, "es": lambda w: 0.0}
LOWER_HEADS = set()   # words English Wiktionary has as a lowercase headword (is, will, rose)
FORM_WORDS = set()    # words that are an inflected form of another word (is, went, children)

def english_note(es):
    """'future tense' in a Spanish translation row is an editor's note, not Spanish."""
    return " " in es and re.fullmatch(r"[a-z ]+", es.lower()) and ZIPF["en"](es) > ZIPF["es"](es) + 1

CONTENT = ("noun", "verb", "adj")

def sense_glosses(items, pos=""):
    """Translations grouped by sense, best sense first; within a sense, Mexican usage first."""
    by = defaultdict(list)
    for rank, region, es in items:
        if english_note(es):
            continue
        by[rank].append((region, es))
    out = []
    for rank in sorted(by):
        words = []
        # Mexican usage first, then the commonest Spanish word (cosa before volancheje, dar before diñar).
        for region, es in sorted(by[rank], key=lambda x: (x[0], -ZIPF["es"](x[1]))):
            if es not in words and region < 9 or not words and es not in words:
                words.append(es)
        best = max((ZIPF["es"](x) for x in words), default=0)
        words = [x for x in words if ZIPF["es"](x) >= best - 2.5] or words
        if pos in CONTENT:   # a bare que, la, se in a noun or verb row is part of a phrase, not the meaning
            words = [x for x in words if " " in x or ZIPF["es"](x) < 6.3] or words
        if words:
            out.append(", ".join(words[:MAX_WORDS_PER_SENSE]))
    return out

def head_zipf(g):
    """How common a gloss's first Spanish word or phrase is."""
    h = re.sub(r"\([^()]*\)", "", re.split(r"[,;]", g)[0]).strip()
    return ZIPF["es"](h) if h else 0.0

# ---------------------------------------------------------------- Spanish Wiktionary
def read_eswikt(src):
    defs = defaultdict(list)   # word -> [(pos, [glosses])]
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            e = json.loads(line)
            if e.get("lang_code") != "en":
                continue
            w = key_of(e.get("word", ""))
            if not w:
                continue
            gl = []
            for s in e.get("senses", []):
                if s.get("form_of") or SKIP_TAGS & set(s.get("tags", [])):
                    continue
                g = clean_es((s.get("glosses") or [""])[-1], keep_case=e.get("pos") == "name")
                # Some entries carry an English example sentence as a gloss ("We sat on the bench").
                if " " in g and ZIPF["en"](g) > ZIPF["es"](g) + 1:
                    continue
                if g and not ES_FORM_GLOSS.match(g) and g not in gl:
                    gl.append(g)
            orig = e.get("word", "")
            if gl and e.get("pos") not in LETTER_POS:
                defs[w].append((e.get("pos", ""), gl, e.get("pos") == "name" or (len(orig) > 1 and orig != orig.lower())))
    return defs

# ---------------------------------------------------------------- Spanish entries, read backwards
REV_POS = {"noun", "verb", "adj", "adv", "prep", "conj", "pron", "intj", "num", "det"}

def read_reverse(src, wanted, zipf_es):
    """English gloss item -> Spanish lemmas, for the English words in `wanted` only.
    formar: "to form, to create" gives form -> formar. Scored by Spanish frequency, earlier sense
    and earlier item first."""
    cand = defaultdict(lambda: defaultdict(dict))   # en -> pos -> spanish -> score
    with gzip.open(src, "rt", encoding="utf-8") as fh:
        for line in fh:
            e = json.loads(line)
            if e.get("lang_code") != "es" or e.get("pos") not in REV_POS:
                continue
            es = unicodedata.normalize("NFC", e.get("word", ""))
            if not re.fullmatch(r"[a-záéíóúüñ]{2,}", es):
                continue
            pos, si = e["pos"], 0
            for s in e.get("senses", []):
                tags = set(s.get("tags", []))
                if s.get("form_of") or s.get("alt_of") or tags & (SKIP_TAGS | {"slang", "vulgar", "derogatory"}):
                    continue
                # A sense used only in one region (Costa Rica's "mejenga") is a poor first meaning
                # unless that region is Mexico or Latin America as a whole.
                regional = {t for t in tags if t[:1].isupper()}
                if regional and not regional & {"Mexico", "Latin-America"}:
                    si += 1
                    continue
                g = re.sub(r"\([^()]*\)", "", (s.get("glosses") or [""])[-1])
                for ii, item in enumerate(re.split(r"[;,]", g)):
                    item = item.strip().lower()
                    item = re.sub(r"^(to|a|an|the) ", "", item)
                    if item in wanted:
                        score = zipf_es(es) - 0.6 * si - 0.4 * ii
                        old = cand[item][pos].get(es)
                        if old is None or score > old:
                            cand[item][pos][es] = score
                si += 1
    return cand

def reverse_d(w, cand, en_pos):
    order = [p for p in en_pos if p in cand]      # only parts of speech the English word really has
    d = []
    for pos in order:
        best = sorted(cand[pos].items(), key=lambda x: -x[1])[:MAX_WORDS_PER_SENSE]
        best = [es for es, sc in best if sc > 1.0] or [best[0][0]]
        d.append([pos, "", [", ".join(best)]])
    return d[:MAX_POS]

# British -> American spelling, tried in order; the first that has meanings wins.
UK_US = [(r"our$", "or"), (r"ours$", "ors"), (r"ence$", "ense"), (r"ise$", "ize"), (r"ised$", "ized"),
         (r"ising$", "izing"), (r"isation$", "ization"), (r"yse$", "yze"), (r"tre$", "ter"), (r"tres$", "ters"),
         (r"ogue$", "og"), (r"ll(ed|ing|er)$", r"l\1"), (r"^grey", "gray")]

def uk_to_us(w, words):
    for a, b in UK_US:
        v = re.sub(a, b, w)
        if v != w and "d" in words.get(v, {}):
            return v
    return None

def ly_base(w, words):
    if not w.endswith("ly") or len(w) < 5:
        return None
    for base in (w[:-2], w[:-3] + "y" if w.endswith("ily") else None,
                 w[:-1] + "e" if w.endswith(("bly", "ply", "tly")) else None,
                 w[:-2] + "e", w[:-4] + "ic" if w.endswith("ically") else None):
        if base and "d" in words.get(base, {}):
            return base
    return None

# Contractions: hand-written for Lector (no source text). Each reads "Spanish (the full English)".
_SUBJ = {"i": ("yo", "I"), "you": ("tú, usted", "you"), "he": ("él", "he"), "she": ("ella", "she"),
         "it": ("eso", "it"), "we": ("nosotros", "we"), "they": ("ellos", "they"),
         "that": ("eso", "that"), "there": ("hay, había", "there"), "who": ("quién", "who"),
         "what": ("qué", "what"), "where": ("dónde", "where"), "here": ("aquí", "here"),
         "how": ("cómo", "how"), "when": ("cuándo", "when"), "this": ("esto", "this")}
_BE = {"i": "soy, estoy", "you": "eres, estás; es, está", "we": "somos, estamos", "they": "son, están",
       "who": "es, son", "what": "es, son"}
CONTRACTIONS = {
    "isn't": "no es, no está (is not)", "aren't": "no son, no están; no eres (are not)",
    "wasn't": "no era, no estaba, no fue (was not)", "weren't": "no eran, no estaban (were not)",
    "don't": "no (+ verbo): I don't know = no sé (do not)", "doesn't": "no (+ verbo): she doesn't know = ella no sabe (does not)",
    "didn't": "no (+ pasado): I didn't go = no fui (did not)", "can't": "no poder: no puedo, no puede (cannot)",
    "cannot": "no poder: no puedo, no puede", "couldn't": "no podía, no pudo, no podría (could not)",
    "won't": "no (+ futuro): I won't go = no iré (will not)", "wouldn't": "no (+ condicional): no iría (would not)",
    "shouldn't": "no debería (should not)", "haven't": "no haber: I haven't seen = no he visto (have not)",
    "hasn't": "no haber: she hasn't seen = no ha visto (has not)", "hadn't": "no había (had not)",
    "mustn't": "no deber: you mustn't = no debes (must not)", "needn't": "no hace falta (need not)",
    "shan't": "no (+ futuro) (shall not)", "mightn't": "quizá no (might not)",
    "ain't": "no es, no está, no tiene (coloquial: is not, are not, has not)",
    "let's": "vamos a… (let us): let's go = vamos", "o'clock": "en punto: one o'clock = la una en punto",
    "'tis": "es (it is, antiguo)", "'twas": "era (it was, antiguo)",
    "gonna": "ir a (going to): I'm gonna eat = voy a comer", "wanna": "querer (want to)",
    "gotta": "tener que (got to)", "y'all": "ustedes (you all)", "ma'am": "señora",
    "there's": "hay (there is)", "there're": "hay (there are)", "there'll": "habrá (there will)",
    "there'd": "habría, había (there would, there had)", "there've": "ha habido (there have)",
}
def contractions(known):
    """The hand list, plus pronoun and question-word contractions that English Wiktionary has."""
    out = dict(CONTRACTIONS)
    gen = {}
    for w, (es, en) in _SUBJ.items():
        if w == "there":
            continue
        if w not in ("i", "you", "we", "they"):
            gen[f"{w}'s"] = f"{es} es, {es} está; {es} ha (+ participio) ({en} is, {en} has)"
        gen[f"{w}'ll"] = f"{es} (+ futuro) ({en} will)"
        gen[f"{w}'d"] = f"{es} (+ condicional o pasado) ({en} would, {en} had)"
        gen[f"{w}'ve"] = f"{es} he, has, hemos, han (+ participio) ({en} have)"
        if w in _BE:
            gen["i'm" if w == "i" else f"{w}'re"] = f"{es} {_BE[w]} ({en} {'am' if w == 'i' else 'are'})"
    core = {"i'm", "i'll", "i'd", "i've", "you're", "you'll", "you'd", "you've", "he's", "he'll", "he'd",
            "she's", "she'll", "she'd", "it's", "it'll", "we're", "we'll", "we'd", "we've", "they're",
            "they'll", "they'd", "they've", "that's", "what's", "who's", "where's", "here's", "how's"}
    for k, v in gen.items():
        if k in core or k in known:
            out.setdefault(k, v)
    return out

# ---------------------------------------------------------------- merge
def words_of(g):
    ws = set(re.findall(r"[a-záéíóúüñ]+", g.lower()))
    return (ws - {"de", "la", "el", "a", "en", "se", "un", "una"}) or ws

# Hand-written first meanings for English helper verbs, where a translation table can't say what
# the word does (will -> "future tense"). Each leads its part of speech, and that part leads the word.
FIRST = {
    "will": ("verb", "(+ verbo) futuro: I will go = iré"),
    "would": ("verb", "(+ verbo) condicional: I would go = iría"),
    "shall": ("verb", "(+ verbo) futuro: I shall go = iré; ¿shall we…? = ¿…?"),
    "should": ("verb", "debería (+ verbo): you should go = deberías ir"),
    "can": ("verb", "poder, saber (+ verbo): I can swim = sé nadar"),
    "could": ("verb", "podía, pudo, podría (+ verbo)"),
    "may": ("verb", "poder (permiso o posibilidad): it may rain = puede que llueva"),
    "might": ("verb", "podría, quizá (+ verbo): it might rain = quizá llueva"),
    "must": ("verb", "deber, tener que (+ verbo)"),
    "do": ("verb", "hacer; (en preguntas y negaciones no se traduce): do you know? = ¿sabes?"),
    "does": ("verb", "hace; (en preguntas y negaciones no se traduce): does she know? = ¿sabe?"),
    "did": ("verb", "hizo; (+ verbo, en preguntas y negaciones marca el pasado): did you go? = ¿fuiste?"),
    "to": ("prep", "a, hacia, hasta; (+ verbo) marca el infinitivo: to go = ir"),
    "like": ("prep", "como, parecido a"),
    "you": ("pron", "tú, usted, ustedes; te, lo, la, los, les"),
    "it": ("pron", "eso, ello; lo, la (a menudo no se traduce: it rains = llueve)"),
    "they": ("pron", "ellos, ellas"),
    "who": ("pron", "quién, quiénes; que, el que (the man who… = el hombre que…)"),
    "why": ("adv", "por qué"),
}
# Words that work mostly as one part of speech in running text, whatever order Wiktionary uses.
POS_FIRST = {"back": "adv", "still": "adv", "even": "adv", "just": "adv", "only": "adv", "well": "adv",
             "right": "adj", "over": "prep", "on": "prep", "about": "prep", "while": "conj", "so": "adv",
             "out": "adv", "up": "adv", "down": "adv", "off": "adv", "in": "prep", "as": "conj",
             "that": "conj", "there": "adv", "here": "adv", "then": "adv", "now": "adv", "very": "adv",
             "too": "adv", "much": "adv", "more": "adv", "most": "adv", "all": "det", "any": "det",
             "some": "det", "no": "det", "one": "num", "since": "prep", "before": "prep", "after": "prep"}
CLOSED = ("article", "prep", "conj", "det", "pron")

def wordlike(g):
    """A gloss that is a word or a short list of words, not an explanation."""
    if re.match(r"(sinónimo|antónimo|usado|úsase|se usa|se emplea|empleado|indica)\b", g, re.I):
        return False
    return all(len(x.split()) <= 3 for x in re.split(r"[,;]", g)) and len(g) <= 60

def merge(w, en_entries, es_entries):
    """Lowercase headwords (german: full sibling) and capitalised ones (German: alemán) are built
    apart. The capitalised reading leads only when its first meaning is a much commoner Spanish
    word (alemán, Canadá, China); acronyms that only look like a word (IS) never stand in for it."""
    lower = build(w, [x for x in en_entries if not x[2]], [x for x in es_entries if not x[2]])
    caps = build(w, [x for x in en_entries if x[2]], [x for x in es_entries if x[2]])
    if not lower:   # is: a form of be, so the pointer answers, not the acronym IS
        return [] if w in FORM_WORDS else caps
    if caps and w not in FIRST and head_zipf(caps[0][2][0]) > head_zipf(lower[0][2][0]) + 1:
        return (caps + [p for p in lower if p[0] not in {c[0] for c in caps}])[:MAX_POS]
    return lower

def build(w, en_entries, es_entries):
    order, word_es, expl_es, gl = [], defaultdict(list), defaultdict(list), defaultdict(list)
    for pos, _, _ in en_entries:
        if pos not in order:
            order.append(pos)
    for pos, glosses, _ in es_entries:
        if pos not in order:
            order.append(pos)
        for g in glosses:
            (word_es if wordlike(g) else expl_es)[pos].append(g)
    for pos in order:
        seen = set()
        def add(g):
            nonlocal seen
            ws = words_of(g)
            if g in gl[pos] or ws and ws <= seen:
                return
            gl[pos].append(g[:MAX_GLOSS])
            seen |= ws
        if w in FIRST and FIRST[w][0] == pos:
            add(FIRST[w][1])
        en_gl = [g for p, items, _ in en_entries if p == pos for g in sense_glosses(items, pos)]
        # Candidates in source order: the first English sense, Spanish Wiktionary's short meanings,
        # the other English senses. Then the commonest Spanish word wins, less a little for each
        # place further down (team: equipo over "tiro, yunta"; end: fin over muerte; place: lugar).
        cands = en_gl[:1] + word_es[pos] + en_gl[1:]
        ranked = range(len(cands))
        if pos in CONTENT:   # pronouns and little words keep source order: their commonest Spanish
            ranked = sorted(ranked, key=lambda i: -(head_zipf(cands[i]) - 0.4 * i))   # match is "la", "se"
        for i in ranked:
            add(cands[i])
        for g in expl_es[pos]:                 # Spanish Wiktionary's longer explanations go last.
            add(g)
    if w in FIRST and FIRST[w][0] not in gl:
        order.insert(0, FIRST[w][0])
        gl[FIRST[w][0]].append(FIRST[w][1])
    lead = FIRST.get(w, (POS_FIRST.get(w),))[0]
    if len(w) == 1:   # i, a: the pronoun and the article lead, the letter's own noun entry goes last
        order.sort(key=lambda p: p not in ("pron", "article", "det"))
    elif lead:
        order.sort(key=lambda p: p != lead)
    elif any(p in CLOSED for p in order if gl[p]):
        order.sort(key=lambda p: p not in CLOSED)
    d = [[pos, "", gl[pos][:MAX_SENSES]] for pos in order if gl[pos]]
    return d[:MAX_POS]

def word_zipf(lang="en"):
    """Word frequency (wordfreq, data CC BY-SA 4.0) if installed, else a flat 0."""
    try:
        from wordfreq import zipf_frequency
    except ImportError:
        print("wordfreq not installed: form pointers keep page order", file=sys.stderr)
        return lambda w: 0.0
    cache = {}
    def z(w):
        if w not in cache:
            cache[w] = zipf_frequency(w, lang)
        return cache[w]
    return z

def main(en_src, es_src, es_dict_src, out):
    zipf = word_zipf()
    zipf_es = word_zipf("es")
    ZIPF["en"], ZIPF["es"] = zipf, zipf_es
    trans, forms, known = read_enwikt(en_src)
    FORM_WORDS.update(w for w, fl in forms.items() if any(l != "variante" for _, l in fl))
    es_defs = read_eswikt(es_src)
    words = {}
    for w in set(trans) | set(es_defs) | set(FIRST):
        d = merge(w, trans.get(w, []), es_defs.get(w, []))
        if d:
            words[w] = {"d": d}
    # English words with no Spanish meaning yet that aren't a form or a spelling of a word that has
    # one (grey -> gray, defence -> defense: the pointer beats a backwards guess).
    wanted = {w for w in known if w not in words and re.fullmatch(r"[a-z]{3,}", w)
              and set(known[w]) & {"noun", "verb", "adj", "adv"}
              and not any(lem in words for lem, _ in forms.get(w, []))
              and not uk_to_us(w, words)}
    rev = read_reverse(es_dict_src, wanted, zipf_es)
    n_rev = 0
    for w, cand in rev.items():
        d = reverse_d(w, cand, known.get(w, []))
        if d:
            words[w] = {"d": d, "r": 1}
            n_rev += 1
    contr = contractions(known)
    for w, c in contr.items():
        words[w] = {"d": [["contraction", "", [c]]]}
    for w, fl in forms.items():
        # Only pointers to words that have meanings; a spelling variant only when the word has none.
        keep = [f for f in fl if f[0] in words and (f[1] != "variante" or "d" not in words.get(w, {}))
                and not (f[1] == "plural" and len(f[0]) <= 2)]      # is: not "plural of i"; us: not of u
        # Commonest lemma first; drop lemmas far rarer than the best one (did -> do, not Scots "de"
        # or "doe"; has -> have, not "ha"; must keeps its own meanings, not "mote").
        keep.sort(key=lambda f: -zipf(f[0]))
        if keep:
            best = zipf(keep[0][0])
            keep = [f for f in keep if zipf(f[0]) >= best - 1.5]
            if "d" in words.get(w, {}):
                keep = [f for f in keep if zipf(f[0]) >= zipf(w) - 2]
        if keep:
            words.setdefault(w, {})["f"] = keep[:4]
            # "fl": the form reading should lead. saw -> see, felt -> feel, found -> find, doing -> do:
            # the form of a common verb, which is usually what a reader has met, not the tool, the
            # cloth, or the noun "hacimiento". (Plurals are left alone: news, glasses, years have
            # meanings of their own.)
            if "d" in words[w] and w not in FIRST and any(
                    zipf(lem) >= 5.0 and (l in ("pasado", "participio") or
                                          l == "gerundio (-ing)" and zipf(lem) > zipf(w))
                    for lem, l in keep):
                words[w]["fl"] = 1
    n_fallback = 0
    for w in list(known):
        if w in words:
            continue
        v = uk_to_us(w, words)
        b = None if v else ly_base(w, words)
        if v or b:
            words[w] = {"f": [[v, "variante"]] if v else [[b, "adverbio (-ly)"]]}
            n_fallback += 1
    print(f"{n_rev} words from Spanish entries read backwards, {n_fallback} spelling/-ly pointers, "
          f"{len(contr)} contractions")
    shards = defaultdict(dict)
    for w, r in words.items():
        shards[shard(w)][w] = r
    os.makedirs(out, exist_ok=True)
    keep = {"_index.json", "_meta.json", "top.json"}
    for f in os.listdir(out):            # shards from an older build that this one no longer makes
        if f.endswith(".json") and f not in keep and f[:-5] not in shards:
            os.remove(os.path.join(out, f))
    for k, d in shards.items():
        with open(os.path.join(out, k + ".json"), "w", encoding="utf-8") as fh:
            json.dump(dict(sorted(d.items())), fh, ensure_ascii=False, separators=(",", ":"))
    json.dump(sorted(shards), open(os.path.join(out, "_index.json"), "w"))
    nd = sum(1 for r in words.values() if "d" in r)
    print(f"{len(words)} words ({nd} with Spanish meanings, {len(words) - nd} forms only) in {len(shards)} shards")

if __name__ == "__main__":
    main(*sys.argv[1:5])
