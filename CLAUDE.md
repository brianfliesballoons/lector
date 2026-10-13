# Lector — tap-a-word Spanish and French reader (read a book you know in English, tap any word for its meaning and sound)

> **Reading protocol:** the parent [CLAUDE.md](../CLAUDE.md) routes here. This file is authoritative inside this folder — read it before editing anything here.

## Active to-do

*Live state, not a log (workspace convention — root CLAUDE.md, "status report" protocol): add items as work opens them, **delete** them when done, update after every meaningful unit of work. **Numbered, in priority order** — Brian references items by number. A "status report" scoped to this project reads exactly this list.*

1. **French + Android: BUILT 2026-10-12, committed locally, NOT pushed** (Brian: *"let's do the one time French fine-tuning"*, for a friend who asked for a French version and uses Android). Settings › Learning switches Spanish / French; a French dictionary, French tuning, 6 French starter books and a 3,863-book French catalogue; installable on Android. Checks: Spanish 66/66 + 36/36 (the 36-check copy counts the 10 Spanish books, since the shelf is now 16), Spanish 66/66 again with an Android Chrome user agent at 412×915, French 46/46 (iPhone) and 47/47 (Android). See *French (2026-10-12)* below. ▶ The main loop reviews and pushes. ▶ The friend tries it on a real Android phone; nobody has yet.
2. **Redesign + Find a free book: SHIPPED 2026-10-12** (Brian: *"Let's incorporate all of it!"*). It's the first project through design-first (root convention 26): research, then the [design board](https://claude.ai/artifact/KGBVDy2sdNYogT1f9b4E9D), then the build. Built by a `make` agent and reviewed against the board screenshots. 66/66 headless checks passed, including a REAL Gutenberg download through the relay. The app's labels are English and speak-on-tap defaults to on (recommendations Brian didn't overrule). ▶ Brian tries it on his iPhone; also run his *Animal Farm* through the new start-of-story rule. **Rough-edge fixes SHIPPED the same day:**
   - A word's own entry leads (*partida* → noun, no false "from partir").
   - Phrases light up: 21,570 multi-word entries, with only meaning-stable types shown (*pompas fúnebres* → funeral).
   - Verbs read as English (*estaba* → "was · from estar, to be").
   - The parser reads each book's own table of contents, so there are no junk chapters (*selva* 99 → 34 chapters).
   - The manifest finds story starts by their opening words.
   - *Animal Farm* opens at CAPÍTULO I (tested locally, never uploaded).

   Still loose:
   - a few adverb phrases ("a cada paso" → "all day long")
   - subjunctives all read "might…"
   - *Animal Farm* footer says "of 12" (back matter counted)
   - books already downloaded or imported keep their old chapter split until added again
   - not yet tried on a real iPhone
3. **v1 LIVE 2026-10-12 at [brianfliesballoons.github.io/lector](https://brianfliesballoons.github.io/lector/)** (repo `brianfliesballoons/lector`, public, Pages from `main`). Verified in headless Chrome against a real Gutenberg EPUB (*Don Quijote*, 139 chapters): parse, Gutenberg license stripped, tap → definitions, inflected forms → lemma, attached pronouns (*levantóse* → *levantó* + *se* → *levantar*), progress save, and 98.9% dictionary coverage on 9,705 running words (misses are names and 1605 spellings). ▶ **Brian opens it on his iPhone**: tap test, voice check (Settings › Accessibility › Spoken Content › Voices › Spanish if none), "Save the dictionary for offline" before a flight. ✅ Brian is using it on his phone (2026-10-12: *"literally exactly what I wanted"*).
4. **Animal Farm: BOUGHT 2026-10-12 (Rosetta Edu order #1123, to briancamplynch@gmail.com) and verified DRM-free**: no `encryption.xml`. Guillermo Tirelli translation, 2nd ed. Jan 2026, ISBN 978-1-915088-51-2. Parsed in headless Chrome: 10 chapters plus front and back matter, 30K words, 99.5% dictionary coverage (7,309/7,347). ▶ Brian adds it on his phone: open the email's download link in Safari, Download, save to Files, then **+ Add an EPUB** in Lector. ⚠ The email's link is a page with a Download button (`…/download`), not the file itself; Shopify may cap download counts, and one download was used to verify. The file is in `offline books/` (git-ignored). **Never commit the file.**
5. **Starter shelf: DONE 2026-10-12**, 10 books in `books/` (see `books/CLAUDE.md`). Each translation's date was checked against its own title page.
6. **English under every sentence (opened 2026-10-12, Brian: "pre-translating the entire thing and having a live copy is ideal").** The word card now shows the sentence's English under the Spanish.
   - **Pre-translated (works offline, Mac off):** `translate_book.py <epub>` runs the app's own parser and `splitSentences()` in headless Chrome, translates paragraph by paragraph on the local `qwen3.8:27b-mlx` (~30 tok/s), and writes `lector/translations.json` **inside the EPUB**. Brian re-adds the file, and the app replaces the same title in place, keeping his place. Quality check on chapter I came out almost word for word Orwell's own English. **✅ *Rebelión en la granja* DONE 2026-10-12: 1,653 of 1,654 unique sentences** are embedded and verified in the app. The one miss (*"—Ahora, camaradas —gritó Bola de Nieve…"*) fails the JSON reply three runs running, so the live fallback covers it. ▶ Brian re-adds the book from `offline books/`. Cache: `~/lector-build/cache/`. Log: `~/lector-build/translate-*.log`. Pre-run backup: `~/lector-build/granja-original-backup.epub`.
   - **Live fallback (Mac on):** `POST /lector/translate` on local-chat (model pinned, one at a time, CORS only for `brianfliesballoons.github.io`). It works on the Mac, but **the phone can't reach it yet**: the app is HTTPS, so it needs `https://…ts.net/lector`, and Tailscale says *"your Tailscale account does not support getting TLS certs"*. ▶ **Brian, one click:** Tailscale admin → DNS → **Enable HTTPS**. Then run `tailscale serve --bg --https=443 --set-path=/lector http://127.0.0.1:8765/lector`. Note: enabling HTTPS puts the machine's tailnet name in public certificate-transparency logs.
   - ▶ Next: translate the 10 free classics the same way (Quijote is ~380K words, so many hours; do the short ones first).
7. **Movie subtitles — PARKED 2026-10-12, Brian away from the laptop ~10 days (back ~10-22). Circle back when he asks about "the movie subtitle translation project".** Seen in a TikTok ad (likely Lingopie): pause a show, tap a subtitle word, get a pop-up. Two routes discussed:
   - **Netflix/YouTube:** the free Chrome extension **Language Reactor** does this on the Mac (dual subtitles, click a word). Brian: *"seems pretty cool"*. Nothing can overlay the Netflix app on iPhone or TV.
   - **Our own, still open (Brian: *"still wondering if we should set something up with the Jellyfin"*):** a movie mode in Lector that plays films from Jellyfin ([home-media-server](../home-media-server/CLAUDE.md)) with the Spanish subtitle line tappable, the same word card, and English under each line, pre-translated by `translate_book.py`'s pipeline (~1,000–1,500 lines a film, ~20 min). Spanish subs come from the disc's own track when ripping, or OpenSubtitles. Limit: needs the Mac on, so it won't work on a plane until the Mac Studio is the always-on box.
   - ▶ On return: Brian decides yes/no on Jellyfin movie mode and picks a first film he owns that has a Spanish track.
8. Later, if wanted: flashcard review of saved words.

## What this is

Brian wants to get from "getting by" to fluent in Spanish by reading books he has already read in English, tapping any word to see its English meaning and hear it spoken. The commercial apps that do this (LingQ, Readlang and similar) are subscriptions; this is a free one he owns. Done = he can open it on his iPhone, load the Spanish *Animal Farm* (*Rebelión en la granja*), read, tap words, hear them, and keep his place.

**Decisions so far (Brian, 2026-10-12):**
- Tap a **word** is enough — whole-sentence translation is not required for v1.
- Level: **getting by, aiming for fluency.**
- No subscription, no paid API.
- Lives here in CODING.

## Redesign research (2026-10-12, `make` agent, reviewed against its screenshots)

Why Alito found it confusing, measured in the running app, worst first:

1. **Every free book (10/10) opens on front matter**, not the story. *Cántico* opens on "COLECCIONDE LOSMEJORES…" and a page-number list; the story is chapter 3 of 8.
2. **Nothing says "tap a word."** The only hint is inside the empty saved-words sheet.
3. **Every free-book tap ends on "No English for this sentence yet"** (none of the bundled books carry translations), and the card repeats the whole Spanish sentence.
4. **The meaning is buried.** *cuarta* lists "horse whip" before "fourth". 1% of words get only grammar jargon ("masculine pl. of venerado").
5. **Controls hide on scroll and tapping the page doesn't bring them back.**
6. **Icons:** unlabeled (☆ = my words, Aa = settings), 38 pt instead of Apple's 44 pt, and labels mixing Spanish and English.
7. **Settings has 28 controls in one sheet**, and its close button scrolls away.
8. **"Add an EPUB" is unexplained.**

Bug: the Auto theme swatch renders empty when selected (`.themes button.sel{background:inherit!important}`).

**Board plan:** 7 screens (Library · Reader · Word card · Contents · Look · Words · Settings) plus an "Add your own book" help sheet, with three labeled tabs (Library · Words · Settings).

**Key decisions:**
- Open every book at the story.
- Teach the tap once, in context, with a live sentence on first run and no tutorial carousel.
- Keep the single tap; long-press is where other apps lose people.
- The word card is half height and answer first: one best meaning, large, then plain-English grammar. It never ends on an error.
- Tapping the page brings the controls back.
- Labels on every icon.
- Saving is explicit and clearly marked.
- Settings cut to Size / Theme / Font, with "More" for the rest.

Sources: Apple's guidelines (Buttons 44 pt, Onboarding "teach through interactivity", Sheets medium detent, Tab bars "include tab labels"), NN/g (tutorials, icon labels, bottom sheets) and reviews of Beelinguapp, Kindle, LingQ and Readlang. The full report with links was in that session's scratchpad.

**Open for Brian:** app controls in English, or in Spanish for immersion? Speak on tap: on or off by default?

## Architecture

- **Single self-contained `index.html`, vanilla JS** (workspace CODING pattern), deployed on GitHub Pages like glow-show.
- **Dictionary:** built from English Wiktionary's Spanish entries (kaikki.org extract, CC BY-SA — attribution shown in the app). Inflected forms point to their lemma, so tapping *comieron* finds *comer*. Built by `tools/build_dict.py` into sharded JSON the page loads on demand, cached on the phone so it works offline.
- **Pronunciation:** the phone's built-in voice for the book's language (`speechSynthesis`) — free, offline, can slow down. Android reports voices as `fr_FR`, iPhone as `fr-FR`; both are matched.
- **Languages:** `PACK.es` / `PACK.fr` in `index.html` hold everything that differs (dictionary folder, little words, verb rules, voice, catalogue, Start-here sentence). `settings.lang` is the language being learned; every book stores its own `lang` (books saved before French are Spanish), and a word is always looked up in its book's language.
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
| `translate_book.py` | primary copy | Pre-translates a book on the Mac and embeds the result in the EPUB (see to-do 4) |
| `build_dict.py` | primary copy | Builds `dict/` (Spanish) or `dict/fr/` (French, third argument `fr`) from a kaikki.org extract. Rebuilding Spanish with it gives byte-identical shards (checked 2026-10-12). |
| `dict/` 📘 | generated | 516 Spanish dictionary shards, about 770K words, ~7 MB gzipped |
| `dict/fr/` 📘 | generated | 537 French shards, 386,536 words, ~4 MB gzipped, from `~/lector-build/fr-src/fr.jsonl.gz` (kaikki.org, 2026-10-03 extract). Fetched only when a French word is looked up. |
| `books/` 📘 | primary copy | 10 bundled public-domain EPUBs + `manifest.json` |
| `offline books/` 📘 | private | Brian's purchased DRM-free EPUBs. **Git-ignored**: in iCloud only, never pushed |
| `books/catalog-fr.json` | generated | 3,863 French Gutenberg books `{id,t,a,dl,en?}`, sorted by downloads; `en` is the English title readers know (109 books: *Les Misérables*, *The Count of Monte Cristo*…). Built by `~/lector-build/catalog-fr/build_catalog_fr.py` from `pg_catalog.csv` + the downloads-sorted search pages (4,189 counts scraped 2026-10-12, 1 request/second). Dictionaries, grammars, language textbooks and periodicals are left out (356). |
| `books/catalog-es.json` | generated | 904 Spanish Gutenberg books `{id,t,a,dl}`, sorted by downloads. Built 2026-10-12 from `pg_catalog.csv` + Gutenberg's downloads-sorted search pages (scratch in `~/lector-build/catalog/`). Dictionaries, grammars and periodicals are excluded. |
| `worker/` | primary copy | **`lector-books` Cloudflare Worker, LIVE** at `https://lector-books.brianfliesballoons.workers.dev`. It relays `GET /epub/<numeric id>` from gutenberg.org only, with CORS for github.io and localhost:8000, cached 30 days. Deploy: `cd worker && npx wrangler@3 deploy`. ⚠ `account_id` is pinned in `wrangler.toml` because this login also sees **a client's account** (the Unravel one); never remove it. |
| `manifest.webmanifest` | primary copy | Web app manifest so Chrome on Android offers "Install app" (standalone, 192 + 512 icons). The apple-* metas stay for iPhone. |
| `icons/` | primary copy | `icon-192.png`, `icon-512.png`: a cloth-cover "L" with ❦, rendered in headless Chrome from the app's palette |
| `.nojekyll` | required | Without it, Pages drops `dict/_index.json` (leading underscore) |

## Conventions specific to this project

- **Never commit or publish a copyrighted book text.** Bundled books must be verifiably public domain in the US (both the original and the Spanish translation).
- Tap targets are sized for a phone in one hand; the reader is a reading display first. Motion is limited to the sheet sliding up and the header hiding while you read, and all of it is off under reduced-motion.
- **Look (restyled 2026-10-12, Brian: "style it up a bit"):** generated cloth-colour covers (hash of the title picks the palette, so a book keeps its colours), a "Seguir leyendo" card, chapter openers with ❦ and a drop cap, a slide-up word sheet with POS chips and an article chip (*el/la*). Reading settings: size slider 14–34, six typefaces (Literata default, Lora, EB Garamond, Georgia, New York, Atkinson Hyperlegible — Google Fonts, cached by `sw.js` for offline), line spacing, margins, ragged/justified (with Spanish hyphenation), themes Auto/Light/Sepia/Dark/Black.
- **Visual checks:** screenshots via the Chrome DevTools protocol at 390×844 @2x. `--screenshot` with `--virtual-time-budget` hangs here, and macOS has no `timeout` command. Check `scrollWidth === innerWidth`: a grid of `1fr` columns with `nowrap` text silently widened the page to 504 px (fixed with `minmax(0,1fr)`).

## French (2026-10-12)

The hand-tuned Spanish parts, redone for French. All French code is gated on the book's language, so Spanish behaves exactly as before.

- **Verbs read as English:** *était* → "was · From être, to be", *dit* → "said" (the passé simple wins; *il dit*, *dit-il*, *a dit* all read "said"), *avait dit* → "had said", *sera* → "will be", *allait* → "was going", *a été* → "been", *avait été* → "had been", *pouvait* → "could", *devait* → "had to", *il faut* → "must". The word before decides: a determiner means a noun (*le fait*, fact; *les avions*, planes), a subject or object pronoun means a verb (*il fait*, does; *nous avions*, had), and a helper verb means a past participle (*a fait*, did).
- **Elision:** l', d', j', qu', n', s', m', t', c', jusqu', lorsqu', puisqu', quoiqu', presqu', with ' or ’. *l'homme* → "man", with "l’ is le or la (the…), shortened before a vowel"; *s'il* reads si (if). Whole entries win when the dictionary has them (*aujourd'hui*, *jusqu'à*, *d'abord*), except "contraction of que + il" entries. Saved as *homme*.
- **Inversion:** *dit-il*, *a-t-il*, *s'écria-t-il*, *dites-moi*. Also old printings: *Etait* for *Était*, *coeur* for *cœur*, *A peine* for *À peine*.
- **Phrases:** the same meaning-stable filter with French little words. Lit and checked: *tout à coup*, *au lieu de* (and *au lieu d'aller*), *pomme de terre*, *il y a* (and *qu'il y a*), *il y avait*, *tout de suite*, *à peine*, *parce qu'il*, *tout d'un coup*, *tout le monde*; *de la terre* lights nothing. *il y a* and its tenses are listed by hand because they are all little words.
- **Dictionary build:** French only, a sub-sense follows its parent sense (*coup* → "blow, hit, strike", not "sound of the action"), and Louisiana-only inflection pointers are dropped (*été* is not "gone").
- **Parser:** French front matter (Table des matières, Préface, Avant-propos, Avertissement, Notice, Dédicace…) is skipped like Spanish prólogo. A trailing TABLE or notes is marked "After the story". A chapter label that a source set as a small heading (*XII* in Verne) starts its own chapter, and a long chapter holding three or more "CHAPITRE …" lines between prose is split; a contents list never is. A chapter titled only "I" shows its subtitle under it in Contents.
- **Shelf:** 6 books (see `books/CLAUDE.md`), each found by its opening words. First-run sentence: Perrault, *"Il était une fois une petite fille de village…"*.
- **Android:** web app manifest + icons, Android wording in "Add your own book" (Downloads, Google Play Books), the button reads "Add a book from your phone", and the no-voice message gives the Android path (Settings › System › Languages › Text-to-speech › Google › Install voice data). Voices that load late are looked for again. **Not yet tested on a real Android phone.**

Still loose:
- *eût*, *fût* and other imperfect subjunctives read "might have…" (*qu'on eût su voir* is "could have seen").
- *l'* is always explained as "the", even before a verb where it is him/her/it (the note says both).
- La Fontaine's *Fables* left off the shelf: 17th-century spelling (*étoit*, *connoît*) and verse in 252 tiny chapters.
- The relay fetches Gutenberg's `.epub3.images`, which for a few illustrated French books is huge (La Fontaine 56327 is 99 MB). Changing the Worker to `.epub.noimages` is a deploy, so it was left alone.
- The French catalogue lists 64 books with no download count (they sort last), and some titles carry their long Gutenberg subtitles.

## Delegation notes

- Book and edition research goes to `make` (needs sourced claims, workspace rule 25); dictionary build and app code are done in the main loop.
