// files.js — where the app's files go.
//
// Three destinations:
//   downloads  the browser's download folder (nothing to configure; one file at a time)
//   folder     a folder on this computer, picked with Chrome's folder picker
//              (File System Access API; Chrome and Edge). Chrome asks to re-allow
//              it after a restart.
//   server     the data folder of the server that serves the app, when it was
//              started with DATA_DIR (the macOS app and the Home Assistant app do
//              that). Works from any browser, needs no re-allowing, and the files
//              live where the server runs — on a Raspberry Pi, say.
//
// Under either folder the layout is one root with one subfolder per kind:
//   <root>/<shots>/     each shot's JSON and CSV, written as it is saved
//   <root>/<exports>/   CSV summaries, zips, Beanconqueror files, chart images
//   <root>/<reports>/   per-shot PDF reports
//   <root>/<reviews>/   AI reviews (.md / .docx / .pdf)
//   <root>/<backups>/   database and settings backups (the automatic one too)
//   <root>/<logs>/      the debug log, a file per day
// The root and every subfolder name are settings (Settings → Files and folders).
// Nothing here knows about shots; main.js decides what to write and when.

export const FILE_KINDS = {
  shots: { def: 'shots', label: 'Shot files', what: "each shot's JSON and CSV, written when the shot is saved" },
  exports: { def: 'exports', label: 'Exports', what: 'CSV summaries, zip exports, Beanconqueror files, chart images' },
  reports: { def: 'reports', label: 'Reports', what: 'the per-shot PDF report' },
  reviews: { def: 'reviews', label: 'AI reviews', what: 'saved reviews as .md, .docx or .pdf' },
  backups: { def: 'backups', label: 'Backups', what: 'database and settings backups, the automatic one included' },
  logs: { def: 'logs', label: 'Logs', what: 'the debug log, one file per day' },
};
export const DEFAULT_ROOT = 'portal-met-bridge';
export const DESTINATIONS = ['auto', 'downloads', 'folder', 'server'];

/**
 * A folder name (or a short relative path like `espresso/shots`) safe for the
 * File System Access API, the server and every desktop OS: no `.`/`..`, no
 * hidden or empty parts, none of the characters Windows refuses. Returns the
 * fallback when nothing usable is left; '' is allowed only when the fallback is ''.
 */
