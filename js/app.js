import { firebaseConfig } from '../firebase-config.js';
import {
  LocalStore, FirebaseStore, COLLECTIONS, householdExists, createHousehold,
  makeHouseholdCode, normaliseCode, newId,
} from './store.js';
import {
  parseIngredient, ingredientKey, displayName, guessSection, formatAmounts, addAmount, cleanLine, SECTIONS,
} from './ingredients.js';
import { scanImage, parseRecipeText, makeThumbnail } from './scan.js';

const APP_VERSION = '1.0.0';

const DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];
const MEALS = ['breakfast', 'lunch', 'dinner'];
const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
// Default: Monday–Friday dinner only; weekends breakfast, lunch and dinner.
const DEFAULT_DAYS = Object.fromEntries(DAYS.map((d, i) => [d.key,
  i < 5 ? { breakfast: false, lunch: false, dinner: true } : { breakfast: true, lunch: true, dinner: true }]));

/* ---------------- dates ---------------- */
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fromYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
const fmtDay = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/* ---------------- state ---------------- */
const state = {
  store: null,
  household: null,
  loaded: new Set(),
  settings: { days: DEFAULT_DAYS },
  recipes: new Map(),
  plans: new Map(),
  shopping: [],
  tab: 'plan',
  week: mondayOf(new Date()),
  recipeQuery: '',
  shopDraft: '',
  sheetRefresh: null,
  unsubs: [],
};

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

function setTop(title, actions = '') {
  $('#title').textContent = title;
  $('#topbar-actions').innerHTML = actions;
}

function openSheet(title, bodyHtml, { actions = '' } = {}) {
  const sheet = $('#sheet');
  state.sheetRefresh = null;
  sheet.innerHTML = `<div class="sheet-head"><span class="grab"></span><h2>${esc(title)}</h2>${actions}
    <button class="icon-btn" data-close aria-label="Close">✕</button></div><div class="sheet-body">${bodyHtml}</div>`;
  sheet.hidden = false;
  $('#sheet-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  sheet.scrollTop = 0;
  $('[data-close]', sheet).onclick = closeSheet;
  return { sheet, body: $('.sheet-body', sheet) };
}
function closeSheet() {
  const sheet = $('#sheet');
  sheet.hidden = true;
  sheet.innerHTML = '';
  $('#sheet-backdrop').hidden = true;
  document.body.style.overflow = '';
  state.sheetRefresh = null;
}

function slotLabel(week, slot) {
  const [dayKey, meal] = slot.split('_');
  const i = DAYS.findIndex(d => d.key === dayKey);
  return `${DAYS[i].label} ${MEAL_LABEL[meal].toLowerCase()} (${fmtDay(addDays(fromYmd(week), i))})`;
}
function slotsFor(week) { return state.plans.get(week)?.slots || {}; }
function setSlot(week, slot, entries) { return state.store.merge('plans', week, { slots: { [slot]: entries } }); }
function addToSlot(week, slot, entry) {
  return setSlot(week, slot, [...(slotsFor(week)[slot] || []), { id: newId(), ...entry }]);
}

const qtyOf = item => item.qtyText || formatAmounts(item.amounts);
const sortedRecipes = () => [...state.recipes.values()].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;

/* ---------------- data connection ---------------- */
function mergeDays(days) {
  const out = {};
  for (const d of DAYS) out[d.key] = { ...DEFAULT_DAYS[d.key], ...((days || {})[d.key] || {}) };
  return out;
}

function connect(store) {
  state.unsubs.forEach(u => u());
  state.unsubs = [];
  state.store = store;
  state.loaded = new Set();
  const onErr = e => toast(`Sync problem: ${e.code || e.message}`);
  const done = col => { state.loaded.add(col); scheduleRender(); };
  state.unsubs.push(
    store.subscribe('meta', docs => {
      const s = docs.find(d => d.id === 'settings');
      state.settings = { days: mergeDays(s && s.days) };
      done('meta');
    }, onErr),
    store.subscribe('recipes', docs => { state.recipes = new Map(docs.map(d => [d.id, d])); done('recipes'); }, onErr),
    store.subscribe('plans', docs => { state.plans = new Map(docs.map(d => [d.id, d])); done('plans'); }, onErr),
    store.subscribe('shopping', docs => { state.shopping = docs; done('shopping'); }, onErr),
  );
  $('.tabbar').hidden = false;
}

let rafId = 0;
function scheduleRender() {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    render();
    if (state.sheetRefresh) state.sheetRefresh();
  });
}

