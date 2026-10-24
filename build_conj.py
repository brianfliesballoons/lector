#!/usr/bin/env python3
"""Build Lector's Spanish verb conjugation tables (conj/) from the kaikki.org extract of
English Wiktionary (CC BY-SA 4.0), with every irregular part of every form marked.

usage: build_conj.py <kaikki es.jsonl.gz> <out_dir> [--vosotros] [--books <dir>] [--dict <dir>]

  --vosotros   also store the vosotros forms (off by default: Lector teaches Mexican Spanish,
               where ustedes does the job; RAE, Diccionario panhispánico de dudas, "vosotros").
  --books DIR  rank top.json by token counts in the EPUBs in DIR instead of wordfreq.
  --dict DIR   the Spanish dict/ shards to read (default: ./dict). iCloud may hold them as
               placeholders that fail to read; a fresh `build_dict.py` copy in ~/lector-build works.

Output (see conj/CLAUDE.md for the full shape):
  <out>/<shard>.json  lemma -> table, sharded by the same two-letter accent-folded prefix as dict/
  <out>/_index.json   shard names (for "Save for offline")
  <out>/_meta.json    tense keys, person order, mark categories
  <out>/top.json      the ~300 most useful verbs, most frequent first, with their tables

How a form is marked: the builder makes the textbook regular form from the infinitive's class
(-ar / -er / -ir) and compares. A form that matches is regular. One that matches once the
predictable spelling rules are applied (c>qu, g>gu, z>c, gu>gü before e; g>j, c>z, gu>g, qu>c
before a/o; unstressed i>y between vowels; i dropped after ll/ñ; a written accent to keep a
vowel apart: leíste, envío, reúno) is "spell". One that matches after a stem-vowel change
(e>ie, o>ue, e>i, o>u, u>ue, i>ie, e>ye, o>hue, e>í), with or without a spelling rule on top,
is "stem". Anything else is "irr". The stored span is the part of the real form that differs
from the plain regular form (stem + ending, no rules), so the app can colour just that part.
"""
import gzip, json, os, re, sys, unicodedata, zipfile
from collections import defaultdict, Counter

# ---------------------------------------------------------------- shared with build_dict.py
def fold(w):
    w = unicodedata.normalize("NFD", w.lower())
    w = "".join(c for c in w if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z]", "", w)

def shard(w):
    f = fold(w)
    return (f[:2] if len(f) >= 2 else (f + "_")[:2]) or "__"

def nfc(s):
    return unicodedata.normalize("NFC", s)

# ---------------------------------------------------------------- regular endings
# Internal person order is always the full six: yo, tú, él, nosotros, vosotros, ellos.
END = {
    "ar": {"pres": "o as a amos áis an", "pret": "é aste ó amos asteis aron",
           "impf": "aba abas aba ábamos abais aban", "sub": "e es e emos éis en",
           "subi": "ara aras ara áramos arais aran", "ger": "ando", "pp": "ado"},
    "er": {"pres": "o es e emos éis en", "pret": "í iste ió imos isteis ieron",
           "impf": "ía ías ía íamos íais ían", "sub": "a as a amos áis an",
           "subi": "iera ieras iera iéramos ierais ieran", "ger": "iendo", "pp": "ido"},
}
END["ir"] = dict(END["er"], pres="o es e imos ís en")
FUT, COND = "é ás á emos éis án".split(), "ía ías ía íamos íais ían".split()
TENSES = ["pres", "pret", "impf", "fut", "cond", "sub", "subi"]
VOS = 4                       # index of vosotros in the six-person order
IMP = ["imp", "neg"]          # affirmative / negative imperative: tú, usted, vosotros, ustedes

VOWELS, STRONG = set("aeiouáéíóúü"), set("aeoáéóíú")
ACUTE = {"a": "á", "e": "é", "i": "í", "o": "ó", "u": "ú"}
PLAIN = {v: k for k, v in ACUTE.items()}

def syllables(w):
    n, prev = 0, None
    for i, c in enumerate(w):
        if c in "uü" and i and w[i - 1] in "qg" and c == "u" and i + 1 < len(w) and w[i + 1] in "eiéí":
            prev = None          # silent u in que/qui/gue/gui
            continue
        if c in VOWELS:
            if prev is None or (prev in STRONG and c in STRONG):
                n += 1
            prev = c
        else:
            prev = None
    return n

def mono(w):
    """Monosyllables carry no stress accent (dio, vio, fui, fue): standard since 2010."""
    if syllables(w) == 1 and w not in ("dé", "sé", "más", "té"):
        return "".join(PLAIN.get(c, c) for c in w)
    return w

