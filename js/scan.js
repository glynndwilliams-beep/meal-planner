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

/** Downscale + greyscale + boost contrast so text recognition is faster and more accurate. */
function prepareForOcr(img) {
  const max = 2000;
  const w0 = img.width, h0 = img.height;
  const scale = Math.min(1, max / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    let g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    g = (g - 128) * 1.35 + 128 + 10; // contrast + slight brighten
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    p[i] = p[i + 1] = p[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return c;
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

export async function scanImage(file, onProgress = () => {}) {
  progressCb = onProgress;
  onProgress(0, 'Preparing photo…');
  const img = await fileToImage(file);
  const canvas = prepareForOcr(img);
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  onProgress(1, 'Done');
  return data.text || '';
}

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

// A line that doesn't start with a quantity and follows an ingredient is usually a wrapped continuation.
function joinWrappedIngredients(list) {
  const out = [];
  for (const l of list) {
    if (out.length && /^[a-z(]/.test(l) && !QTY_START.test(l) && out[out.length - 1].length > 25) out[out.length - 1] += ' ' + l;
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