/* ---------------- rendering ---------------- */
function render() {
  if (!state.store) return;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  const left = state.shopping.filter(i => !i.checked).length;
  const badge = $('#shop-badge');
  badge.hidden = !left;
  badge.textContent = left;

  if (!COLLECTIONS.every(c => state.loaded.has(c))) {
    view.innerHTML = '<p class="empty">Loading…</p>';
    return;
  }
  // keep focus/caret in a text box when live data re-renders the screen
  const active = document.activeElement;
  const focusId = active && active.id && view.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  ({ plan: renderPlan, recipes: renderRecipes, shopping: renderShopping, settings: renderSettings })[state.tab]();

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ } }
  }
}

/* ----- Plan ----- */
function weekName(week) {
  const diff = Math.round((week - mondayOf(new Date())) / (7 * 864e5));
  if (diff === 0) return 'This week';
  if (diff === 1) return 'Next week';
  if (diff === -1) return 'Last week';
  return diff > 0 ? `In ${diff} weeks` : `${-diff} weeks ago`;
}

function chipHtml(e, slot) {
  const x = `<button class="chip-x" data-action="remove-entry" data-slot="${slot}" data-entry="${e.id}" aria-label="Remove">✕</button>`;
  if (e.type === 'text') return `<span class="chip text"><span class="chip-main">${esc(e.text)}</span>${x}</span>`;
  const r = state.recipes.get(e.recipeId);
  return `<span class="chip"><button class="chip-main" data-action="open-recipe" data-recipe="${esc(e.recipeId)}" ${r ? '' : 'disabled'}>${r ? esc(r.title) : 'Deleted recipe'}</button>${x}</span>`;
}

function renderPlan() {
  const week = ymd(state.week);
  const isThisWeek = week === ymd(mondayOf(new Date()));
  setTop('Meal plan', isThisWeek ? '' : '<button class="btn small" data-action="this-week">This week</button>');
  const slots = slotsFor(week);
  const today = ymd(new Date());
  let html = `<div class="week-nav">
    <button class="icon-btn" data-action="week" data-dir="-1" aria-label="Previous week">‹</button>
    <div class="label">${weekName(state.week)}<small>${fmtDay(state.week)} – ${fmtDay(addDays(state.week, 6))}</small></div>
    <button class="icon-btn" data-action="week" data-dir="1" aria-label="Next week">›</button></div>`;
  let any = false;
  DAYS.forEach((d, i) => {
    const meals = MEALS.filter(m => state.settings.days[d.key][m]);
    if (!meals.length) return;
    any = true;
    const date = addDays(state.week, i);
    html += `<div class="card ${ymd(date) === today ? 'today' : ''}">
      <div class="card-head"><h2>${d.label}</h2><span class="sub">${ymd(date) === today ? 'Today · ' : ''}${fmtDay(date)}</span></div>`;
    for (const m of meals) {
      const slot = `${d.key}_${m}`;
      html += `<div class="meal-row"><div class="meal-name">${MEAL_LABEL[m]}</div><div class="meal-items">
        ${(slots[slot] || []).map(e => chipHtml(e, slot)).join('')}
        <button class="add-slot" data-action="add-slot" data-slot="${slot}" aria-label="Add to ${d.label} ${MEAL_LABEL[m]}">+ Add</button>
      </div></div>`;
    }
    html += '</div>';
  });
  if (!any) html += '<p class="empty"><span class="big">🗓️</span>No meals are switched on.<br>Choose days and meals in Settings.</p>';
  view.innerHTML = html;
}

/* ----- Recipes ----- */
function recipeListHtml() {
  const q = state.recipeQuery.trim().toLowerCase();
  const list = sortedRecipes().filter(r => !q || (r.title || '').toLowerCase().includes(q) || (r.ingredients || []).some(i => i.toLowerCase().includes(q)));
  if (!list.length) return `<p class="empty">No recipes match “${esc(state.recipeQuery)}”.</p>`;
  return list.map(r => `<button class="recipe-item" data-action="open-recipe" data-recipe="${esc(r.id)}">
      ${r.photo ? `<img class="thumb" src="${r.photo}" alt="">` : '<span class="thumb">🍽️</span>'}
      <span class="grow"><span class="t">${esc(r.title)}</span><br><span class="s">${(r.ingredients || []).length} ingredients${r.serves ? ` · serves ${esc(r.serves)}` : ''}</span></span>
      <span class="muted">›</span></button>`).join('');
}

function renderRecipes() {
  setTop('Recipes', '<button class="btn small primary" data-action="new-recipe">+ New</button>');
  if (!state.recipes.size) {
    view.innerHTML = `<div class="empty"><span class="big">📖</span>No recipes yet.<br>Scan one from a cookbook or magazine with your camera.
      <div style="margin-top:16px"><button class="btn primary" data-action="new-recipe">📷 Add your first recipe</button></div></div>`;
    return;
  }
  view.innerHTML = `<input type="search" id="recipe-search" class="search" placeholder="Search recipes or ingredients" value="${esc(state.recipeQuery)}" autocomplete="off">
    <div class="card" id="recipe-list">${recipeListHtml()}</div>`;
}

