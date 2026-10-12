#!/usr/bin/env python3
"""Build Lector's sharded Spanish->English dictionary from the kaikki.org
Wiktionary extract (CC BY-SA 4.0).

usage: build_dict.py <kaikki-Spanish.jsonl.gz> <out_dir>

Output: <out_dir>/<shard>.json, one per two-letter prefix of the accent-folded
lowercase word. Each maps word -> {"d": [[pos, gender, [glosses]]...],
"f": [[lemma, label]...]}. "d" is a real definition, "f" points an inflected
form (comieron) at its lemma (comer) so the page can show both.
"""
import gzip, json, os, re, sys, unicodedata
from collections import defaultdict

MAX_POS, MAX_SENSES, MAX_GLOSS = 3, 4, 140
SKIP_TAGS = {"obsolete", "archaic", "rare", "dated"}
ABBR = [("first-person", "1st"), ("second-person", "2nd"), ("third-person", "3rd"),
        ("singular", "sing."), ("plural", "pl."), ("indicative", "ind."),
        ("subjunctive", "subj."), ("imperative", "imper."), ("preterite", "preterite"),
        ("imperfect", "imperfect"), ("conditional", "cond."), ("informal", "inf."),
        ("formal", "formal")]

def fold(w):
    w = unicodedata.normalize("NFD", w.lower())
    w = "".join(c for c in w if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z]", "", w)

def shard(w):
    f = fold(w)
    return (f[:2] if len(f) >= 2 else (f + "_")[:2]) or "__"

def gender(e):
    for t in e.get("head_templates", []):
        a = t.get("args", {})
        g = a.get("1", "")
        if t.get("name", "").startswith("es-noun") and g in ("m", "f", "mf", "m-p", "f-p", "mfbysense"):
            return {"mfbysense": "mf", "m-p": "m", "f-p": "f"}.get(g, g)
    return ""

def label(gloss, lemma):
    lab = re.sub(r"\s+of\s+" + re.escape(lemma) + r".*$", "", gloss).strip()
    for a, b in ABBR:
        lab = lab.replace(a, b)
    return lab[:80]

def main(src, out):
    words = defaultdict(lambda: {"d": [], "f": []})
    with gzip.open(src, "rt", encoding="utf-8") as fh:
        for line in fh:
            e = json.loads(line)
            if e.get("lang_code") != "es":
                continue
            w = e["word"].lower().strip()
            if not w or " " in w and len(w) > 40:
                continue
            pos = e.get("pos", "")
            defs, forms = [], []
            senses = e.get("senses", [])
            plain = [s for s in senses if not SKIP_TAGS & set(s.get("tags", []))] or senses
            for s in plain:
                gl = (s.get("glosses") or [""])[-1].strip()
                if not gl:
                    continue
                if s.get("form_of"):
                    lem = s["form_of"][0].get("word", "").strip()
                    if lem and lem.lower() != w:
                        forms.append([lem, label(gl, lem)])
                    continue
                prev = None
                while prev != gl:  # drop long asides, innermost first
                    prev, gl = gl, re.sub(r"\s*\([^()]{30,}\)", "", gl).strip()
                if gl and gl not in defs:
                    defs.append(gl[:MAX_GLOSS])
            rec = words[w]
            if defs and len(rec["d"]) < MAX_POS:
                rec["d"].append([pos, gender(e), defs[:MAX_SENSES]])
            for f in forms:
                if f not in rec["f"] and len(rec["f"]) < 4:
                    rec["f"].append(f)
    shards = defaultdict(dict)
    for w, r in words.items():
        r = {k: v for k, v in r.items() if v}
        if r:
            shards[shard(w)][w] = r
    os.makedirs(out, exist_ok=True)
    total = 0
    for k, d in shards.items():
        with open(os.path.join(out, k + ".json"), "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, separators=(",", ":"))
        total += len(d)
    json.dump(sorted(shards), open(os.path.join(out, "_index.json"), "w"))
    print(f"{total} words in {len(shards)} shards")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