def plain_join(stem, end):
    return mono(stem + end)

def ortho(stem, end, cls):
    """Join stem + ending, applying only the predictable spelling rules."""
    e0 = PLAIN.get(end[:1], end[:1])
    if e0 == "e" and cls == "ar":
        if stem.endswith("gu"):
            stem = stem[:-2] + "gü"
        elif stem.endswith("c"):
            stem = stem[:-1] + "qu"
        elif stem.endswith("g"):
            stem = stem[:-1] + "gu"
        elif stem.endswith("z"):
            stem = stem[:-1] + "c"
    elif e0 in "ao" and cls in ("er", "ir") and e0:
        if stem.endswith("gu"):
            stem = stem[:-2] + "g"
        elif stem.endswith("qu"):
            stem = stem[:-2] + "c"
        elif stem.endswith("g"):
            stem = stem[:-1] + "j"
        elif stem.endswith("c"):
            stem = stem[:-1] + "z"
    if cls in ("er", "ir") and end.startswith("i"):
        silent_u = stem.endswith(("gu", "qu"))
        if stem.endswith(("ll", "ñ")) and len(end) > 1 and end[1] in VOWELS:
            end = end[1:]                                     # bulló, tañendo
        elif stem and stem[-1] in VOWELS and not silent_u and len(end) > 1 and end[1] in VOWELS:
            end = "y" + end[1:]                               # leyó, oyendo, construyó
        elif stem and stem[-1] in "aeoáéó" and (len(end) == 1 or end[1] not in VOWELS):
            end = "í" + end[1:]                               # leíste, oímos, leído
    return mono(stem + end)

def stem_variants(stem, cls):
    """Every single stem-vowel change Spanish uses, on the stem's last sounded vowel."""
    idx = None
    for i in range(len(stem) - 1, -1, -1):
        c = stem[i]
        if c not in "aeiou":
            continue
        if c == "u" and i and stem[i - 1] in "qg" and (i == len(stem) - 1 or stem[i + 1] in "ei"):
            continue                                          # silent u (seguir, requerir)
        idx = i
        break
    if idx is None:
        return []
    v, pre, post = stem[idx], stem[:idx], stem[idx + 1:]
    subs = {"e": [("ie", "e>ie"), ("i", "e>i"), ("í", "e>í")] + ([("ye", "e>ye")] if idx == 0 else []),
            "o": [("ue", "o>ue"), ("u", "o>u")] + ([("hue", "o>hue")] if idx == 0 else []),
            "u": [("ue", "u>ue"), ("ú", "u>ú")],
            "i": [("ie", "i>ie"), ("í", "i>í")],
            "a": []}[v]
    out = []
    for new, name in subs:
        s2 = pre + new + post
        if new == "ue" and pre.endswith("g"):
            s2 = pre + "üe" + post                            # agorar -> agüero
        out.append((s2, name, (len(pre), len(s2) - len(post))))
    return out

ACCENT_ONLY = {"i>í", "u>ú"}   # envío, reúno, aíslo: a written accent, so "spell"

def span(real, plain):
    """Return (start, end) of the part of `real` that differs from `plain`."""
    p = 0
    while p < min(len(real), len(plain)) and real[p] == plain[p]:
        p += 1
    s = 0
    while s < min(len(real), len(plain)) - p and real[-1 - s] == plain[-1 - s]:
        s += 1
    return p, len(real) - s

def classify(real, stem, end, cls, plain):
    """-> None (regular) or [category, start, end], plus the stem change found (or None)."""
    if real == plain:
        return None, None
    a, b = span(real, plain)
    if real == ortho(stem, end, cls):
        cat, change = "spell", None
    else:
        cat, change = "irr", None
        for s2, name, where in stem_variants(stem, cls):
            if real == ortho(s2, end, cls) or real == plain_join(s2, end):
                cat, change = ("spell" if name in ACCENT_ONLY else "stem"), name
                if cat == "stem" and real.startswith(s2[: where[1]]):
                    a, b = where          # colour the whole new vowel: t[ie]nes, j[ue]go, p[ue]do
                break
    if a >= b:   # a letter was dropped. Spelling (bulló): colour the letter before the gap.
        # Irregular: colour the shortened stem up to the next letter ([podr]é, [har]é, [ten], [di]).
        a, b = (max(0, a - 1), a) if cat == "spell" else (0, min(len(real), a + 1))
    return [cat, a, b], change

