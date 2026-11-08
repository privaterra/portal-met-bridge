// store.js — IndexedDB persistence for shots, beans and settings. One database,
// three object stores. Shots carry their own refractometer reading and coffee
// context so calibration can be rebuilt from the shot list alone; the beans
// store is the pick-list of coffees you have entered before.

const DB_NAME = 'portal-met-bridge';
const DB_VERSION = 2;

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
  }

  // ----------------------------------------------------------------- shots --

  async putShot(shot) {
    const db = await this.dbp;
    shot.coffeeKey = coffeeKey(shot.context?.beanName);
    shot.roasterKey = coffeeKey(shot.context?.roaster);
    await tx(db, 'shots', 'readwrite', (s) => s.put(shot));
    return shot;
  }

  async getShot(id) {
    const db = await this.dbp;
    return tx(db, 'shots', 'readonly', (s) => s.get(id));
  }

  async deleteShot(id) {
    const db = await this.dbp;
    await tx(db, 'shots', 'readwrite', (s) => s.delete(id));
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

  async deleteBean(name) {
    const db = await this.dbp;
    await tx(db, 'beans', 'readwrite', (s) => s.delete(coffeeKey(name)));
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
    const [shots, beans] = await Promise.all([this.listShots({ limit: 100000 }), this.listBeans({ limit: 100000 })]);
    return { app: 'portal-met-bridge', version: 2, exportedAt: new Date().toISOString(), shots, beans };
  }

  async importAll(json) {
    if (!json || !Array.isArray(json.shots)) throw new Error('Not a portal-met-bridge export.');
    let n = 0;
    for (const s of json.shots) {
      if (s && s.id && Array.isArray(s.machine)) {
        await this.putShot(s);
        n++;
      }
    }
    if (Array.isArray(json.beans)) {
      const db = await this.dbp;
      for (const b of json.beans) if (b && b.key) await tx(db, 'beans', 'readwrite', (s) => s.put(b));
    }
    return n;
  }
}

/** Shots calibrate per coffee; the key is the normalised bean name. */
export function coffeeKey(name) {
  return (name || '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase();
}
