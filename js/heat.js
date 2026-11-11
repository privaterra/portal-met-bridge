// heat.js — "is the brew water at temperature yet?"
//
// The machine heats after Start brew (or Preheat) and the status stream carries
// a temperature every 100 ms, but the machine's own "click to start" says only
// that *its* heating routine finished. This module watches the temperature
// against the loaded profile's target with a rule the user picks in Settings,
// and the Start brew button turns green when the rule is met:
//
//   machine   the machine reports "click to start" (its own readiness)
//   reach     the reading is within ±tolerance of the target (first time)
//   hold      the reading has stayed within ±tolerance for `holdSec` seconds
//   settled   within ±tolerance for `holdSec` seconds AND it moved by less than
//             `settleC` over that window (no longer climbing or falling)
//   both      the machine says "click to start" AND the hold rule agrees
//
// Readiness is armed while the machine heats (or when nothing has happened yet)
// and disarmed once a brew has run, so the button is green before a shot and
// plain again after it until the machine heats for the next one.
// Pure: feed it status-like samples, read `ready`, `phase` and `describe()`.

export const HEAT_RULES = {
  machine: { label: 'the machine says so — it reports "click to start"', short: 'machine' },
  reach: { label: 'the water is within the tolerance of the target (first reading that is)', short: 'reached' },
  hold: { label: 'the water has stayed within the tolerance of the target for the hold time', short: 'held' },
  settled: { label: 'within the tolerance for the hold time and no longer changing (settled)', short: 'settled' },
  both: { label: 'the machine says so and the hold rule agrees', short: 'machine + held' },
};
export const HEAT_SENSORS = {
  status: { label: "the status temperature (what the machine's screen shows)" },
  ext1: { label: 'external probe 1 (boiler side)' },
  ext2: { label: 'external probe 2 (group side)' },
  tube: { label: 'the tube' },
  bar: { label: 'the bar heaters (mean of the four)' },
};
export const HEAT_DEFAULTS = { rule: 'hold', sensor: 'status', toleranceC: 1.0, holdSec: 10, settleC: 0.3 };

export class HeatMonitor {
  constructor(opts = {}) {
    this.configure({ ...HEAT_DEFAULTS, ...opts });
    this.reset();
  }

  configure({ rule, sensor, toleranceC, holdSec, settleC } = {}) {
    if (rule in HEAT_RULES) this.rule = rule;
    if (sensor in HEAT_SENSORS) this.sensor = sensor;
    if (Number.isFinite(toleranceC) && toleranceC > 0) this.toleranceC = toleranceC;
    if (Number.isFinite(holdSec) && holdSec >= 0) this.holdSec = holdSec;
    if (Number.isFinite(settleC) && settleC > 0) this.settleC = settleC;
    this.samples = []; // a changed rule starts the hold again
    this.ready = false;
  }

  /** Forget everything (disconnect, new machine). */
  reset() {
    this.samples = []; // [{ at (ms), temp }]
    this.targetC = null;
    this.phase = 'idle'; // idle | heating | ready | brewing | done
    this.armed = true; // may become ready; false after a brew until the machine heats again
    this.ready = false;
    this.machineReady = false;
    this.lastTemp = NaN;
    this.lastAt = 0;
    this.since = 0; // when the current phase began
  }

  /** The loaded profile's brew temperature; null when unknown (then only the machine rule can decide). */
  setTarget(c) {
    const v = Number(c);
    const next = Number.isFinite(v) && v > 0 ? v : null;
    if (next !== this.targetC) {
      this.targetC = next;
      this.samples = [];
      this.ready = false;
    }
  }

  /**
   * One status sample. `name` is the machine's stage/state name, `extracting`
   * its flag, `temp` the reading of the chosen sensor (°C), `at` a clock in ms.
   * Returns true when `ready` changed.
   */
  onStatus({ name = '', extracting = false, temp = NaN, at = Date.now() } = {}) {
    const was = this.ready;
    const n = String(name || '');
    this.machineReady = /click to start/i.test(n);
    const heatingName = /heat/i.test(n);
    if (Number.isFinite(temp)) {
      this.lastTemp = temp;
      this.lastAt = at;
      this.samples.push({ at, temp });
      const cutoff = at - Math.max(60000, (this.holdSec + 5) * 1000);
      while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
    }

    // Phases: a brew (the machine's extracting flag) disarms readiness until the machine heats again.
    if (extracting) {
      if (this.phase !== 'brewing') this._enter('brewing', at);
      this.armed = false;
      this.ready = false;
      return was !== this.ready;
    }
    if (this.phase === 'brewing') {
      this._enter('done', at);
      this.samples = [];
    }
    const belowBand = this.targetC !== null && Number.isFinite(this.lastTemp) && this.lastTemp < this.targetC - 3 * this.toleranceC;
    if (heatingName || (this.phase === 'done' && belowBand)) {
      if (!this.armed || this.phase === 'done' || this.phase === 'idle') {
        this.armed = true;
        this._enter('heating', at);
      }
    }
    if (!this.armed) {
      this.ready = false;
      return was !== this.ready;
    }
    const verdict = this.evaluate(at);
    this.ready = verdict.ready;
    if (this.ready && this.phase !== 'ready') this._enter('ready', at);
    else if (!this.ready && this.phase === 'ready') this._enter('heating', at); // fell out of the band
    else if (!this.ready && this.phase === 'idle' && (heatingName || belowBand)) this._enter('heating', at);
    return was !== this.ready;
  }

