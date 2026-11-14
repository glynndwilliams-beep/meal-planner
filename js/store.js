// Data storage. Two interchangeable back ends with the same interface:
//   LocalStore    - this device only (localStorage). Used until Firebase is configured.
//   FirebaseStore - shared household data in Cloud Firestore, live-synced between phones.
//
// Data is organised as collections of documents:
//   meta/settings      { days: { mon: { breakfast, lunch, dinner }, ... } }
//   recipes/{id}       { title, serves, ingredients: [string], method, source, photo, createdAt }
//   plans/{weekKey}    { slots: { "mon_dinner": [ { id, type: 'recipe', recipeId } | { id, type: 'text', text } ] } }
//   shopping/{id}      { name, key, amounts, section, checked, sources: [string], createdAt }

const FIREBASE_VERSION = '10.12.2';
export const COLLECTIONS = ['meta', 'recipes', 'plans', 'shopping'];

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(target, src) {
  const out = { ...(target || {}) };
  for (const [k, v] of Object.entries(src)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/* ------------------------------------------------------------------ */
export class LocalStore {
  constructor(key = 'mp-local-data') {
    this.kind = 'local';
    this.key = key;
    try { this.data = JSON.parse(localStorage.getItem(key) || '{}'); } catch { this.data = {}; }
    this.subs = {};
  }
  _save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); }
    catch (e) { console.error(e); alert('Storage is full. Try removing recipe photos or exporting a backup.'); }
  }
  _list(col) { return Object.entries(this.data[col] || {}).map(([id, v]) => ({ id, ...v })); }
  _emit(col) { (this.subs[col] || []).forEach(cb => cb(this._list(col))); }
  subscribe(col, cb) {
    (this.subs[col] ||= []).push(cb);
    cb(this._list(col));
    return () => { this.subs[col] = this.subs[col].filter(f => f !== cb); };
  }
  async set(col, id, val) { (this.data[col] ||= {})[id] = val; this._save(); this._emit(col); }
  async merge(col, id, partial) { (this.data[col] ||= {})[id] = deepMerge(this.data[col][id], partial); this._save(); this._emit(col); }
  async remove(col, id) { if (this.data[col]) delete this.data[col][id]; this._save(); this._emit(col); }
  /** ops: [{ op: 'set'|'merge'|'remove', col, id, val }] */
  async batch(ops) {
    const touched = new Set();
    for (const o of ops) {
      this.data[o.col] ||= {};
      if (o.op === 'remove') delete this.data[o.col][o.id];
      else if (o.op === 'merge') this.data[o.col][o.id] = deepMerge(this.data[o.col][o.id], o.val);
      else this.data[o.col][o.id] = o.val;
      touched.add(o.col);
    }
    this._save();
    touched.forEach(c => this._emit(c));
  }
  dump() { return JSON.parse(JSON.stringify(this.data)); }
  hasData() { return ['recipes', 'plans', 'shopping'].some(c => Object.keys(this.data[c] || {}).length); }
}

/* ------------------------------------------------------------------ */
let fb = null; // lazily loaded Firebase modules
async function loadFirebase(config) {
  if (fb) return fb;
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(config);
  const auth = authMod.getAuth(app);
  let db;
  try {
    db = fsMod.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentSingleTabManager() }),
    });
  } catch {
    db = fsMod.getFirestore(app);
  }
  // Reuse the saved sign-in if there is one (so the app opens offline), otherwise sign in.
  const user = await new Promise(resolve => {
    const stop = authMod.onAuthStateChanged(auth, u => { stop(); resolve(u); });
  });
  if (!user) await authMod.signInAnonymously(auth);
  fb = { ...fsMod, db };
  return fb;
}

export async function householdExists(config, code) {
  const f = await loadFirebase(config);
  const snap = await f.getDoc(f.doc(f.db, 'households', code));
  return snap.exists();
}

export async function createHousehold(config, code) {
  const f = await loadFirebase(config);
  await f.setDoc(f.doc(f.db, 'households', code), { createdAt: Date.now() });
}

export class FirebaseStore {
  constructor(f, code) {
    this.kind = 'firebase';
    this.f = f;
    this.code = code;
  }
  static async open(config, code) {
    const f = await loadFirebase(config);
    return new FirebaseStore(f, code);
  }
  _col(col) { return this.f.collection(this.f.db, 'households', this.code, col); }
  _doc(col, id) { return this.f.doc(this.f.db, 'households', this.code, col, id); }
  subscribe(col, cb, onError) {
    return this.f.onSnapshot(this._col(col),
      snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => { console.error(err); onError && onError(err); });
  }
  set(col, id, val) { return this.f.setDoc(this._doc(col, id), val); }
  merge(col, id, partial) { return this.f.setDoc(this._doc(col, id), partial, { merge: true }); }
  remove(col, id) { return this.f.deleteDoc(this._doc(col, id)); }
  async batch(ops) {
    // Firestore batches are limited to 500 writes.
    for (let i = 0; i < ops.length; i += 450) {
      const b = this.f.writeBatch(this.f.db);
      for (const o of ops.slice(i, i + 450)) {
        const ref = this._doc(o.col, o.id);
        if (o.op === 'remove') b.delete(ref);
        else if (o.op === 'merge') b.set(ref, o.val, { merge: true });
        else b.set(ref, o.val);
      }
      await b.commit();
    }
  }
}

/* ------------------------------------------------------------------ */
const WORDS = ['APPLE', 'BASIL', 'BERRY', 'CHIVE', 'CIDER', 'CLOVE', 'COCOA', 'CRUMB', 'CURRY', 'DATE', 'FENNEL', 'FIG', 'GINGER', 'GRAPE', 'HONEY', 'KALE', 'LEMON', 'LIME', 'MANGO', 'MAPLE', 'MELON', 'MINT', 'OLIVE', 'ONION', 'PEACH', 'PEAR', 'PECAN', 'PLUM', 'RADISH', 'SAGE', 'SPICE', 'THYME', 'TOAST', 'WAFFLE'];
const MORE = ['RIVER', 'CEDAR', 'MEADOW', 'HARBOR', 'ORCHARD', 'GARDEN', 'VALLEY', 'COTTAGE', 'HILL', 'BROOK', 'MAPLE', 'FIELD', 'STONE', 'WILLOW', 'ASPEN', 'HAVEN'];
export function makeHouseholdCode() {
  const r = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  return `${WORDS[r(WORDS.length)]}-${MORE[r(MORE.length)]}-${String(1000 + r(9000))}`;
}
export function normaliseCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}
