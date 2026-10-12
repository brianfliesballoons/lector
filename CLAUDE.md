# Lector — tap-a-word Spanish reader (read a book you know in English, tap any word for its meaning and sound)

> **Reading protocol:** the parent [CLAUDE.md](../CLAUDE.md) routes here. This file is authoritative inside this folder — read it before editing anything here.

## Active to-do

*Live state, not a log (workspace convention — root CLAUDE.md, "status report" protocol): add items as work opens them, **delete** them when done, update after every meaningful unit of work. **Numbered, in priority order** — Brian references items by number. A "status report" scoped to this project reads exactly this list.*

1. **Build v1** (opened 2026-10-12, Brian: *"let's make it happen"*). Reader + offline Spanish→English tap dictionary + phone speech + load-your-own EPUB + bundled public-domain books.
2. **Pick the Spanish *Animal Farm* edition to buy** — research in progress (needs a DRM-free EPUB, or one whose text can be loaded into the app).
3. **Pick the public-domain starter shelf** — Spanish texts of books Brian has likely already read in English; research in progress.

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

## The files

| File | Status | What it is |
|---|---|---|
| `CLAUDE.md` | primary copy | This file |

## Conventions specific to this project

- **Never commit or publish a copyrighted book text.** Bundled books must be verifiably public domain in the US (both the original and the Spanish translation).
- Tap targets are sized for a phone in one hand; the reader is a reading display first — plain, large serif type, nothing animated.

## Delegation notes

- Book and edition research goes to `make` (needs sourced claims, workspace rule 25); dictionary build and app code are done in the main loop.
