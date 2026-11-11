// log.js — an in-page debug log with three outlets: an in-memory ring buffer
// (always), a live tail in the Settings view (when shown), and a file per day at
// the app's file destination (files.js: a chosen folder or the server's data
// folder) when one is writable. Nothing is sent anywhere.
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
    this.writer = null; // files.js destination (setWriter)
    this.pending = []; // lines not yet flushed to the destination
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
    if (this.writer) {
      this.pending.push(formatLine(entry));
      if (this.pending.length > RING_MAX) this.pending.splice(0, this.pending.length - RING_MAX);
      if (this.writer.ready) this._scheduleFlush();
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

  // ----------------------------------------------------------------- files --

  /**
   * The file destination (files.js) the log is appended to as it happens:
   * <root>/<logs>/YYYY-MM-DD.log. Lines queue up while nothing is writable and
   * are flushed when a destination becomes ready.
   */
  setWriter(writer) {
    this.writer = writer || null;
    if (writer?.addEventListener) writer.addEventListener('change', () => {
      if (writer.ready && this.pending.length) this._scheduleFlush();
    });
  }

  get writing() {
    return !!this.writer?.ready;
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 3000);
  }

  /** Append pending lines to the day's log file at the destination. */
  async flush() {
    if (!this.writer?.ready || !this.pending.length) return;
    const lines = this.pending.splice(0);
    try {
      const name = new Date().toISOString().slice(0, 10) + '.log';
      const text = lines.join('\n') + '\n';
      await this.writer.write('logs', name, text, { append: true, type: 'text/plain' });
      this.bytesWritten += text.length;
      this.lastFlushError = null;
    } catch (err) {
      this.lastFlushError = err?.message || String(err);
      if (this.pending.length < 2000) this.pending.unshift(...lines); // keep them for the next try
    }
  }

  /** Drop queued lines (the destination is being erased or forgotten). */
  dropPending() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = [];
  }

  _installGlobalHandlers() {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (e) => this.error('window', e.message, { file: e.filename, line: e.lineno }));
    window.addEventListener('unhandledrejection', (e) => this.error('promise', e.reason?.message || String(e.reason)));
  }
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
