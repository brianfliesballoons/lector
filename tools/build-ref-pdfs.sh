#!/bin/bash
# Rebuild the printable PDFs of the Reference cards (run after any change to refs/cards.json, the card layout or the
# verb tables, then commit refs/pdf). Needs Google Chrome. Serves the repo on localhost:8765 and prints each card with
# the app's own print layout (#print=<id>, @media print in index.html): one card per Letter page.
#   every card in refs/cards.json (both shelves) except the interactive verb chart, which prints per verb:
#   verb-<infinitive> for the 24 most used Spanish verbs (the chips under the chart), in the app's own order, and
#   everb-<verb> for the 24 most used English verbs on María Antonieta's chart (conj-en/verbs.json order).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/refs/pdf"; CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE=$(mktemp -d); mkdir -p "$OUT"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$PROFILE"' EXIT
sleep 1
ids=$(python3 -I - "$ROOT" <<'PY'
import json, re, sys
root = sys.argv[1]
cards = json.load(open(root + '/refs/cards.json'))
ids = [c['id'] for side in ('es', 'en') for c in cards[side]['cards'] if c.get('page') not in ('charts', 'en-charts')]
# the chart's 24 chips: top.json in frequency order, minus CONJ_SKIP (read from index.html) and archaic verbs
skip = set(re.findall(r"'([a-z]+)'", re.search(r"const CONJ_SKIP = new Set\(\[(.*?)\]\)", open(root + '/index.html').read()).group(1)))
top = json.load(open(root + '/conj/top.json'))
verbs = [v for v in top['verbs'] if v not in skip and v in top['tables'] and not top['tables'][v].get('old')][:24]
# the English chart (María Antonieta's side): its 24 most used verbs
en = [v['b'] for v in json.load(open(root + '/conj-en/verbs.json'))['verbs'][:24]]
print(' '.join(ids + ['verb-' + v for v in verbs] + ['everb-' + v for v in en]))
PY
)
n=0
for id in $ids; do
  "$CH" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="$PROFILE" --virtual-time-budget=8000 \
    --print-to-pdf="$OUT/$id.pdf" "http://127.0.0.1:8765/?b=$RANDOM#print=$id" 2>/dev/null
  pages=$(python3 -I -c "import re,sys; d=open(sys.argv[1],'rb').read(); print(len(re.findall(rb'/Type\s*/Page[^s]', d)))" "$OUT/$id.pdf")
  echo "$id: $pages page(s)"; n=$((n+1))
done
# a card that left the shelf leaves no stale PDF behind
for f in "$OUT"/*.pdf; do b=$(basename "$f" .pdf); case " $ids " in *" $b "*) ;; *) rm -f "$f"; echo "removed $b.pdf";; esac; done
echo "$n PDFs in refs/pdf"