/* ----- Shopping ----- */
function renderShopping() {
  const items = state.shopping;
  const done = items.filter(i => i.checked).length;
  setTop('Shopping', `${items.length ? '<button class="icon-btn" data-action="share-list" aria-label="Share list">⬆️</button>' : ''}${done ? `<button class="btn small" data-action="clear-done">Clear ${done} ticked</button>` : ''}`);
  let html = `<form class="shop-add" id="shop-add"><input type="text" id="shop-input" placeholder="Add an item, e.g. 2 lemons" value="${esc(state.shopDraft)}" autocomplete="off" enterkeyhint="done"><button class="btn primary" type="submit">Add</button></form>`;
  if (!items.length) {
    view.innerHTML = html + '<p class="empty"><span class="big">🛒</span>Your shopping list is empty.<br>Open a recipe from your meal plan and tick what you need.</p>';
    return;
  }
  const groups = new Map(SECTIONS.map(s => [s, []]));
  for (const it of items) (groups.get(it.section) || groups.get('Other')).push(it);
  for (const [section, list] of groups) {
    if (!list.length) continue;
    list.sort((a, b) => (a.checked - b.checked) || a.name.localeCompare(b.name));
    html += `<div class="section-title">${esc(section)}</div><div class="card">${list.map(it => `
      <div class="shop-item ${it.checked ? 'done' : ''}">
        <input type="checkbox" class="check" data-action="toggle-item" data-id="${esc(it.id)}" ${it.checked ? 'checked' : ''} aria-label="Got ${esc(it.name)}">
        <button class="name" data-action="edit-item" data-id="${esc(it.id)}"><b>${esc(it.name)}</b>${qtyOf(it) ? ` <span class="qty">${esc(qtyOf(it))}</span>` : ''}
        ${(it.sources || []).length ? `<span class="src">for ${esc(it.sources.join(', '))}</span>` : ''}</button>
      </div>`).join('')}</div>`;
  }
  view.innerHTML = html;
}

/* ----- Settings ----- */
function renderSettings() {
  setTop('Settings');
  const days = state.settings.days;
  let html = `<div class="section-title">Meals to plan</div>
    <div class="card"><div class="card-body">
      <table class="days-grid"><tr><th></th>${MEALS.map(m => `<th>${MEAL_LABEL[m]}</th>`).join('')}</tr>
      ${DAYS.map(d => `<tr><td>${d.label}</td>${MEALS.map(m => `<td><input type="checkbox" class="check" data-action="toggle-meal" data-day="${d.key}" data-meal="${m}" ${days[d.key][m] ? 'checked' : ''} aria-label="${d.label} ${MEAL_LABEL[m]}"></td>`).join('')}</tr>`).join('')}
      </table>
      <button class="link-btn" data-action="reset-days">Reset to default (weekday dinners, all weekend meals)</button>
    </div></div>`;

  html += '<div class="section-title">Household sharing</div><div class="card"><div class="card-body stack">';
  if (state.store.kind === 'firebase') {
    html += `<p class="small" style="margin:0">Everyone using this code sees the same meal plan, recipes and shopping list. To add someone, they install the app and choose <b>Join household</b>.</p>
      <div class="code-box">${esc(state.household)}</div>
      <button class="btn block" data-action="share-code">Send code to someone</button>
      <button class="btn danger block" data-action="leave-household">Leave household on this phone</button>`;
  } else {
    html += `<div class="notice">Sharing isn’t switched on yet, so everything is saved on <b>this phone only</b>. Follow step 2 in SETUP.md to connect a free Firebase database; your existing recipes and plans will be copied across.</div>`;
  }
  html += '</div></div>';

  if (isIOS && !isStandalone()) {
    html += `<div class="section-title">Install</div><div class="card"><div class="card-body small">
      To put Meal Planner on your Home Screen: in Safari tap the <b>Share</b> button (square with an arrow), scroll down and tap <b>Add to Home Screen</b>.</div></div>`;
  }

  html += `<div class="section-title">Backup</div><div class="card"><div class="card-body stack">
      <p class="small muted" style="margin:0">${state.recipes.size} recipes, ${state.plans.size} planned weeks, ${state.shopping.length} shopping items.</p>
      <button class="btn block" data-action="export">Save a backup file</button>
      <label class="btn block file-btn">Restore from a backup file<input type="file" accept="application/json,.json" data-action="import"></label>
    </div></div>
    <p class="center small muted">Meal Planner ${APP_VERSION}</p>`;
  view.innerHTML = html;
}

