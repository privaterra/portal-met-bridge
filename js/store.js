// store.js — IndexedDB persistence for shots and settings. One database,
// two object stores. Shots carry their own refractometer reading and coffee
// context so calibration can be rebuilt from the shot list alone.

const DB_NAME = 'portal-bridge';
const DB_VERSION = 1;

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

  async putShot(shot) {
    const db = await this.dbp;
    shot.coffeeKey = coffeeKey(shot.context?.beanName);
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

  async getSetting(key, fallback = null) {
    const db = await this.dbp;
    const v = await tx(db, 'settings', 'readonly', (s) => s.get(key));
    return v === undefined ? fallback : v;
  }

  async setSetting(key, value) {
    const db = await this.dbp;
    await tx(db, 'settings', 'readwrite', (s) => s.put(value, key));
  }

  async exportAll() {
    const shots = await this.listShots({ limit: 100000 });
    return { app: 'portal-met-bridge', version: 1, exportedAt: new Date().toISOString(), shots };
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
    return n;
  }
}

/** Shots calibrate per coffee; the key is the normalised bean name. */
export function coffeeKey(beanName) {
  return (beanName || '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase();
}
