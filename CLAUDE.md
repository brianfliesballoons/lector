# Lector — tap-a-word Spanish reader (read a book you know in English, tap any word for its meaning and sound)

> **Reading protocol:** the parent [CLAUDE.md](../CLAUDE.md) routes here. This file is authoritative inside this folder — read it before editing anything here.

## Active to-do

*Live state, not a log (workspace convention — root CLAUDE.md, "status report" protocol): add items as work opens them, **delete** them when done, update after every meaningful unit of work. **Numbered, in priority order** — Brian references items by number. A "status report" scoped to this project reads exactly this list.*

1. **v1 LIVE 2026-10-12 at [brianfliesballoons.github.io/lector](https://brianfliesballoons.github.io/lector/)** (repo `brianfliesballoons/lector`, public, Pages from `main`). Verified in headless Chrome against a real Gutenberg EPUB (*Don Quijote*, 139 chapters): parse, Gutenberg license stripped, tap → definitions, inflected forms → lemma, attached pronouns (*levantóse* → *levantó* + *se* → *levantar*), progress save, and 98.9% dictionary coverage on 9,705 running words (misses are names and 1605 spellings). ▶ **Brian opens it on his iPhone**: tap test, voice check (Settings › Accessibility › Spoken Content › Voices › Spanish if none), "Save the dictionary for offline" before a flight. Not yet tested on a real iPhone.
2. **Pick the Spanish *Animal Farm* edition to buy**: research in progress. It needs a DRM-free (or watermark-only) EPUB that loads into the app.
3. **Fill the public-domain starter shelf** (`books/`): research in progress.
4. Later, if wanted: flashcard review of saved words, and whole-sentence translation through the local model (`local-chat`).

## What this is

Brian wants to get from "getting by" to fluent in Spanish by reading books he has already read in English, tapping any word to see its English meaning and hear it spoken. The commercial apps that do this (LingQ, Readlang and similar) are subscriptions; this is a free one he owns. Done = he can open it on his iPhone, load the Spanish *Animal Farm* (*Rebelión en la granja*), read, tap words, hear them, and keep his place.

**Decisions so far (Brian, 2026-10-12):**
- Tap a **word** is enough — whole-sentence translation is not required for v1.
- Level: **getting by, aiming for fluency.**
- No subscription, no paid API.
- Lives here in CODING.

## Architecture

- **Single self-contained `index.html`, vanilla JS** (workspace CODING pattern), deployed on GitHub Pages like glow-show.
- **Dictionary:** built from English Wiktionary's Spanish entries (kaikki.org extract, CC BY-SA — attribution shown in the app). Inflected forms point to their lemma, so tapping *comieron* finds *comer*. Built by `tools/build_dict.py` into sharded JSON the page loads on demand, cached on the phone so it works offline.
- **Pronunciation:** the phone's built-in Spanish voice (`speechSynthesis`) — free, offline, can slow down.
- **Books:** public-domain texts are bundled in the repo. **Copyrighted books are never committed or hosted** — Brian loads his own purchased EPUB from his phone, and it stays in that phone's storage (IndexedDB). *Animal Farm* is under US copyright until Jan 1, 2041, and every Spanish translation is separately the translator's.
- Build scratch (raw dictionary download, ~95 MB) lives in `~/lector-build/`, never in iCloud.
- **Lookup order:** exact word → its form-of pointers (shown with the lemma's own definitions) → strip up to two attached pronouns (me/te/se/nos/os/le/les/lo/la/los/las), retrying with and without the written accent → "not found" with a SpanishDict link.
- **Testing:** the headless-Chrome POST-callback harness (recipe in `../Balloon weather widget/CLAUDE.md`, *Verifying without the Chrome extension*), with `dict/` symlinked into a scratch copy.

## The files

| File | Status | What it is |
|---|---|---|
| `CLAUDE.md` | primary copy | This file |
| `index.html` | primary copy | The whole app: library, EPUB parser (JSZip), reader, tap sheet, speech, saved words + CSV export, settings |
| `sw.js` | primary copy | Service worker: page network-first; dictionary, books and JSZip cache-first for offline reading |
| `jszip.min.js` | vendored | JSZip 3.10.1 (MIT), vendored so EPUBs open offline |
| `build_dict.py` | primary copy | Builds `dict/` from the kaikki.org Spanish extract |
| `dict/` 📘 | generated | 516 dictionary shards, about 770K words, ~7 MB gzipped |
| `books/` 📘 | primary copy | Bundled public-domain EPUBs + `manifest.json` |
| `.nojekyll` | required | Without it, Pages drops `dict/_index.json` (leading underscore) |

## Conventions specific to this project

- **Never commit or publish a copyrighted book text.** Bundled books must be verifiably public domain in the US (both the original and the Spanish translation).
- Tap targets are sized for a phone in one hand; the reader is a reading display first — plain, large serif type, nothing animated.

## Delegation notes

- Book and edition research goes to `make` (needs sourced claims, workspace rule 25); dictionary build and app code are done in the main loop.
