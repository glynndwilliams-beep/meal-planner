// Data storage. Two interchangeable back ends with the same interface:
//   LocalStore    - this device only (localStorage). Used until Firebase is configured.
//   FirebaseStore - shared household data in Cloud Firestore, live-synced between phones.
//
// Data is organised as collections of documents:
//   meta/settings      { days: { mon: { breakfast, lunch, dinner }, ... }, pantry: [string], people: number|null }
//   recipes/{id}       { title, serves, ingredients: [string], method, source, photo, tags: [string], rating: 0-5, notes, createdAt }
//   plans/{weekKey}    { slots: { "mon_dinner": [ { id, type: 'recipe', recipeId } | { id, type: 'text', text } ] } }
//   shopping/{id}      { name, key, amounts, section, checked, sources: [string], createdAt }
//   meta/trips         { list: { [tripCode]: { name, start, end, key } } }  (trips this household organises)
//
// Trips (shared with other families for a date range) live outside the household:
//   trips/{code}                 { name, start, end, endsAt: Timestamp, meals: [..], createdAt }
//   trips/{code}/private/owner   { key }   never readable; proves who the organisers are
//   trips/{code}/organisers/{uid}{ key }   phones of the organising household
//   trips/{code}/families|meals|recipes|shopping/{id}
// The security rules (firestore.rules) only let other families in until endsAt.

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
  constructor(key = 'mp-local-data', { root = null } = {}) {
    this.root = root;
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
  // The trip's own document (name, dates): kept under a hidden collection locally.
  subscribeRoot(cb) { return this.subscribe('_root', docs => cb(docs.find(d => d.id === 'doc') || null)); }
  mergeRoot(val) { return this.merge('_root', 'doc', val); }
  async registerOrganiser() { return true; }
  async destroy() { localStorage.removeItem(this.key); this.data = {}; }
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
  fb = { ...fsMod, db, auth };
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
  constructor(f, code, root = 'households') {
    this.kind = 'firebase';
    this.f = f;
    this.code = code;
    this.root = root;
  }
  static async open(config, code, root = 'households') {
    const f = await loadFirebase(config);
    return new FirebaseStore(f, code, root);
  }
  _col(col) { return this.f.collection(this.f.db, this.root, this.code, col); }
  _doc(col, id) { return this.f.doc(this.f.db, this.root, this.code, col, id); }
  _rootRef() { return this.f.doc(this.f.db, this.root, this.code); }
  subscribeRoot(cb, onError) {
    return this.f.onSnapshot(this._rootRef(),
      snap => cb(snap.exists() ? fromFirestore({ id: snap.id, ...snap.data() }) : null),
      err => { console.error(err); onError && onError(err); });
  }
  mergeRoot(val) { return this.f.setDoc(this._rootRef(), toFirestore(this.f, val), { merge: true }); }
  /** Prove this phone belongs to the organising household (needs the secret key from meta/trips). */
  async registerOrganiser(key) {
    const uid = this.f.auth.currentUser && this.f.auth.currentUser.uid;
    if (!uid || !key) return false;
    try { await this.f.setDoc(this._doc('organisers', uid), { key, at: Date.now() }); return true; } catch (e) { console.warn(e); return false; }
  }
  /** Delete the whole trip (organisers only). */
  async destroy() {
    const ops = [];
    for (const col of TRIP_COLLECTIONS) {
      const snap = await this.f.getDocs(this._col(col));
      snap.forEach(d => ops.push({ op: 'remove', col, id: d.id }));
    }
    await this.batch(ops);
    const uid = this.f.auth.currentUser.uid;
    const b = this.f.writeBatch(this.f.db);
    b.delete(this._doc('private', 'owner'));
    b.delete(this._rootRef());
    b.delete(this._doc('organisers', uid));
    await b.commit();
  }
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

/* ------------------------------ trips ------------------------------ */
export const TRIP_COLLECTIONS = ['families', 'meals', 'recipes', 'shopping'];

// endsAt is a real Firestore timestamp so the security rules can compare it with the time.
function toFirestore(f, val) {
  const out = { ...val };
  if (typeof out.endsAt === 'number') out.endsAt = f.Timestamp.fromMillis(out.endsAt);
  return out;
}
function fromFirestore(doc) {
  if (doc && doc.endsAt && typeof doc.endsAt.toMillis === 'function') doc.endsAt = doc.endsAt.toMillis();
  return doc;
}

export function makeTripCode() {
  const r = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  return `TRIP-${WORDS[r(WORDS.length)]}-${MORE[r(MORE.length)]}-${String(100000 + r(900000))}`;
}
/** 128-bit secret that only the organising household knows. */
export function makeSecret() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Create the trip, its secret, and register this phone as an organiser, all in one go. */
export async function createTrip(config, code, info, key) {
  const f = await loadFirebase(config);
  const uid = f.auth.currentUser.uid;
  const b = f.writeBatch(f.db);
  b.set(f.doc(f.db, 'trips', code), toFirestore(f, info));
  b.set(f.doc(f.db, 'trips', code, 'private', 'owner'), { key });
  b.set(f.doc(f.db, 'trips', code, 'organisers', uid), { key, at: Date.now() });
  await b.commit();
}

/** 'open' | 'missing' (wrong code, or ended and locked) */
export async function tripStatus(config, code) {
  const f = await loadFirebase(config);
  try {
    const snap = await f.getDoc(f.doc(f.db, 'trips', code));
    return snap.exists() ? 'open' : 'missing';
  } catch { return 'missing'; } // permission denied = ended (or never existed)
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
