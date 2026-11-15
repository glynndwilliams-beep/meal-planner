// Ingredient parsing, merging and shop-section guessing.

const FRACTIONS = { '½': .5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': .25, '¾': .75, '⅕': .2, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 };

// unit spelling -> canonical
const UNITS = {
  g: 'g', gr: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  mg: 'mg',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l', ltr: 'l',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  pint: 'pint', pints: 'pint',
  pinch: 'pinch', pinches: 'pinch',
  handful: 'handful', handfuls: 'handful',
  clove: 'clove', cloves: 'clove',
  tin: 'tin', tins: 'tin', can: 'tin', cans: 'tin',
  pack: 'pack', packs: 'pack', packet: 'pack', packets: 'pack',
  bunch: 'bunch', bunches: 'bunch',
  slice: 'slice', slices: 'slice',
  sprig: 'sprig', sprigs: 'sprig',
  stick: 'stick', sticks: 'stick',
  jar: 'jar', jars: 'jar',
  bag: 'bag', bags: 'bag',
  head: 'head', heads: 'head',
  knob: 'knob', knobs: 'knob',
  dash: 'dash', splash: 'splash',
};

const PREP_WORDS = /\b(finely|roughly|thinly|coarsely|freshly|chopped|diced|sliced|minced|grated|crushed|peeled|deseeded|trimmed|halved|quartered|beaten|softened|melted|drained|rinsed|to taste|optional|large|small|medium|fresh|ripe|about|approx\.?|heaped|level|good|of)\b/g;

export const SECTIONS = [
  'Fruit & veg',
  'Meat & fish',
  'Dairy & eggs',
  'Bakery',
  'Cupboard',
  'Herbs & spices',
  'Frozen',
  'Drinks',
  'Household',
  'Other',
];

// First match wins, so specific phrases come before general words.
const SECTION_RULES = [
  [/\bfrozen\b|ice cream|\bpeas\b|oven chips/, 'Frozen'],
  [/coconut milk|tinned|\btins?\b|\bcans?\b|canned|passata|tomato (pur[eé]e|paste)|chopped tomatoes|baked beans|kidney beans|black beans|butter beans|cannellini|chickpea|lentil|\bstock\b|bouillon|gravy|soy sauce|fish sauce|worcester|vinegar|\boil\b|ketchup|mayo|mustard|\bpesto\b|\bsauce\b|\bjam\b|honey|syrup|peanut butter|\brice\b|pasta|spaghetti|penne|fusilli|linguine|tagliatelle|lasagne|macaroni|noodle|couscous|quinoa|\boats?\b|cereal|flour|cornflour|sugar|baking powder|bicarbonate|yeast|cocoa|chocolate|\bnuts?\b|almond|cashew|walnut|peanut|raisin|sultana|crackers|crisps|biscuit|tuna/, 'Cupboard'],
  [/\bsalt\b|black pepper|peppercorn|white pepper|cayenne|chilli (powder|flakes)|chili (powder|flakes)|paprika|cumin|coriander seed|ground coriander|turmeric|garam masala|curry powder|cinnamon|nutmeg|ginger powder|ground ginger|oregano|dried (herbs|thyme|oregano|basil|parsley|mint|rosemary|sage)|mixed herbs|bay lea|allspice|cardamom|fennel seed|spice|seasoning|vanilla/, 'Herbs & spices'],
  [/chicken|beef|pork|lamb|mince|bacon|lardons|sausage|\bham\b|turkey|steak|chorizo|salami|pancetta|prosciutto|duck|venison|salmon|\bcod\b|haddock|prawn|shrimp|\bfish\b|mackerel|sea bass|trout|mussels|squid/, 'Meat & fish'],
  [/\bmilk\b|butter|cheese|cheddar|parmesan|mozzarella|feta|halloumi|ricotta|mascarpone|\bcream\b|cr[eè]me fra[iî]che|yogh?urt|\beggs?\b|quark|paneer/, 'Dairy & eggs'],
  [/bread|\brolls?\b|\bwraps?\b|tortilla|pitta|pita|naan|bagel|croissant|\bbuns?\b|baguette|ciabatta|brioche|crumpet|muffin/, 'Bakery'],
  [/onion|garlic|shallot|tomato|potato|carrot|pepper|chilli|chili|lettuce|spinach|rocket|salad|kale|cabbage|broccoli|cauliflower|courgette|zucchini|aubergine|eggplant|squash|pumpkin|leek|celery|cucumber|avocado|mushroom|sweetcorn|corn on|green beans|mangetout|asparagus|beetroot|parsnip|swede|turnip|radish|ginger|lemongrass|apple|banana|lemon|lime|orange|grape|berr|melon|mango|pineapple|pear|peach|plum|cherr|kiwi|coriander|cilantro|parsley|basil|mint|thyme|rosemary|dill|chives|sage|herbs/, 'Fruit & veg'],
  [/juice|water|wine|beer|lager|cider|coffee|\btea\b|squash drink|lemonade|cola/, 'Drinks'],
  [/kitchen roll|foil|cling|bin bag|washing|detergent|soap|toilet|tissue|sponge|bleach/, 'Household'],
];

export function guessSection(name) {
  const n = name.toLowerCase();
  for (const [re, section] of SECTION_RULES) if (re.test(n)) return section;
  return 'Other';
}

function toNumber(s) {
  s = s.trim().replace(',', '.');
  let total = 0;
  for (const part of s.split(/\s+/)) {
    if (FRACTIONS[part] != null) total += FRACTIONS[part];
    else if (/^\d+\/\d+$/.test(part)) { const [a, b] = part.split('/').map(Number); total += b ? a / b : 0; }
    else if (/^\d+(\.\d+)?$/.test(part)) total += Number(part);
    else {
      // e.g. "1½"
      const m = part.match(/^(\d+)([½⅓⅔¼¾⅕⅛⅜⅝⅞])$/);
      if (m) total += Number(m[1]) + FRACTIONS[m[2]];
      else return null;
    }
  }
  return total;
}

/** Remove bullet characters and whitespace that scanning or pasting leaves at the start of a line. */
export function cleanLine(line) {
  return line
    .replace(/^[\s•●▪◦·*\-–—□☐✓✔>»]+/, '')
    .replace(/^o\s+(?=\S)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse "200g plain flour, sifted" -> { qty: 200, unit: 'g', name: 'plain flour', note: 'sifted', raw }
 */
// "600g/1lb 5oz pork" -> keep "600g" and drop the imperial alternative after the slash
const METRIC_IMPERIAL = /^([\d.,½⅓⅔¼¾⅕⅛⅜⅝⅞]+\s*(?:g|kg|ml|l))\s*\/\s*[\d.,½⅓⅔¼¾⅕⅛⅜⅝⅞]+\s*(?:fl\s*oz|oz|lb|pints?)\b(?:\s+[\d.,½⅓⅔¼¾⅕⅛⅜⅝⅞]+\s*(?:fl\s*)?oz\b)?/i;

export function parseIngredient(raw) {
  const line = cleanLine(raw).replace(METRIC_IMPERIAL, '$1');
  // "2 x 400g tins chopped tomatoes" -> 2 tin, "chopped tomatoes" (400g kept as a note)
  const multi = line.match(/^(\d+)\s*x\s*(\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b)\s*(tins?|cans?|packs?|packets?|jars?|bags?|bottles?)?\s*(?:of\s+)?(.+)$/i);
  if (multi) {
    const container = multi[3] ? (UNITS[multi[3].toLowerCase()] || multi[3].toLowerCase().replace(/s$/, '')) : '';
    return { raw: line, qty: Number(multi[1]), unit: container, name: multi[4].split(',')[0].trim(), note: multi[2] };
  }
  const fr = Object.keys(FRACTIONS).join('');
  const numRe = `(?:\\d+(?:[.,]\\d+)?(?:\\s*[${fr}])?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+|[${fr}])`;
  const re = new RegExp(`^(${numRe})(?:\\s*(?:-|–|to)\\s*(${numRe}))?\\s*(?:x\\s+)?([a-zA-Z]+\\.?)?\\s*(.*)$`);
  let qty = null, unit = '', rest = line;
  const m = line.match(re);
  if (m) {
    const a = toNumber(m[1].replace(/(\d)([½⅓⅔¼¾⅕⅛⅜⅝⅞])/, '$1 $2'));
    const b = m[2] ? toNumber(m[2]) : null;
    const maybeUnit = (m[3] || '').toLowerCase().replace(/\.$/, '');
    if (a != null) {
      qty = b != null ? b : a;
      if (maybeUnit && UNITS[maybeUnit]) { unit = UNITS[maybeUnit]; rest = m[4]; }
      else rest = ((m[3] || '') + ' ' + m[4]).trim();
    }
  }
  rest = rest.replace(/^of\s+/i, '');
  let name = rest, note = '';
  const comma = rest.indexOf(',');
  if (comma > 0) { name = rest.slice(0, comma); note = rest.slice(comma + 1).trim(); }
  name = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (!name) name = line;
  return { raw: line, qty, unit, name, note };
}

/** Key used to decide that two ingredients are "the same thing" on the shopping list. */
export function ingredientKey(name) {
  let n = name.toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(g|kg|ml|l|oz|lb)\b/g, ' ')
    .replace(PREP_WORDS, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  n = n.split(' ').map(w => {
    if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }).join(' ');
  return n;
}

export function displayName(name) {
  const n = name.replace(/\s+/g, ' ').trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  const whole = Math.floor(n), frac = n - whole;
  const named = [[.125, '⅛'], [.25, '¼'], [.5, '½'], [.75, '¾'], [1 / 3, '⅓'], [2 / 3, '⅔']].find(([v]) => Math.abs(v - frac) < .02);
  if (named) return (whole || '') + named[1];
  return String(Math.round(n * 100) / 100);
}

/** amounts: [{qty, unit}] -> "400g + 1 tin" */
export function formatAmounts(amounts = []) {
  const parts = [];
  let unknown = false;
  for (const a of amounts) {
    if (a.qty == null) { unknown = true; continue; }
    const u = a.unit;
    if (!u) parts.push(fmtNum(a.qty));
    else if (/^(g|kg|mg|ml|l|oz|lb)$/.test(u)) parts.push(fmtNum(a.qty) + u);
    else parts.push(`${fmtNum(a.qty)} ${u}${a.qty > 1 && !/(pinch|dash|splash|tsp|tbsp)$/.test(u) ? (u.endsWith('ch') ? 'es' : 's') : ''}`);
  }
  if (!parts.length && unknown) return '';
  return parts.join(' + ');
}

/** Add an amount into an existing list, summing where units match (and converting g/kg, ml/l). */
export function addAmount(amounts, qty, unit) {
  const base = (q, u) => (u === 'kg' ? { qty: q * 1000, unit: 'g' } : u === 'l' ? { qty: q * 1000, unit: 'ml' } : { qty: q, unit: u });
  const list = amounts.map(a => (a.qty == null ? { ...a } : base(a.qty, a.unit)));
  if (qty == null) {
    if (!list.some(a => a.qty == null)) list.push({ qty: null, unit: '' });
    return list;
  }
  const { qty: q, unit: u } = base(qty, unit);
  const hit = list.find(a => a.qty != null && a.unit === u);
  if (hit) hit.qty += q; else list.push({ qty: q, unit: u });
  // tidy big metric values back up
  for (const a of list) {
    if (a.unit === 'g' && a.qty >= 1000) { a.qty = a.qty / 1000; a.unit = 'kg'; }
    if (a.unit === 'ml' && a.qty >= 1000) { a.qty = a.qty / 1000; a.unit = 'l'; }
  }
  return list;
}

/* ---------- scaling for a different number of people ---------- */

/** A friendly number for a scaled amount: whole grams, quarters for spoons and items. */
function niceNum(n) {
  if (n >= 100) return String(Math.round(n / 5) * 5);
  if (n >= 10) return String(Math.round(n));
  if (n < 0.2) return '⅛';
  const q = Math.round(n * 4) / 4;
  if (Math.abs(n - q) < 0.09) return fmtNum(q);
  const third = [1 / 3, 2 / 3].find(t => Math.abs((n % 1) - t) < 0.05);
  return third ? fmtNum(Math.floor(n) + third) : String(Math.round(n * 10) / 10);
}

/**
 * Multiply the amounts at the start of an ingredient line, e.g. scaleLine("600g/1lb 5oz pork", 0.5)
 * -> "300g/10½oz pork". Numbers inside the name, or the size after "2 x", are left alone.
 */
export function scaleLine(line, factor) {
  if (!factor || Math.abs(factor - 1) < 1e-6) return line;
  const fr = Object.keys(FRACTIONS).join('');
  const num = new RegExp(`^(?:\\d+(?:[.,]\\d+)?(?:\\s*[${fr}])?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+|[${fr}])`);
  let out = '', rest = line, skipNext = false, sawNumber = false;
  for (let guard = 0; guard < 30 && rest; guard++) {
    const sp = rest.match(/^[\s/–-]+/);
    if (sp) { out += sp[0]; rest = rest.slice(sp[0].length); continue; }
    const n = rest.match(num);
    if (n) {
      const v = toNumber(n[0].replace(/(\d)([½⅓⅔¼¾⅕⅛⅜⅝⅞])/, '$1 $2'));
      out += v == null || skipNext ? n[0] : niceNum(v * factor);
      skipNext = false; sawNumber = true;
      rest = rest.slice(n[0].length);
      continue;
    }
    const w = rest.match(/^([a-zA-Z]+)\.?/);
    if (w && sawNumber && (UNITS[w[1].toLowerCase()] || /^(x|to)$/i.test(w[1]))) {
      if (/^x$/i.test(w[1])) skipNext = true;
      out += w[0]; rest = rest.slice(w[0].length);
      continue;
    }
    break;
  }
  return out + rest;
}

/** First whole number in "Serves 4-6" / "4 people" -> 4, or null. */
export function servesNumber(serves) {
  const m = String(serves || '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** Is this ingredient something kept in the cupboard? `pantry` is a list of names. */
export function inPantry(line, pantry) {
  if (!pantry || !pantry.length) return false;
  const key = ` ${ingredientKey(parseIngredient(line).name)} `;
  return pantry.some(p => { const k = ingredientKey(p); return k && key.includes(` ${k} `); });
}
