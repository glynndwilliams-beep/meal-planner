// On-device recipe scanning with Tesseract.js (text recognition runs in the browser;
// photos are not uploaded anywhere).
//
// Pipeline: crop -> greyscale -> adaptive black/white -> straighten -> find columns
//           -> read each region separately -> decide which region is ingredients / method
//           -> join wrapped lines using indentation and spacing.
import { cleanLine } from './ingredients.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerPromise = null;
let progressCb = () => {};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the text reader. Check your internet connection.'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      const w = await window.Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') progressCb(null, 'Reading text…', m.progress);
          else if (/load|initializ/.test(m.status)) progressCb(0.05, 'Getting ready (first time takes longer)…');
        },
      });
      await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return w;
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

export async function fileToImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/* ======================= image preparation ======================= */

/**
 * Crop to the area the user marked (fractions 0–1), keep plenty of resolution,
 * greyscale, then *adaptive* black/white: each pixel is compared with its own
 * neighbourhood, so shadows, glare and uneven light don't wipe out letters.
 * Finally straighten a tilted page.
 */
export function prepareForOcr(img, crop = { x: 0, y: 0, w: 1, h: 1 }) {
  const sx = Math.round(crop.x * img.width), sy = Math.round(crop.y * img.height);
  const sw = Math.max(1, Math.round(crop.w * img.width)), sh = Math.max(1, Math.round(crop.h * img.height));
  const long = Math.max(sw, sh);
  const scale = Math.min(3, Math.max(1800 / long, Math.min(1, 3200 / long)));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  const p = d.data;
  const n = w * h;
  const grey = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) grey[j] = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];

  // Bradley–Roth adaptive threshold using an integral image.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += grey[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const half = Math.max(8, Math.round(Math.max(w, h) / 32));
  const T = 0.14;
  const bin = new Uint8Array(n); // 1 = ink
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (w + 1) + x2 + 1] - integral[y1 * (w + 1) + x2 + 1]
        - integral[(y2 + 1) * (w + 1) + x1] + integral[y1 * (w + 1) + x1];
      const ink = grey[y * w + x] * count <= sum * (1 - T);
      bin[y * w + x] = ink ? 1 : 0;
      const k = (y * w + x) * 4;
      p[k] = p[k + 1] = p[k + 2] = ink ? 0 : 255;
    }
  }
  ctx.putImageData(d, 0, 0);

  const angle = estimateSkew(bin, w, h);
  if (Math.abs(angle) < 0.3) return c;
  const r = document.createElement('canvas');
  r.width = w; r.height = h;
  const rc = r.getContext('2d', { willReadFrequently: true });
  rc.fillStyle = '#fff';
  rc.fillRect(0, 0, w, h);
  rc.translate(w / 2, h / 2);
  rc.rotate(-angle * Math.PI / 180);
  rc.drawImage(c, -w / 2, -h / 2);
  return r;
}

/** Find the page tilt (degrees) that makes text rows line up best. */
function estimateSkew(bin, w, h) {
  const step = Math.max(1, Math.round(Math.max(w, h) / 700));
  const xs = [], ys = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (bin[y * w + x]) { xs.push(x); ys.push(y); }
  if (xs.length < 200) return 0;
  const off = Math.ceil(w * 0.1 / step) + 2;
  const len = Math.ceil((h + w * 0.2) / step) + 6;
  const score = a => {
    const r = a * Math.PI / 180, s = Math.sin(r), co = Math.cos(r);
    const bins = new Float32Array(len);
    for (let i = 0; i < xs.length; i++) {
      const k = Math.round((ys[i] * co - xs[i] * s) / step) + off;
      if (k >= 0 && k < len) bins[k]++;
    }
    let t = 0;
    for (let i = 0; i < len; i++) t += bins[i] * bins[i];
    return t;
  };
  let best = 0, bestScore = -1;
  for (let a = -6; a <= 6; a += 0.5) { const sc = score(a); if (sc > bestScore) { bestScore = sc; best = a; } }
  for (let a = best - 0.4; a <= best + 0.4; a += 0.1) { const sc = score(a); if (sc > bestScore) { bestScore = sc; best = a; } }
  return best;
}

