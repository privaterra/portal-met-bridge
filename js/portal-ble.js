// portal-ble.js — Web Bluetooth driver for the Belka Portal.
//
// Protocol (from variegated-coffee/variegated-rs, crate
// variegated-belka-portal-trouble-driver, MIT © Magnus Nordlander; verified
// against one device by the Decenza project):
//   service          0x7400
//   measurement char 0x7410  read + notify, 13 bytes:
//                              [0..4)  EC                 f32 LE
//                              [4..8)  internal temp (?)  f32 LE
//                              [8..12) outlet temp °C     f32 LE
//                              [12]    status byte (battery-ish; semantics unverified)
//   command char     0x7420  write-with-response, 4 bytes; two known payloads:
//                              40 00 01 2D  show graph on the Portal's screen
//                              40 00 01 2E  hide graph
// The Portal acknowledges writes but never reports whether it understood them.

export const PORTAL_SERVICE = 0x7400;
export const MEASUREMENT_CHAR = 0x7410;
export const COMMAND_CHAR = 0x7420;
export const SHOW_GRAPH = Uint8Array.of(0x40, 0x00, 0x01, 0x2d);
export const HIDE_GRAPH = Uint8Array.of(0x40, 0x00, 0x01, 0x2e);

export function parseMeasurement(dataView) {
  if (!dataView || dataView.byteLength !== 13) return null;
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
    this._wantReconnect = false;
    this._onNotify = (ev) => this._handle(ev.target.value);
    this._onDisconnect = () => this._disconnected();
  }

  /** Ask the browser for a Portal. Must be called from a user gesture. */
  async pick({ acceptAll = false } = {}) {
    if (!bluetoothSupported()) throw new Error('Web Bluetooth is not available in this browser. Use Chrome or Edge on macOS, served from http://localhost.');
    const request = acceptAll
      ? { acceptAllDevices: true, optionalServices: [PORTAL_SERVICE] }
      : { filters: [{ services: [PORTAL_SERVICE] }], optionalServices: [PORTAL_SERVICE] };
    this.device = await navigator.bluetooth.requestDevice(request);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    this._wantReconnect = true;
    await this.connect();
    return this.device;
  }

  async connect() {
    if (!this.device) throw new Error('No Portal selected yet.');
    this._emit('state', { state: 'connecting' });
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(PORTAL_SERVICE);
    this.measurement = await service.getCharacteristic(MEASUREMENT_CHAR);
    try {
      this.command = await service.getCharacteristic(COMMAND_CHAR);
    } catch {
      this.command = null; // older firmware may not expose it
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
    this.connected = true;
    this._emit('state', { state: 'connected', name: this.device.name || 'Belka Portal' });
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

  _handle(view) {
    const m = parseMeasurement(view);
    if (!m) {
      this._emit('malformed', { byteLength: view?.byteLength ?? 0 });
      return;
    }
    const now = performance.now();
    this.last = { ...m, at: now, wall: Date.now() };
    this.lastAt = now;
    this._emit('measurement', this.last);
  }

  async _disconnected() {
    this.connected = false;
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

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
