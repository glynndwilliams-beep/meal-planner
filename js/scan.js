// On-device recipe scanning with Tesseract.js (text recognition runs in the browser;
// photos are not uploaded anywhere).
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
      return window.Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') progressCb(0.15 + m.progress * 0.85, 'Reading text…');
          else if (/load|initializ/.test(m.status)) progressCb(Math.min(0.15, (m.progress || 0) * 0.15), 'Getting ready (first time takes longer)…');
        },
      });
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

async function fileToImage(file) {
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

/**
 * Prepare a phone photo for text recognition:
 *  - crop to the area the user marked (fractions 0–1)
 *  - keep plenty of resolution (small cookbook print needs it)
 *  - greyscale, then *adaptive* black/white: each pixel is compared with its own
 *    neighbourhood, so shadows, glare and uneven light don't wipe out letters.
 */
export function prepareForOcr(img, crop = { x: 0, y: 0, w: 1, h: 1 }) {
  const sx = Math.round(crop.x * img.width), sy = Math.round(crop.y * img.height);
  const sw = Math.max(1, Math.round(crop.w * img.width)), sh = Math.max(1, Math.round(crop.h * img.height));
  const long = Math.max(sw, sh);
  const scale = Math.min(2, Math.max(1800 / long, Math.min(1, 3200 / long)));
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
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (w + 1) + x2 + 1] - integral[y1 * (w + 1) + x2 + 1]
        - integral[(y2 + 1) * (w + 1) + x1] + integral[y1 * (w + 1) + x1];
      const v = grey[y * w + x] * count <= sum * (1 - T) ? 0 : 255;
      const k = (y * w + x) * 4;
      p[k] = p[k + 1] = p[k + 2] = v;
    }
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

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

/** Small JPEG to keep with the recipe (stays well under database document limits). */
export async function makeThumbnail(file, size = 480) {
  const img = await fileToImage(file);
  const scale = Math.min(1, size / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

export async function scanImage(file, onProgress = () => {}, { crop } = {}) {
  progressCb = onProgress;
  onProgress(0, 'Preparing photo…');
  const img = await fileToImage(file);
  const canvas = prepareForOcr(img, crop);
  const worker = await getWorker();
  await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
  const { data } = await worker.recognize(canvas);
  onProgress(1, 'Done');
  if (Array.isArray(data.lines) && data.lines.length) {
    return data.lines.filter(keepLine).map(l => l.text.trim()).join('\n');
  }
  return data.text || '';
}

/** Plain text -> ingredient lines (for a crop the user marked as ingredients). */
export function textToIngredients(text) {
  return joinWrappedIngredients(text.split(/\r?\n/).map(cleanLine).filter(l => l.length > 1 && !ING_HEAD.test(l)));
}
/** Plain text -> method paragraphs (for a crop the user marked as method). */
export function textToMethod(text) {
  return joinMethod(text.split(/\r?\n/).filter(l => !METHOD_HEAD.test(l.trim())));
}

export { fileToImage };

/* ---------------- turn raw text into recipe parts ---------------- */
const ING_HEAD = /^(ingredients?|you will need|what you need|shopping list)\b[:\s]*$/i;
const METHOD_HEAD = /^(method|directions?|instructions?|preparation|steps|how to make( it)?|to make|cooking)\b[:\s]*$/i;
const QTY_START = /^([\d½⅓⅔¼¾⅛]|a\s+(pinch|handful|knob|bunch|little|few|splash|dash)\b|pinch\b|handful\b|salt\b|freshly\b)/i;
const SERVES = /\b(serves|servings?|makes|portions?)\s*:?\s*(\d+(\s*[-–]\s*\d+)?)/i;
const STEP_START = /^(step\s*)?\d{1,2}[.):]\s+/i;

export function parseRecipeText(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim().length);
  let serves = '';
  for (const l of lines) { const m = l.match(SERVES); if (m) { serves = m[2].replace(/\s/g, ''); break; } }

  let iHead = lines.findIndex(l => ING_HEAD.test(l.trim()));
  let mHead = lines.findIndex(l => METHOD_HEAD.test(l.trim()));

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

  ingredients = joinWrappedIngredients(ingredients.map(cleanLine).filter(l => l.length > 1 && !SERVES.test(l)));
  const method = joinMethod(methodLines);

  return { title, serves, ingredients, method };
}

// Fix digits misread as letters at the start of a quantity: "4o0g" -> "400g", "1l/2" -> "11/2"
function fixQuantity(line) {
  return line.replace(/^[\dOoIl|S]+/, m => (/\d/.test(m) ? m.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5') : m));
}

// A line that doesn't start with a quantity and follows an ingredient is usually a wrapped continuation.
function joinWrappedIngredients(list) {
  list = list.map(fixQuantity);
  const out = [];
  for (const l of list) {
    const prev = out[out.length - 1];
    const unfinished = prev && (/[,(\-–]$/.test(prev) || prev.split('(').length > prev.split(')').length ||/\b(and|or|of|into|for|to|plus|a|the|with)$/i.test(prev));
    if (prev && !QTY_START.test(l) && (unfinished || /^\(/.test(l))) out[out.length - 1] += ' ' + l;
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
