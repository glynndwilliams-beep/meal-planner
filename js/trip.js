// Trips: a plan and shopping list shared with other families for a date range.
// Other families only ever get the trip code, so they never see the household's recipes,
// plans or history. The database rules (firestore.rules) shut them out after the end date;
// the organising household's phones can still open it, change the dates, or delete it.
import {
  LocalStore, FirebaseStore, TRIP_COLLECTIONS, newId, makeTripCode, makeSecret, createTrip, tripStatus, normaliseCode,
} from './store.js';
import {
  parseIngredient, ingredientKey, displayName, formatAmounts, addAmount, cleanLine, SECTIONS,
  scaleLine, servesNumber,
} from './ingredients.js';

const MY_TRIPS = 'mp-trips';          // { [code]: { name, familyId } } trips this phone has opened
const CURRENT = 'mp-current-trip';    // code of the trip on screen, so the app reopens there

const readJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') || d; } catch { return d; } };
export const myTrips = () => readJson(MY_TRIPS, {});
function saveMyTrip(code, patch) {
  const all = myTrips();
  all[code] = { ...(all[code] || {}), ...patch };
  localStorage.setItem(MY_TRIPS, JSON.stringify(all));
}
function forgetMyTrip(code) {
  const all = myTrips();
  delete all[code];
  localStorage.setItem(MY_TRIPS, JSON.stringify(all));
  if (localStorage.getItem(CURRENT) === code) localStorage.removeItem(CURRENT);
}
export const currentTripCode = () => localStorage.getItem(CURRENT);

