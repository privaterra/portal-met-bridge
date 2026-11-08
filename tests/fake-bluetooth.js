// fake-bluetooth.js — a stand-in navigator.bluetooth that behaves like a Belka
// Portal, for exercising the app's BLE path in a browser with no Portal nearby.
// Injected by tests/e2e-portal.mjs; you can also paste it into the console.
//
// It implements just enough of Web Bluetooth for js/portal-ble.js:
// requestDevice → device.gatt.connect → getPrimaryService(0x7400) →
// getCharacteristic(0x7410 | 0x7420) → readValue / startNotifications /
// writeValueWithResponse, with characteristicvaluechanged events carrying the
// real 13-byte packet layout at ~8 Hz. EC follows a synthetic espresso curve
// keyed to window.__fakePortalShotStart (ms, performance.now()) when set, else
// it idles near zero like water.
(function () {
  const SERVICE = 0x7400;
  const MEASUREMENT = 0x7410;
  const COMMAND = 0x7420;
  const RATE_HZ = 8;

  function ecAt(now) {
    const t0 = window.__fakePortalShotStart;
    if (!Number.isFinite(t0)) return 0.02 + Math.random() * 0.01;
    const since = (now - t0) / 1000 - 7.0; // liquid reaches the Portal ~7 s in
    if (since < 0) return 0.03 + Math.random() * 0.01;
    return Math.max(0, 3.1 * (1 - Math.exp(-since / 0.9)) * Math.exp(-since / 11) + 0.35 + (Math.random() - 0.5) * 0.03);
  }

  class FakeCharacteristic extends EventTarget {
    constructor(uuid, device) {
      super();
      this.uuid = uuid;
      this.device = device;
      this.value = null;
      this._timer = null;
      this.writes = [];
    }
    _packet() {
      const buf = new ArrayBuffer(13);
      const dv = new DataView(buf);
      const now = performance.now();
      dv.setFloat32(0, ecAt(now), true);
      dv.setFloat32(4, 30 + Math.random(), true);
      dv.setFloat32(8, Number.isFinite(window.__fakePortalShotStart) ? 62 + Math.random() * 2 : 24, true);
      dv.setUint8(12, 87);
      return dv;
    }
    async readValue() {
      this.value = this._packet();
      return this.value;
    }
    async startNotifications() {
      if (this._timer) return this;
      this._timer = setInterval(() => {
        if (!this.device.gatt.connected) return;
        this.value = this._packet();
        this.dispatchEvent(new Event('characteristicvaluechanged'));
      }, 1000 / RATE_HZ);
      return this;
    }
    async stopNotifications() {
      clearInterval(this._timer);
      this._timer = null;
      return this;
    }
    async writeValueWithResponse(bytes) {
      this.writes.push(Array.from(new Uint8Array(bytes.buffer || bytes)));
      window.__fakePortalWrites = this.writes;
    }
    async writeValue(bytes) {
      return this.writeValueWithResponse(bytes);
    }
  }

  class FakeService {
    constructor(device) {
      this.device = device;
      this.chars = new Map();
    }
    async getCharacteristic(uuid) {
      if (uuid !== MEASUREMENT && uuid !== COMMAND) throw new DOMException('No such characteristic', 'NotFoundError');
      if (!this.chars.has(uuid)) this.chars.set(uuid, new FakeCharacteristic(uuid, this.device));
      return this.chars.get(uuid);
    }
  }

  class FakeGatt {
    constructor(device) {
      this.device = device;
      this.connected = false;
      this.service = new FakeService(device);
    }
    async connect() {
      await new Promise((r) => setTimeout(r, 120));
      this.connected = true;
      return this;
    }
    disconnect() {
      this.connected = false;
      this.device.dispatchEvent(new Event('gattserverdisconnected'));
    }
    async getPrimaryService(uuid) {
      if (uuid !== SERVICE) throw new DOMException('No such service', 'NotFoundError');
      return this.service;
    }
  }

  class FakeDevice extends EventTarget {
    constructor() {
      super();
      this.id = 'fake-portal-0001';
      this.name = 'PORTAL (simulated)';
      this.gatt = new FakeGatt(this);
    }
  }

  const device = new FakeDevice();
  window.__fakePortalDevice = device;
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: {
      async getAvailability() {
        return true;
      },
      async requestDevice(options) {
        window.__fakePortalRequest = options;
        const filters = options?.filters || [];
        const matches = options?.acceptAllDevices || filters.some((f) => (f.services || []).includes(SERVICE) || (f.namePrefix && device.name.startsWith(f.namePrefix)));
        if (!matches) throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
        return device;
      },
    },
  });
  console.log('[fake-bluetooth] simulated Belka Portal installed');
})();
