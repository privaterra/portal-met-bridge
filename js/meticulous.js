// meticulous.js — client for the Meticulous espresso machine's local API.
//
// On the machine, nginx fronts the backend (MeticulousHome/meticulous-backend)
// on **port 80**: REST under /api/v1 and socket.io on the same origin, CORS
// open. The backend's own 8080 listener is bound to localhost and is not
// reachable over the network (it only matters for an emulated backend run
// without nginx, e.g. in Docker). This matches the nickwilsonr/meticulous-addon
// finding. Verified against firmware 0.2.24 (beta channel) on 2026-11-08.
// DEFAULT_HOST is a placeholder: type your machine's LAN IP or meticulous.local.
//
//   socket.io "status"  (~10 Hz): { name, state, extracting, time (ms since shot
//       start), profile, profile_time, sensors: { p bar, f ml/s, w g, t °C,
//       g gravimetric ml/s }, setpoints: { active, pressure?, flow? },
//       loaded_profile, id }
//   socket.io "sensors" (same cadence): { t_ext_1, t_ext_2, t_bar_up, t_bar_mu,
//       t_bar_md, t_bar_down, t_tube, t_motor_temp, lam_temp, p, m_pos, m_spd,
//       m_pwr, m_cur, bh_pwr, bh_cur, w_stat, motor_temp, weight_pred, ... }
//   socket.io "settings", "notification", "profile", "action", "OSUpdate"
//   GET  /api/v1/machine           device info (name, hostname, firmware, serial,
//                                  colour, batch, mainVoltage, image_version, …)
//   GET  /api/v1/history/stats     { totalSavedShots, byProfile[], mileage }
//   GET  /api/v1/history/last      last saved shot: { id, time (epoch s), name,
//                                  profile_name, profile{…stages}, data[] }
//   POST /api/v1/history           { history: [...] }
//   GET  /api/v1/profile/list      [{ id, name, author, temperature,
//                                  final_weight, variables[], display{image} }]
//   GET  /api/v1/profile/last      { profile: {…} } or the last loaded profile
//   GET  /api/v1/settings          machine settings
//   GET  /api/v1/wifi/config       { config, status{ips,mac,hostname}, health{…} }
//   GET  /api/v1/notifications     pending notifications

import { io } from '../vendor/socket.io.esm.min.js';

export const DEFAULT_HOST = '127.0.0.1';

export function normalizeBaseUrl(input) {
  let s = (input || '').trim();
  if (!s) s = DEFAULT_HOST;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  return u.origin; // no port → 80, which is what the machine serves
}

/** The machine writes bare NaN / Infinity into shot JSON; JSON.parse refuses them. */
export function parseLooseJson(text) {
  if (!text || text === 'null') return null;
  return JSON.parse(text.replace(/:\s*(-?Infinity|NaN)\b/g, ': null'));
}

/**
 * The machine's origin as the page can reach it. `via: 'server'` goes through
 * the serving host's proxy (serve.mjs: /machine/<host[:port]>/…), which a page
 * on https must use (its plain-http API would be mixed content) and which also
 * works when the browser cannot reach the machine's address itself.
 */
export function machineBaseUrl(input, { via = 'direct', pageOrigin = typeof location !== 'undefined' ? location.origin : '' } = {}) {
  const direct = normalizeBaseUrl(input);
  if (via !== 'server') return direct;
  const u = new URL(direct);
  return `${pageOrigin}/machine/${u.host}`;
}

export class MeticulousClient extends EventTarget {
  constructor(baseUrl, { via = 'direct' } = {}) {
    super();
    this.via = via === 'server' ? 'server' : 'direct';
    this.directUrl = normalizeBaseUrl(baseUrl);
    this.baseUrl = machineBaseUrl(baseUrl, { via: this.via });
    this.socket = null;
    this.connected = false;
    this.lastStatus = null;
    this.lastStatusAt = 0;
    this.lastSensors = null;
    this.lastSettings = null;
  }