/* ---------------- sheets ---------------- */
function openAddToSlot(week, slot) {
  const label = slotLabel(week, slot);
  const { body } = openSheet(`Add to ${label.split(' (')[0]}`, `
    <form id="free-form" class="row"><input type="text" id="free-text" class="grow" placeholder="Type anything, e.g. Pizza night" autocomplete="off" enterkeyhint="done"><button class="btn" type="submit">Add</button></form>
    <div class="row" style="flex-wrap:wrap;margin-top:8px">${['Leftovers', 'Takeaway', 'Eating out', 'Freezer meal'].map(t => `<button class="btn small" data-quick="${t}">${t}</button>`).join('')}</div>
    <div class="section-title">Or choose a recipe</div>
    ${state.recipes.size > 6 ? '<input type="search" id="pick-search" placeholder="Search recipes" autocomplete="off" style="margin-bottom:6px">' : ''}
    <ul class="pick-list" id="pick-list"></ul>
    <button class="btn block" data-act="new" style="margin-top:10px">+ New recipe</button>`);

  const list = $('#pick-list', body);
  const fill = (q = '') => {
    const rs = sortedRecipes().filter(r => r.title.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = rs.length
      ? rs.map(r => `<li><button data-pick="${esc(r.id)}">${r.photo ? `<img class="thumb" style="width:36px;height:36px" src="${r.photo}" alt="">` : '<span class="thumb" style="width:36px;height:36px;font-size:18px">🍽️</span>'}<span class="grow">${esc(r.title)}</span></button></li>`).join('')
      : `<li class="muted small" style="padding:10px 4px">${state.recipes.size ? 'No matches.' : 'No saved recipes yet.'}</li>`;
  };
  fill();
  const search = $('#pick-search', body);
  if (search) search.oninput = () => fill(search.value);

  const addText = async text => {
    text = text.trim();
    if (!text) return;
    await addToSlot(week, slot, { type: 'text', text });
    closeSheet();
    toast(`Added to ${label.split(' (')[0]}`);
  };
  $('#free-form', body).onsubmit = e => { e.preventDefault(); addText($('#free-text', body).value); };
  body.onclick = async e => {
    const q = e.target.closest('[data-quick]');
    if (q) return addText(q.dataset.quick);
    const p = e.target.closest('[data-pick]');
    if (p) {
      await addToSlot(week, slot, { type: 'recipe', recipeId: p.dataset.pick });
      closeSheet();
      toast(`Added to ${label.split(' (')[0]}`);
    }
    if (e.target.closest('[data-act="new"]')) {
      openEditor(null, { onSaved: id => addToSlot(week, slot, { type: 'recipe', recipeId: id }) });
    }
  };
}

function methodHtml(text) {
  const parts = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) return `<ol>${parts.map(p => `<li>${esc(p)}</li>`).join('')}</ol>`;
  return esc(text);
}

async function addToShopping(lines, source) {
  const pending = new Map();
  for (const raw of lines) {
    const p = parseIngredient(raw);
    const key = ingredientKey(p.name) || p.name.toLowerCase();
    let item = pending.get(key);
    if (!item) {
      const ex = state.shopping.find(i => !i.checked && i.key === key);
      item = ex
        ? { ...ex, amounts: [...(ex.amounts || [])], sources: [...(ex.sources || [])] }
        : { id: newId(), name: displayName(p.name), key, amounts: [], qtyText: '', section: guessSection(p.unit === 'tin' ? `tin ${p.name}` : p.name), checked: false, sources: [], createdAt: Date.now() };
      pending.set(key, item);
    }
    if (item.qtyText) {
      const extra = formatAmounts(addAmount([], p.qty, p.unit));
      if (extra) item.qtyText += ` + ${extra}`;
    } else {
      item.amounts = addAmount(item.amounts, p.qty, p.unit);
    }
    if (source && !item.sources.includes(source)) item.sources.push(source);
  }
  await state.store.batch([...pending.values()].map(({ id, ...val }) => ({ op: 'set', col: 'shopping', id, val })));
  return pending.size;
}