# ---------------------------------------------------------------- reading kaikki
PERSON = {("first-person", "singular"): 0, ("second-person", "singular"): 1,
          ("third-person", "singular"): 2, ("first-person", "plural"): 3,
          ("second-person", "plural"): 4, ("third-person", "plural"): 5}
PRON = ("me ", "te ", "se ", "nos ", "os ")
CLITIC = re.compile(r"(nos|os|te|se|me)$")
OLD = {"obsolete", "archaic", "rare", "dated"}
SKIP = {"vos-form", "combined-form", "imperfect-se", "archaic", "obsolete", "dated"}

def deaccent_enclitic(w):
    """arrepiéntete -> arrepiente, arrepintiéndose -> arrepintiendo (the accent came with the clitic;
    an accent that splits two vowels, as in reúne, stays)."""
    out = list(w)
    for i, c in enumerate(w):
        if c in PLAIN:
            if c in "íú" and ((i and w[i - 1] in VOWELS) or (i + 1 < len(w) and w[i + 1] in VOWELS)):
                continue
            out[i] = PLAIN[c]
    return "".join(out)

def bare(form, kind, pronominal):
    if not pronominal:
        return form
    if kind in ("fin", "neg"):
        for p in PRON:
            if form.startswith(p):
                return form[len(p):]
        return form
    if kind in ("imp", "ger"):
        m = CLITIC.search(form)
        if m and len(form) > len(m.group(0)) + 1:
            return deaccent_enclitic(form[: m.start()])
    return form

def cell_of(tags):
    t = set(tags)
    if t & SKIP or "participle" in t and "masculine" not in t:
        return None
    if t == {"infinitive"}:
        return ("inf", 0)
    if t == {"gerund"}:
        return ("ger", 0)
    if {"participle", "past", "masculine", "singular"} <= t:
        return ("pp", 0)
    if "imperative" in t:
        key = "neg" if "negative" in t else "imp"
        if "first-person" in t:
            return None
        if "second-person-semantically" in t:
            return (key, 1 if "singular" in t else 3)
        if "second-person" in t and "third-person" not in t:
            return (key, 0 if "singular" in t else 2)
        return None
    num = "singular" if "singular" in t else "plural" if "plural" in t else None
    per = next((p for p in ("first-person", "second-person", "third-person") if p in t), None)
    if not num or not per:
        return None
    i = PERSON[(per, num)]
    if "conditional" in t:
        return ("cond", i)
    if "subjunctive" in t:
        if "present" in t:
            return ("sub", i)
        if "imperfect" in t:
            return ("subi", i)
        return None
    if "indicative" in t:
        for k, tag in (("pres", "present"), ("pret", "preterite"), ("impf", "imperfect"), ("fut", "future")):
            if tag in t:
                return (k, i)
    return None

def read_tables(src):
    tables = defaultdict(list)
    with gzip.open(src, "rt", encoding="utf-8") as fh:
        for line in fh:
            if '"es-conj"' not in line:
                continue
            e = json.loads(line)
            if e.get("lang_code") != "es" or e.get("pos") != "verb":
                continue
            w = nfc(e["word"])
            if not re.fullmatch(r"[a-záéíóúüñ]*(ar|er|ir|ír)(se)?", w):
                continue
            fs = [f for f in e.get("forms", []) if f.get("source") == "conjugation"]
            if fs:
                senses = e.get("senses", [])
                old = bool(senses) and all(OLD & set(s.get("tags", [])) for s in senses)
                tables[w].append((fs, old))
    return tables

def raw_cells(fs, pronominal, lemma):
    """One entry can hold two tables (caer, then caerse). A plain verb keeps only its own table."""
    cells = defaultdict(list)
    other_table = False
    for f in fs:
        form = nfc(f.get("form", "").strip())
        if f.get("tags") == ["infinitive"]:
            other_table = form != lemma
        if other_table or not form or form == "-":
            continue
        c = cell_of(f.get("tags", []))
        if not c:
            continue
        kind = {"imp": "imp", "neg": "neg", "ger": "ger"}.get(c[0], "fin" if c[0] in TENSES else "x")
        if pronominal and c == ("imp", 2) and form.endswith("os"):
            b = deaccent_enclitic(form[:-2]) + "d"           # arrepentíos -> arrepentid, idos -> id
        else:
            b = bare(form, kind, pronominal)
        if " " in b:
            continue
        if b not in cells[c]:
            cells[c].append(b)
    return cells