  connect() {
    if (this.socket) return;
    this._emit('state', { state: 'connecting', url: this.baseUrl });
    const opts = { transports: ['websocket', 'polling'], reconnection: true, reconnectionDelayMax: 10000, timeout: 8000 };
    if (this.via === 'server') {
      // socket.io on the proxy path: ws(s)://<page host>/machine/<host>/socket.io/…
      const u = new URL(this.baseUrl);
      this.socket = io(u.origin, { ...opts, path: `${u.pathname.replace(/\/$/, '')}/socket.io` });
    } else this.socket = io(this.baseUrl, opts);
    this.socket.on('connect', () => {
      this.connected = true;
      this._emit('state', { state: 'connected', url: this.baseUrl });
    });
    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this._emit('state', { state: 'disconnected', reason });
    });
    this.socket.on('connect_error', (err) => {
      this._emit('state', { state: 'error', error: err?.message || String(err) });
    });
    this.socket.on('status', (data) => {
      const s = normalizeStatus(data);
      this.lastStatus = s;
      this.lastStatusAt = performance.now();
      this._emit('status', s);
    });
    this.socket.on('sensors', (data) => {
      this.lastSensors = { ...data, at: performance.now() };
      this._emit('sensors', this.lastSensors);
    });
    for (const ev of ['settings', 'notification', 'profile', 'action', 'OSUpdate', 'button']) {
      this.socket.on(ev, (data) => {
        if (ev === 'settings') this.lastSettings = data;
        this._emit(ev, data);
      });
    }
  }

  disconnect() {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.connected = false;
    this._emit('state', { state: 'disconnected' });
  }

  async _get(path, timeoutMs = 10000) {
    const r = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
    return parseLooseJson(await r.text());
  }

  ping() {
    return this._get('/api/v1/history/stats', 5000);
  }
  machineInfo() {
    return this._get('/api/v1/machine');
  }
  stats() {
    return this._get('/api/v1/history/stats');
  }
  settings() {
    return this._get('/api/v1/settings');
  }
  wifi() {
    return this._get('/api/v1/wifi/config');
  }
  notifications() {
    return this._get('/api/v1/notifications').catch(() => []);
  }
  /** The machine's profiles; `full` adds the stages (the list is otherwise name/target/temperature/variables). */
  profiles({ full = false } = {}) {
    return this._get(full ? '/api/v1/profile/list?full=true' : '/api/v1/profile/list');
  }
  /** One profile with everything in it (stages, variables, description); 404 when the id is unknown. */
  profile(id) {
    return this._get(`/api/v1/profile/get/${encodeURIComponent(id)}`);
  }
  lastProfile() {
    return this._get('/api/v1/profile/last').catch(() => null);
  }
  lastShot() {
    return this._get('/api/v1/history/last', 20000);
  }
  imageUrl(path) {
    if (!path) return null;
    return path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /** Shot list, newest first. dumpData=false keeps it light. */
  async history({ maxResults = 50, query = '', dumpData = false, ids = [] } = {}) {
    const body = { query, ids, start_date: null, end_date: null, order_by: ['date'], sort: 'desc', max_results: maxResults, dump_data: dumpData };
    const r = await fetch(`${this.baseUrl}/api/v1/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = parseLooseJson(await r.text());
    return json?.history || [];
  }

  async shotById(id) {
    const list = await this.history({ ids: [id], dumpData: true, maxResults: 1 });
    return list[0] || null;
  }

  /**
   * Machine actions (backend: api/action.py → Machine.ALLOWED_ESP_ACTIONS + ["reset","abort"]).
   * 'start' is the dial click: from idle it loads the last profile and heats; at
   * "click to start" it begins the shot. 'abort' ends a running profile the safe
   * way (home during a shot, stop otherwise). The backend answers 409 when the
   * ESP refuses and 400 with the allowed list for an unknown action.
   */
  async action(name) {
    const r = await fetch(`${this.baseUrl}/api/v1/action/${encodeURIComponent(name)}`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    let json = null;
    try {
      json = text ? parseLooseJson(text) : null;
    } catch {
      json = null;
    }
    if (!r.ok) {
      const why = json?.error || (r.status === 409 ? 'the machine refused it (busy, or a motor-strain alarm is up)' : `HTTP ${r.status}`);
      const err = new Error(`${name}: ${why}`);
      err.status = r.status;
      err.allowed = json?.allowed_actions;
      throw err;
    }
    return json || { action: name, status: 'ok' };
  }

  /** Load a profile by id so the next start brews it (409 while the machine is busy). */
  async loadProfile(id) {
    const r = await fetch(`${this.baseUrl}/api/v1/profile/load/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    const json = text ? parseLooseJson(text) : null;
    if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
    return json; // { name, id }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** Flatten a socket.io status into the sample shape the recorder stores. */
export function normalizeStatus(d) {
  const s = d?.sensors || {};
  return {
    name: d?.name ?? '',
    state: d?.state ?? '',
    extracting: !!d?.extracting,
    timeMs: Number.isFinite(d?.time) ? d.time : -1,
    profileTimeMs: Number.isFinite(d?.profile_time) ? d.profile_time : -1,
    profile: d?.profile ?? d?.loaded_profile ?? null,
    loadedProfile: d?.loaded_profile ?? null,
    profileId: d?.id ?? null,
    p: num(s.p),
    f: num(s.f),
    w: num(s.w),
    temp: num(s.t),
    g: num(s.g),
    setpoints: d?.setpoints ?? null,
    at: performance.now(),
  };
}

/** Stage names that mean the pump is no longer pushing water into the puck. */
const END_STAGES = /retract|idle|purge|done|finish|closing|click to start/i;

/** Convert a saved machine shot (history entry or /history/last) into machine samples. */
export function machineSamplesFromSavedShot(saved) {
  const data = saved?.data || [];
  const out = [];
  for (const d of data) {
    const sh = d.shot || {};
    const ms = Number.isFinite(d.time) ? d.time : null;
    if (ms === null) continue;
    const sens = d.sensors || {};
    out.push({
      t: ms / 1000,
      p: num(sh.pressure),
      f: num(sh.flow),
      w: num(sh.weight),
      g: num(sh.gravimetric_flow),
      // The saved file has no "brew temp" field; external_1 is the probe the
      // live stream's sensors.t tracks most closely on this firmware.
      temp: num(sens.external_1 ?? sens.tube),
      status: d.status ?? '',
      setpoint: sh.setpoints?.active ? num(sh.setpoints[sh.setpoints.active]) : NaN,
      ext: {
        tExt1: num(sens.external_1), tExt2: num(sens.external_2), tBarUp: num(sens.bar_up), tBarMidUp: num(sens.bar_mid_up),
        tBarMidDown: num(sens.bar_mid_down), tBarDown: num(sens.bar_down), tTube: num(sens.tube), motorTemp: num(sens.motor_temp),
        motorPos: num(sens.motor_position), motorSpeed: num(sens.motor_speed), motorPower: num(sens.motor_power), motorCurrent: num(sens.motor_current),
        heaterPower: num(sens.bandheater_power),
      },
    });
  }
  return out;
}

/** Duration of the extraction proper inside a saved shot (before retraction). */
export function extractionEndSec(samples) {
  let end = 0;
  for (const s of samples) if (s.status && !END_STAGES.test(s.status)) end = s.t;
  return end || (samples.length ? samples[samples.length - 1].t : 0);
}

export function isEndStage(status) {
  return END_STAGES.test(status || '');
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
