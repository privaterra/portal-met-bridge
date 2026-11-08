// portal-ble.js — Web Bluetooth driver for the Belka Portal.
//
// Protocol (from variegated-coffee/variegated-rs, crate
// variegated-belka-portal-trouble-driver, MIT © Magnus Nordlander; verified
// against one device by the Decenza project):
//   service          0x7400  (advertised — the variegated firmware recognises a
//                             Portal by this UUID in its advertising data, so a
//                             Web Bluetooth `services` filter can match it)
//   measurement char 0x7410  read + notify, 13 bytes:
//                              [0..4)  EC                 f32 LE
//                              [4..8)  internal temp (?)  f32 LE
//                              [8..12) outlet temp °C     f32 LE
//                              [12]    status byte (battery-ish; semantics unverified)
//   command char     0x7420  write-with-response, 4 bytes; two known payloads:
//                              40 00 01 2D  show graph on the Portal's screen
//                              40 00 01 2E  hide graph
// The Portal acknowledges writes but never reports whether it understood them.
//
// macOS + Chrome notes: Web Bluetooth needs a secure origin (http://localhost
// counts), Chrome needs the Bluetooth permission in System Settings → Privacy &
// Security → Bluetooth, and the Portal must not be connected to the phone app.

export const PORTAL_SERVICE = 0x7400;
export const MEASUREMENT_CHAR = 0x7410;
export const COMMAND_CHAR = 0x7420;
export const SHOW_GRAPH = Uint8Array.of(0x40, 0x00, 0x01, 0x2d);
export const HIDE_GRAPH = Uint8Array.of(0x40, 0x00, 0x01, 0x2e);
export const PACKET_BYTES = 13;

/** Connection steps, in order, for the "connection check" display. */
export const STEPS = ['secure', 'api', 'adapter', 'device', 'gatt', 'service', 'measurement', 'command', 'notify', 'packet'];

export function parseMeasurement(dataView) {
  if (!dataView || dataView.byteLength !== PACKET_BYTES) return null;
  const ec = dataView.getFloat32(0, true);
  const tInt = dataView.getFloat32(4, true);
  const tOut = dataView.getFloat32(8, true);
  const status = dataView.getUint8(12);
  if (![ec, tInt, tOut].every(Number.isFinite)) return null;
  return { ec, tInt, tOut, status };
}

export function bluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/** Environment checks that need no device: secure context, API, adapter. */
export async function environmentCheck() {
  const out = {
    secure: typeof window !== 'undefined' && window.isSecureContext,
    api: bluetoothSupported(),
    adapter: null,
    hint: '',
  };
  if (!out.secure) out.hint = 'Open the app at http://localhost (not a file:// path or a LAN address); Web Bluetooth needs a secure page.';
  else if (!out.api) out.hint = 'This browser has no Web Bluetooth. Use Google Chrome or Microsoft Edge.';
  else if (navigator.bluetooth.getAvailability) {
    try {
      out.adapter = await navigator.bluetooth.getAvailability();
      if (!out.adapter) out.hint = 'No Bluetooth adapter is available to Chrome. On macOS: turn Bluetooth on, and allow Google Chrome under System Settings → Privacy & Security → Bluetooth.';
    } catch {
      out.adapter = null;
    }
  }
  return out;
}