function openRecipe(id) {
  const r = state.recipes.get(id);
  if (!r) { toast('That recipe has been deleted'); return; }
  const ticked = new Set(); // ingredients start unticked: tick what you need
  const { sheet, body } = openSheet(r.title, '', { actions: '<button class="btn small" data-act="edit">Edit</button>' });
  $('[data-act="edit"]', sheet).onclick = () => openEditor(id);

  const renderBody = () => {
    const rec = state.recipes.get(id);
    if (!rec) { closeSheet(); return; }
    $('.sheet-head h2', sheet).textContent = rec.title;
    const ings = rec.ingredients || [];
    const onList = new Set(state.shopping.filter(i => !i.checked).map(i => i.key));
    const scroll = sheet.scrollTop;
    body.innerHTML = `
      ${rec.photo ? `<img class="hero" src="${rec.photo}" alt="">` : ''}
      ${rec.serves || rec.source ? `<p class="small muted" style="margin:0 0 8px">${rec.serves ? `Serves ${esc(rec.serves)}` : ''}${rec.serves && rec.source ? ' · ' : ''}${esc(rec.source || '')}</p>` : ''}
      <div class="row"><h3 class="grow" style="margin:6px 0">Ingredients</h3>
        ${ings.length ? `<button class="link-btn" data-act="all">${ticked.size === ings.length ? 'Untick all' : 'Tick all'}</button>` : ''}</div>
      ${ings.length ? `<p class="small muted" style="margin:0 0 4px">Tick the items you need to buy.</p>
      <ul class="ing-list">${ings.map((line, i) => `<li><label><input type="checkbox" class="check" data-i="${i}" ${ticked.has(i) ? 'checked' : ''}><span class="grow">${esc(line)}</span></label>
        ${onList.has(ingredientKey(parseIngredient(line).name)) ? '<span class="on-list">On list</span>' : ''}</li>`).join('')}</ul>
      <div class="sticky-action"><button class="btn primary block" data-act="add" ${ticked.size ? '' : 'disabled'}>${ticked.size ? `🛒 Add ${ticked.size} to shopping list` : 'Tick items to add them'}</button></div>`
      : '<p class="muted small">No ingredients saved. Tap Edit to add some.</p>'}
      ${rec.method ? `<h3>Method</h3><div class="method">${methodHtml(rec.method)}</div>` : ''}
      <button class="btn block" data-act="plan" style="margin-top:20px">📅 Add to meal plan</button>`;
    sheet.scrollTop = scroll;
  };
  renderBody();
  state.sheetRefresh = renderBody;

  body.onchange = e => {
    const cb = e.target.closest('[data-i]');
    if (!cb) return;
    const i = Number(cb.dataset.i);
    cb.checked ? ticked.add(i) : ticked.delete(i);
    renderBody();
  };
  body.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const ings = state.recipes.get(id)?.ingredients || [];
    if (act === 'all') {
      if (ticked.size === ings.length) ticked.clear(); else ings.forEach((_, i) => ticked.add(i));
      renderBody();
    } else if (act === 'add') {
      const lines = [...ticked].sort((a, b) => a - b).map(i => ings[i]).filter(Boolean);
      await addToShopping(lines, state.recipes.get(id).title);
      ticked.clear();
      renderBody();
      toast(`Added ${lines.length} item${lines.length === 1 ? '' : 's'} to the shopping list`);
    } else if (act === 'plan') {
      openPlanPicker(id);
    }
  };
}

function openPlanPicker(recipeId) {
  const r = state.recipes.get(recipeId);
  let week = new Date(state.week);
  const { body } = openSheet(`Plan “${r.title}”`, '');
  const draw = () => {
    const wk = ymd(week);
    const slots = slotsFor(wk);
    let html = `<div class="week-nav"><button class="icon-btn" data-dir="-1" aria-label="Previous week">‹</button>
      <div class="label">${weekName(week)}<small>${fmtDay(week)} – ${fmtDay(addDays(week, 6))}</small></div>
      <button class="icon-btn" data-dir="1" aria-label="Next week">›</button></div><ul class="pick-list">`;
    DAYS.forEach((d, i) => MEALS.filter(m => state.settings.days[d.key][m]).forEach(m => {
      const slot = `${d.key}_${m}`;
      const now = (slots[slot] || []).map(e => e.type === 'text' ? e.text : (state.recipes.get(e.recipeId)?.title || '')).filter(Boolean).join(', ');
      html += `<li><button data-slot="${slot}"><span class="grow"><b>${d.label.slice(0, 3)} ${fmtDay(addDays(week, i))}</b> · ${MEAL_LABEL[m]}
        ${now ? `<br><span class="small muted">${esc(now)}</span>` : ''}</span><span class="muted">+</span></button></li>`;
    }));
    body.innerHTML = html + '</ul>';
  };
  draw();
  body.onclick = async e => {
    const dir = e.target.closest('[data-dir]');
    if (dir) { week = addDays(week, 7 * Number(dir.dataset.dir)); draw(); return; }
    const s = e.target.closest('[data-slot]');
    if (s) {
      const wk = ymd(week);
      await addToSlot(wk, s.dataset.slot, { type: 'recipe', recipeId });
      closeSheet();
      toast(`Added to ${slotLabel(wk, s.dataset.slot).split(' (')[0]}`);
    }
  };
}

