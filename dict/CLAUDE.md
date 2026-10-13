# dict/ — generated dictionary shards (do not hand-edit)

> **Reading protocol:** the parent [CLAUDE.md](../CLAUDE.md) is authoritative; this folder is build output.

## Active to-do

*Nothing open — regenerate, never edit.*

## What this is

516 JSON shards (by two-letter accent-folded prefix) plus `_index.json`, built by `../build_dict.py` from the kaikki.org extract of English Wiktionary's Spanish entries (CC BY-SA 4.0, credited in the app). Rebuild: `python3 build_dict.py ~/lector-build/es.jsonl.gz dict` (raw download lives in `~/lector-build/`, never in iCloud).

`fr/` holds the French dictionary in the same format: 537 shards from English Wiktionary's French entries. Rebuild: `python3 build_dict.py ~/lector-build/fr-src/fr.jsonl.gz dict/fr fr`. (`dict/fr.json` is a Spanish shard; `dict/fr/` is the French folder. They don't clash.)

## The files

| File | Status | What it is |
|---|---|---|
| `<prefix>.json` | generated | word → `{d: definitions, f: form-of pointers}` |
| `_index.json` | generated | list of shard names, used by "Save for offline" |
| `fr/` | generated | the French dictionary, same layout |

## Conventions specific to this project

- Never edit a shard by hand. Change `build_dict.py` and rebuild.

## Delegation notes

- None.
