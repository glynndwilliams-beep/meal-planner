// Import a recipe from a web page (BBC Food, BBC Good Food, Allrecipes, most food blogs…).
// Nearly every recipe site embeds the recipe as schema.org "Recipe" data for search engines;
// we read that rather than scraping the page layout, so it keeps working when sites restyle.
//
// The app is a static site, so the browser isn't allowed to read other sites directly
// (CORS). Routes, in order: the household's own fetching service (cloudflare/recipe-fetch.js,
// set in Settings) if there is one, a direct fetch, then free public relay services.
// Only the recipe's web address is sent to them.
import { makeThumbnail } from './scan.js';

const RELAYS = [
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

/** Pull the first web address out of whatever was pasted ("Look at this! https://…"). */
export function findUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i)
    || String(text || '').match(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>"']*/i);
  if (!m) return '';
  const u = m[0].replace(/[).,;]+$/, '');
  return /^https?:/i.test(u) ? u : `https://${u}`;
}

async function fetchWithTimeout(url, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) {
      // the household's fetcher explains itself in plain text ("That site answered 403")
      const why = await res.text().then(t => t.trim().slice(0, 120)).catch(() => '');
      throw new Error(why && !/^</.test(why) ? why : `HTTP ${res.status}`);
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('took too long to answer');
    if (err instanceof TypeError) throw new Error('couldn’t be reached');
    throw err;
  } finally { clearTimeout(timer); }
}

/** The household's own service, e.g. https://recipe-fetch.name.workers.dev */
const ownRoute = base => u => `${base.replace(/\/+$/, '')}/?url=${encodeURIComponent(u)}`;

/** Check a fetching-service address: resolves true, or throws with a reason. */
export async function testRelay(base) {
  let u;
  try { u = new URL(base); } catch { throw new Error('That doesn’t look like a web address'); }
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw new Error('The address should start with https://');
  const res = await fetchWithTimeout(u.href, 10000);
  const data = await res.json().catch(() => null);
  if (!data || data.service !== 'meal-planner-recipe-fetch') throw new Error('Something answered, but it isn’t the recipe fetcher. Check the code was pasted and deployed.');
  return true;
}

/**
 * Fetch through each route in turn; `accept` decides whether a response is usable.
 * Throws an error whose `.notFound` is true if a page was fetched but had no recipe,
 * and whose `.own` holds why the household's own fetcher failed (if it was tried).
 */
async function fetchAny(url, read, accept, relay) {
  const routes = [
    ...(relay ? [{ own: true, to: ownRoute(relay), ms: 25000 }] : []),
    { to: u => u, ms: 8000 },
    ...RELAYS.map(to => ({ to, ms: 10000 })),
  ];
  let notFound = false, own = '';
  for (const r of routes) {
    try {
      const out = await read(await fetchWithTimeout(r.to(url), r.ms));
      if (accept(out)) return out;
      // Our fetcher got the real page and it has no recipe: trust that and stop.
      // From a public service it may just be a "you're blocked" page, so keep trying.
      if (r.own) { notFound = true; break; }
      if (!own) notFound = true;
    } catch (err) { if (r.own) own = err.message; }
  }
  const err = new Error(notFound ? 'no recipe found' : 'unreachable');
  err.notFound = notFound;
  err.own = own;
  throw err;
}

/* ---------- reading schema.org Recipe data ---------- */

const entityBox = document.createElement('textarea');
function decode(s) {
  if (s == null) return '';
  entityBox.innerHTML = String(s);
  return entityBox.value;
}
/** Plain text: decode entities, drop any HTML tags, tidy spaces. */
function text(s) {
  const d = decode(s);
  const plain = /<[a-z/][^>]*>/i.test(d) ? new DOMParser().parseFromString(d, 'text/html').body.textContent : d;
  return plain.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
}
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isType = (node, t) => arr(node && node['@type']).some(x => String(x).toLowerCase() === t);

function findRecipeNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; }
    return null;
  }
  if (isType(node, 'recipe')) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const r = findRecipeNode(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

/** Steps can be strings, HowToStep objects, or HowToSection groups of steps. */
function steps(instr) {
  const out = [];
  const walk = (n) => {
    if (n == null) return;
    if (typeof n === 'string') {
      const t = text(n);
      // A single block of text: split into its own paragraphs/lines
      t.split(/\n+|(?<=\.)\s*(?=\d+\.\s)/).map(s => s.trim()).filter(Boolean).forEach(s => out.push(s));
      return;
    }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (isType(n, 'howtosection')) {
      if (n.name) out.push(`${text(n.name)}:`);
      walk(n.itemListElement || n.steps);
      return;
    }
    if (n.itemListElement) { walk(n.itemListElement); return; }
    const t = text(n.text || n.description || n.name || '');
    if (t) out.push(t);
  };
  walk(instr);
  // Drop leading "1." / "Step 1" numbering – the app shows steps as paragraphs
  return out.map(s => s.replace(/^(?:step\s*)?\d+[.):]?\s+(?=\S)/i, ''));
}

function serves(y) {
  const vals = arr(y).map(v => text(v)).filter(Boolean);
  const withNum = vals.find(v => /\d/.test(v)) || vals[0] || '';
  const m = withNum.match(/\d+(?:\s*[-–]\s*\d+)?/);
  return m ? m[0].replace(/\s+/g, '') : withNum;
}

function imageUrl(img, base) {
  for (const i of arr(img)) {
    const u = typeof i === 'string' ? i : (i && (i.url || i.contentUrl || i['@id']));
    if (u) { try { return new URL(text(u), base).href; } catch { /* next */ } }
  }
  return '';
}

function guessMeals(r) {
  const tags = [r.recipeCategory, r.keywords, r.name].flat().map(x => text(x).toLowerCase()).join(' ');
  const meals = [];
  if (/breakfast|brunch/.test(tags)) meals.push('breakfast');
  if (/\blunch|sandwich|salad|soup/.test(tags)) meals.push('lunch');
  if (/main|dinner|supper|\bdish\b/.test(tags) || !meals.length) meals.push('dinner');
  return meals;
}

/** A short list of tags from the site's category, cuisine and keywords. */
function tagsFrom(r) {
  const authors = new Set(arr(r.author).map(a => text(typeof a === 'string' ? a : a && a.name).toLowerCase()).filter(Boolean));
  const raw = [r.recipeCategory, r.recipeCuisine, r.keywords].flat()
    .flatMap(x => text(x).split(/[,;|]/))
    .map(t => t.trim().toLowerCase().replace(/\s+recipes?$/, ''))
    .filter(t => t && t.length <= 20 && !authors.has(t) && !/^\d|^recipe|-tested$|^(new|easy recipes?|popular)$/.test(t));
  return [...new Set(raw)].slice(0, 8);
}

/** Microdata fallback for older sites that mark up the page itself instead of using JSON. */
function fromMicrodata(doc) {
  const scope = doc.querySelector('[itemtype*="schema.org/Recipe" i]');
  if (!scope) return null;
  const prop = (p) => [...scope.querySelectorAll(`[itemprop="${p}"]`)];
  const val = el => el.getAttribute('content') || el.getAttribute('src') || el.textContent;
  return {
    name: prop('name')[0] && val(prop('name')[0]),
    recipeYield: prop('recipeYield').map(val),
    recipeIngredient: (prop('recipeIngredient').length ? prop('recipeIngredient') : prop('ingredients')).map(val),
    recipeInstructions: prop('recipeInstructions').map(val),
    image: prop('image').map(val),
  };
}

export function parseRecipeHtml(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let node = null;
  for (const s of doc.querySelectorAll('script[type="application/ld+json" i]')) {
    try { node = findRecipeNode(JSON.parse(s.textContent.trim())); } catch { /* bad JSON on page: skip */ }
    if (node) break;
  }
  node = node || fromMicrodata(doc);
  if (!node) return null;
  const ingredients = arr(node.recipeIngredient || node.ingredients).map(text).filter(Boolean);
  const method = steps(node.recipeInstructions);
  if (!ingredients.length && !method.length) return null;
  const site = doc.querySelector('meta[property="og:site_name"]')?.content;
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  return {
    title: text(node.name || node.headline || doc.title),
    serves: serves(node.recipeYield || node.yield),
    ingredients,
    method: method.join('\n\n'),
    meals: guessMeals(node),
    tags: tagsFrom(node),
    image: imageUrl(node.image, pageUrl),
    source: `${text(site) || host} – ${pageUrl}`,
  };
}

