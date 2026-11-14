import { firebaseConfig } from '../firebase-config.js';
import {
  LocalStore, FirebaseStore, COLLECTIONS, householdExists, createHousehold,
  makeHouseholdCode, normaliseCode, newId,
} from './store.js';
import {
  parseIngredient, ingredientKey, displayName, guessSection, formatAmounts, addAmount, cleanLine, SECTIONS,
} from './ingredients.js';
import { scanRecipe, makeThumbnail } from './scan.js';
import { mountCropper } from './crop.js';

const APP_VERSION = '1.1.0';

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

/* ---------------- history (past planned meals count as eaten) ---------------- */
function buildHistory({ from = null } = {}) {
  const today = ymd(new Date());
  const events = [];
  for (const [wk, doc] of state.plans) {
    const start = fromYmd(wk);
    for (const [slot, entries] of Object.entries(doc.slots || {})) {
      const [dayKey, meal] = slot.split('_');
      const i = DAYS.findIndex(d => d.key === dayKey);
      if (i < 0) continue;
      const date = ymd(addDays(start, i));
      if (date > today || (from && date < from)) continue;
      for (const e of entries || []) {
        if (e.type === 'recipe') {
          const r = state.recipes.get(e.recipeId);
          events.push({ date, day: dayKey, meal, kind: 'recipe', id: e.recipeId, label: r ? r.title : 'Deleted recipe' });
        } else if (e.text && e.text.trim()) {
          events.push({ date, day: dayKey, meal, kind: 'text', id: `t:${e.text.trim().toLowerCase()}`, label: e.text.trim() });
        }
      }
    }
  }
  return events;
}

/** recipeId -> { last: 'YYYY-MM-DD', count, meals: Set } over all time */
function recipeStats() {
  const m = new Map();
  for (const ev of buildHistory()) {
    if (ev.kind !== 'recipe') continue;
    const x = m.get(ev.id) || { last: '', count: 0, meals: new Set() };
    if (ev.date > x.last) x.last = ev.date;
    x.count++;
    x.meals.add(ev.meal);
    m.set(ev.id, x);
  }
  return m;
}