function openEditor(id, { onSaved } = {}) {
  const r = id ? state.recipes.get(id) : null;
  let photo = (r && r.photo) || '';
  const { body } = openSheet(r ? 'Edit recipe' : 'New recipe', `
    <div class="stack">
      <div class="card" style="margin:0"><div class="card-body stack">
        <div class="small muted">Scan a recipe page with your camera. You can scan several pages – each one is added below for you to check.</div>
        <div class="scan-buttons">
          <label class="btn primary file-btn">📷 Take photo<input type="file" accept="image/*" capture="environment" data-scan></label>
          <label class="btn file-btn">🖼️ From photos<input type="file" accept="image/*" data-scan></label>
        </div>
        <div id="scan-status" class="stack" hidden><div class="small" id="scan-msg"></div><div class="progress"><div id="scan-bar"></div></div></div>
      </div></div>
      <div id="photo-wrap"></div>
      <label class="field"><span>Recipe name</span><input type="text" id="ed-title" value="${esc(r?.title)}" placeholder="e.g. Chicken fajitas"></label>
      <label class="field"><span>Serves</span><input type="text" id="ed-serves" inputmode="numeric" value="${esc(r?.serves)}" placeholder="e.g. 4"></label>
      <label class="field"><span>Ingredients – one per line</span><textarea id="ed-ings" rows="9" placeholder="400g chicken breast&#10;2 red peppers&#10;1 onion">${esc((r?.ingredients || []).join('\n'))}</textarea></label>
      <label class="field"><span>Method</span><textarea id="ed-method" rows="9" placeholder="Leave a blank line between steps">${esc(r?.method)}</textarea></label>
      <label class="field"><span>Source / notes</span><input type="text" id="ed-source" value="${esc(r?.source)}" placeholder="e.g. Family favourite, cookbook p.42"></label>
      <button class="btn primary block" data-act="save">Save recipe</button>
      ${r ? '<button class="btn danger block" data-act="delete">Delete recipe</button>' : ''}
    </div>`);

  const drawPhoto = () => {
    $('#photo-wrap', body).innerHTML = photo
      ? `<img class="hero" src="${photo}" alt="Recipe photo" style="margin-bottom:4px"><button class="link-btn" data-act="remove-photo">Remove photo</button>`
      : '';
  };
  drawPhoto();

  const status = $('#scan-status', body), msg = $('#scan-msg', body), bar = $('#scan-bar', body);
  const field = s => $(s, body);
  const append = (sel, text, sep) => { const el = field(sel); el.value = el.value.trim() ? `${el.value.trim()}${sep}${text}` : text; };

  body.addEventListener('change', async e => {
    const input = e.target.closest('[data-scan]');
    if (!input || !input.files[0]) return;
    const file = input.files[0];
    input.value = '';
    body.querySelectorAll('[data-scan]').forEach(i => { i.disabled = true; });
    status.hidden = false;
    bar.style.width = '0%';
    msg.textContent = 'Preparing photo…';
    try {
      if (!photo) { photo = await makeThumbnail(file); drawPhoto(); }
      const text = await scanImage(file, (p, m) => { bar.style.width = `${Math.round(p * 100)}%`; msg.textContent = m; });
      const parsed = parseRecipeText(text);
      if (parsed.title && !field('#ed-title').value.trim()) field('#ed-title').value = parsed.title;
      if (parsed.serves && !field('#ed-serves').value.trim()) field('#ed-serves').value = parsed.serves;
      if (parsed.ingredients.length) append('#ed-ings', parsed.ingredients.join('\n'), '\n');
      if (parsed.method) append('#ed-method', parsed.method, '\n\n');
      if (!parsed.ingredients.length && !parsed.method && text.trim()) append('#ed-method', text.trim(), '\n\n');
      msg.textContent = text.trim()
        ? `Found ${parsed.ingredients.length} ingredient${parsed.ingredients.length === 1 ? '' : 's'}${parsed.method ? ' and a method' : ''}. Please check them below and fix any mistakes.`
        : 'No text found. Try again in good light, holding the phone flat above the page.';
    } catch (err) {
      console.error(err);
      msg.textContent = `Couldn’t read that photo: ${err.message || err}`;
    } finally {
      body.querySelectorAll('[data-scan]').forEach(i => { i.disabled = false; });
    }
  });

  body.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove-photo') { photo = ''; drawPhoto(); }
    if (act === 'save') {
      const title = field('#ed-title').value.trim();
      if (!title) { toast('Please give the recipe a name'); field('#ed-title').focus(); return; }
      const rid = id || newId();
      await state.store.set('recipes', rid, {
        title,
        serves: field('#ed-serves').value.trim(),
        ingredients: field('#ed-ings').value.split('\n').map(cleanLine).filter(Boolean),
        method: field('#ed-method').value.trim(),
        source: field('#ed-source').value.trim(),
        photo,
        createdAt: (r && r.createdAt) || Date.now(),
        updatedAt: Date.now(),
      });
      if (onSaved) await onSaved(rid);
      toast('Recipe saved');
      openRecipe(rid);
    }
    if (act === 'delete' && r) {
      if (!confirm(`Delete “${r.title}”? This can’t be undone.`)) return;
      await state.store.remove('recipes', id);
      closeSheet();
      toast('Recipe deleted');
    }
  });
}