/**
 * The iPhone Shortcut can read the recipe straight off the page open in Safari (see
 * PAGE_SCRIPT) and hand it over as { u: page address, s: site name, l: [recipe JSON-LD], m: microdata HTML }.
 * Nothing needs fetching then, so it works even on sites that block fetchers (e.g. BBC).
 */
export function parsePageData(page) {
  if (!page || typeof page.u !== 'string') return null;
  try { new URL(page.u); } catch { return null; }
  const attr = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = `<meta property="og:site_name" content="${attr(page.s)}">`
    + (Array.isArray(page.l) ? page.l : []).map(t => `<script type="application/ld+json">${String(t).replace(/<\/script/gi, '<\\/script')}</script>`).join('')
    + (typeof page.m === 'string' ? page.m : '');
  return parseRecipeHtml(html, page.u);
}

/** What the iPhone Shortcut's "Run JavaScript on Web Page" action runs (pasted in by the user). */
export const PAGE_SCRIPT = `var l=[],drop={review:1,reviews:1,video:1,comment:1,aggregateRating:1,interactionStatistic:1};
function trim(o){if(Array.isArray(o))return o.map(trim);if(o&&typeof o=='object'){for(var k in o){if(drop[k])delete o[k];else o[k]=trim(o[k]);}}return o;}
document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s){if(/Recipe/.test(s.textContent)){try{l.push(JSON.stringify(trim(JSON.parse(s.textContent))));}catch(e){l.push(s.textContent);}}});
var md=l.length?'':((document.querySelector('[itemtype*="schema.org/Recipe"]')||{}).outerHTML||'').slice(0,60000);
var sn=document.querySelector('meta[property="og:site_name"]');
completion('MPRECIPE:'+encodeURIComponent(JSON.stringify({u:location.href,s:sn?sn.content:'',l:l,m:md})));`;
// The MPRECIPE: label keeps Shortcuts from turning the result into a "Dictionary" and changing it,
// and encoding it here means characters Shortcuts' URL Encode leaves alone (like &) can't break the link.

/** Turn whatever arrived after ?import= back into page data, or null. Copes with being encoded once or twice. */
export function readImportParam(raw) {
  let t = String(raw || '').trim();
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^MPRECIPE(:|%3A)\s*/i, '');
    if (t.startsWith('{')) break;
    if (!/^%7B/i.test(t)) return null;
    try { t = decodeURIComponent(t); } catch { return null; }
  }
  try {
    const p = JSON.parse(t);
    return p && typeof p.u === 'string' ? p : null;
  } catch { return null; }
}

/** Fetch a recipe page and return { title, serves, ingredients, method, meals, tags, photo, source }. */
export async function importRecipe(url, onStatus = () => {}, { relay = '', page = null } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That doesn’t look like a web address'); }
  let recipe = page ? parsePageData(page) : null;
  if (!recipe) onStatus('Fetching the page…');
  try {
    recipe = recipe || await fetchAny(u.href, res => res.text().then(h => parseRecipeHtml(h, u.href)), r => !!r, relay);
  } catch (err) {
    if (err.notFound) throw new Error('Couldn’t find a recipe on that page. Check it’s the recipe itself, not a list of recipes.');
    if (err.own) throw new Error(`Couldn’t get that page. Your recipe fetcher said: “${err.own}”. Check the address is right and try again.`);
    throw new Error(relay
      ? 'Couldn’t get that page. Check you’re online and the address is right, then try again.'
      : 'Couldn’t get that page – the free public services it uses are down or blocked. Setting up your own recipe fetcher (Settings → Recipes from websites) fixes this.');
  }
  recipe.photo = '';
  if (recipe.image) {
    onStatus('Getting the photo…');
    try {
      const blob = await fetchAny(recipe.image, res => res.blob(), b => b.size > 0 && /^image\//.test(b.type), relay);
      recipe.photo = await makeThumbnail(blob);
    } catch { /* recipe is still useful without a photo */ }
  }
  return recipe;
}