function daysSince(dateStr) { return Math.round((fromYmd(ymd(new Date())) - fromYmd(dateStr)) / 864e5); }
function ago(dateStr) {
  const d = daysSince(dateStr);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 730) return `${Math.round(d / 30.4)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}

/** Which meals a recipe suits: its tags, else what it has been planned for, else dinner. */
function recipeMeals(r, stats) {
  if (Array.isArray(r.meals) && r.meals.length) return r.meals;
  const s = stats && stats.get(r.id);
  if (s && s.meals.size) return [...s.meals];
  return ['dinner'];
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

  ({ plan: renderPlan, recipes: renderRecipes, shopping: renderShopping, history: renderHistory, settings: renderSettings })[state.tab]();

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
  setTop('Meal plan', `${isThisWeek ? '' : '<button class="btn small" data-action="this-week">This week</button>'}<button class="btn small primary" data-action="suggest">✨ Suggest</button>`);
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

/* ----- History ----- */
const PERIODS = [[3, '3 months'], [6, '6 months'], [12, '1 year'], [0, 'All time']];

function countBy(events, keyFn = e => e.id) {
  const m = new Map();
  for (const e of events) {
    const k = keyFn(e);
    const x = m.get(k) || { id: e.id, label: e.label, kind: e.kind, count: 0 };
    x.count++;
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function barsHtml(rows) {
  const max = Math.max(...rows.map(r => r.count), 1);
  return rows.map(r => `<div class="bar-row" title="${esc(r.label)}: ${r.count} time${r.count === 1 ? '' : 's'}">
      <div class="bar-label ${r.kind === 'text' ? 'text-entry' : ''}">${esc(r.label)}</div>
      <div class="bar-track"><div class="bar" style="width:${Math.max(4, (r.count / max) * 100)}%"></div></div>
      <div class="bar-val">${r.count}</div></div>`).join('');
}

function renderHistory() {
  setTop('History', '<button class="btn small primary" data-action="suggest">✨ Suggest</button>');
  const months = state.historyMonths ?? 3;
  let from = null;
  if (months) { const d = new Date(); d.setMonth(d.getMonth() - months); from = ymd(d); }
  const events = buildHistory({ from });

  let html = `<div class="segmented" role="group" aria-label="Time period">${PERIODS.map(([m, l]) =>
    `<button data-action="history-period" data-months="${m}" class="${m === months ? 'on' : ''}" aria-pressed="${m === months}">${l}</button>`).join('')}</div>`;

  // Not had for a while: all recipes, all-time stats, never-had first
  const stats = recipeStats();
  const stale = sortedRecipes()
    .map(r => ({ r, s: stats.get(r.id) }))
    .sort((a, b) => (a.s ? a.s.last : '') .localeCompare(b.s ? b.s.last : ''));
  const staleShown = state.showAllStale ? stale : stale.slice(0, 6);

  if (events.length) {
    const unique = new Set(events.map(e => e.id)).size;
    const fromRecipes = Math.round(100 * events.filter(e => e.kind === 'recipe').length / events.length);
    html += `<div class="tiles">
      <div class="tile"><div class="num">${events.length}</div><div class="lbl">meals planned</div></div>
      <div class="tile"><div class="num">${unique}</div><div class="lbl">different dishes</div></div>
      <div class="tile"><div class="num">${fromRecipes}%</div><div class="lbl">from your recipes</div></div></div>`;
  }

  if (stale.length) {
    html += `<div class="section-title">Not had for a while</div><div class="card">${staleShown.map(({ r, s }) => `
      <div class="recipe-item">
        <button class="grow link-row" data-action="open-recipe" data-recipe="${esc(r.id)}"><span class="t">${esc(r.title)}</span><br>
        <span class="s">${s ? `Last had ${ago(s.last)} · ${s.count}×` : 'Never had'}</span></button>
        <button class="btn small" data-action="plan-recipe" data-recipe="${esc(r.id)}">Plan</button>
      </div>`).join('')}
      ${stale.length > 6 ? `<div class="center"><button class="link-btn" data-action="toggle-stale">${state.showAllStale ? 'Show fewer' : `Show all ${stale.length}`}</button></div>` : ''}</div>`;
  }

  if (!events.length) {
    html += `<p class="empty"><span class="big">📊</span>Nothing to show for this period yet.<br>Meals on your plan are counted here once their day has passed.</p>`;
    view.innerHTML = html;
    return;
  }

  html += `<div class="section-title">Most eaten</div><div class="card"><div class="card-body">${barsHtml(countBy(events).slice(0, 10))}</div></div>`;

  // When: top items for each meal, and the usual pick per weekday
  html += '<div class="section-title">When you eat what</div><div class="card"><div class="card-body stack">';
  for (const m of MEALS) {
    const top = countBy(events.filter(e => e.meal === m)).slice(0, 3);
    if (!top.length) continue;
    html += `<div><div class="habit-head">${MEAL_LABEL[m]}</div>${top.map(t => `<div class="habit"><span class="${t.kind === 'text' ? 'text-entry' : ''}">${esc(t.label)}</span><span class="muted">${t.count}×</span></div>`).join('')}</div>`;
  }
  const dayRows = DAYS.map(d => {
    const evs = events.filter(e => e.day === d.key);
    const top = countBy(evs)[0];
    const nDates = new Set(evs.map(e => e.date)).size;
    return top && top.count >= 3 && top.count / nDates >= 0.4 ?`<div class="habit"><span><b>${d.label}s</b> · <span class="${top.kind === 'text' ? 'text-entry' : ''}">${esc(top.label)}</span></span><span class="muted">${top.count} of ${new Set(evs.map(e => e.date)).size}</span></div>` : '';
  }).join('');
  if (dayRows) html += `<div><div class="habit-head">Regular days</div>${dayRows}</div>`;
  html += '</div></div>';

  view.innerHTML = html;
}

/* ----- Suggestions ----- */
function openSuggest(startWeek = state.week) {
  let week = new Date(startWeek);
  let plan = [];
  const { body } = openSheet('Suggest meals', '');

  const build = () => {
    const wk = ymd(week);
    const slots = slotsFor(wk);
    const today = ymd(new Date());
    const stats = recipeStats();
    // don't suggest anything already planned this week or last week
    const recent = new Set();
    for (const w of [-1, 0]) for (const es of Object.values(slotsFor(ymd(addDays(week, 7 * w))))) for (const e of es) if (e.type === 'recipe') recent.add(e.recipeId);
    const score = r => {
      const s = stats.get(r.id);
      const days = s ? daysSince(s.last) : 60; // never-had counts as ~2 months
      return days * (0.85 + Math.random() * 0.3); // a little shuffle so Suggest can vary
    };
    const used = new Set();
    plan = [];
    DAYS.forEach((d, i) => MEALS.forEach(m => {
      if (!state.settings.days[d.key][m]) return;
      const slot = `${d.key}_${m}`;
      const date = ymd(addDays(week, i));
      if (date < today || (slots[slot] || []).length) return;
      const options = [...state.recipes.values()]
        .filter(r => !recent.has(r.id) && recipeMeals(r, stats).includes(m))
        .map(r => ({ r, sc: score(r) }))
        .sort((a, b) => b.sc - a.sc)
        .map(x => x.r);
      const pick = options.find(r => !used.has(r.id));
      if (pick) used.add(pick.id);
      plan.push({ slot, day: d, meal: m, date, options, pick, keep: !!pick });
    }));
  };

  const draw = () => {
    const stats = recipeStats();
    const kept = plan.filter(p => p.keep && p.pick).length;
    let html = `<div class="week-nav"><button class="icon-btn" data-dir="-1" aria-label="Previous week">‹</button>
      <div class="label">${weekName(week)}<small>${fmtDay(week)} – ${fmtDay(addDays(week, 6))}</small></div>
      <button class="icon-btn" data-dir="1" aria-label="Next week">›</button></div>`;
    if (!state.recipes.size) {
      body.innerHTML = html + '<p class="empty">Add some recipes first, then Suggest can plan with them.</p>';
      return;
    }
    if (!plan.length) {
      body.innerHTML = html + '<p class="empty"><span class="big">✅</span>Every meal left this week is already planned.<br>Try next week with ›.</p>';
      return;
    }
    html += '<p class="small muted" style="margin:0 0 6px">Recipes you haven’t had for longest, for the empty meals. ↻ swaps one; untick to leave it empty.</p><ul class="pick-list">';
    plan.forEach((p, i) => {
      const s = p.pick && stats.get(p.pick.id);
      html += `<li class="sug ${p.keep ? '' : 'off'}"><div class="grow">
          <div class="small muted">${p.day.label.slice(0, 3)} ${fmtDay(fromYmd(p.date))} · ${MEAL_LABEL[p.meal]}</div>
          ${p.pick ? `<b>${esc(p.pick.title)}</b><div class="small muted">${s ? `Last had ${ago(s.last)}` : 'Never had'}</div>`
            : `<span class="small muted">${p.options.length
              ? `All your ${MEAL_LABEL[p.meal].toLowerCase()} recipes were used this week or last week.`
              : `No ${MEAL_LABEL[p.meal].toLowerCase()} recipes to suggest. Tag recipes “Good for ${MEAL_LABEL[p.meal].toLowerCase()}” when editing them.`}</span>`}
        </div>
        ${p.pick ? `<button class="icon-btn" data-swap="${i}" aria-label="Swap suggestion" ${p.options.length > 1 ? '' : 'disabled'}>↻</button>
        <input type="checkbox" class="check" data-keep="${i}" ${p.keep ? 'checked' : ''} aria-label="Use this suggestion">` : ''}</li>`;
    });
    html += `</ul><div class="sticky-action stack">
      <button class="btn primary block" data-act="apply" ${kept ? '' : 'disabled'}>Add ${kept} meal${kept === 1 ? '' : 's'} to the plan</button>
      <button class="btn block" data-act="shuffle">🔀 Shuffle all</button></div>`;
    body.innerHTML = html;
  };

  build();
  draw();
  body.onchange = e => {
    const k = e.target.closest('[data-keep]');
    if (k) { plan[Number(k.dataset.keep)].keep = k.checked; draw(); }
  };
  body.onclick = async e => {
    const dir = e.target.closest('[data-dir]');
    if (dir) { week = addDays(week, 7 * Number(dir.dataset.dir)); build(); draw(); return; }
    const sw = e.target.closest('[data-swap]');
    if (sw) {
      const p = plan[Number(sw.dataset.swap)];
      const taken = new Set(plan.filter(q => q !== p && q.keep && q.pick).map(q => q.pick.id));
      const start = p.options.indexOf(p.pick);
      const before = p.pick;
      for (let n = 1; n < p.options.length; n++) {
        const cand = p.options[(start + n) % p.options.length];
        if (!taken.has(cand.id)) { p.pick = cand; break; }
      }
      if (p.pick === before) toast('No other recipe is free – untick another meal to swap');
      p.keep = true;
      draw();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'shuffle') { build(); draw(); }
    if (act === 'apply') {
      const wk = ymd(week);
      const slots = slotsFor(wk);
      const add = {};
      for (const p of plan) if (p.keep && p.pick) add[p.slot] = [...(slots[p.slot] || []), { id: newId(), type: 'recipe', recipeId: p.pick.id }];
      await state.store.merge('plans', wk, { slots: add });
      closeSheet();
      state.week = new Date(week);
      state.tab = 'plan';
      render();
      toast(`Added ${Object.keys(add).length} meals to the plan`);
    }
  };
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
    const st = recipeStats().get(id);
    body.innerHTML = `
      ${rec.photo ? `<img class="hero" src="${rec.photo}" alt="">` : ''}
      <p class="small" style="margin:0 0 8px"><b>${st ? `Last had ${ago(st.last)}` : 'Not had yet'}</b>${st ? ` · ${st.count} time${st.count === 1 ? '' : 's'} in total` : ''}</p>
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
        <div class="small muted">Photograph the recipe in good light with the phone flat above the page, then box in just the text. You can scan several parts – each is added below for you to check.</div>
        <div class="scan-buttons">
          <label class="btn primary file-btn">📷 Take photo<input type="file" accept="image/*" capture="environment" data-scan></label>
          <label class="btn file-btn">🖼️ From photos<input type="file" accept="image/*" data-scan></label>
        </div>
        <details class="small tip"><summary>Tip: the iPhone’s own <b>Scan Text</b> is even more accurate</summary>
          Tap in the <b>Ingredients</b> or <b>Method</b> box below, then tap it again (or touch and hold) and choose <b>Scan Text</b> – you may need to tap <b>›</b> to find it. Point the camera at the page, wait for the text to highlight, then tap <b>Insert</b>.</details>
        <div id="crop-panel" class="stack" hidden></div>
        <div id="scan-status" class="stack" hidden><div class="small" id="scan-msg"></div><div class="progress"><div id="scan-bar"></div></div></div>
      </div></div>
      <div id="photo-wrap"></div>
      <label class="field"><span>Recipe name</span><input type="text" id="ed-title" value="${esc(r?.title)}" placeholder="e.g. Chicken fajitas"></label>
      <label class="field"><span>Serves</span><input type="text" id="ed-serves" inputmode="numeric" value="${esc(r?.serves)}" placeholder="e.g. 4"></label>
      <div class="field"><span class="field-label">Good for (used by Suggest)</span><div class="row" id="ed-meals" style="gap:18px">
        ${MEALS.map(m => `<label class="row"><input type="checkbox" class="check" value="${m}" ${(r ? recipeMeals(r, recipeStats()) : ['dinner']).includes(m) ? 'checked' : ''}> ${MEAL_LABEL[m]}</label>`).join('')}
      </div></div>
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

  // Step 1: photo chosen -> show it with a crop box and "this part is…" choice
  const panel = $('#crop-panel', body);
  let pending = null;
  const closeCrop = () => {
    if (pending) URL.revokeObjectURL(pending.url);
    pending = null;
    panel.hidden = true;
    panel.innerHTML = '';
  };
  body.addEventListener('change', e => {
    const input = e.target.closest('[data-scan]');
    if (!input || !input.files[0]) return;
    const file = input.files[0];
    input.value = '';
    closeCrop();
    const url = URL.createObjectURL(file);
    status.hidden = true;
    panel.hidden = false;
    panel.innerHTML = `<div class="small"><b>Drag the corners</b> so the box covers just the recipe text. Leave out pictures and other recipes.</div>
      <div id="crop-host"></div>
      <div class="small muted">This part is:</div>
      <div class="segmented" style="grid-template-columns:repeat(3,1fr);margin:0">
        ${[['auto', 'Whole recipe'], ['ingredients', 'Ingredients'], ['method', 'Method']].map(([v, l], i) => `<button type="button" data-target="${v}" class="${i ? '' : 'on'}" aria-pressed="${!i}">${l}</button>`).join('')}
      </div>
      <div class="row"><button class="btn primary grow" data-act="read">Read text</button><button class="btn" data-act="cancel-crop">Cancel</button></div>`;
    pending = { file, url, target: 'auto', cropper: mountCropper($('#crop-host', body), url) };
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  // Step 2: read the boxed area
  const readText = async () => {
    const { file, target } = pending;
    const crop = pending.cropper.get();
    closeCrop();
    body.querySelectorAll('[data-scan]').forEach(i => { i.disabled = true; });
    status.hidden = false;
    bar.style.width = '0%';
    msg.textContent = 'Preparing photo…';
    try {
      if (!photo) { photo = await makeThumbnail(file); drawPhoto(); }
      const parsed = await scanRecipe(file, (p, m) => { bar.style.width = `${Math.round(p * 100)}%`; msg.textContent = m; }, { crop, target });
      if (!parsed.text.trim()) {
        msg.textContent = 'No text found. Try again in good light, with the phone flat above the page and the box tight around the text.';
        return;
      }
      if (parsed.title && !field('#ed-title').value.trim()) field('#ed-title').value = parsed.title;
      if (parsed.serves && !field('#ed-serves').value.trim()) field('#ed-serves').value = parsed.serves;
      if (parsed.ingredients.length) append('#ed-ings', parsed.ingredients.join('\n'), '\n');
      if (parsed.method) append('#ed-method', parsed.method, '\n\n');
      if (target === 'auto' && !parsed.ingredients.length && !parsed.method) append('#ed-method', parsed.text.trim(), '\n\n');
      const n = parsed.ingredients.length;
      msg.textContent = target === 'method'
        ? 'Added the method. Please check it below and fix any mistakes.'
        : `Found ${n} ingredient${n === 1 ? '' : 's'}${parsed.method ? ' and a method' : ''}. Please check them below and fix any mistakes.`;
    } catch (err) {
      console.error(err);
      msg.textContent = `Couldn’t read that photo: ${err.message || err}`;
    } finally {
      body.querySelectorAll('[data-scan]').forEach(i => { i.disabled = false; });
    }
  };
  body.addEventListener('click', e => {
    const t = e.target.closest('[data-target]');
    if (t && pending) {
      pending.target = t.dataset.target;
      panel.querySelectorAll('[data-target]').forEach(b => { b.classList.toggle('on', b === t); b.setAttribute('aria-pressed', b === t); });
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'read' && pending) readText();
    if (act === 'cancel-crop') closeCrop();
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
        meals: (() => { const m = [...body.querySelectorAll('#ed-meals input:checked')].map(i => i.value); return m.length ? m : ['dinner']; })(),
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
    case 'suggest': openSuggest(state.week); break;
    case 'plan-recipe': openPlanPicker(el.dataset.recipe); break;
    case 'history-period': state.historyMonths = Number(el.dataset.months); render(); break;
    case 'toggle-stale': state.showAllStale = !state.showAllStale; render(); break;
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