export function cleanDirName(value, fallback = '') {
  const parts = String(value ?? '')
    .split(/[\\/]+/)
    .map((p) => p.replace(/[\0-\x1f<>:"|?*]/g, '').trim().replace(/[. ]+$/, ''))
    .filter((p) => p && p !== '.' && p !== '..' && !p.startsWith('.'));
  const clean = parts.join('/');
  if (clean) return clean.length > 120 ? clean.slice(0, 120) : clean;
  return fallback;
}

/** Join path parts, dropping empty ones (an empty root means "directly in the folder"). */
export function joinPath(...parts) {
  return parts.filter((p) => p !== '' && p != null).join('/');
}

export class Files extends EventTarget {
  constructor() {
    super();
    this.folder = null; // FileSystemDirectoryHandle or null
    this.folderState = 'none'; // none | granted | prompt | denied | error
    this.server = null; // { dataDir, host } when the server offers a data folder
    this.serverChecked = false;
    this.destination = 'auto';
    this.layout = { root: DEFAULT_ROOT, ...Object.fromEntries(Object.entries(FILE_KINDS).map(([k, v]) => [k, v.def])) };
    this.lastError = null;
    this.bytesWritten = 0;
    this.filesWritten = 0;
    this.apiBase = 'api/files'; // relative: works behind a path prefix (ingress) too
  }

  // ------------------------------------------------------------- settings --

  /** destination: one of DESTINATIONS; layout: { root, shots, exports, … } (any subset). */
  configure({ destination, layout } = {}) {
    if (destination && DESTINATIONS.includes(destination)) this.destination = destination;
    if (layout) {
      for (const [k, v] of Object.entries(layout)) {
        if (k === 'root') this.layout.root = cleanDirName(v, '');
        else if (k in FILE_KINDS) this.layout[k] = cleanDirName(v, FILE_KINDS[k].def);
      }
    }
    this._changed();
  }

  /** The destination actually in use: 'auto' prefers a chosen folder, then the server, then downloads. */
  get effective() {
    const d = this.destination;
    if (d === 'folder') return 'folder';
    if (d === 'server') return 'server';
    if (d === 'downloads') return 'downloads';
    if (this.folder) return 'folder';
    if (this.server) return 'server';
    return 'downloads';
  }

  /** True when files can be written somewhere other than the download folder right now. */
  get ready() {
    const e = this.effective;
    if (e === 'server') return !!this.server;
    if (e === 'folder') return !!this.folder && this.folderState === 'granted';
    return false;
  }

  /** Why `ready` is false, for the UI; '' when it is true. */
  get blocker() {
    const e = this.effective;
    if (e === 'downloads') return this.destination === 'downloads' ? 'Files are downloaded one by one.' : 'No folder is chosen and this server has no data folder, so files are downloaded.';
    if (e === 'server') return this.server ? '' : 'This server was started without a data folder (DATA_DIR), so files are downloaded instead.';
    if (!this.folder) return 'No folder is chosen yet, so files are downloaded instead.';
    if (this.folderState === 'prompt') return 'Chrome needs you to re-allow the folder (Re-allow folder) — until then files are downloaded.';
    if (this.folderState !== 'granted') return `The folder is not writable (${this.folderState}${this.lastError ? ': ' + this.lastError : ''}); files are downloaded instead.`;
    return '';
  }

  /**
   * The root folder actually used at the effective destination: the configured one,
   * unless the chosen place is itself a folder of that name (the server's data folder
   * ~/Documents/portal-met-bridge, a picked folder called portal-met-bridge), in which
   * case nothing is nested and the kinds sit directly in it.
   */
  get rootInUse() {
    const root = this.layout.root;
    if (!root) return '';
    const e = this.effective;
    const place = e === 'server' && this.server ? this.server.dataDir.replace(/\/+$/, '').split('/').pop() : e === 'folder' && this.folder ? this.folder.name : null;
    return place && place === root ? '' : root;
  }

  /** The folder files go to, as the user would say it: "Documents/espresso/portal-met-bridge/" or "/share/portal-met-bridge/". */
  describe() {
    const e = this.effective;
    const root = this.rootInUse ? `${this.rootInUse}/` : '';
    if (e === 'server' && this.server) return `${this.server.dataDir.replace(/\/+$/, '')}/${root}`;
    if (e === 'folder' && this.folder) return `${this.folder.name}/${root}`;
    return 'the download folder';
  }

  /** The relative path of a file of this kind, under the root: "portal-met-bridge/shots/<name>". */
  pathOf(kind, name) {
    const sub = kind in FILE_KINDS ? this.layout[kind] : cleanDirName(kind, 'misc');
    return joinPath(this.rootInUse, sub, name);
  }

  /** Where a file of this kind lands, for notes in the UI. */
  whereOf(kind) {
    return this.ready ? `${this.describe()}${this.layout[kind] ? this.layout[kind] + '/' : ''}` : 'the download folder';
  }

  // --------------------------------------------------------------- server --

  /** Ask the server whether it has a data folder. Quiet on failure (a plain static host says 404). */
  async probeServer(fetchImpl = typeof fetch === 'function' ? fetch : null) {
    this.serverChecked = true;
    if (!fetchImpl) return null;
    try {
      const res = await fetchImpl(this.apiBase, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const info = await res.json();
      this.server = info && typeof info.dataDir === 'string' ? { dataDir: info.dataDir, host: info.host || '' } : null;
    } catch {
      this.server = null;
    }
    this._changed();
    return this.server;
  }

  // --------------------------------------------------------------- folder --

  static get canPickFolder() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  /** Must be called from a user gesture. */
  async pickFolder() {
    if (!Files.canPickFolder) throw new Error('This browser cannot open a folder picker; use Chrome or Edge, or the server\'s data folder, or downloads.');
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'portal-met-bridge', startIn: 'documents' });
    await this.useFolder(handle);
    return handle;
  }

  /** Adopt a (possibly restored) handle and check its permission. */
  async useFolder(handle, { request = false } = {}) {
    this.folder = handle || null;
    if (!handle) {
      this.folderState = 'none';
      this._changed();
      return 'none';
    }
    try {
      let p = await handle.queryPermission({ mode: 'readwrite' });
      if (p === 'prompt' && request) p = await handle.requestPermission({ mode: 'readwrite' });
      this.folderState = p === 'granted' ? 'granted' : p === 'prompt' ? 'prompt' : 'denied';
      if (this.folderState === 'granted') this.lastError = null;
    } catch (err) {
      this.folderState = 'error';
      this.lastError = err?.message || String(err);
    }
    this._changed();
    return this.folderState;
  }

  forgetFolder() {
    this.folder = null;
    this.folderState = 'none';
    this._changed();
  }

  // ---------------------------------------------------------------- write --

  /**
   * Write (or append to) <root>/<kind>/<name> at the effective destination.
   * Returns the path as a string for notes. Throws when nothing is writable, so
   * the caller can fall back to a download.
   */
  async write(kind, name, data, { append = false, type } = {}) {
    if (!this.ready) throw new Error(this.blocker || 'No writable destination.');
    const rel = this.pathOf(kind, name);
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    try {
      if (this.effective === 'server') await this._putServer(rel, blob, append);
      else await this._putFolder(rel, blob, append);
    } catch (err) {
      this.lastError = err?.message || String(err);
      if (this.effective === 'folder' && /NotAllowed|SecurityError/i.test(this.lastError)) this.folderState = 'prompt';
      this._changed();
      throw err;
    }
    this.bytesWritten += blob.size;
    this.filesWritten++;
    this.lastError = null;
    return this.effective === 'server' ? `${this.server.dataDir.replace(/\/+$/, '')}/${rel}` : `${this.folder.name}/${rel}`;
  }

  async _putServer(rel, blob, append) {
    const url = `${this.apiBase}/${rel.split('/').map(encodeURIComponent).join('/')}${append ? '?append=1' : ''}`;
    const res = await fetch(url, { method: 'PUT', body: blob, headers: { 'content-type': blob.type || 'application/octet-stream' } });
    let body = null;
    try {
      body = await res.json(); // always drain the response, or the browser keeps the request open
    } catch {
      /* no body */
    }
    if (!res.ok) throw new Error(`server refused ${rel}: ${body?.error || res.status}`);
  }

  async _putFolder(rel, blob, append) {
    const parts = rel.split('/');
    const name = parts.pop();
    let dir = this.folder;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    if (append) {
      const file = await fh.getFile();
      const w = await fh.createWritable({ keepExistingData: true });
      await w.seek(file.size);
      await w.write(blob);
      await w.close();
    } else {
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    }
  }

  // ---------------------------------------------------------------- erase --

  /**
   * Remove what this app wrote at the destination — the root folder, or, when no
   * root is in use (files directly in the chosen place), only the known subfolders;
   * never anything else. Returns the names removed.
   */
  async eraseAll() {
    if (!this.ready) return [];
    const root = this.rootInUse;
    const targets = root ? [root] : [...new Set(Object.keys(FILE_KINDS).map((k) => this.layout[k]).filter(Boolean))];
    const removed = [];
    for (const t of targets) {
      try {
        if (this.effective === 'server') {
          const res = await fetch(`${this.apiBase}/${t.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || String(res.status));
          if (body.removed) removed.push(t);
        } else {
          const parts = t.split('/');
          const last = parts.pop();
          let dir = this.folder;
          for (const p of parts) dir = await dir.getDirectoryHandle(p);
          await dir.getDirectoryHandle(last); // throws NotFoundError if absent
          await dir.removeEntry(last, { recursive: true });
          removed.push(t);
        }
      } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
      }
    }
    return removed;
  }

  _changed() {
    this.dispatchEvent(new CustomEvent('change', { detail: { effective: this.effective, ready: this.ready } }));
  }
}

export const files = new Files();