/**
 * Look for a two-column layout: an empty vertical strip in the middle of the page.
 * Returns regions to read separately: an optional full-width top part (title, intro),
 * then the left and right columns. Falls back to the whole page.
 */
export function findRegions(canvas) {
  const w = canvas.width, h = canvas.height;
  const whole = [{ kind: 'page', left: 0, top: 0, width: w, height: h }];
  const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const ink = (x, y) => px[(y * w + x) * 4] < 128;
  // rows that are mostly dark are table/shadow beyond the page edge, not text: ignore them
  const darkRow = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x += 4) if (ink(x, y)) c++;
    darkRow[y] = c > (w / 4) * 0.4 ? 1 : 0;
  }

  // Ink per x. Titles and intros often run full width above the columns, so try measuring
  // from several starting heights and keep whichever shows the clearest gap.
  const y1 = Math.round(h * 0.96);
  const rad = Math.max(2, Math.round(w * 0.006));
  let colInk, smooth, mean = 0, gx = -1, gMin = Infinity, bestRatio = Infinity;
  for (const startFrac of [0.04, 0.2, 0.35, 0.5]) {
    const ci = new Float32Array(w);
    for (let y = Math.round(h * startFrac); y < y1; y += 2) if (!darkRow[y]) for (let x = 0; x < w; x++) if (ink(x, y)) ci[x]++;
    const sm = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, x - rad); k <= Math.min(w - 1, x + rad); k++) { s += ci[k]; c++; }
      sm[x] = s / c;
    }
    let mn = 0;
    for (let x = Math.round(w * 0.1); x < w * 0.9; x++) mn += sm[x];
    mn /= w * 0.8;
    if (!mn) continue;
    let x0 = -1, m0 = Infinity;
    for (let x = Math.round(w * 0.3); x < w * 0.75; x++) if (sm[x] < m0) { m0 = sm[x]; x0 = x; }
    if (m0 / mn < bestRatio) { bestRatio = m0 / mn; colInk = ci; smooth = sm; mean = mn; gx = x0; gMin = m0; }
  }
  if (gx < 0 || gMin > mean * 0.25) return whole;

  // widen to the whole empty strip
  let gl = gx, gr = gx;
  while (gl > 0 && smooth[gl - 1] <= mean * 0.25) gl--;
  while (gr < w - 1 && smooth[gr + 1] <= mean * 0.25) gr++;
  const bandL = gl, bandR = gr;

  // rows where something crosses the gap = full-width part (title/intro); the columns start below it
  const rowCross = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    if (!darkRow[y]) for (let x = bandL; x <= bandR; x++) if (ink(x, y)) c++;
    rowCross[y] = c > 0 ? 1 : 0;
  }
  // the columns region is the longest run of rows (allowing small specks) with nothing crossing
  let bestStart = 0, bestLen = 0, runStart = 0, misses = 0;
  const tol = Math.round(h * 0.004);
  for (let y = 0; y <= h; y++) {
    if (y === h || (rowCross[y] && ++misses > tol)) {
      if (y - runStart > bestLen) { bestLen = y - runStart; bestStart = runStart; }
      runStart = y + 1; misses = 0;
    } else if (!rowCross[y]) misses = 0;
  }
  if (bestLen < h * 0.25) return whole;

  // both sides must actually contain text
  const sideInk = (a, b) => { let s = 0; for (let x = a; x < b; x++) s += colInk[x]; return s; };
  if (sideInk(0, gl) < mean * w * 0.05 || sideInk(gr, w) < mean * w * 0.05) return whole;

  const regions = [];
  const top = bestStart, bottom = bestStart + bestLen;
  if (top > h * 0.03) regions.push({ kind: 'top', left: 0, top: 0, width: w, height: top });
  regions.push({ kind: 'col', left: 0, top, width: bandL, height: bottom - top });
  regions.push({ kind: 'col', left: bandR, top, width: w - bandR, height: bottom - top });
  if (bottom < h * 0.97) regions.push({ kind: 'bottom', left: 0, top: bottom, width: w, height: h - bottom });
  return regions;
}