function openItem(id) {
  const it = state.shopping.find(i => i.id === id);
  if (!it) return;
  const original = qtyOf(it);
  const { body } = openSheet('Edit item', `<div class="stack">
    <label class="field"><span>Item</span><input type="text" id="it-name" value="${esc(it.name)}"></label>
    <label class="field"><span>Amount</span><input type="text" id="it-qty" value="${esc(original)}" placeholder="e.g. 500g"></label>
    <label class="field"><span>Shop section</span><select id="it-sec">${SECTIONS.map(s => `<option ${s === it.section ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
    ${(it.sources || []).length ? `<p class="small muted" style="margin:0">Needed for: ${esc(it.sources.join(', '))}</p>` : ''}
    <button class="btn primary block" data-act="save">Save</button>
    <button class="btn danger block" data-act="delete">Remove from list</button></div>`);
  body.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') {
      const name = $('#it-name', body).value.trim() || it.name;
      const qty = $('#it-qty', body).value.trim();
      const { id: _id, ...rest } = it;
      const val = { ...rest, name, key: ingredientKey(name) || name.toLowerCase(), section: $('#it-sec', body).value };
      if (qty !== original) { val.qtyText = qty; val.amounts = []; }
      await state.store.set('shopping', id, val);
      closeSheet();
    }
    if (act === 'delete') { await state.store.remove('shopping', id); closeSheet(); }
  };
}

/* ---------------- actions ---------------- */
async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch { prompt('Copy this:', text); }
}

function shoppingAsText() {
  const lines = [];
  for (const s of SECTIONS) {
    const items = state.shopping.filter(i => !i.checked && (i.section === s || (s === 'Other' && !SECTIONS.includes(i.section))));
    if (!items.length) continue;
    lines.push(s.toUpperCase());
    items.sort((a, b) => a.name.localeCompare(b.name)).forEach(i => lines.push(`• ${i.name}${qtyOf(i) ? ` (${qtyOf(i)})` : ''}`));
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function exportBackup() {
  const data = {
    app: 'meal-planner', version: 1, exportedAt: new Date().toISOString(),
    settings: state.settings,
    recipes: [...state.recipes.values()],
    plans: [...state.plans.values()],
    shopping: state.shopping,
  };
  const name = `meal-planner-backup-${ymd(new Date())}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Meal Planner backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a Meal Planner backup'); return; }
  if (data.app !== 'meal-planner') { toast('That file isn’t a Meal Planner backup'); return; }
  const n = (data.recipes || []).length;
  if (!confirm(`Restore ${n} recipes, ${(data.plans || []).length} planned weeks and ${(data.shopping || []).length} shopping items? Matching items will be replaced.`)) return;
  await copyInto(state.store, data);
  toast('Backup restored');
}

async function copyInto(store, data) {
  const ops = [];
  const strip = ({ id, ...v }) => v;
  if (data.settings) ops.push({ op: 'set', col: 'meta', id: 'settings', val: { days: mergeDays(data.settings.days) } });
  for (const r of data.recipes || []) ops.push({ op: 'set', col: 'recipes', id: r.id, val: strip(r) });
  for (const p of data.plans || []) ops.push({ op: 'set', col: 'plans', id: p.id, val: strip(p) });
  for (const s of data.shopping || []) ops.push({ op: 'set', col: 'shopping', id: s.id, val: strip(s) });
  if (ops.length) await store.batch(ops);
}

function localDataSnapshot() {
  const local = new LocalStore();
  if (!local.hasData()) return null;
  const d = local.dump();
  const list = col => Object.entries(d[col] || {}).map(([id, v]) => ({ id, ...v }));
  return { settings: d.meta && d.meta.settings, recipes: list('recipes'), plans: list('plans'), shopping: list('shopping') };
}

/* ---------------- welcome (household) ---------------- */
function renderWelcome(message = '') {
  $('.tabbar').hidden = true;
  setTop('Meal Planner');
  view.innerHTML = `<div class="welcome stack">
    <div class="logo">🥗</div>
    <h2>Welcome</h2>
    <p class="muted">Share one meal plan, recipe book and shopping list with everyone at home.</p>
    <div class="card"><div class="card-body stack"><b>Setting up for the first time?</b>
      <button class="btn primary block" data-action="create-household">Create a household</button></div></div>
    <div class="card"><div class="card-body stack"><b>Someone already set it up?</b>
      <form id="join-form" class="stack"><input type="text" id="join-code" placeholder="Household code, e.g. PLUM-RIVER-4821" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false">
      <button class="btn block" type="submit">Join household</button></form></div></div>
    <p class="small" id="welcome-msg" style="color:var(--danger)">${esc(message)}</p></div>`;
}

async function enterHousehold(code, { created = false } = {}) {
  const store = await FirebaseStore.open(firebaseConfig, code);
  if (created) {
    const local = localDataSnapshot();
    if (local) await copyInto(store, local);
  }
  localStorage.setItem('mp-household', code);
  state.household = code;
  connect(store);
}

async function welcomeAction(fn) {
  const msg = $('#welcome-msg');
  view.querySelectorAll('button').forEach(b => { b.disabled = true; });
  msg.style.color = 'var(--muted)';
  msg.textContent = 'Connecting…';
  try { await fn(); } catch (e) {
    console.error(e);
    renderWelcome(`Couldn’t connect: ${e.code || e.message}. Check your internet connection and the Firebase setup (SETUP.md).`);
  }
}

/* ---------------- event wiring ---------------- */
document.addEventListener('click', async e => {
  const tabBtn = e.target.closest('.tabbar button');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (e.target.id === 'sheet-backdrop') { closeSheet(); return; }

  const el = e.target.closest('[data-action]');
  if (!el || el.closest('#sheet')) return;
  const week = ymd(state.week);
  switch (el.dataset.action) {
    case 'week': state.week = addDays(state.week, 7 * Number(el.dataset.dir)); render(); break;
    case 'this-week': state.week = mondayOf(new Date()); render(); break;
    case 'add-slot': openAddToSlot(week, el.dataset.slot); break;
    case 'remove-entry': {
      const list = (slotsFor(week)[el.dataset.slot] || []).filter(x => x.id !== el.dataset.entry);
      await setSlot(week, el.dataset.slot, list);
      break;
    }
    case 'open-recipe': openRecipe(el.dataset.recipe); break;
    case 'new-recipe': openEditor(null); break;
    case 'toggle-item': await state.store.merge('shopping', el.dataset.id, { checked: el.checked }); break;
    case 'edit-item': openItem(el.dataset.id); break;
    case 'clear-done': {
      const done = state.shopping.filter(i => i.checked);
      await state.store.batch(done.map(i => ({ op: 'remove', col: 'shopping', id: i.id })));
      toast(`Cleared ${done.length} item${done.length === 1 ? '' : 's'}`);
      break;
    }
    case 'share-list': shareText('Shopping list', shoppingAsText()); break;
    case 'toggle-meal':
      await state.store.merge('meta', 'settings', { days: { ...state.settings.days, [el.dataset.day]: { ...state.settings.days[el.dataset.day], [el.dataset.meal]: el.checked } } });
      break;
    case 'reset-days': await state.store.set('meta', 'settings', { days: DEFAULT_DAYS }); toast('Meal days reset'); break;
    case 'share-code': shareText('Meal Planner household code', `Join our meal planner: open the app, tap “Join household” and enter ${state.household}`); break;
    case 'leave-household':
      if (confirm('Stop using this household on this phone? The shared data stays safe for everyone else, and you can rejoin with the code.')) {
        localStorage.removeItem('mp-household');
        location.reload();
      }
      break;
    case 'export': exportBackup(); break;
    case 'create-household':
      welcomeAction(async () => {
        const code = makeHouseholdCode();
        await createHousehold(firebaseConfig, code);
        state.tab = 'settings';
        await enterHousehold(code, { created: true });
        toast('Household created – share the code with your household');
      });
      break;
    default: break;
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.action === 'import' && el.files[0]) { importBackup(el.files[0]); el.value = ''; }
});

document.addEventListener('input', e => {
  if (e.target.id === 'recipe-search') {
    state.recipeQuery = e.target.value;
    $('#recipe-list').innerHTML = recipeListHtml();
  }
  if (e.target.id === 'shop-input') state.shopDraft = e.target.value;
});

document.addEventListener('submit', async e => {
  if (e.target.id === 'shop-add') {
    e.preventDefault();
    const text = state.shopDraft.trim();
    if (!text) return;
    state.shopDraft = '';
    await addToShopping([text], '');
    render();
  }
  if (e.target.id === 'join-form') {
    e.preventDefault();
    const code = normaliseCode($('#join-code').value);
    if (!code) return;
    welcomeAction(async () => {
      if (!(await householdExists(firebaseConfig, code))) {
        renderWelcome(`No household found with the code ${code}. Check the spelling and try again.`);
        return;
      }
      await enterHousehold(code);
      toast('Joined household');
    });
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

/* ---------------- start ---------------- */
async function boot() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker failed', err));
  }
  if (!firebaseConfig) { connect(new LocalStore()); return; }

  const code = localStorage.getItem('mp-household');
  if (!code) { renderWelcome(); return; }
  view.innerHTML = '<p class="empty">Connecting to your household…</p>';
  try {
    await enterHousehold(code);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><span class="big">📡</span>Couldn’t connect to your household.<br>${esc(e.code || e.message)}
      <div style="margin-top:16px"><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`;
  }
}

boot();
