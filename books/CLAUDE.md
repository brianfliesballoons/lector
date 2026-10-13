# books/ — the bundled public-domain shelf

> **Reading protocol:** the parent [CLAUDE.md](../CLAUDE.md) is authoritative; read its copyright rule first.

## Active to-do

*Nothing open. The Spanish shelf of 10 was filled 2026-10-12; the French shelf of 6 the same day.*

## What this is

EPUB files the app offers on its "Free books" shelf, listed in `manifest.json` (`id`, `title`, `author`, `file`, optional `note`, `lang` — missing means Spanish). The shelf shows only the language being learned. **Only texts that are public domain in the US, both the original and the Spanish translation, ever go here** — this folder is published on GitHub Pages.

## The files

| File | Status | What it is |
|---|---|---|
| `manifest.json` | primary copy | The shelf listing, easiest first |
| `carol.epub` | PD | *El cántico de Navidad*, Dickens, tr. Luis Barthe, Madrid **1883** (Wikisource via ws-export) |
| `holmes.epub` | PD | *Aventuras de Sherlock Holmes I*, Buenos Aires *La Nación* **1909** (Wikisource) |
| `pg62627.epub` | PD | *El caso extraño del Doctor Jekyll*, tr. Emilio Soulère, NY Appleton **1891** |
| `vuelta.epub` | PD | *La vuelta al mundo en ochenta días*, Verne (Spanish ed. **1885**, Wikisource) |
| `pg46196.epub` | PD | Poe, *Cuentos clásicos del Norte*, tr. Carmen Torres Calderón de Pinillos, NY **1920** |
| `pg45438.epub` | PD | *La isla del tesoro*, tr. Manuel Caballero, **1886** (1901 printing) |
| `pg69552.epub` | PD | Kipling, *El libro de las tierras vírgenes*, tr. Ramón D. Perés, **1918** |
| `pg36990.epub` | PD | *La letra escarlata*, tr. Francisco Sellén, NY **1894** |
| `pg320.epub` | PD | *Lazarillo de Tormes*, Spanish original, **1554** |
| `pg2000.epub` | PD | *Don Quijote*, Spanish original, **1605/1615** |
| `perrault.epub` | PD | *Contes de Perrault*, French original (1697), Casterman edition of **1902** (Wikisource via ws-export; Doré illustrations stripped to keep it at 90 KB) |
| `pg14247.epub` | PD | Comtesse de Ségur, *Nouveaux contes de fées*, French original (1857), Gutenberg's 1896 printing |
| `pg11770.epub` | PD | Alphonse Daudet, *Lettres de mon moulin*, French original (**1869**) |
| `pg11714.epub` | PD | Guy de Maupassant, *Contes de la bécasse*, French original (**1883**) |
| `pg800.epub` | PD | Jules Verne, *Le tour du monde en quatre-vingts jours*, French original (**1873**) |
| `pg13951.epub` | PD | Alexandre Dumas, *Les trois mousquetaires*, French original (**1844**) |

## Conventions specific to this project

- Gutenberg files are numbered `pg<n>.epub` (French ones taken as `.epub.noimages`). The Wikisource ones come from `https://ws-export.wmcloud.org/?lang=es&page=<title>&format=epub-3` (`lang=fr` for French).
- Never add a copyrighted book. Brian's own purchases are loaded on his phone and never committed.

## Delegation notes

- None.
