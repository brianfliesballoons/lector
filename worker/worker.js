// lector-books: a narrow relay so the Lector page (on github.io) can download
// public-domain EPUBs from Project Gutenberg, whose servers send no CORS header.
// It fetches ONLY gutenberg.org EPUBs by numeric book id — nothing else.
const ALLOWED_ORIGINS = [
  'https://brianfliesballoons.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Vary': 'Origin' };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors(origin), 'Access-Control-Allow-Methods': 'GET' } });
    }
    if (request.method !== 'GET') return new Response('GET only', { status: 405 });

    const m = new URL(request.url).pathname.match(/^\/epub\/(\d{1,6})$/);
    if (!m) return new Response('Not found', { status: 404, headers: cors(origin) });

    const cache = caches.default;
    const key = new Request(`https://lector-books.cache/epub/${m[1]}`);
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(`https://www.gutenberg.org/ebooks/${m[1]}.epub3.images`, {
        headers: { 'User-Agent': 'lector-books relay (personal Spanish reader)' },
        redirect: 'follow',
      });
      if (!up.ok) return new Response(`Gutenberg answered ${up.status}`, { status: 502, headers: cors(origin) });
      res = new Response(up.body, {
        headers: { 'Content-Type': 'application/epub+zip', 'Cache-Control': 'public, max-age=2592000' },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    return out;
  },
};