export function setupTrips(ctx) {
  const { state, $, esc, toast, setTop, openSheet, closeSheet, methodHtml, shareText, ymd, fromYmd, addDays, MEALS, MEAL_LABEL } = ctx;
  const T = () => state.trip;
  const fmt = d => fromYmd(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtRange = info => `${fmt(info.start)} – ${fmt(info.end)}`;
  const endOfDay = d => { const x = fromYmd(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
  const familyName = id => (T().families.find(f => f.id === id) || {}).name || '';
  const myFamily = () => T().familyId;
  const headcount = () => T().families.reduce((n, f) => n + (Number(f.people) || 0), 0) || null;
  const isEnded = info => info && info.endsAt && Date.now() > info.endsAt;

  /* ---------------- opening and closing ---------------- */
  async function open(code, { quiet = false } = {}) {
    close();
    const hh = state.householdTrips[code];
    const store = ctx.firebaseConfig ? await FirebaseStore.open(ctx.firebaseConfig, code, 'trips') : new LocalStore(`mp-trip-${code}`);
    let organiser = !ctx.firebaseConfig && !!hh;
    if (hh && ctx.firebaseConfig) organiser = await store.registerOrganiser(hh.key);
    const t = {
      code, store, organiser, info: null, families: [], meals: [], recipes: new Map(), shopping: [],
      loaded: new Set(), ended: false, unsubs: [], familyId: (myTrips()[code] || {}).familyId || '', shopFilter: 'all',
    };
    state.trip = t;
    state.mode = 'trip';
    state.tab = 'tplan';
    localStorage.setItem(CURRENT, code);
    const done = col => { t.loaded.add(col); ctx.scheduleRender(); };
    const denied = () => { t.ended = true; ctx.scheduleRender(); };
    t.unsubs.push(store.subscribeRoot(info => {
      t.info = info;
      if (info) saveMyTrip(code, { name: info.name, end: info.end });
      done('root');
      if (info && !t.familyId && !t.asked && TRIP_READY()) { t.asked = true; setTimeout(() => openFamilyPicker({ first: true }), 50); }
    }, denied));
    for (const col of TRIP_COLLECTIONS) {
      t.unsubs.push(store.subscribe(col, docs => {
        if (col === 'recipes') t.recipes = new Map(docs.map(d => [d.id, d]));
        else t[col] = docs;
        done(col);
        if (col === 'families' && t.info && !t.familyId && !t.asked && TRIP_READY()) { t.asked = true; setTimeout(() => openFamilyPicker({ first: true }), 50); }
      }, denied));
    }
    ctx.setTabbar();
    ctx.render();
    if (!quiet) window.scrollTo(0, 0);
  }
  const TRIP_READY = () => T() && ['root', ...TRIP_COLLECTIONS].every(c => T().loaded.has(c));

  function close() {
    if (!state.trip) return;
    state.trip.unsubs.forEach(u => { try { u(); } catch { /* ignore */ } });
    state.trip = null;
  }

  /** Back to the household (or the welcome screen on a phone that only has trips). */
  function goHome() {
    close();
    localStorage.removeItem(CURRENT);
    state.mode = 'home';
    state.tab = 'plan';
    ctx.setTabbar();
    if (state.store) ctx.render(); else ctx.renderWelcome();
    window.scrollTo(0, 0);
  }

  /* ---------------- rendering ---------------- */
  function render() {
    const t = T();
    const view = ctx.view;
    const homeBtn = state.store ? '<button class="btn small" data-action="trip-home">‹ Home</button>' : '';
    const left = t ? t.shopping.filter(i => !i.checked).length : 0;
    const badge = $('#shop-badge');
    if (badge) { badge.hidden = !left; badge.textContent = left; }
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    // Other families: once the database refuses them (or the end date has passed on this phone's
    // clock, e.g. offline with an old copy cached), show only this – never the cached trip.
    if (t && ((t.ended && !t.info) || (!t.organiser && (t.ended || isEnded(t.info))))) {
      if (badge) badge.hidden = true;
      setTop('Trip', homeBtn);
      view.innerHTML = `<div class="empty"><span class="big">🏁</span>This trip has ended, or the code is no longer valid.<br>Only the family that organised it can open it now.
        <div style="margin-top:16px" class="stack"><button class="btn primary" data-action="trip-forget">Remove it from this phone</button></div></div>`;
      return;
    }
    if (!t || !TRIP_READY()) { setTop('Trip', homeBtn); view.innerHTML = '<p class="empty">Opening trip…</p>'; return; }
    if (!t.info) {
      setTop('Trip', homeBtn);
      view.innerHTML = `<div class="empty"><span class="big">🗑️</span>This trip has been deleted.
        <div style="margin-top:16px"><button class="btn primary" data-action="trip-forget">Remove it from this phone</button></div></div>`;
      return;
    }
    ({ tplan: renderPlan, tshop: renderShop, tinfo: renderInfo })[state.tab]?.(homeBtn);
  }

  function endedNotice() {
    const info = T().info;
    return isEnded(info) ? `<div class="notice" style="margin-bottom:12px">This trip ended on ${fmt(info.end)}. The other families can’t open it any more; only your household can see it. Change the dates under <b>Trip</b> to reopen it.</div>` : '';
  }

  function renderPlan(homeBtn) {
    const t = T();
    const info = t.info;
    setTop(`🏕️ ${info.name}`, homeBtn);
    const today = ymd(new Date());
    const n = headcount();
    let html = endedNotice() + `<p class="small muted" style="margin:0 0 10px">${fmtRange(info)}${n ? ` · ${n} people` : ''}${t.familyId ? ` · you’re <b>${esc(familyName(t.familyId))}</b>` : ''}</p>`;
    const meals = (info.meals && info.meals.length ? info.meals : MEALS).filter(m => MEALS.includes(m));
    for (let d = fromYmd(info.start), i = 0; ymd(d) <= info.end && i < 60; d = addDays(d, 1), i++) {
      const date = ymd(d);
      html += `<div class="card ${date === today ? 'today' : ''}"><div class="card-head"><h2>${d.toLocaleDateString('en-GB', { weekday: 'long' })}</h2>
        <span class="sub">${date === today ? 'Today · ' : ''}${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div>`;
      for (const m of meals) {
        const entries = t.meals.filter(e => e.date === date && e.meal === m).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        html += `<div class="meal-row"><div class="meal-name">${MEAL_LABEL[m]}</div><div class="meal-items">
          ${entries.map(e => `<span class="chip ${e.recipeId ? '' : 'text'}"><button class="chip-main" data-action="trip-meal" data-id="${esc(e.id)}">${esc(e.title)}${e.cook ? `<span class="cook-by">👨‍🍳 ${esc(familyName(e.cook))}</span>` : ''}</button></span>`).join('')}
          <button class="add-slot" data-action="trip-add" data-date="${date}" data-meal="${m}" aria-label="Add to ${fmt(date)} ${MEAL_LABEL[m]}">+ Add</button>
        </div></div>`;
      }
      html += '</div>';
    }
    ctx.view.innerHTML = html;
  }

  function renderShop(homeBtn) {
    const t = T();
    const items = t.shopping;
    const done = items.filter(i => i.checked).length;
    setTop('Trip shopping', `${homeBtn}${items.length ? '<button class="icon-btn" data-action="trip-share-list" aria-label="Share list">⬆️</button>' : ''}${done ? `<button class="btn small" data-action="trip-clear-done">Clear ${done}</button>` : ''}`);
    const f = t.shopFilter;
    let html = endedNotice() + `<button class="btn block" data-action="trip-shop-meals" style="margin-bottom:12px">📅 Add ingredients for the trip’s meals</button>
      <form class="shop-add" id="trip-shop-add"><input type="text" id="trip-shop-input" placeholder="Add an item, e.g. 6 pints milk" autocomplete="off" enterkeyhint="done"><button class="btn primary" type="submit">Add</button></form>`;
    if (!items.length) {
      ctx.view.innerHTML = html + '<p class="empty"><span class="big">🛒</span>The trip shopping list is empty.<br>Add meals to the trip plan, then tap the button above.</p>';
      return;
    }
    html += `<div class="segmented" style="grid-template-columns:repeat(3,1fr)" role="group" aria-label="Show">
      ${[['all', 'Everything'], ['mine', 'We’re bringing'], ['open', 'Nobody yet']].map(([v, l]) => `<button data-action="trip-shop-filter" data-f="${v}" class="${f === v ? 'on' : ''}" aria-pressed="${f === v}">${l}</button>`).join('')}</div>`;
    const shown = items.filter(i => f === 'all' || (f === 'mine' ? i.claimedBy && i.claimedBy === t.familyId : !i.claimedBy));
    if (!shown.length) html += `<p class="empty">${f === 'mine' ? 'Your family hasn’t said it’s bringing anything yet. Tap an item to claim it.' : 'Everything has someone bringing it. 🎉'}</p>`;
    const groups = new Map(SECTIONS.map(s => [s, []]));
    for (const it of shown) (groups.get(it.section) || groups.get('Other')).push(it);
    for (const [section, list] of groups) {
      if (!list.length) continue;
      list.sort((a, b) => (a.checked - b.checked) || a.name.localeCompare(b.name));
      html += `<div class="section-title">${esc(section)}</div><div class="card">${list.map(it => `
        <div class="shop-item ${it.checked ? 'done' : ''}">
          <input type="checkbox" class="check" data-action="trip-toggle-item" data-id="${esc(it.id)}" ${it.checked ? 'checked' : ''} aria-label="Got ${esc(it.name)}">
          <button class="name" data-action="trip-edit-item" data-id="${esc(it.id)}"><b>${esc(it.name)}</b>${qtyOf(it) ? ` <span class="qty">${esc(qtyOf(it))}</span>` : ''}
          ${(it.sources || []).length ? `<span class="src">for ${esc(it.sources.join(', '))}</span>` : ''}</button>
          ${it.claimedBy ? `<span class="claim ${it.claimedBy === t.familyId ? 'mine' : ''}">🙋 ${esc(familyName(it.claimedBy) || '?')}</span>` : ''}
        </div>`).join('')}</div>`;
    }
    ctx.view.innerHTML = html;
  }
  const qtyOf = item => item.qtyText || formatAmounts(item.amounts);

  function renderInfo(homeBtn) {
    const t = T();
    const info = t.info;
    setTop('Trip', homeBtn);
    const ended = isEnded(info);
    let html = `<div class="card"><div class="card-body stack">
      <div><b style="font-size:19px">🏕️ ${esc(info.name)}</b><div class="muted">${fmtRange(info)}</div></div>
      <div class="notice">${ended
        ? `Ended on ${fmt(info.end)}. Other families are locked out; only your household can open it.`
        : `Anyone with the code can use the trip plan and shopping list until the end of ${fmt(info.end)}. After that they’re locked out automatically.`}</div>
      <div class="small muted">The other families only see this trip – never your recipe book, meal plan or history.</div>
    </div></div>`;
    html += `<div class="section-title">Trip code</div><div class="card"><div class="card-body stack">
      <div class="code-box">${esc(t.code)}</div>
      <button class="btn block" data-action="trip-share-code">Send the code to the other families</button>
    </div></div>`;
    const n = headcount();
    html += `<div class="section-title">Families${n ? ` · ${n} people` : ''}</div><div class="card">${t.families.length
      ? [...t.families].sort((a, b) => a.name.localeCompare(b.name)).map(f => `<div class="recipe-item"><span class="grow"><span class="t">${esc(f.name)}</span>${f.id === t.familyId ? ' <span class="small muted">(this phone)</span>' : ''}<br><span class="s">${f.people ? `${f.people} ${f.people === 1 ? 'person' : 'people'}` : 'number not set'}</span></span></div>`).join('')
      : '<p class="small muted" style="padding:12px">No families yet.</p>'}
      <div class="card-body"><button class="btn block" data-action="trip-family">${t.familyId ? 'Change our family or numbers' : 'Say which family you are'}</button></div></div>`;
    if (t.organiser) {
      html += `<div class="section-title">Organiser</div><div class="card"><div class="card-body stack">
        <button class="btn block" data-action="trip-edit">Change name, dates or meals</button>
        <button class="btn danger block" data-action="trip-delete">Delete this trip for everyone</button></div></div>`;
    }
    html += `<div class="card"><div class="card-body stack">
      ${state.store ? '<button class="btn block" data-action="trip-home">‹ Back to our home meal plan</button>' : '<button class="btn block" data-action="trip-forget">Remove this trip from this phone</button>'}
    </div></div>`;
    ctx.view.innerHTML = html;
  }

  /* ---------------- families ---------------- */
  function openFamilyPicker({ first = false } = {}) {
    const t = T();
    if (!t) return;
    const mine = t.families.find(f => f.id === t.familyId);
    const { body } = openSheet(first ? `Welcome to ${t.info.name}` : 'Your family', `<div class="stack">
      <p class="small muted" style="margin:0">So everyone knows who’s cooking and bringing what. ${first ? 'You can change this later under Trip.' : ''}</p>
      ${t.families.length ? `<div class="section-title" style="margin-top:4px">We’re one of these</div><ul class="pick-list">${t.families.map(f => `<li><button data-fam="${esc(f.id)}"><span class="grow"><b>${esc(f.name)}</b> <span class="small muted">${f.people ? `${f.people} people` : ''}</span></span>${f.id === t.familyId ? '✓' : ''}</button></li>`).join('')}</ul>` : ''}
      <div class="section-title" style="margin-top:4px">${mine ? 'Change our details' : 'Or add our family'}</div>
      <label class="field"><span>Family name</span><input type="text" id="fam-name" value="${esc(mine ? mine.name : '')}" placeholder="e.g. The Williamses"></label>
      <label class="field"><span>How many of you (for amounts)</span><input type="number" id="fam-people" min="1" max="30" inputmode="numeric" value="${esc(mine ? mine.people : '')}" placeholder="e.g. 4"></label>
      <button class="btn primary block" data-act="fam-save">${mine ? 'Save' : 'Add our family'}</button></div>`);
    body.onclick = async e => {
      const pick = e.target.closest('[data-fam]');
      if (pick) {
        t.familyId = pick.dataset.fam;
        saveMyTrip(t.code, { familyId: t.familyId });
        closeSheet();
        ctx.render();
        toast(`You’re ${familyName(t.familyId)}`);
        return;
      }
      if (e.target.closest('[data-act="fam-save"]')) {
        const name = $('#fam-name', body).value.trim();
        const people = Number($('#fam-people', body).value) || null;
        if (!name) { toast('Please type your family name'); return; }
        const id = mine ? mine.id : newId();
        await t.store.set('families', id, { name, people, joinedAt: (mine && mine.joinedAt) || Date.now() });
        t.familyId = id;
        saveMyTrip(t.code, { familyId: id });
        closeSheet();
        toast('Saved');
      }
    };
  }

  /* ---------------- meals ---------------- */
  function openAdd(date, meal, { edit = null } = {}) {
    const t = T();
    const label = `${fmt(date)} ${MEAL_LABEL[meal].toLowerCase()}`;
    const homeRecipes = t.organiser ? [...state.recipes.values()].sort((a, b) => (a.title || '').localeCompare(b.title || '')) : [];
    const tripRecipes = [...t.recipes.values()].sort((a, b) => a.title.localeCompare(b.title));
    const { body } = openSheet(edit ? 'Edit dish' : `Add to ${label}`, `<div class="stack">
      <label class="field"><span>Dish</span><input type="text" id="tm-title" value="${esc(edit ? edit.title : '')}" placeholder="e.g. BBQ, Spaghetti bolognese" autocomplete="off"></label>
      ${edit ? '' : `<div class="row" style="flex-wrap:wrap">${['BBQ', 'Eating out', 'Takeaway', 'Leftovers', 'Sandwiches'].map(q => `<button class="btn small" data-quick="${q}">${q}</button>`).join('')}</div>`}
      <label class="field"><span>Ingredients – optional, one per line (amounts for the whole group)</span><textarea id="tm-ings" rows="5" style="min-height:90px" placeholder="2kg sausages&#10;24 burger buns">${esc(edit ? (edit.ingredients || []).join('\n') : '')}</textarea></label>
      <button class="btn primary block" data-act="tm-save">${edit ? 'Save' : 'Add to the trip plan'}</button>
      ${!edit && tripRecipes.length ? `<div class="section-title">Recipes already in this trip</div><ul class="pick-list">${tripRecipes.map(r => `<li><button data-trec="${esc(r.id)}"><span class="grow">${esc(r.title)}</span><span class="muted">+</span></button></li>`).join('')}</ul>` : ''}
      ${!edit && homeRecipes.length ? `<div class="section-title">Or one of your recipes</div>
        <p class="small muted" style="margin:0">A copy of just this recipe (ingredients and method) goes into the trip so whoever cooks it can follow it. Nothing else from your book is shared.</p>
        ${homeRecipes.length > 6 ? '<input type="search" id="tm-search" placeholder="Search your recipes" autocomplete="off">' : ''}
        <ul class="pick-list" id="tm-home"></ul>` : ''}
    </div>`);
    const list = $('#tm-home', body);
    const fill = (q = '') => {
      if (!list) return;
      const rs = homeRecipes.filter(r => (r.title || '').toLowerCase().includes(q.toLowerCase()));
      list.innerHTML = rs.map(r => `<li><button data-hrec="${esc(r.id)}">${r.photo ? `<img class="thumb" style="width:36px;height:36px" src="${r.photo}" alt="">` : '<span class="thumb" style="width:36px;height:36px;font-size:18px">🍽️</span>'}<span class="grow">${esc(r.title)}</span><span class="muted">+</span></button></li>`).join('') || '<li class="muted small" style="padding:10px 4px">No matches.</li>';
    };
    fill();
    const search = $('#tm-search', body);
    if (search) search.oninput = () => fill(search.value);

    const add = async entry => {
      await t.store.set('meals', newId(), { date, meal, cook: null, people: null, addedBy: t.familyId || null, createdAt: Date.now(), ...entry });
      closeSheet();
      toast(`Added to ${label}`);
    };
    body.onclick = async e => {
      const q = e.target.closest('[data-quick]');
      if (q) { $('#tm-title', body).value = q.dataset.quick; return; }
      if (e.target.closest('[data-act="tm-save"]')) {
        const title = $('#tm-title', body).value.trim();
        if (!title) { toast('Please name the dish'); return; }
        const ingredients = $('#tm-ings', body).value.split('\n').map(cleanLine).filter(Boolean);
        if (edit) { await t.store.merge('meals', edit.id, { title, ingredients }); closeSheet(); toast('Saved'); }
        else await add({ title, ingredients, recipeId: null });
        return;
      }
      const tr = e.target.closest('[data-trec]');
      if (tr) { const r = t.recipes.get(tr.dataset.trec); await add({ title: r.title, recipeId: r.id, ingredients: [] }); return; }
      const hr = e.target.closest('[data-hrec]');
      if (hr) {
        const r = state.recipes.get(hr.dataset.hrec);
        const rid = `home-${r.id}`;
        // copy only what's needed to cook it; ratings, notes, tags and history stay at home
        await t.store.set('recipes', rid, {
          title: r.title, serves: r.serves || '', ingredients: r.ingredients || [], method: r.method || '',
          photo: r.photo || '', sharedBy: t.familyId || null, sharedAt: Date.now(),
        });
        await add({ title: r.title, recipeId: rid, ingredients: [] });
      }
    };
  }

  /** People this meal is for, and how to scale its recipe. */
  function mealScale(e) {
    const r = e.recipeId ? T().recipes.get(e.recipeId) : null;
    const base = r ? servesNumber(r.serves) : null;
    const people = e.people || headcount() || base || null;
    return { r, base, people, factor: base && people ? people / base : 1 };
  }
  const mealLines = e => {
    const { r, factor } = mealScale(e);
    return r ? (r.ingredients || []).map(l => scaleLine(l, factor)) : (e.ingredients || []);
  };

  function openMeal(id) {
    const t = T();
    const ticked = new Set();
    const { sheet, body } = openSheet('', '');
    const draw = () => {
      const e = t.meals.find(m => m.id === id);
      if (!e) { closeSheet(); return; }
      const { r, base, people } = mealScale(e);
      const lines = mealLines(e);
      const onList = new Set(t.shopping.filter(i => !i.checked).map(i => i.key));
      $('.sheet-head h2', sheet).textContent = e.title;
      const scroll = sheet.scrollTop;
      const mineCook = e.cook && e.cook === t.familyId;
      body.innerHTML = `
        ${r && r.photo ? `<img class="hero" src="${r.photo}" alt="">` : ''}
        <p class="small muted" style="margin:0 0 8px">${fmt(e.date)} · ${MEAL_LABEL[e.meal]}${e.addedBy && familyName(e.addedBy) ? ` · added by ${esc(familyName(e.addedBy))}` : ''}</p>
        <div class="card" style="margin:0 0 10px"><div class="card-body row">
          <span class="grow">${e.cook ? `👨‍🍳 <b>${esc(familyName(e.cook) || 'Someone')}</b> ${mineCook ? '(you) are' : 'is'} cooking` : '<span class="muted">Nobody is cooking this yet</span>'}</span>
          ${mineCook ? '<button class="btn small" data-act="uncook">Not us</button>' : `<button class="btn small primary" data-act="cook">We’ll cook it</button>`}
        </div></div>
        ${base ? `<div class="row serves-row"><span class="grow"><b>For</b> <span class="small muted">(recipe makes ${base})</span></span>
          <span class="stepper"><button class="icon-btn" data-act="ppl" data-d="-1" aria-label="Fewer people" ${people <= 1 ? 'disabled' : ''}>−</button><b>${people}</b><button class="icon-btn" data-act="ppl" data-d="1" aria-label="More people">+</button></span></div>` : ''}
        ${lines.length ? `<div class="row"><h3 class="grow" style="margin:6px 0">Ingredients</h3><button class="link-btn" data-act="all">${ticked.size === lines.length ? 'Untick all' : 'Tick all'}</button></div>
          <ul class="ing-list">${lines.map((l, i) => `<li><label><input type="checkbox" class="check" data-i="${i}" ${ticked.has(i) ? 'checked' : ''}><span class="grow">${esc(l)}</span></label>
            ${onList.has(ingredientKey(parseIngredient(l).name)) ? '<span class="on-list">On list</span>' : ''}</li>`).join('')}</ul>
          <div class="sticky-action"><button class="btn primary block" data-act="add" ${ticked.size ? '' : 'disabled'}>${ticked.size ? `🛒 Add ${ticked.size} to the trip list` : 'Tick items to add them'}</button></div>`
          : `<p class="small muted">No ingredients listed${r ? '' : ' – tap Edit dish to add some'}.</p>`}
        ${r && r.method ? `<h3>Method</h3><div class="method">${methodHtml(r.method)}</div>` : ''}
        ${r ? '' : '<button class="btn block" data-act="edit" style="margin-top:16px">✏️ Edit dish</button>'}
        <button class="btn danger block" data-act="remove" style="margin-top:10px">Remove from the trip plan</button>`;
      sheet.scrollTop = scroll;
    };
    draw();
    state.sheetRefresh = draw;
    body.onchange = ev => {
      const cb = ev.target.closest('[data-i]');
      if (!cb) return;
      const i = Number(cb.dataset.i);
      cb.checked ? ticked.add(i) : ticked.delete(i);
      draw();
    };
    body.onclick = async ev => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const e = t.meals.find(m => m.id === id);
      if (!e) return;
      const act = btn.dataset.act;
      const lines = mealLines(e);
      if (act === 'cook') {
        if (!t.familyId) { openFamilyPicker(); return; }
        if (e.cook && e.cook !== t.familyId && !confirm(`${familyName(e.cook)} is down to cook this. Take it over?`)) return;
        await t.store.merge('meals', id, { cook: t.familyId });
      }
      if (act === 'uncook') await t.store.merge('meals', id, { cook: null });
      if (act === 'ppl') { const { people } = mealScale(e); await t.store.merge('meals', id, { people: Math.max(1, people + Number(btn.dataset.d)) }); }
      if (act === 'all') { if (ticked.size === lines.length) ticked.clear(); else lines.forEach((_, i) => ticked.add(i)); draw(); }
      if (act === 'add') {
        const chosen = [...ticked].sort((a, b) => a - b).map(i => lines[i]).filter(Boolean);
        await addItems(chosen.map(line => ({ line, source: e.title })));
        ticked.clear();
        draw();
        toast(`Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} to the trip list`);
      }
      if (act === 'edit') openAdd(e.date, e.meal, { edit: e });
      if (act === 'remove' && confirm(`Remove “${e.title}” from the trip plan?`)) {
        await t.store.remove('meals', id);
        closeSheet();
      }
    };
  }

  /* ---------------- shopping ---------------- */
  const addItems = entries => ctx.addToShopping(entries, '', {
    store: T().store, items: T().shopping, extra: { claimedBy: null, addedBy: T().familyId || null },
  });

  /** All the trip's meals from today on, combined into one list to tick through. */
  function openMealsShop() {
    const t = T();
    const today = ymd(new Date());
    const onList = new Set(t.shopping.filter(i => !i.checked).map(i => i.key));
    const map = new Map();
    for (const e of t.meals.filter(m => m.date >= today || isEnded(t.info)).sort((a, b) => a.date.localeCompare(b.date))) {
      for (const line of mealLines(e)) {
        const p = parseIngredient(line);
        const key = ingredientKey(p.name) || p.name.toLowerCase();
        const row = map.get(key) || { key, name: displayName(p.name), lines: [], amounts: [], onList: onList.has(key) };
        row.lines.push({ line, source: e.title });
        row.amounts = addAmount(row.amounts, p.qty, p.unit);
        map.set(key, row);
      }
    }
    const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    rows.forEach(x => { x.tick = !x.onList; });
    const { body } = openSheet('Shop for the trip’s meals', '');
    const draw = () => {
      const n = rows.filter(x => x.tick).length;
      if (!rows.length) {
        body.innerHTML = '<p class="empty"><span class="big">📅</span>No ingredients yet.<br>Add meals to the trip plan – recipes bring their ingredients, and typed dishes can list theirs.</p>';
        return;
      }
      body.innerHTML = `<p class="small muted" style="margin:0 0 6px">Amounts are for the number of people set on each meal${headcount() ? ` (usually ${headcount()})` : ''}. Untick anything someone already has.</p>
        <div class="row"><div class="grow"></div><button class="link-btn" data-act="none">Untick all</button></div>
        <ul class="ing-list">${rows.map((x, i) => `<li><label><input type="checkbox" class="check" data-row="${i}" ${x.tick ? 'checked' : ''}>
          <span class="grow">${esc(x.name)}${formatAmounts(x.amounts) ? ` <span class="muted">${esc(formatAmounts(x.amounts))}</span>` : ''}
          <span class="small muted" style="display:block">${esc([...new Set(x.lines.map(l => l.source))].join(', '))}</span></span></label>
          ${x.onList ? '<span class="on-list">On list</span>' : ''}</li>`).join('')}</ul>
        <div class="sticky-action"><button class="btn primary block" data-act="go" ${n ? '' : 'disabled'}>${n ? `🛒 Add ${n} item${n === 1 ? '' : 's'} to the trip list` : 'Tick items to add them'}</button></div>`;
    };
    draw();
    body.onchange = e => { const x = e.target.closest('[data-row]'); if (x) { rows[Number(x.dataset.row)].tick = x.checked; draw(); } };
    body.onclick = async e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'none') { rows.forEach(x => { x.tick = false; }); draw(); }
      if (act === 'go') {
        const n = await addItems(rows.filter(x => x.tick).flatMap(x => x.lines));
        closeSheet();
        toast(`Added ${n} item${n === 1 ? '' : 's'} to the trip list`);
      }
    };
  }

  function openItem(id) {
    const t = T();
    const it = t.shopping.find(i => i.id === id);
    if (!it) return;
    const original = qtyOf(it);
    const mine = it.claimedBy && it.claimedBy === t.familyId;
    const { body } = openSheet('Trip shopping item', `<div class="stack">
      <div class="card" style="margin:0"><div class="card-body row">
        <span class="grow">${it.claimedBy ? `🙋 <b>${esc(familyName(it.claimedBy) || 'Someone')}</b> ${mine ? '(you) are' : 'is'} bringing this` : '<span class="muted">Nobody is bringing this yet</span>'}</span>
        ${mine ? '<button class="btn small" data-act="unclaim">Not us</button>' : '<button class="btn small primary" data-act="claim">We’ll bring it</button>'}
      </div></div>
      <label class="field"><span>Item</span><input type="text" id="ti-name" value="${esc(it.name)}"></label>
      <label class="field"><span>Amount</span><input type="text" id="ti-qty" value="${esc(original)}" placeholder="e.g. 2kg"></label>
      <label class="field"><span>Shop section</span><select id="ti-sec">${SECTIONS.map(s => `<option ${s === it.section ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      ${(it.sources || []).length ? `<p class="small muted" style="margin:0">Needed for: ${esc(it.sources.join(', '))}</p>` : ''}
      ${it.addedBy && familyName(it.addedBy) ? `<p class="small muted" style="margin:0">Added by ${esc(familyName(it.addedBy))}</p>` : ''}
      <button class="btn primary block" data-act="save">Save</button>
      <button class="btn danger block" data-act="delete">Remove from list</button></div>`);
    body.onclick = async e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'claim') {
        if (!t.familyId) { openFamilyPicker(); return; }
        if (it.claimedBy && !confirm(`${familyName(it.claimedBy)} said they’d bring this. Take it over?`)) return;
        await t.store.merge('shopping', id, { claimedBy: t.familyId });
        closeSheet();
        toast(`${familyName(t.familyId)} is bringing ${it.name}`);
      }
      if (act === 'unclaim') { await t.store.merge('shopping', id, { claimedBy: null }); closeSheet(); }
      if (act === 'save') {
        const name = $('#ti-name', body).value.trim() || it.name;
        const qty = $('#ti-qty', body).value.trim();
        const val = { name, key: ingredientKey(name) || name.toLowerCase(), section: $('#ti-sec', body).value };
        if (qty !== original) { val.qtyText = qty; val.amounts = []; }
        await t.store.merge('shopping', id, val);
        closeSheet();
      }
      if (act === 'delete') { await t.store.remove('shopping', id); closeSheet(); }
    };
  }

  function listAsText() {
    const t = T();
    const lines = [`${t.info.name} – shopping`, ''];
    for (const s of SECTIONS) {
      const items = t.shopping.filter(i => !i.checked && (i.section === s || (s === 'Other' && !SECTIONS.includes(i.section))));
      if (!items.length) continue;
      lines.push(s.toUpperCase());
      items.sort((a, b) => a.name.localeCompare(b.name)).forEach(i => lines.push(`• ${i.name}${qtyOf(i) ? ` (${qtyOf(i)})` : ''}${i.claimedBy ? ` – ${familyName(i.claimedBy)}` : ''}`));
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  /* ---------------- creating and editing a trip ---------------- */
  function tripForm(info) {
    const meals = info ? info.meals || MEALS : MEALS;
    const today = ymd(new Date());
    return `<div class="stack">
      <label class="field"><span>Trip name</span><input type="text" id="tr-name" value="${esc(info ? info.name : '')}" placeholder="e.g. Lake District, Christmas"></label>
      <div class="row"><label class="field grow"><span>First day</span><input type="date" id="tr-start" value="${esc(info ? info.start : today)}"></label>
        <label class="field grow"><span>Last day</span><input type="date" id="tr-end" value="${esc(info ? info.end : ymd(addDays(new Date(), 3)))}"></label></div>
      <div class="field"><span class="field-label">Meals to plan</span><div class="row" id="tr-meals" style="gap:18px">
        ${MEALS.map(m => `<label class="row"><input type="checkbox" class="check" value="${m}" ${meals.includes(m) ? 'checked' : ''}> ${MEAL_LABEL[m]}</label>`).join('')}</div></div>
      ${info ? '' : `<label class="field"><span>Your family’s name</span><input type="text" id="tr-fam" placeholder="e.g. The Williamses"></label>
        <label class="field"><span>How many of you</span><input type="number" id="tr-people" min="1" max="30" inputmode="numeric" placeholder="e.g. 4"></label>
        <p class="small muted" style="margin:0">The other families will be able to use the trip from when you send them the code until the end of the last day. They never see your recipe book, plan or history.</p>`}
    </div>`;
  }
  function readForm(body) {
    const name = $('#tr-name', body).value.trim();
    const start = $('#tr-start', body).value;
    const end = $('#tr-end', body).value;
    const meals = [...body.querySelectorAll('#tr-meals input:checked')].map(i => i.value);
    if (!name) return { err: 'Please name the trip' };
    if (!start || !end) return { err: 'Please choose the dates' };
    if (end < start) return { err: 'The last day is before the first day' };
    if ((fromYmd(end) - fromYmd(start)) / 864e5 > 59) return { err: 'Trips can be up to 60 days' };
    if (!meals.length) return { err: 'Tick at least one meal' };
    return { name, start, end, meals, endsAt: endOfDay(end) };
  }

  function openCreate() {
    if (!state.store) return;
    const { body } = openSheet('Plan a trip', `${tripForm(null)}<button class="btn primary block" data-act="create" style="margin-top:14px">Create trip</button>
      ${state.store.kind === 'firebase' ? '' : '<p class="small" style="color:var(--danger)">Sharing isn’t switched on, so this trip will only be on this phone. Set up Firebase (SETUP.md step 2) to share it.</p>'}`);
    body.onclick = async e => {
      if (!e.target.closest('[data-act="create"]')) return;
      const f = readForm(body);
      if (f.err) { toast(f.err); return; }
      const famName = $('#tr-fam', body).value.trim();
      const people = Number($('#tr-people', body).value) || null;
      if (!famName) { toast('Please add your family’s name'); return; }
      const btn = e.target.closest('button');
      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const code = makeTripCode();
        const key = makeSecret();
        const info = { ...f, createdAt: Date.now() };
        if (ctx.firebaseConfig) await createTrip(ctx.firebaseConfig, code, info, key);
        else await new LocalStore(`mp-trip-${code}`).mergeRoot(info);
        await state.store.merge('meta', 'trips', { list: { [code]: { name: f.name, start: f.start, end: f.end, key } } });
        state.householdTrips = { ...state.householdTrips, [code]: { name: f.name, start: f.start, end: f.end, key } };
        const famId = newId();
        saveMyTrip(code, { name: f.name, familyId: famId });
        closeSheet();
        await open(code);
        await T().store.set('families', famId, { name: famName, people, joinedAt: Date.now() });
        state.tab = 'tinfo';
        ctx.render();
        toast('Trip created – send the code to the other families');
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        btn.textContent = 'Create trip';
        toast(`Couldn’t create the trip: ${err.code || err.message}`);
      }
    };
  }

  function openEdit() {
    const t = T();
    const { body } = openSheet('Edit trip', `${tripForm(t.info)}<button class="btn primary block" data-act="save" style="margin-top:14px">Save</button>
      <p class="small muted">Moving the last day later reopens the trip for the other families until then.</p>`);
    body.onclick = async e => {
      if (!e.target.closest('[data-act="save"]')) return;
      const f = readForm(body);
      if (f.err) { toast(f.err); return; }
      await t.store.mergeRoot(f);
      const entry = { ...(state.householdTrips[t.code] || {}), name: f.name, start: f.start, end: f.end };
      await state.store.merge('meta', 'trips', { list: { [t.code]: entry } });
      closeSheet();
      toast('Trip updated');
    };
  }

  async function removeTrip() {
    const t = T();
    if (!confirm(`Delete “${t.info.name}” for everyone? Its plan and shopping list will be gone for all the families. This can’t be undone.`)) return;
    try {
      await t.store.destroy();
    } catch (err) { console.error(err); toast(`Couldn’t delete it: ${err.code || err.message}`); return; }
    const list = { ...state.householdTrips };
    delete list[t.code];
    await state.store.set('meta', 'trips', { list });
    forgetMyTrip(t.code);
    goHome();
    toast('Trip deleted');
  }

  /** Join from a typed code; works on a phone with no household. */
  async function join(rawCode) {
    const code = normaliseCode(rawCode);
    if (!code.startsWith('TRIP-')) return false;
    if (ctx.firebaseConfig) {
      const status = await tripStatus(ctx.firebaseConfig, code);
      if (status !== 'open' && !state.householdTrips[code]) throw new Error('No open trip with that code. Check it, or the trip may have ended.');
    } else if (!localStorage.getItem(`mp-trip-${code}`)) {
      throw new Error('Trips need sharing switched on (SETUP.md step 2).');
    }
    saveMyTrip(code, {});
    await open(code);
    return true;
  }

  /* ---------------- home-side pieces ---------------- */
  /** Trips this phone can open: the household's own, plus any it joined. */
  function allTrips() {
    const out = new Map();
    for (const [code, x] of Object.entries(state.householdTrips || {})) out.set(code, { code, name: x.name, start: x.start, end: x.end, ours: true });
    for (const [code, x] of Object.entries(myTrips())) if (!out.has(code)) out.set(code, { code, name: x.name || code, end: x.end, ours: false });
    return [...out.values()].sort((a, b) => (b.start || b.end || '').localeCompare(a.start || a.end || ''));
  }

  function tripsListHtml() {
    const today = ymd(new Date());
    return allTrips().map(x => `<button class="recipe-item" data-action="trip-open" data-code="${esc(x.code)}">
      <span class="thumb">🏕️</span><span class="grow"><span class="t">${esc(x.name)}</span><br>
      <span class="s">${x.start ? fmtRange(x) : ''}${x.end && x.end < today ? ' · ended' : ''}${x.ours ? ' · organised by you' : ''}</span></span><span class="muted">›</span></button>`).join('');
  }

  function settingsHtml() {
    return `<div class="section-title">Trips with other families</div><div class="card">
      ${tripsListHtml()}
      <div class="card-body stack">
        <p class="small muted" style="margin:0">Share a trip plan and shopping list with other families for set dates. They only see the trip – never your recipes, plan or history.</p>
        <button class="btn primary block" data-action="trip-create">🏕️ Plan a trip</button>
        <form id="trip-join" class="row"><input type="text" id="trip-join-code" class="grow" placeholder="Got a trip code? TRIP-…" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false"><button class="btn" type="submit">Join</button></form>
      </div></div>`;
  }

  /** A link on the home plan when a trip overlaps the week on screen. */
  function planBannerHtml(weekStart) {
    const a = ymd(weekStart), b = ymd(addDays(weekStart, 6));
    return allTrips().filter(x => x.start && x.start <= b && x.end >= a).map(x =>
      `<button class="card trip-banner" data-action="trip-open" data-code="${esc(x.code)}"><span>🏕️ <b>${esc(x.name)}</b> · ${fmtRange(x)}</span><span class="muted">Open ›</span></button>`).join('');
  }

  /* ---------------- events ---------------- */
  async function onAction(el) {
    const a = el.dataset.action || '';
    if (!a.startsWith('trip-')) return false;
    const t = T();
    switch (a) {
      case 'trip-open': await open(el.dataset.code); break;
      case 'trip-create': openCreate(); break;
      case 'trip-home': goHome(); break;
      case 'trip-forget': if (t) forgetMyTrip(t.code); goHome(); break;
      case 'trip-add': openAdd(el.dataset.date, el.dataset.meal); break;
      case 'trip-meal': openMeal(el.dataset.id); break;
      case 'trip-family': openFamilyPicker(); break;
      case 'trip-edit': openEdit(); break;
      case 'trip-delete': await removeTrip(); break;
      case 'trip-share-code': shareText(`${t.info.name} – trip code`, `Join our “${t.info.name}” trip plan and shopping list (${fmtRange(t.info)}).\n\n1. Open ${location.origin}${location.pathname} on your phone (in Safari on iPhone).\n2. Tap “Join household or trip” and enter: ${t.code}\n\nIt only works until the end of the trip.`); break;
      case 'trip-shop-meals': openMealsShop(); break;
      case 'trip-shop-filter': t.shopFilter = el.dataset.f; ctx.render(); break;
      case 'trip-toggle-item': await t.store.merge('shopping', el.dataset.id, { checked: el.checked }); break;
      case 'trip-edit-item': openItem(el.dataset.id); break;
      case 'trip-share-list': shareText(`${t.info.name} shopping`, listAsText()); break;
      case 'trip-clear-done': {
        const done = t.shopping.filter(i => i.checked);
        await t.store.batch(done.map(i => ({ op: 'remove', col: 'shopping', id: i.id })));
        toast(`Cleared ${done.length} item${done.length === 1 ? '' : 's'}`);
        break;
      }
      default: return false;
    }
    return true;
  }

  async function onSubmit(e) {
    if (e.target.id === 'trip-shop-add') {
      e.preventDefault();
      const input = $('#trip-shop-input');
      const text = input.value.trim();
      if (!text) return true;
      input.value = '';
      await addItems([{ line: text, source: '' }]);
      return true;
    }
    if (e.target.id === 'trip-join') {
      e.preventDefault();
      try {
        if (!(await join($('#trip-join-code').value))) toast('Trip codes start with TRIP-');
      } catch (err) { toast(err.message); }
      return true;
    }
    return false;
  }

  return { open, close, goHome, render, join, onAction, onSubmit, settingsHtml, planBannerHtml, tripsListHtml, allTrips };
}