# ---------------------------------------------------------------- one verb
def build_verb(lemma, entries, keep_vos):
    pronominal = lemma.endswith("se") and lemma[:-2].endswith(("ar", "er", "ir", "ír"))
    inf = lemma[:-2] if pronominal else lemma
    cls = fold(inf)[-2:]
    if cls not in END:
        return None
    stem, fstem = inf[:-2], inf[:-2] + cls
    E = {k: (v.split() if " " in v else v) for k, v in END[cls].items()}
    E["fut"], E["cond"] = FUT, COND

    old = all(o for _, o in entries)
    entries = [fs for fs, _ in entries]
    cells = raw_cells(entries[0], pronominal, lemma)
    if not pronominal and not any(cells.get((t, i)) for t in TENSES for i in range(6)):
        # Wiktionary filed the verb under its plain form but only gave the pronominal table
        # (acuclillar -> acuclillarse): use that one and mark the verb pronominal.
        cells = raw_cells(entries[0], True, lemma + "se")
        pronominal = bool(cells)
    for extra in entries[1:]:                    # homographs: other readings become alternatives
        for c, forms in raw_cells(extra, pronominal, lemma).items():
            for f in forms:
                if f not in cells[c]:
                    cells[c].append(f)
    need = [(t, i) for t in TENSES for i in range(6) if i != VOS]
    if sum(1 for c in need if cells.get(c)) < 7:   # defective verbs (atañer, concernir: third person
        return None                                 # only) are kept, with null in the missing cells

    def regular(t, i):
        if t in ("fut", "cond"):
            return fstem, E[t][i]
        if t == "imp":
            return {0: (stem, E["pres"][2]), 1: (stem, E["sub"][2]), 2: (inf[:-1], "d"), 3: (stem, E["sub"][5])}[i]
        if t == "neg":
            return {0: (stem, E["sub"][1]), 1: (stem, E["sub"][2]), 2: (stem, E["sub"][4]), 3: (stem, E["sub"][5])}[i]
        if t in ("ger", "pp"):
            return stem, E[t]
        return stem, E[t][i]

    rec, marks, alts, changes, worst = {}, {}, {}, set(), 0
    rank = {"spell": 1, "stem": 2, "irr": 3}
    rec["inf"] = inf
    for key in ("ger", "pp"):
        forms = cells.get((key, 0), [])
        if not forms:
            rec[key] = None
            continue
        rec[key] = forms[0]
        if len(forms) > 1:
            alts[key] = forms[1:]
        s, e = regular(key, 0)
        m, ch = classify(forms[0], s, e, cls, plain_join(s, e))
        if m:
            marks[key] = m
            worst = max(worst, rank[m[0]])
            if ch:
                changes.add(ch)
    persons = list(range(6)) if keep_vos else [0, 1, 2, 3, 5]
    imp_persons = [0, 1, 2, 3] if keep_vos else [0, 1, 3]
    for t in TENSES + IMP:
        idxs = imp_persons if t in IMP else persons
        row, mrow = [], []
        for i in idxs:
            forms = cells.get((t, i), [])
            if not forms:
                row.append(None); mrow.append(0)
                continue
            row.append(forms[0])
            if len(forms) > 1:
                alts[f"{t}.{len(row) - 1}"] = forms[1:]
            s, e = regular(t, i)
            m, ch = classify(forms[0], s, e, cls, plain_join(s, e))
            mrow.append(m or 0)
            if m:
                worst = max(worst, rank[m[0]])
                if ch:
                    changes.add(ch)
        rec[t] = row
        if any(mrow):
            marks[t] = mrow
    rec["k"] = ["reg", "spell", "stem", "irr"][worst]
    if changes:
        rec["st"] = sorted(changes)
    if pronominal:
        rec["se"] = 1
    if old:
        rec["old"] = 1
    if marks:
        rec["x"] = marks
    if alts:
        rec["alt"] = alts
    return rec

# ---------------------------------------------------------------- frequency (top.json)
def epub_text(path):
    out = []
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith((".xhtml", ".html", ".htm")):
                t = z.read(n).decode("utf-8", "ignore")
                out.append(re.sub(r"<[^>]+>", " ", t))
    return " ".join(out)

def form_counts_books(book_dir):
    c = Counter()
    for f in sorted(os.listdir(book_dir)):
        if f.endswith(".epub"):
            for w in re.findall(r"[a-záéíóúüñ]+", epub_text(os.path.join(book_dir, f)).lower()):
                c[w] += 1
    return c

def form_counts_wordfreq():
    from wordfreq import top_n_list, word_frequency
    return {w: word_frequency(w, "es") for w in top_n_list("es", 200000)}