export class PortalBle extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.measurement = null;
    this.command = null;
    this.connected = false;
    this.last = null;
    this.lastAt = 0;
    this.packetCount = 0;
    this.malformedCount = 0;
    this.rateWindow = [];
    this.steps = {}; // step → true | false | 'error message'
    this._wantReconnect = false;
    this._onNotify = (ev) => this._handle(ev.target.value);
    this._onDisconnect = () => this._disconnected();
  }

  /** Ask the browser for a Portal. Must be called from a user gesture. */
  async pick({ acceptAll = false } = {}) {
    const env = await environmentCheck();
    this._step('secure', env.secure);
    this._step('api', env.api);
    this._step('adapter', env.adapter === null ? null : env.adapter);
    if (!env.secure || !env.api) throw new Error(env.hint);
    const request = acceptAll
      ? { acceptAllDevices: true, optionalServices: [PORTAL_SERVICE] }
      : {
          // Filters are OR-ed: the advertised service is the real match; the
          // name prefixes are a fallback for firmware that advertises no UUID.
          filters: [{ services: [PORTAL_SERVICE] }, { namePrefix: 'PORTAL' }, { namePrefix: 'Portal' }, { namePrefix: 'Belka' }],
          optionalServices: [PORTAL_SERVICE],
        };
    this.device = await navigator.bluetooth.requestDevice(request);
    this._step('device', this.device.name || '(unnamed device)');
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    this._wantReconnect = true;
    await this.connect();
    return this.device;
  }

  async connect() {
    if (!this.device) throw new Error('No Portal selected yet.');
    this._emit('state', { state: 'connecting' });
    for (const k of ['gatt', 'service', 'measurement', 'command', 'notify', 'packet']) this._step(k, null);
    try {
      this.server = await this.device.gatt.connect();
      this._step('gatt', true);
      const service = await this.server.getPrimaryService(PORTAL_SERVICE);
      this._step('service', true);
      this.measurement = await service.getCharacteristic(MEASUREMENT_CHAR);
      this._step('measurement', true);
      try {
        this.command = await service.getCharacteristic(COMMAND_CHAR);
        this._step('command', true);
      } catch {
        this.command = null; // older firmware may not expose it
        this._step('command', 'not exposed by this firmware');
      }
      // An initial read, then notifications.
      try {
        const v = await this.measurement.readValue();
        this._handle(v);
      } catch {
        /* some stacks refuse a read before notifications start; fine */
      }
      this.measurement.addEventListener('characteristicvaluechanged', this._onNotify);
      await this.measurement.startNotifications();
      this._step('notify', true);
      this.connected = true;
      this._emit('state', { state: 'connected', name: this.device.name || 'Belka Portal' });
    } catch (err) {
      const failed = ['gatt', 'service', 'measurement', 'notify'].find((k) => this.steps[k] === null) || 'gatt';
      this._step(failed, err?.message || String(err));
      this.connected = false;
      this._emit('state', { state: 'error', error: err?.message || String(err) });
      throw err;
    }
  }

  async disconnect() {
    this._wantReconnect = false;
    try {
      if (this.measurement) {
        this.measurement.removeEventListener('characteristicvaluechanged', this._onNotify);
        await this.measurement.stopNotifications().catch(() => {});
      }
    } finally {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
      this.connected = false;
      this._emit('state', { state: 'disconnected' });
    }
  }

  /** Write one of the known 4-byte commands. Resolves when the Portal acknowledges the bytes. */
  async writeCommand(payload) {
    if (!this.connected || !this.command) throw new Error('Portal command characteristic is not available.');
    if (this.command.writeValueWithResponse) await this.command.writeValueWithResponse(payload);
    else await this.command.writeValue(payload);
  }

  showGraph() {
    return this.writeCommand(SHOW_GRAPH);
  }

  hideGraph() {
    return this.writeCommand(HIDE_GRAPH);
  }

  /** True when a notification arrived within the last `staleMs`. */
  isFresh(staleMs = 5000) {
    return this.connected && this.lastAt > 0 && performance.now() - this.lastAt < staleMs;
  }

  /** Notifications per second over the last ~5 s. */
  packetRate() {
    const now = performance.now();
    this.rateWindow = this.rateWindow.filter((t) => now - t < 5000);
    return this.rateWindow.length / 5;
  }

  _handle(view) {
    const m = parseMeasurement(view);
    if (!m) {
      this.malformedCount++;
      this._step('packet', `unexpected length ${view?.byteLength ?? 0} B (expected ${PACKET_BYTES})`);
      this._emit('malformed', { byteLength: view?.byteLength ?? 0 });
      return;
    }
    const now = performance.now();
    this.packetCount++;
    this.rateWindow.push(now);
    if (this.steps.packet !== true) this._step('packet', true);
    this.last = { ...m, at: now, wall: Date.now(), raw: Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
    this.lastAt = now;
    this._emit('measurement', this.last);
  }

  async _disconnected() {
    this.connected = false;
    this._step('gatt', false);
    this._emit('state', { state: 'disconnected' });
    if (!this._wantReconnect) return;
    // Exponential backoff reconnect while the user still wants this Portal.
    for (let attempt = 0; attempt < 6 && this._wantReconnect; attempt++) {
      await sleep(1000 * 2 ** attempt);
      if (!this._wantReconnect) return;
      try {
        await this.connect();
        return;
      } catch {
        /* keep trying */
      }
    }
    this._emit('state', { state: 'lost' });
  }

  _step(name, value) {
    this.steps[name] = value;
    this._emit('step', { name, value, steps: { ...this.steps } });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