/** Small JPEG to keep with the recipe (stays well under database document limits). */
export async function makeThumbnail(file, size = 480) {
  const img = await fileToImage(file);
  const scale = Math.min(1, size / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

/* ======================= reading ======================= */

/** Drop lines the reader wasn't sure about that also look like noise (pictures, page edges). */
function keepLine(line) {
  const t = (line.text || '').trim();
  if (!t) return false;
  const letters = (t.match(/[A-Za-z0-9½¼¾]/g) || []).length;
  const ratio = letters / t.replace(/\s/g, '').length;
  const realWords = (t.match(/[A-Za-z]{3,}/g) || []).length;
  if (line.confidence >= 70 && ratio > 0.5) return true;
  if (line.confidence >= 45 && ratio > 0.7 && (realWords >= 1 || /\d/.test(t))) return true;
  return false;
}

/** Remove stray marks the page edge leaves after a big gap: "olive oil      f" -> "olive oil" */
function tidy(text) {
  return text
    .replace(/\s{2,}\S{1,2}\s*$/, '')
    .replace(/\s+[|!{}[\]'"`~^*»«°]+\s*$/, '')
    .replace(/^\s*[|!{}[\]'"`~^*»«;:,.]+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// page numbers like "226", "226 * extravagant", "extravagant | 226"
const PAGE_FOOTER = /^(\d{1,4}|\d{1,4}\s*[*•|·]\s*[a-z ]{0,20}|[a-z ]{0,20}\s*[*•|·]\s*\d{1,4})$/i;

/**
 * Turn Tesseract's lines into clean { text, x0, x1, y0, y1 } using word positions:
 * short scraps sitting far from the real text (page binding, edge marks) are dropped.
 */
function cleanLines(rawLines) {
  const out = [];
  for (const l of rawLines.filter(keepLine)) {
    let ws = (l.words || []).filter(w => w.text.trim());
    if (!ws.length) continue;
    const hh = median(ws.map(w => w.bbox.y1 - w.bbox.y0)) || (l.bbox.y1 - l.bbox.y0);
    const far = (a, b) => b.bbox.x0 - a.bbox.x1 > hh * 1.5;
    // leading scraps: up to 3 short words followed by a big gap
    for (let i = Math.min(3, ws.length - 1); i >= 1; i--) {
      if (far(ws[i - 1], ws[i]) && ws.slice(0, i).every(w => w.text.length <= 3)) { ws = ws.slice(i); break; }
    }
    // trailing scraps
    for (let i = Math.max(1, ws.length - 3); i < ws.length; i++) {
      if (far(ws[i - 1], ws[i]) && ws.slice(i).every(w => w.text.length <= 3)) { ws = ws.slice(0, i); break; }
    }
    const text = tidy(ws.map(w => w.text).join(' '));
    if (text.length < 2 || PAGE_FOOTER.test(text)) continue;
    out.push({
      text,
      x0: ws[0].bbox.x0, x1: ws[ws.length - 1].bbox.x1,
      y0: Math.min(...ws.map(w => w.bbox.y0)), y1: Math.max(...ws.map(w => w.bbox.y1)),
    });
  }
  return out;
}

async function readRegion(worker, canvas, region) {
  const opts = region.kind === 'page' ? {} : { rectangle: { left: region.left, top: region.top, width: region.width, height: region.height } };
  const { data } = await worker.recognize(canvas, opts);
  return { ...region, lines: cleanLines(data.lines || []) };
}

async function readImage(file, onProgress, crop) {
  onProgress(0, 'Preparing photo…');
  const img = await fileToImage(file);
  const canvas = prepareForOcr(img, crop);
  onProgress(0.03, 'Looking at the page layout…');
  let regions = findRegions(canvas);
  // With columns, also read the whole page once: titles read best that way.
  if (regions.length > 1) regions = [{ kind: 'page', left: 0, top: 0, width: canvas.width, height: canvas.height, titleOnly: true }, ...regions.filter(r => r.kind === 'col')];
  progressCb = (p, msg) => onProgress(p ?? 0.05, msg);
  const worker = await getWorker();
  const out = [];
  for (let i = 0; i < regions.length; i++) {
    progressCb = (p, msg, sub) => onProgress(p ?? 0.08 + 0.92 * ((i + (sub || 0)) / regions.length), msg);
    out.push(await readRegion(worker, canvas, regions[i]));
  }
  onProgress(1, 'Done');
  return out;
}

/** Plain text of a photo (used for testing). */
export async function scanImage(file, onProgress = () => {}, { crop } = {}) {
  const regions = (await readImage(file, onProgress, crop)).filter(r => !r.titleOnly);
  return regions.map(r => r.lines.map(l => l.text).join('\n')).join('\n');
}

/**
 * Read a recipe photo. target: 'auto' | 'ingredients' | 'method'.
 * Returns { title, serves, ingredients: [string], method: string, text }.
 */
export async function scanRecipe(file, onProgress = () => {}, { crop, target = 'auto' } = {}) {
  const all = await readImage(file, onProgress, crop);
  const page = all.find(r => r.titleOnly);
  const regions = all.filter(r => !r.titleOnly);
  const text = regions.map(r => r.lines.map(l => l.text).join('\n')).join('\n');
  const allLines = regions.flatMap(r => r.lines);
  if (target === 'ingredients') return { title: '', serves: '', ingredients: linesToIngredients(allLines), method: '', text };
  if (target === 'method') return { title: '', serves: '', ingredients: [], method: linesToMethod(allLines), text };

  if (regions.length === 1) {
    // single column: use headings ("Ingredients", "Method") and quantities
    const parsed = parseRecipeText(text);
    return { ...parsed, text };
  }

  // columns: decide what each one is
  const colTop = Math.min(...regions.map(r => r.top));
  const result = { title: '', serves: findServes(`${text}\n${page.lines.map(l => l.text).join('\n')}`), ingredients: [], method: '', text };
  const methods = [];
  for (const r of regions) {
    const lines = r.lines.filter(l => !ING_HEAD.test(l.text) && !METHOD_HEAD.test(l.text));
    if (!lines.length) continue;
    if (looksLikeIngredients(lines)) result.ingredients.push(...linesToIngredients(lines));
    else methods.push(linesToMethod(lines));
  }
  result.method = methods.filter(Boolean).join('\n\n');
  result.title = findTitle(page.lines.filter(l => l.y1 <= colTop + 20)) || findTitle(page.lines.slice(0, 4));
  return result;
}

/* ======================= turning lines into recipe parts ======================= */
const ING_HEAD = /^(ingredients?|you will need|what you need|shopping list)\b[:\s]*$/i;
const METHOD_HEAD = /^(method|directions?|instructions?|preparation|steps|how to make( it)?|to make|cooking)\b[:\s]*$/i;
const SUB_HEAD = /^(for (the )?[a-z' -]{2,30}|to serve|to garnish|to decorate|optional|for serving)\s*:?$/i;
const QTY_START = /^([\d½⅓⅔¼¾⅛]|a\s+(pinch|handful|knob|bunch|little|few|splash|dash)\b|pinch\b|handful\b|salt\b|freshly\b)/i;
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const SERVES = new RegExp(`\\b(serves|servings?|makes|portions?|feeds)\\s*:?\\s*(\\d+(\\s*[-–]\\s*\\d+)?|${Object.keys(NUM_WORDS).join('|')})\\b`, 'i');
const STEP_START = /^(step\s*)?\d{1,2}[.):]\s+/i;

function findServes(text) {
  const m = text.match(SERVES);
  if (!m) return '';
  const v = m[2].toLowerCase().replace(/\s/g, '');
  return String(NUM_WORDS[v] ?? v);
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

/** Title = the biggest text near the top. */
function findTitle(lines) {
  if (!lines.length) return '';
  const hs = lines.map(l => l.y1 - l.y0);
  const med = median(hs);
  const big = lines.filter(l => l.y1 - l.y0 >= med * 1.25 && /[a-z]{3,}/i.test(l.text));
  const pick = (big.length ? big : lines.filter(l => /[a-z]{3,}/i.test(l.text)).slice(0, 1)).slice(0, 3);
  return pick.map(l => l.text).join(' ').replace(/[^A-Za-z0-9)]+$/, '').replace(/^[^A-Za-z0-9(]+/, '').replace(/\s+/g, ' ').trim();
}

function looksLikeIngredients(lines) {
  if (!lines.length) return false;
  const qty = lines.filter(l => QTY_START.test(cleanLine(l.text))).length / lines.length;
  const sentences = lines.filter(l => /[a-z]\.\s+[A-Z]|[a-z]\.$/.test(l.text)).length / lines.length;
  const avgLen = lines.reduce((s, l) => s + l.text.length, 0) / lines.length;
  return qty >= 0.25 && sentences < 0.3 && avgLen < 45;
}

// Fix digits misread as letters at the start of a quantity: "4o0g" -> "400g", "75%" -> "75g"
function fixQuantity(line) {
  return line
    .replace(/^[\dOoIl|S]+/, m => (/\d/.test(m) ? m.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5') : m))
    .replace(/^(\d+)\s?[%9]\s/, '$1g ')
    // old-style "1" often reads as I, l, | or t: "I heaped tablespoon", "juice of t small lemon"
    .replace(/^[Il|](?=\s+[a-z])/, '1')
    .replace(/(\s)[tIl|](?=\s+[a-z])/g, '$11');
}

function isUnfinished(prev) {
  return /[,(\-–]$/.test(prev) || prev.split('(').length > prev.split(')').length
    || /\b(and|or|of|into|for|to|plus|a|the|with|freshly|extra)$/i.test(prev);
}

/** Lines with positions -> ingredient list. Indented lines continue the one above. */
function linesToIngredients(lines) {
  const ls = lines.map(l => ({ ...l, text: fixQuantity(cleanLine(l.text)) }))
    .filter(l => l.text.length > 1 && !ING_HEAD.test(l.text) && !SUB_HEAD.test(l.text) && !SERVES.test(l.text));
  if (!ls.length) return [];
  const h = median(ls.map(l => l.y1 - l.y0)) || 10;
  const base = median(ls.map(l => l.x0).sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(ls.length / 2))));
  const out = [];
  for (const l of ls) {
    const prev = out[out.length - 1];
    const indented = l.x0 - base > h * 0.45;
    const cont = prev && !QTY_START.test(l.text) && (indented || isUnfinished(prev) || /^\(/.test(l.text));
    if (cont) out[out.length - 1] = `${prev} ${l.text}`;
    else out.push(l.text);
  }
  return out;
}

/** Lines with positions -> method paragraphs, split on numbered steps or extra spacing. */
function linesToMethod(lines) {
  const ls = lines.filter(l => !METHOD_HEAD.test(l.text) && !SERVES.test(l.text) && !/^takes about|^prep(aration)? time|^cook(ing)? time/i.test(l.text));
  if (!ls.length) return '';
  // line pitch (top to top); a paragraph break shows as extra spacing, or a short line ending in "."
  const pitch = ls.slice(1).map((l, i) => l.y0 - ls[i].y0);
  const normalPitch = median(pitch.filter(p => p > 0)) || 30;
  const fullWidth = median(ls.map(l => l.x1 - l.x0));
  const steps = [];
  ls.forEach((l, i) => {
    const t = l.text.trim();
    const prev = ls[i - 1];
    const bigGap = i > 0 && pitch[i - 1] > normalPitch * 1.2;
    const shortEnd = prev && /[.!?]$/.test(prev.text) && (prev.x1 - prev.x0) < fullWidth * 0.8 && /^[A-Z]/.test(t);
    if (!steps.length || STEP_START.test(t) || bigGap || shortEnd) steps.push(t.replace(STEP_START, ''));
    else steps[steps.length - 1] += ' ' + t;
  });
  return steps.map(s => s.replace(/(\w)- (\w)/g, '$1$2').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

/* ---------- text-only parsing (single column, or pasted text) ---------- */
export function parseRecipeText(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim().length);
  const serves = findServes(text);

  const iHead = lines.findIndex(l => ING_HEAD.test(l.trim()));
  const mHead = lines.findIndex(l => METHOD_HEAD.test(l.trim()));

  let ingredients = [], methodLines = [], titleCandidates = [];

  if (iHead >= 0) {
    titleCandidates = lines.slice(0, iHead);
    const end = mHead > iHead ? mHead : lines.length;
    ingredients = lines.slice(iHead + 1, end);
    methodLines = mHead > iHead ? lines.slice(mHead + 1) : [];
    if (mHead >= 0 && mHead < iHead) methodLines = lines.slice(mHead + 1, iHead);
  } else if (mHead >= 0) {
    const before = lines.slice(0, mHead);
    ingredients = before.filter(l => QTY_START.test(cleanLine(l)));
    titleCandidates = before.filter(l => !QTY_START.test(cleanLine(l)));
    methodLines = lines.slice(mHead + 1);
  } else {
    // No headings: short lines starting with a quantity are ingredients, the rest is method.
    for (const l of lines) {
      const c = cleanLine(l);
      if (QTY_START.test(c) && c.length < 70 && !STEP_START.test(c)) ingredients.push(l);
      else if (!ingredients.length && !methodLines.length) titleCandidates.push(l);
      else methodLines.push(l);
    }
  }

  const title = (titleCandidates.map(cleanLine).find(l => l.length >= 3 && l.length <= 70 && !SERVES.test(l) && /[a-z]/i.test(l)) || '').replace(/[|_]+/g, '').trim();

  ingredients = joinWrappedIngredients(ingredients.map(cleanLine).filter(l => l.length > 1 && !SERVES.test(l) && !SUB_HEAD.test(l)));
  const method = joinMethod(methodLines);

  return { title, serves, ingredients, method };
}

function joinWrappedIngredients(list) {
  const out = [];
  for (const l of list.map(fixQuantity)) {
    const prev = out[out.length - 1];
    if (prev && !QTY_START.test(l) && (isUnfinished(prev) || /^\(/.test(l))) out[out.length - 1] += ' ' + l;
    else out.push(l);
  }
  return out;
}

function joinMethod(lines) {
  const steps = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (STEP_START.test(l) || !steps.length) steps.push(l.replace(STEP_START, ''));
    else if (/[.!?]$/.test(steps[steps.length - 1]) && /^[A-Z]/.test(l)) steps.push(l);
    else steps[steps.length - 1] += ' ' + l;
  }
  return steps.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

/** Plain text -> ingredient lines. */
export function textToIngredients(text) {
  return joinWrappedIngredients(text.split(/\r?\n/).map(cleanLine).filter(l => l.length > 1 && !ING_HEAD.test(l) && !SUB_HEAD.test(l)));
}
/** Plain text -> method paragraphs. */
export function textToMethod(text) {
  return joinMethod(text.split(/\r?\n/).filter(l => !METHOD_HEAD.test(l.trim())));
}
