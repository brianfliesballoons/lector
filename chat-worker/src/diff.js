// Word-level diff between what the learner wrote and the model's minimally corrected version.
// The model only returns a corrected sentence; the edits and their character offsets are computed
// here, so start/end always point at the learner's own text exactly.

const TOKEN = /[\p{L}\p{M}\p{N}'’]+|[^\s\p{L}\p{M}\p{N}]/gu;

function tokens(s) {
  const out = [];
  for (const m of s.matchAll(TOKEN)) out.push({ t: m[0], s: m.index, e: m.index + m[0].length });
  return out;
}

// letters and digits only, lower-cased: two strings that differ only in case or punctuation compare equal
const bare = s => s.toLocaleLowerCase('es').replace(/[^\p{L}\p{M}\p{N}]/gu, '');

// Returns [{from, to, start, end}] in the original's coordinates.
// Case-only and punctuation-only differences are dropped: in chat they are style, not errors.
export function edits(orig, fixed) {
  const a = tokens(orig), b = tokens(fixed);
  if (a.length > 400 || b.length > 400) return [];
  const n = a.length, m = b.length;
  // LCS table on exact token text
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i].t === b[j].t ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0, ra = [], rb = [];
  const flush = () => {
    if (!ra.length && !rb.length) return;
    let start, end;
    if (ra.length) { start = a[ra[0]].s; end = a[ra[ra.length - 1]].e; }
    else { start = end = i < n ? a[i].s : orig.length; }   // pure insertion: before the next original token
    const from = orig.slice(start, end);
    let bs, be;
    if (rb.length) { bs = b[rb[0]].s; be = b[rb[rb.length - 1]].e; }
    else { bs = be = j < m ? b[j].s : fixed.length; }
    out.push({ from, to: fixed.slice(bs, be), start, end, bs, be });
    ra = []; rb = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i].t === b[j].t) { flush(); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { rb.push(j); j++; }
    else { ra.push(i); i++; }
  }
  flush();
  // A moved phrase shows up as an insertion and a deletion of the same words: join everything between them into one edit.
  for (let k = 0; k < out.length; k++) for (let l = out.length - 1; l > k; l--) {
    const x = out[k], y = out[l];
    if ((bare(x.from) === '' && bare(x.to) && bare(x.to) === bare(y.from) && bare(y.to) === '') ||
        (bare(x.to) === '' && bare(x.from) && bare(x.from) === bare(y.to) && bare(y.from) === '')) {
      out.splice(k, l - k + 1, { from: orig.slice(x.start, y.end), to: fixed.slice(x.bs, y.be), start: x.start, end: y.end, bs: x.bs, be: y.be });
      break;
    }
  }
  return out.filter(e => bare(e.from) !== bare(e.to)).map(({ from, to, start, end }) => ({ from, to, start, end }));
}