def build_top(verbs, counts, dict_dir, n=300):
    """Each form's frequency is shared among the verbs it belongs to. A form that is also a non-verb
    word in Lector's dictionary, or points at a non-verb lemma there (como, para, una, cosas, mesa,
    parte), is not counted at all, so
    comer, parar, unir and coser don't ride on the preposition or the noun. Verbs whose every sense
    is obsolete, archaic, rare or dated (her, seer) and pronominal duplicates are left out."""
    owners = defaultdict(set)
    for lemma, r in verbs.items():
        if r.get("se") or r.get("old"):
            continue
        for key in ("inf", "ger", "pp"):
            if r.get(key):
                owners[r[key]].add(lemma)
        for t in TENSES + IMP:
            for f in r[t]:
                if f:
                    owners[f].add(lemma)
    shards = {}
    def nonverb(w):
        k = shard(w)
        if k not in shards:
            p = os.path.join(dict_dir, k + ".json")
            shards[k] = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}
        e = shards[k].get(w, {})
        return (any(pos != "verb" for pos, _, _ in e.get("d", []))
                or any(lem not in verbs for lem, _ in e.get("f", [])))
    usable = {f: (counts[f], lemmas) for f, lemmas in owners.items() if counts.get(f) and not nonverb(f)}
    # A form shared by two verbs (siento: sentir/sentar; suele: soler/solar; haciendo: hacer/hacendar)
    # is split in proportion to what each verb scores on the forms that belong to it alone.
    prior = Counter()
    for cnt, lemmas in usable.values():
        if len(lemmas) == 1:
            prior[next(iter(lemmas))] += cnt
    score = Counter()
    for cnt, lemmas in usable.values():
        tot = sum(prior[l] + 1e-12 for l in lemmas)
        for l in lemmas:
            score[l] += cnt * (prior[l] + 1e-12) / tot
    return [l for l, _ in score.most_common(n)]

# ---------------------------------------------------------------- main
def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    keep_vos = "--vosotros" in argv
    books = argv[argv.index("--books") + 1] if "--books" in argv else None
    dict_dir = argv[argv.index("--dict") + 1] if "--dict" in argv else None
    for a in (books, dict_dir):
        if a:
            args.remove(a)
    src, out = args[0], args[1]
    here = os.path.dirname(os.path.abspath(__file__))
    tables = read_tables(src)
    verbs = {}
    for lemma, entries in tables.items():
        r = build_verb(lemma, entries, keep_vos)
        if r:
            verbs[lemma] = r
    shards = defaultdict(dict)
    for w, r in verbs.items():
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
    meta = {
        "tenses": {"pres": "indicative present", "pret": "preterite", "impf": "imperfect",
                   "fut": "future", "cond": "conditional", "sub": "present subjunctive",
                   "subi": "imperfect subjunctive (-ra)", "imp": "affirmative imperative",
                   "neg": "negative imperative (shown after 'no')"},
        "persons": (["yo", "tú", "él/ella/usted", "nosotros", "vosotros", "ellos/ellas/ustedes"] if keep_vos
                    else ["yo", "tú", "él/ella/usted", "nosotros", "ellos/ellas/ustedes"]),
        "imperative": (["tú", "usted", "vosotros", "ustedes"] if keep_vos else ["tú", "usted", "ustedes"]),
        "marks": {"spell": "predictable spelling change", "stem": "stem vowel change",
                  "irr": "irregular"},
        "vosotros": keep_vos,
        "source": "English Wiktionary via kaikki.org (CC BY-SA 4.0)",
    }
    json.dump(meta, open(os.path.join(out, "_meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    counts = form_counts_books(books) if books else form_counts_wordfreq()
    top = build_top(verbs, counts, dict_dir or os.path.join(here, "dict"))
    if books:
        source = "token counts in the EPUBs in " + os.path.basename(os.path.normpath(books))
    else:
        from importlib.metadata import version
        source = f"wordfreq {version('wordfreq')} Spanish word frequencies (data CC BY-SA 4.0)"
    # The top verbs' own tables ride along, so the app's charts, "Irregulars at a glance" and the
    # conjugation drill need this one file (about 70 KB gzipped) instead of dozens of shards.
    json.dump({"source": source,
               "verbs": top,
               "tables": {w: verbs[w] for w in top}}, open(os.path.join(out, "top.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    kinds = Counter(r["k"] for r in verbs.values())
    print(f"{len(verbs)} verbs in {len(shards)} shards; {dict(kinds)}; top {len(top)}")

if __name__ == "__main__":
    main(sys.argv[1:])
