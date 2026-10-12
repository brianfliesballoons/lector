# Lector — tap-a-word Spanish reader (read a book you know in English, tap any word for its meaning and sound)

> **Reading protocol:** the parent [CLAUDE.md](../CLAUDE.md) routes here. This file is authoritative inside this folder — read it before editing anything here.

## Active to-do

*Live state, not a log (workspace convention — root CLAUDE.md, "status report" protocol): add items as work opens them, **delete** them when done, update after every meaningful unit of work. **Numbered, in priority order** — Brian references items by number. A "status report" scoped to this project reads exactly this list.*

1. **v1 LIVE 2026-10-12 at [brianfliesballoons.github.io/lector](https://brianfliesballoons.github.io/lector/)** (repo `brianfliesballoons/lector`, public, Pages from `main`). Verified in headless Chrome against a real Gutenberg EPUB (*Don Quijote*, 139 chapters): parse, Gutenberg license stripped, tap → definitions, inflected forms → lemma, attached pronouns (*levantóse* → *levantó* + *se* → *levantar*), progress save, and 98.9% dictionary coverage on 9,705 running words (misses are names and 1605 spellings). ▶ **Brian opens it on his iPhone**: tap test, voice check (Settings › Accessibility › Spoken Content › Voices › Spanish if none), "Save the dictionary for offline" before a flight. Not yet tested on a real iPhone.
2. **Animal Farm: BOUGHT 2026-10-12 (Rosetta Edu order #1123, to briancamplynch@gmail.com) and verified DRM-free**: no `encryption.xml`. Guillermo Tirelli translation, 2nd ed. Jan 2026, ISBN 978-1-915088-51-2. Parsed in headless Chrome: 10 chapters plus front and back matter, 30K words, 99.5% dictionary coverage (7,309/7,347). ▶ Brian adds it on his phone: open the email's download link in Safari, Download, save to Files, then **+ Add an EPUB** in Lector. ⚠ The email's link is a page with a Download button (`…/download`), not the file itself; Shopify may cap download counts, and one download was used to verify. The file is in `offline books/` (git-ignored). **Never commit the file.**
3. **Starter shelf: DONE 2026-10-12**, 10 books in `books/` (see `books/CLAUDE.md`). Each translation's date was checked against its own title page.
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
| `books/` 📘 | primary copy | 10 bundled public-domain EPUBs + `manifest.json` |
| `offline books/` 📘 | private | Brian's purchased DRM-free EPUBs. **Git-ignored**: in iCloud only, never pushed |
| `.nojekyll` | required | Without it, Pages drops `dict/_index.json` (leading underscore) |

## Conventions specific to this project

- **Never commit or publish a copyrighted book text.** Bundled books must be verifiably public domain in the US (both the original and the Spanish translation).
- Tap targets are sized for a phone in one hand; the reader is a reading display first. Motion is limited to the sheet sliding up and the header hiding while you read, and all of it is off under reduced-motion.
- **Look (restyled 2026-10-12, Brian: "style it up a bit"):** generated cloth-colour covers (hash of the title picks the palette, so a book keeps its colours), a "Seguir leyendo" card, chapter openers with ❦ and a drop cap, a slide-up word sheet with POS chips and an article chip (*el/la*). Reading settings: size slider 14–34, six typefaces (Literata default, Lora, EB Garamond, Georgia, New York, Atkinson Hyperlegible — Google Fonts, cached by `sw.js` for offline), line spacing, margins, ragged/justified (with Spanish hyphenation), themes Auto/Light/Sepia/Dark/Black.
- **Visual checks:** screenshots via the Chrome DevTools protocol at 390×844 @2x. `--screenshot` with `--virtual-time-budget` hangs here, and macOS has no `timeout` command. Check `scrollWidth === innerWidth`: a grid of `1fr` columns with `nowrap` text silently widened the page to 504 px (fixed with `minmax(0,1fr)`).

## Delegation notes

- Book and edition research goes to `make` (needs sourced claims, workspace rule 25); dictionary build and app code are done in the main loop.