  _enter(phase, at) {
    this.phase = phase;
    this.since = at;
  }

  /** Apply the rule to what has been seen. { ready, detail } */
  evaluate(at = this.lastAt) {
    const r = this.rule;
    if (r === 'machine') return { ready: this.machineReady, detail: this.machineReady ? 'the machine reports click to start' : 'waiting for the machine' };
    if (this.targetC === null) return { ready: false, detail: 'no target temperature (load a profile with one)' };
    if (!Number.isFinite(this.lastTemp)) return { ready: false, detail: 'no temperature yet' };
    const inBand = (t) => Math.abs(t - this.targetC) <= this.toleranceC;
    if (r === 'reach') return { ready: inBand(this.lastTemp), detail: inBand(this.lastTemp) ? 'within the tolerance' : 'not within the tolerance yet' };
    // hold / settled / both: every sample of the last holdSec seconds inside the band
    const windowStart = at - this.holdSec * 1000;
    const recent = this.samples.filter((s) => s.at >= windowStart);
    const covered = this.samples.length && this.samples[0].at <= windowStart + 250; // the window is full
    const heldS = this._heldSeconds(at);
    const held = covered && recent.length > 0 && recent.every((s) => inBand(s.temp)) && heldS >= this.holdSec - 0.05;
    if (!inBand(this.lastTemp)) return { ready: false, detail: 'not within the tolerance yet', heldS: 0 };
    if (!held) return { ready: false, detail: `within the tolerance for ${heldS.toFixed(0)} of ${this.holdSec} s`, heldS };
    if (r === 'hold') return { ready: true, detail: `within the tolerance for ${this.holdSec} s`, heldS };
    if (r === 'both') return this.machineReady ? { ready: true, detail: `held ${this.holdSec} s and the machine reports click to start`, heldS } : { ready: false, detail: `held ${this.holdSec} s, waiting for the machine`, heldS };
    // settled: the spread over the window must be small
    const temps = recent.map((s) => s.temp);
    const spread = Math.max(...temps) - Math.min(...temps);
    return spread <= this.settleC ? { ready: true, detail: `settled: moved ${spread.toFixed(2)} °C in ${this.holdSec} s`, heldS, spread } : { ready: false, detail: `still moving: ${spread.toFixed(2)} °C over ${this.holdSec} s`, heldS, spread };
  }

  /** How long the reading has been continuously inside the band, in seconds. */
  _heldSeconds(at = this.lastAt) {
    if (this.targetC === null) return 0;
    let start = null;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i];
      if (Math.abs(s.temp - this.targetC) > this.toleranceC) break;
      start = s.at;
    }
    return start === null ? 0 : (at - start) / 1000;
  }

  /** One line for the UI. */
  describe() {
    const t = Number.isFinite(this.lastTemp) ? `${this.lastTemp.toFixed(1)} °C` : 'no reading';
    const target = this.targetC !== null ? ` · target ${this.targetC.toFixed(1)} °C` : ' · target unknown';
    if (this.phase === 'brewing') return `brewing · ${t}`;
    if (this.phase === 'done') return `brew done · ${t}${target} — green again when the machine heats for the next one`;
    const v = this.evaluate();
    if (this.ready) return `water ready (${HEAT_RULES[this.rule].short}) · ${t}${target}`;
    return `${this.phase === 'heating' ? 'heating' : 'waiting'} · ${t}${target} · ${v.detail}`;
  }
}

/** The chosen sensor's reading from a status sample and the latest "sensors" packet. */
export function sensorTemp(sensor, status, sensors) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  switch (sensor) {
    case 'ext1': return n(sensors?.t_ext_1);
    case 'ext2': return n(sensors?.t_ext_2);
    case 'tube': return n(sensors?.t_tube);
    case 'bar': {
      const vals = [sensors?.t_bar_up, sensors?.t_bar_mu, sensors?.t_bar_md, sensors?.t_bar_down].map(n).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
    }
    default: return n(status?.temp);
  }
}
