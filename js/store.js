// store.js — IndexedDB persistence for shots, beans and settings. One database,
// three object stores. Shots carry their own refractometer reading and coffee
// context so calibration can be rebuilt from the shot list alone; the beans
// store is the pick-list of coffees you have entered before.

const DB_NAME = 'portal-met-bridge';
const DB_VERSION = 4;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shots')) {
        const s = db.createObjectStore('shots', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('coffeeKey', 'coffeeKey');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      if (!db.objectStoreNames.contains('beans')) {
        const b = db.createObjectStore('beans', { keyPath: 'key' });
        b.createIndex('lastUsed', 'lastUsed');
      }
      // v3: pick-lists for roaster / origin / grinder (bean keeps its richer record)
      if (!db.objectStoreNames.contains('lists')) {
        const l = db.createObjectStore('lists', { keyPath: 'key' });
        l.createIndex('kind', 'kind');
      }
      // v4: saved AI reviews (the report text plus the digest it was made from)
      if (!db.objectStoreNames.contains('reviews')) {
        const r = db.createObjectStore('reviews', { keyPath: 'id' });
        r.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class Store {
  constructor() {
    this.dbp = openDb();
    this.onChange = null; // (kind) => void, called after anything a backup would contain changed
  }

  _changed(kind) {
    try {
      if (this.onChange) this.onChange(kind);
    } catch {
      /* a listener must not break a write */
    }
  }

  // ----------------------------------------------------------------- shots --

  async putShot(shot) {
    const db = await this.dbp;
    shot.coffeeKey = coffeeKey(shot.context?.beanName);
    shot.roasterKey = coffeeKey(shot.context?.roaster);
    await tx(db, 'shots', 'readwrite', (s) => s.put(shot));
    this._changed('shot');
    return shot;
  }

  async getShot(id) {
    const db = await this.dbp;
    return tx(db, 'shots', 'readonly', (s) => s.get(id));
  }

  async deleteShot(id) {
    const db = await this.dbp;
    await tx(db, 'shots', 'readwrite', (s) => s.delete(id));
    this._changed('shot');
  }

  /** Newest first. */
  async listShots({ limit = 200 } = {}) {
    const db = await this.dbp;
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('shots', 'readonly');
      const idx = t.objectStore('shots').index('startedAt');
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ----------------------------------------------------------------- beans --

  /** Upsert a bean from a context; returns the stored record. */
  async rememberBean(ctx) {
    const key = coffeeKey(ctx?.beanName);
    if (!key) return null;
    const db = await this.dbp;
    const prev = (await tx(db, 'beans', 'readonly', (s) => s.get(key))) || { key, createdAt: Date.now(), uses: 0 };
    const rec = {
      ...prev,
      key,
      name: ctx.beanName.trim(),
      roaster: (ctx.roaster || prev.roaster || '').trim(),
      roastLevel: ctx.roastLevel || prev.roastLevel || '',
      process: ctx.process || prev.process || '',
      origin: (ctx.origin || prev.origin || '').trim(),
      lastDoseG: Number(ctx.doseG) || prev.lastDoseG || 0,
      lastGrind: ctx.grindSize || prev.lastGrind || '',
      lastUsed: Date.now(),
      uses: (prev.uses || 0) + 1,
    };
    await tx(db, 'beans', 'readwrite', (s) => s.put(rec));
    this._changed('bean');
    return rec;
  }

  async getBean(name) {
    const key = coffeeKey(name);
    if (!key) return null;
    const db = await this.dbp;
    return tx(db, 'beans', 'readonly', (s) => s.get(key));
  }

  /** Most recently used first. */
  async listBeans({ limit = 200 } = {}) {
    const db = await this.dbp;
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('beans', 'readonly');
      const req = t.objectStore('beans').index('lastUsed').openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Store a bean record as given (the Beans tab's editor); `key` is derived from the name. */
  async putBean(rec) {
    const key = coffeeKey(rec?.name);
    if (!key) throw new Error('A coffee needs a name.');
    const db = await this.dbp;
    const prev = (await tx(db, 'beans', 'readonly', (s) => s.get(key))) || { key, createdAt: Date.now(), uses: 0, lastUsed: Date.now() };
    const out = { ...prev, ...rec, key, name: rec.name.trim() };
    await tx(db, 'beans', 'readwrite', (s) => s.put(out));
    this._changed('bean');
    return out;
  }

  async deleteBean(name) {
    const db = await this.dbp;
    await tx(db, 'beans', 'readwrite', (s) => s.delete(coffeeKey(name)));
    this._changed('list');
  }

  // ------------------------------------------------------------ pick-lists --

  /** Remember a value for a kind ('roaster' | 'origin' | 'grinder'); counts uses. */
  async rememberValue(kind, value) {
    const v = (value || '').trim();
    if (!v || !LIST_KINDS.includes(kind)) return null;
    const key = `${kind}:${coffeeKey(v)}`;
    const db = await this.dbp;
    const prev = (await tx(db, 'lists', 'readonly', (s) => s.get(key))) || { key, kind, createdAt: Date.now(), uses: 0 };
    const rec = { ...prev, value: v, uses: (prev.uses || 0) + 1, lastUsed: Date.now() };
    await tx(db, 'lists', 'readwrite', (s) => s.put(rec));
    this._changed('list');
    return rec;
  }

  /** Values of a kind, most used first, then most recent. */
  async listValues(kind) {
    const db = await this.dbp;
    const all = await new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('lists', 'readonly');
      const req = t.objectStore('lists').index('kind').openCursor(IDBKeyRange.only(kind));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed);
  }

  async forgetValue(kind, value) {
    const db = await this.dbp;
    await tx(db, 'lists', 'readwrite', (s) => s.delete(`${kind}:${coffeeKey(value)}`));
    this._changed('list');
  }

  /** One-time: fill the pick-lists from what beans and shots already know. */
  async seedListsFromHistory() {
    if (await this.getSetting('listsSeeded', false)) return 0;
    let n = 0;
    const beans = await this.listBeans({ limit: 100000 });
    for (const b of beans) {
      if (b.roaster && (await this.rememberValue('roaster', b.roaster))) n++;
      if (b.origin && (await this.rememberValue('origin', b.origin))) n++;
    }
    const shots = await this.listShots({ limit: 100000 });
    const seen = new Set();
    for (const s of shots) {
      const c = s.context || {};
      for (const [kind, v] of [['roaster', c.roaster], ['origin', c.origin], ['grinder', c.grinderName]]) {
        if (!v) continue;
        const k = `${kind}:${coffeeKey(v)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (await this.rememberValue(kind, v)) n++;
      }
    }
    await this.setSetting('listsSeeded', true);
    return n;
  }

  /**
   * One-time (v0.10): before shot.beverageG existed, a cup weighed by hand was
   * kept only on the refractometer reading. Promote those to the shot's own field
   * when they differ from what the scale saw; a value equal to the scale was the
   * app's own fallback, not something the user typed.
   */
  async promoteLegacyBeverage() {
    if (await this.getSetting('beveragePromoted', false)) return 0;
    let n = 0;
    for (const s of await this.listShots({ limit: 100000 })) {
      const typed = Number(s.refractometer?.beverageG);
      if (!(typed > 0) || Number(s.beverageG) > 0) continue;
      if (Number.isFinite(s.finalWeightG) && Math.abs(typed - s.finalWeightG) < 0.25) continue;
      s.beverageG = Math.round(typed * 10) / 10;
      await this.putShot(s);
      n++;
    }
    await this.setSetting('beveragePromoted', true);
    return n;
  }

  // --------------------------------------------------------------- reviews --

  async putReview(review) {
    const db = await this.dbp;
    await tx(db, 'reviews', 'readwrite', (s) => s.put(review));
    this._changed('review');
    return review;
  }

  async getReview(id) {
    const db = await this.dbp;
    return tx(db, 'reviews', 'readonly', (s) => s.get(id));
  }

  async deleteReview(id) {
    const db = await this.dbp;
    await tx(db, 'reviews', 'readwrite', (s) => s.delete(id));
    this._changed('review');
  }

  /** Newest first. */
  async listReviews({ limit = 500 } = {}) {
    const db = await this.dbp;
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction('reviews', 'readonly');
      const req = t.objectStore('reviews').index('createdAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // -------------------------------------------------------------- settings --

  async getSetting(key, fallback = null) {
    const db = await this.dbp;
    const v = await tx(db, 'settings', 'readonly', (s) => s.get(key));
    return v === undefined ? fallback : v;
  }

  async setSetting(key, value) {
    const db = await this.dbp;
    await tx(db, 'settings', 'readwrite', (s) => s.put(value, key));
  }

  // ------------------------------------------------------- backup/restore --

  async exportAll() {
    const [shots, beans, reviews, ...lists] = await Promise.all([this.listShots({ limit: 100000 }), this.listBeans({ limit: 100000 }), this.listReviews({ limit: 100000 }), ...LIST_KINDS.map((k) => this.listValues(k))]);
    return { app: 'portal-met-bridge', version: 4, exportedAt: new Date().toISOString(), shots, beans, reviews, lists: lists.flat() };
  }

  async importAll(json) {
    if (!json || !Array.isArray(json.shots)) throw new Error('Not a portal-met-bridge export.');
    let n = 0;
    // A backup is a file from somewhere: every record is brought to the shape the app itself writes before it is stored.
    for (const raw of json.shots) {
      const s = cleanImportedShot(raw);
      if (s) {
        await this.putShot(s);
        n++;
      }
    }
    const db = await this.dbp;
    if (Array.isArray(json.beans)) {
      for (const raw of json.beans) {
        const b = cleanImportedBean(raw);
        if (b) await tx(db, 'beans', 'readwrite', (s) => s.put(b));
      }
    }
    if (Array.isArray(json.lists)) {
      for (const l of json.lists) if (l && typeof l.key === 'string' && LIST_KINDS.includes(l.kind) && typeof l.value === 'string') await tx(db, 'lists', 'readwrite', (s) => s.put({ key: l.key.slice(0, 300), kind: l.kind, value: l.value.slice(0, 200), uses: Number(l.uses) || 0, lastUsed: Number(l.lastUsed) || 0 }));
    }
    if (Array.isArray(json.reviews)) {
      for (const raw of json.reviews) {
        const r = cleanImportedReview(raw);
        if (r) await tx(db, 'reviews', 'readwrite', (s) => s.put(r));
      }
    }
    this._changed('import');
    return n;
  }
}

/** Close the connection so the database can be deleted. */
Store.prototype.close = async function close() {
  try {
    const db = await this.dbp;
    db.close();
  } catch {
    /* never opened */
  }
};

/** Delete this app's databases (current and the v0.1 name). Resolves with what happened per database. */
export function deleteAllDatabases() {
  const names = [DB_NAME, 'portal-bridge'];
  return Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          let blocked = false;
          req.onblocked = () => {
            blocked = true;
          };
          req.onsuccess = () => resolve({ name, ok: true, blocked });
          req.onerror = () => resolve({ name, ok: false, error: req.error?.message || 'error' });
          // deleteDatabase never settles while another tab holds the DB open; don't hang forever.
          setTimeout(() => resolve({ name, ok: false, blocked: true, error: 'another tab of this app still has the database open' }), 8000);
        }),
    ),
  );
}

export const LIST_KINDS = ['roaster', 'origin', 'grinder'];

/** Shots calibrate per coffee; the key is the normalised bean name. */
export function coffeeKey(name) {
  return (name || '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase();
}

// ---------------------------------------------------------------- import --
// Records from a backup file are normalised to the types the app writes itself:
// ids and names become bounded strings, measurements finite numbers, sample
// lists arrays of plain objects. Nothing is trusted to be the shape it claims,
// so a crafted file cannot smuggle an object where the page expects a number.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const numberOr = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const NUMBER_FIELDS = ['startedAt', 'endedAt', 'durationSec', 'finalWeightG', 'beverageG', 'profileTargetG', 'profileTemperatureC', 'rating', 'ratingMax', 'lagSec'];
const TEXT_FIELDS = ['profileName', 'profileId', 'source', 'machineShotId', 'comment', 'beverageSource', 'machineName'];

/** Flat objects of strings/numbers/booleans (a shot's context, its file paths); anything nested is dropped. */
function cleanFlat(obj, max = 500) {
  if (!isObj(obj)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 80)) {
    if (typeof v === 'string') out[k] = v.slice(0, max);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function cleanImportedShot(raw) {
  if (!isObj(raw) || !Array.isArray(raw.machine)) return null;
  const id = text(raw.id, 200);
  if (!id) return null;
  const out = { ...raw, id, machine: raw.machine.filter(isObj), portal: Array.isArray(raw.portal) ? raw.portal.filter(isObj) : [] };
  for (const k of NUMBER_FIELDS) {
    if (!(k in raw)) continue;
    const v = numberOr(raw[k]);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  for (const k of TEXT_FIELDS) {
    if (!(k in raw)) continue;
    const v = text(raw[k], k === 'comment' ? 2000 : 300);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  if ('context' in raw) out.context = cleanFlat(raw.context, 2000) || {};
  if ('files' in raw) {
    const f = cleanFlat(raw.files, 1000);
    if (f) out.files = f;
    else delete out.files;
  }
  if ('refractometer' in raw) {
    const r = cleanFlat(raw.refractometer);
    if (r) out.refractometer = r;
    else delete out.refractometer;
  }
  for (const k of ['inProgress', 'recovered', 'manual']) if (k in raw) out[k] = raw[k] === true;
  for (const k of ['machineSource', 'reviewProfile', 'checkpoint']) if (k in raw && !isObj(raw[k])) delete out[k];
  if (!Number.isFinite(out.startedAt)) out.startedAt = 0;
  return out;
}

export function cleanImportedBean(raw) {
  if (!isObj(raw)) return null;
  const name = text(raw.name, 200);
  const key = text(raw.key, 300);
  if (!name || !key) return null;
  const out = { key, name, uses: Number(raw.uses) || 0, lastUsed: Number(raw.lastUsed) || 0, createdAt: Number(raw.createdAt) || 0 };
  for (const k of ['roaster', 'origin', 'process', 'roastLevel', 'url', 'notes', 'lastGrind', 'grinderName']) {
    const v = text(raw[k], k === 'notes' ? 2000 : 500);
    if (v !== undefined) out[k] = v;
  }
  const dose = numberOr(raw.lastDoseG);
  if (dose !== undefined) out.lastDoseG = dose;
  return out;
}

export function cleanImportedReview(raw) {
  if (!isObj(raw) || typeof raw.markdown !== 'string') return null;
  const id = text(raw.id, 200);
  if (!id) return null;
  return {
    ...raw,
    id,
    markdown: raw.markdown.slice(0, 400000),
    title: text(raw.title, 300) || 'Review',
    provider: text(raw.provider, 40) || '',
    model: text(raw.model, 120) || '',
    taste: text(raw.taste, 4000) || '',
    question: text(raw.question, 4000) || '',
    createdAt: Number(raw.createdAt) || 0,
    durationMs: Number(raw.durationMs) || 0,
    shotIds: Array.isArray(raw.shotIds) ? raw.shotIds.map((x) => text(x, 200)).filter(Boolean) : [],
    shotLabels: Array.isArray(raw.shotLabels) ? raw.shotLabels.map((x) => text(x, 300)).filter(Boolean) : [],
    digests: Array.isArray(raw.digests) ? raw.digests.filter(isObj) : [],
  };
}
