// log.js — an in-page debug log with three outlets: an in-memory ring buffer
// (always), a live tail in the Settings view (when shown), and files in a folder
// the user picked with Chrome's folder picker (File System Access API) when
// one is configured. Nothing is sent anywhere.
//
// Levels: error < warn < info < debug. "debug" includes per-packet detail and is
// gated separately because the Portal sends ~8 packets/s.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const RING_MAX = 5000;

export class Logger extends EventTarget {
  constructor() {
    super();
    this.enabled = false;
    this.level = 'info';
    this.packets = false; // log every Portal packet / machine status (very verbose)
    this.ring = [];
    this.dropped = 0;
    this.folder = null; // FileSystemDirectoryHandle or null
    this.folderState = 'none'; // none | granted | prompt | denied | error
    this.pending = []; // lines not yet flushed to the folder
    this.flushTimer = null;
    this.lastFlushError = null;
    this.bytesWritten = 0;
    this._installGlobalHandlers();
  }

  configure({ enabled, level, packets }) {
    const before = `${this.enabled}|${this.level}|${this.packets}`;
    if (enabled !== undefined) this.enabled = !!enabled;
    if (level && level in LEVELS) this.level = level;
    if (packets !== undefined) this.packets = !!packets;
    const after = `${this.enabled}|${this.level}|${this.packets}`;
    if (after !== before || !this._configuredOnce) this.info('log', `logging ${this.enabled ? 'on' : 'off'} · level ${this.level} · packets ${this.packets ? 'on' : 'off'}`, null, true);
    this._configuredOnce = true;
  }

  /** Log regardless of the enabled flag (used for the enable/disable line itself). */
  error(tag, msg, data) {
    return this._add('error', tag, msg, data, true);
  }
  warn(tag, msg, data) {
    return this._add('warn', tag, msg, data);
  }
  info(tag, msg, data, force = false) {
    return this._add('info', tag, msg, data, force);
  }
  debug(tag, msg, data) {
    return this._add('debug', tag, msg, data);
  }
  /** Per-sample detail; only when `packets` is on. */
  packet(tag, msg, data) {
    if (!this.packets) return;
    return this._add('debug', tag, msg, data);
  }

  _add(level, tag, msg, data, force = false) {
    if (!force && !this.enabled) return;
    if (!force && LEVELS[level] > LEVELS[this.level]) return;
    const entry = { t: Date.now(), level, tag, msg: String(msg), data: safeData(data) };
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) {
      this.ring.shift();
      this.dropped++;
    }
    if (this.folder && this.folderState === 'granted') {
      this.pending.push(formatLine(entry));
      this._scheduleFlush();
    }
    this.dispatchEvent(new CustomEvent('entry', { detail: entry }));
    if (level === 'error') console.error(`[${tag}]`, msg, data ?? '');
    return entry;
  }

  // ---------------------------------------------------------------- output --

  asText(limit = RING_MAX) {
    return this.ring.slice(-limit).map(formatLine).join('\n') + '\n';
  }

  asJsonLines(limit = RING_MAX) {
    return this.ring.slice(-limit).map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  clear() {
    this.ring = [];
    this.dropped = 0;
    this.dispatchEvent(new CustomEvent('cleared'));
  }

  // ---------------------------------------------------------------- folder --

  static get canPickFolder() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  /** Must be called from a user gesture. */
  async pickFolder() {
    if (!Logger.canPickFolder) throw new Error('This browser cannot open a folder picker; use Chrome or Edge, or download the log instead.');
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'portal-met-bridge', startIn: 'documents' });
    await this.useFolder(handle);
    return handle;
  }

  /** Adopt a (possibly restored) handle and check its permission. */
  async useFolder(handle, { request = false } = {}) {
    this.folder = handle || null;
    if (!handle) {
      this.folderState = 'none';
      return 'none';
    }
    try {
      let p = await handle.queryPermission({ mode: 'readwrite' });
      if (p === 'prompt' && request) p = await handle.requestPermission({ mode: 'readwrite' });
      this.folderState = p === 'granted' ? 'granted' : p === 'prompt' ? 'prompt' : 'denied';
    } catch (err) {
      this.folderState = 'error';
      this.lastFlushError = err?.message || String(err);
    }
    this.dispatchEvent(new CustomEvent('folder', { detail: { state: this.folderState, name: handle?.name } }));
    if (this.folderState === 'granted') this.info('log', `log folder: ${handle.name}`, null, true);
    return this.folderState;
  }

  forgetFolder() {
    this.folder = null;
    this.folderState = 'none';
    this.pending = [];
    this.dispatchEvent(new CustomEvent('folder', { detail: { state: 'none' } }));
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 3000);
  }

  /** Append pending lines to <folder>/portal-met-bridge/logs/YYYY-MM-DD.log */
  async flush() {
    if (!this.folder || this.folderState !== 'granted' || !this.pending.length) return;
    const lines = this.pending.splice(0);
    try {
      const dir = await this._subdir('logs');
      const name = new Date().toISOString().slice(0, 10) + '.log';
      const text = lines.join('\n') + '\n';
      await appendToFile(dir, name, text);
      this.bytesWritten += text.length;
      this.lastFlushError = null;
    } catch (err) {
      this.lastFlushError = err?.message || String(err);
      if (/NotAllowed|SecurityError/i.test(this.lastFlushError)) this.folderState = 'prompt';
      this.dispatchEvent(new CustomEvent('folder', { detail: { state: this.folderState, name: this.folder?.name, error: this.lastFlushError } }));
    }
  }

  /** Write any file into <folder>/portal-met-bridge/<sub>/<name>. Returns the path written. */
  async saveFile(sub, name, blobOrText) {
    if (!this.folder || this.folderState !== 'granted') throw new Error('No writable folder is configured.');
    const dir = await this._subdir(sub);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blobOrText);
    await w.close();
    return `${this.folder.name}/portal-met-bridge/${sub}/${name}`;
  }

  async _subdir(sub) {
    const root = await this.folder.getDirectoryHandle('portal-met-bridge', { create: true });
    return root.getDirectoryHandle(sub, { create: true });
  }

  _installGlobalHandlers() {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (e) => this.error('window', e.message, { file: e.filename, line: e.lineno }));
    window.addEventListener('unhandledrejection', (e) => this.error('promise', e.reason?.message || String(e.reason)));
  }
}

async function appendToFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const file = await fh.getFile();
  const w = await fh.createWritable({ keepExistingData: true });
  await w.seek(file.size);
  await w.write(text);
  await w.close();
}

export function formatLine(e) {
  const ts = new Date(e.t).toISOString();
  const data = e.data === undefined || e.data === null ? '' : ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data));
  return `${ts} ${e.level.padEnd(5)} [${e.tag}] ${e.msg}${data}`;
}

function safeData(d) {
  if (d === undefined || d === null) return null;
  if (d instanceof Error) return { error: d.message, name: d.name };
  if (typeof d !== 'object') return d;
  try {
    const s = JSON.stringify(d);
    // Keep entries small: anything over 2 kB is stored as a truncated string.
    return s.length > 2000 ? s.slice(0, 2000) + '…' : JSON.parse(s);
  } catch {
    return String(d);
  }
}

export const log = new Logger();
