// Meal Planner – recipe page fetcher (a Cloudflare Worker).
//
// Browsers won't let the app read other websites directly, so this tiny service fetches
// a recipe page (or its photo) for the app and hands it back. It only answers the
// Meal Planner app's own web address, only fetches web pages and pictures, and never
// stores anything.
//
// Set up: see "Step 5" in SETUP.md. If the app moves to a different web address, add it
// to ALLOWED_ORIGINS below and deploy again.

const ALLOWED_ORIGINS = [
  'https://glynndwilliams-beep.github.io', // the app on GitHub Pages
  'http://localhost:8765',                 // testing on a computer
  'http://127.0.0.1:8765',
];

const MAX_BYTES = 5 * 1024 * 1024; // recipe pages are ~0.5 MB; refuse anything huge
const TIMEOUT_MS = 15000;

// Look like an ordinary browser: several recipe sites refuse bare requests.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/*,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    const reply = (status, text) => new Response(text, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (request.method !== 'GET') return reply(405, 'Only GET');
    if (!allowed) return reply(403, 'This service only works for the Meal Planner app.');

    const target = new URL(request.url).searchParams.get('url');
    // No address: a health check, used by the app's "Test" button.
    if (!target) return new Response(JSON.stringify({ ok: true, service: 'meal-planner-recipe-fetch' }), { headers: { ...cors, 'Content-Type': 'application/json' } });

    let url;
    try { url = new URL(target); } catch { return reply(400, 'Not a web address'); }
    if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return reply(400, 'That address isn’t allowed');

    let res;
    try {
      res = await fetch(url.href, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cf: { cacheTtl: 3600, cacheEverything: true }, // repeat imports of the same page are instant
      });
    } catch (err) {
      return reply(502, `Couldn’t reach that site (${err.name})`);
    }
    if (!res.ok) return reply(502, `That site answered ${res.status}`);

    const type = (res.headers.get('Content-Type') || '').toLowerCase();
    if (!/^(text\/html|application\/xhtml\+xml|image\/)/.test(type)) return reply(415, 'Only web pages and pictures');
    if (Number(res.headers.get('Content-Length') || 0) > MAX_BYTES) return reply(413, 'Too big');

    const body = await readLimited(res.body, MAX_BYTES);
    if (!body) return reply(413, 'Too big');
    return new Response(body, {
      headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Final-Url': res.url },
    });
  },
};

/** Never fetch the service's own machine or private networks. */
function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return h.includes(':');
  return false;
}

async function readLimited(stream, max) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
